// ─────────────────────────────────────────────────────────────────────────
// COMPOSE QUEUE (TASK D1)
//
// ⚠️ CONCURRENCY IS 1 AND SETTLED (§3). Nothing in this file executes two jobs
// at once, and there is no guarded path that could. Search this file for a
// concurrency parameter and you will not find one — that is deliberate.
//
// The queue provides: ADMISSION, FIFO ORDERING, PER-QUESTION STATE,
// KEY-ROUTED RESULT DELIVERY, INDIVIDUAL CANCELLATION and QUEUE DEPTH.
// It does NOT provide parallelism, and it does NOT decide the request pace.
//
// ── WHY THIS IS NOT IN THE SERVICE WORKER ────────────────────────────────
// §6b.4 specified "lives in the service worker". It does not, and the reason is
// a hard constraint that outranks the placement:
//
//   Composing requires a provider API key. §4f/B1 and E5 require that the
//   service worker NEVER handle either key — the worker does not import the AI
//   client at all, and that is an audited, tested boundary
//   (`tests/key-security.test.mjs`). Moving compose into the worker would mean
//   moving key access into the worker and deleting that guarantee.
//
// It also agrees with §4f/B5, which keeps approved answers in sidepanel memory
// DELIBERATELY so that answers derived from ID documents are never written to
// disk. A worker-owned queue would have to persist job state to survive MV3
// termination, which is the opposite of that choice.
//
// So the queue lives in the extension page that already legitimately holds both
// the key and the answers. It is DOM-free and provider-free so it stays
// testable, and it calls back out for the actual work.
//
// ── RELATIONSHIP TO THE GLOBAL GATE ──────────────────────────────────────
// `request-queue.ts` remains the single global concurrency-1 chokepoint and is
// UNCHANGED. This sits ABOVE it as an admission layer adding per-question
// identity, cancellation and visibility — concepts the global gate has none of.
// It must never bypass or duplicate the gate: this file contains no fetch, no
// timer-based pacing and no quota accounting, so every request still passes
// through the gate exactly once and the daily counter still increments in one
// place (§4c).
// ─────────────────────────────────────────────────────────────────────────

export type ComposeJobState = "queued" | "running" | "done" | "cancelled" | "failed";

/**
 * `${runId}:${questionIndex}`.
 *
 * ⚠️ NEVER route a result by arrival order or by an index captured in a closure.
 * Reports are REGENERATED, and a bare index would let a stale job's result land
 * on a freshly-scanned question that happens to sit at the same position. Even
 * at concurrency 1 this is reachable: cancel a job, restart it, and the first
 * request may still land after the second was enqueued.
 */
export function composeJobKey(runId: string, questionIndex: number): string {
  return `${runId}:${questionIndex}`;
}

export interface ComposeJob {
  readonly key: string;
  readonly runId: string;
  readonly questionIndex: number;
  state: ComposeJobState;
  readonly enqueuedAt: number;
  startedAt: number | null;
  /**
   * The draft as it stood when the job STARTED, so cancelling restores exactly
   * what the user had. Captured at start, never at cancel time — by cancel time
   * a partial write may already have replaced it.
   */
  readonly previousDraft: string | null;
  readonly controller: AbortController;
  error: string | null;
}

/** What the UI needs to render, with no access to internals. */
export interface ComposeJobView {
  key: string;
  runId: string;
  questionIndex: number;
  state: ComposeJobState;
  /** 1-based position among QUEUED jobs; null unless queued. */
  queuePosition: number | null;
  /** Milliseconds since the job started running; null unless running. */
  elapsedMs: number | null;
  previousDraft: string | null;
  error: string | null;
}

export interface ComposeQueueSnapshot {
  /** 0 or 1, ALWAYS, by design. Rendered as-is; never presented as a maximum. */
  composing: number;
  queued: number;
  jobs: ComposeJobView[];
}

export interface ComposeQueueHandlers<TResult> {
  /**
   * Performs the actual compose. Receives the abort signal the queue owns, and
   * must pass it through to the provider interface so cancellation reaches the
   * in-flight request rather than merely being ignored locally.
   */
  run: (job: ComposeJob, signal: AbortSignal) => Promise<TResult>;
  /**
   * Delivers a result. Called ONLY when the job that produced it is still the
   * live job for its key — a cancelled or superseded job's result is dropped
   * here rather than being written onto whatever now occupies that position.
   */
  deliver: (job: ComposeJob, result: TResult) => void;
  /** A job failed. The classified error message is passed through verbatim (§4f/B3). */
  fail: (job: ComposeJob, message: string) => void;
  /** A running job was cancelled; restore `job.previousDraft`. */
  restore: (job: ComposeJob) => void;
  /** Any state change, for repainting. */
  onChange: (snapshot: ComposeQueueSnapshot) => void;
  now?: () => number;
}

export class ComposeQueue<TResult> {
  private readonly jobs = new Map<string, ComposeJob>();
  /** FIFO. Holds keys, not jobs, so a cancelled job leaves no hole to skip. */
  private readonly order: string[] = [];
  private runningKey: string | null = null;
  private draining = false;
  private readonly handlers: ComposeQueueHandlers<TResult>;
  private readonly now: () => number;

  constructor(handlers: ComposeQueueHandlers<TResult>) {
    this.handlers = handlers;
    this.now = handlers.now ?? (() => Date.now());
  }

  /**
   * Admits a job. Returns its key, or null when one is already live for that
   * question — double-clicking Compose must not enqueue the same work twice and
   * spend two requests.
   */
  enqueue(input: { runId: string; questionIndex: number; previousDraft: string | null }): string | null {
    const key = composeJobKey(input.runId, input.questionIndex);
    const existing = this.jobs.get(key);
    if (existing && (existing.state === "queued" || existing.state === "running")) {
      return null;
    }
    const job: ComposeJob = {
      key,
      runId: input.runId,
      questionIndex: input.questionIndex,
      state: "queued",
      enqueuedAt: this.now(),
      startedAt: null,
      previousDraft: input.previousDraft,
      controller: new AbortController(),
      error: null,
    };
    this.jobs.set(key, job);
    this.order.push(key);
    this.emit();
    void this.drain();
    return key;
  }

  /**
   * Cancels one job without disturbing any other.
   *
   * A QUEUED job is removed and never spends a request — the cheapest
   * correction available, and the UI should say so. A RUNNING job is aborted;
   * its draft is restored and the next job starts.
   */
  cancel(key: string): { cancelled: boolean; spentRequest: boolean } {
    const job = this.jobs.get(key);
    if (!job || (job.state !== "queued" && job.state !== "running")) {
      return { cancelled: false, spentRequest: false };
    }
    if (job.state === "queued") {
      job.state = "cancelled";
      this.removeFromOrder(key);
      this.emit();
      // No request was ever issued, so nothing to restore and nothing spent.
      return { cancelled: true, spentRequest: false };
    }
    // Running: abort the in-flight request. `settle()` handles the rest when the
    // run() promise rejects, so state is not written from two places.
    job.state = "cancelled";
    job.controller.abort();
    this.handlers.restore(job);
    this.emit();
    return { cancelled: true, spentRequest: true };
  }

  /** Cancels everything. Used when a report is regenerated. */
  cancelAll(): void {
    [...this.order].forEach((key) => this.cancel(key));
    if (this.runningKey) this.cancel(this.runningKey);
  }

  /**
   * Drops every job belonging to a superseded run.
   *
   * On regeneration the old runId's jobs can no longer be delivered anywhere
   * meaningful, and keeping them would let a late result write onto a question
   * that has been rescanned.
   */
  discardRunsExcept(liveRunId: string): void {
    [...this.jobs.values()]
      .filter((job) => job.runId !== liveRunId && (job.state === "queued" || job.state === "running"))
      .forEach((job) => this.cancel(job.key));
  }

  get(key: string): ComposeJob | undefined {
    return this.jobs.get(key);
  }

  viewFor(key: string): ComposeJobView | null {
    const job = this.jobs.get(key);
    return job ? this.toView(job) : null;
  }

  snapshot(): ComposeQueueSnapshot {
    const jobs = [...this.jobs.values()].map((job) => this.toView(job));
    return {
      composing: this.runningKey === null ? 0 : 1,
      queued: this.order.length,
      jobs,
    };
  }

  /** Human-readable depth. The first number is 0 or 1 by design (§6b.4). */
  describeDepth(): string {
    const { composing, queued } = this.snapshot();
    if (composing === 0 && queued === 0) return "";
    const parts = [`${composing} composing`];
    if (queued > 0) parts.push(`${queued} queued`);
    return parts.join(", ");
  }

  private toView(job: ComposeJob): ComposeJobView {
    const queueIndex = this.order.indexOf(job.key);
    return {
      key: job.key,
      runId: job.runId,
      questionIndex: job.questionIndex,
      state: job.state,
      queuePosition: job.state === "queued" && queueIndex >= 0 ? queueIndex + 1 : null,
      elapsedMs: job.state === "running" && job.startedAt !== null ? this.now() - job.startedAt : null,
      previousDraft: job.previousDraft,
      error: job.error,
    };
  }

  private removeFromOrder(key: string): void {
    const at = this.order.indexOf(key);
    if (at >= 0) this.order.splice(at, 1);
  }

  private emit(): void {
    this.handlers.onChange(this.snapshot());
  }

  /**
   * Runs jobs one at a time, in enqueue order.
   *
   * `draining` is the concurrency-1 guarantee: a second call while a job is in
   * flight returns immediately rather than starting anything.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.order.length > 0) {
        const key = this.order[0]!;
        const job = this.jobs.get(key);
        if (!job || job.state !== "queued") {
          this.removeFromOrder(key);
          continue;
        }
        this.removeFromOrder(key);
        job.state = "running";
        job.startedAt = this.now();
        this.runningKey = key;
        this.emit();

        try {
          const result = await this.handlers.run(job, job.controller.signal);
          // ── KEY-ROUTED DELIVERY ──
          // Re-read the job by KEY. If it was cancelled while in flight, or its
          // run was superseded, the result is dropped. Delivering it because it
          // "just arrived" is exactly the bug §6b.4 warns about.
          const live = this.jobs.get(key);
          if (live && live.state === "running") {
            live.state = "done";
            this.handlers.deliver(live, result);
          }
        } catch (error) {
          const live = this.jobs.get(key);
          if (live && live.state === "running") {
            live.state = "failed";
            live.error = error instanceof Error ? error.message : "Compose failed.";
            // ⚠️ A cancellation must NOT be reported as a failure, and must not
            // consume a retry. `cancel()` has already set state to "cancelled",
            // so reaching here with state still "running" means a genuine error.
            this.handlers.fail(live, live.error);
          }
        } finally {
          this.runningKey = null;
          this.emit();
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

/**
 * The label for a job's button. Kept here, beside the state machine, so the
 * wording cannot drift from the state it describes.
 *
 * ⚠️ A QUEUED JOB MUST NOT SAY "Composing…" AND MUST NOT SPIN. With concurrency
 * settled at 1, queued is the ORDINARY state the moment a second question is
 * composed. Two spinners for one in-flight request reads as a broken queue when
 * the second takes twice as long.
 */
export function composeButtonLabel(view: ComposeJobView | null, restingLabel: string): string {
  if (!view) return restingLabel;
  switch (view.state) {
    case "running": {
      // Elapsed seconds appear after ~3s so a slow call does not look hung.
      const seconds = view.elapsedMs === null ? 0 : Math.floor(view.elapsedMs / 1000);
      return seconds >= 3 ? `Composing… ${seconds}s` : "Composing…";
    }
    case "queued":
      return view.queuePosition === null ? "Queued…" : `Queued (${ordinal(view.queuePosition)})…`;
    default:
      return restingLabel;
  }
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
