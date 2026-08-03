// ─────────────────────────────────────────────────────────────────────────
// TASK D1 — COMPOSE QUEUE
//
// Asserts the six things the queue is responsible for (§6b.4): admission, FIFO
// ordering, per-question state, KEY-ROUTED result delivery, individual
// cancellation, and queue depth. Plus the thing it must NOT do: run two jobs at
// once (§3, settled).
// ─────────────────────────────────────────────────────────────────────────
import {
  ComposeQueue,
  composeJobKey,
  composeButtonLabel,
  ordinal,
} from "./_bundle-compose-queue.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A queue whose `run` resolves only when the test says so. */
function harness(overrides = {}) {
  const events = [];
  const pending = new Map();
  let concurrentPeak = 0;
  let inFlight = 0;

  const queue = new ComposeQueue({
    run: (job, signal) => {
      inFlight += 1;
      concurrentPeak = Math.max(concurrentPeak, inFlight);
      events.push(`run:${job.key}`);
      return new Promise((resolve, reject) => {
        pending.set(job.key, {
          resolve: (value) => {
            inFlight -= 1;
            resolve(value);
          },
          reject: (error) => {
            inFlight -= 1;
            reject(error);
          },
          signal,
        });
      });
    },
    deliver: (job, result) => events.push(`deliver:${job.key}:${result}`),
    fail: (job, message) => events.push(`fail:${job.key}:${message}`),
    restore: (job) => events.push(`restore:${job.key}:${job.previousDraft}`),
    onChange: () => {},
    ...overrides,
  });

  return {
    queue,
    events,
    pending,
    peak: () => concurrentPeak,
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

console.log("\n=== D1: keys are runId-scoped, never a bare index ===");
{
  check("the key combines runId and index", composeJobKey("run-a", 3) === "run-a:3");
  check(
    "the same index in a different run is a DIFFERENT job",
    composeJobKey("run-a", 3) !== composeJobKey("run-b", 3),
    "a bare index would let a stale result land on a rescanned question",
  );
}

console.log("\n=== D1: FIFO order, and exactly one job running ===");
{
  const h = harness();
  h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: null });
  h.queue.enqueue({ runId: "r1", questionIndex: 1, previousDraft: null });
  h.queue.enqueue({ runId: "r1", questionIndex: 2, previousDraft: null });
  await h.settle();

  check("only the first job started", h.events.filter((e) => e.startsWith("run:")).length === 1, h.events.join(" | "));
  const snap = h.queue.snapshot();
  check("composing is exactly 1", snap.composing === 1);
  check("the other two are queued", snap.queued === 2);
  check("queue depth reads naturally", h.queue.describeDepth() === "1 composing, 2 queued", h.queue.describeDepth());

  // Positions are 1-based among QUEUED jobs only.
  check("the first queued job is 1st", h.queue.viewFor("r1:1").queuePosition === 1);
  check("the second queued job is 2nd", h.queue.viewFor("r1:2").queuePosition === 2);
  check("the running job has no queue position", h.queue.viewFor("r1:0").queuePosition === null);

  h.pending.get("r1:0").resolve("A");
  await h.settle();
  check("finishing the first starts the SECOND, not the third", h.events.includes("run:r1:1"), h.events.join(" | "));
  check("order is preserved", h.events.indexOf("run:r1:1") < (h.events.indexOf("run:r1:2") + 1 || 99));

  h.pending.get("r1:1").resolve("B");
  await h.settle();
  h.pending.get("r1:2").resolve("C");
  await h.settle();

  check("all three delivered", ["A", "B", "C"].every((v) => h.events.includes(`deliver:r1:${["A", "B", "C"].indexOf(v)}:${v}`)), h.events.join(" | "));
  check("⚠️ CONCURRENCY NEVER EXCEEDED 1", h.peak() === 1, `peak=${h.peak()}`);
  check("the queue empties", h.queue.describeDepth() === "", h.queue.describeDepth());
}

console.log("\n=== D1: results are routed by KEY, not by arrival ===");
{
  const h = harness();
  h.queue.enqueue({ runId: "r1", questionIndex: 5, previousDraft: null });
  await h.settle();
  h.pending.get("r1:5").resolve("FIVE");
  await h.settle();
  check(
    "the result lands on the question that asked for it",
    h.events.includes("deliver:r1:5:FIVE"),
    h.events.join(" | "),
  );
  check(
    "and on no other",
    h.events.filter((e) => e.startsWith("deliver:")).length === 1,
  );
}

console.log("\n=== D1: cancelling a QUEUED job is free ===");
{
  const h = harness();
  h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: null });
  h.queue.enqueue({ runId: "r1", questionIndex: 1, previousDraft: "old-1" });
  await h.settle();

  const verdict = h.queue.cancel("r1:1");
  check("it cancels", verdict.cancelled === true);
  check("⚠️ and NO request was spent", verdict.spentRequest === false, "this is the cheapest correction available");
  check("it never started", !h.events.includes("run:r1:1"), h.events.join(" | "));
  check("nothing was restored, because nothing was overwritten", !h.events.some((e) => e.startsWith("restore:")));
  check("the queue depth drops", h.queue.snapshot().queued === 0);
  check("the RUNNING job is undisturbed", h.queue.viewFor("r1:0").state === "running");

  h.pending.get("r1:0").resolve("A");
  await h.settle();
  check("the cancelled job is never run afterwards", !h.events.includes("run:r1:1"), h.events.join(" | "));
}

console.log("\n=== D1: cancelling the RUNNING job aborts it and restores the draft ===");
{
  const h = harness();
  h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: "the draft before composing" });
  h.queue.enqueue({ runId: "r1", questionIndex: 1, previousDraft: null });
  await h.settle();

  const signal = h.pending.get("r1:0").signal;
  check("the run received an abort signal", signal !== undefined && signal.aborted === false);

  const verdict = h.queue.cancel("r1:0");
  check("it cancels", verdict.cancelled === true);
  check("the signal is aborted, so the in-flight request is really cancelled", signal.aborted === true);
  check(
    "the draft captured AT START is restored",
    h.events.includes("restore:r1:0:the draft before composing"),
    h.events.join(" | "),
  );

  // The provider rejects with an abort error once cancelled.
  h.pending.get("r1:0").reject(new Error("Cancelled."));
  await h.settle();

  check(
    "⚠️ a cancellation is NOT reported as a failure",
    !h.events.some((e) => e.startsWith("fail:")),
    h.events.join(" | "),
  );
  check("and its result is never delivered", !h.events.some((e) => e.startsWith("deliver:")));
  check("the state is cancelled, not failed", h.queue.viewFor("r1:0").state === "cancelled");
  check("the NEXT job starts", h.events.includes("run:r1:1"), h.events.join(" | "));
}

console.log("\n=== D1: a late result from a cancelled job is DROPPED ===");
{
  // The precise §6b.4 hazard: cancel, then the original request completes.
  const h = harness();
  h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: "before" });
  await h.settle();
  h.queue.cancel("r1:0");
  h.pending.get("r1:0").resolve("STALE RESULT");
  await h.settle();
  check(
    "the stale result never reaches the question",
    !h.events.some((e) => e.startsWith("deliver:")),
    h.events.join(" | "),
  );
}

console.log("\n=== D1: a result from a SUPERSEDED run is dropped ===");
{
  const h = harness();
  h.queue.enqueue({ runId: "old-run", questionIndex: 2, previousDraft: null });
  await h.settle();

  // The report is regenerated: a new runId is minted.
  h.queue.discardRunsExcept("new-run");
  h.pending.get("old-run:2").resolve("ANSWER FOR A QUESTION THAT NO LONGER EXISTS");
  await h.settle();

  check(
    "⚠️ it does not land on the freshly-scanned question at the same index",
    !h.events.some((e) => e.startsWith("deliver:")),
    h.events.join(" | "),
  );
  check("the superseded job is cancelled", h.queue.viewFor("old-run:2").state === "cancelled");
}

console.log("\n=== D1: a genuine failure is reported, and does not block the queue ===");
{
  const h = harness();
  h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: null });
  h.queue.enqueue({ runId: "r1", questionIndex: 1, previousDraft: null });
  await h.settle();

  h.pending.get("r1:0").reject(new Error("Rate limit reached. Wait 30s."));
  await h.settle();

  check(
    "the classified message is passed through verbatim, not genericised",
    h.events.includes("fail:r1:0:Rate limit reached. Wait 30s."),
    h.events.join(" | "),
  );
  check("the job is failed", h.queue.viewFor("r1:0").state === "failed");
  check("and the queue continues", h.events.includes("run:r1:1"));
}

console.log("\n=== D1: admission refuses a duplicate for the same live question ===");
{
  const h = harness();
  const first = h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: null });
  const second = h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: null });
  check("the first is admitted", first === "r1:0");
  check(
    "a second for the same question is refused rather than spending two requests",
    second === null,
    "double-clicking Compose must not double-charge",
  );
  await h.settle();
  check("only one run started", h.events.filter((e) => e.startsWith("run:")).length === 1);

  // Once finished, the question may be composed again.
  h.pending.get("r1:0").resolve("A");
  await h.settle();
  check("after completion it may be re-composed", h.queue.enqueue({ runId: "r1", questionIndex: 0, previousDraft: "A" }) === "r1:0");
}

console.log("\n=== C: queued and running are VISUALLY DISTINCT ===");
{
  const running0 = { state: "running", queuePosition: null, elapsedMs: 0 };
  const running5 = { state: "running", queuePosition: null, elapsedMs: 5400 };
  const queued2 = { state: "queued", queuePosition: 2, elapsedMs: null };

  check('running says "Composing…"', composeButtonLabel(running0, "Compose") === "Composing…");
  check(
    "⚠️ queued does NOT say Composing — that would be a lie about a request that has not been sent",
    !/Composing/.test(composeButtonLabel(queued2, "Compose")),
    composeButtonLabel(queued2, "Compose"),
  );
  check("queued shows its POSITION", composeButtonLabel(queued2, "Compose") === "Queued (2nd)…", composeButtonLabel(queued2, "Compose"));
  check("elapsed seconds appear after ~3s", composeButtonLabel(running5, "Compose") === "Composing… 5s");
  check("but not before, so a fast call does not flicker a timer", composeButtonLabel(running0, "Compose") === "Composing…");
  check("a job with no view rests at its normal label", composeButtonLabel(null, "Compose with AI") === "Compose with AI");
  check("a finished job returns to rest", composeButtonLabel({ state: "done", queuePosition: null, elapsedMs: null }, "Compose") === "Compose");
  check("a failed job returns to rest, so the error is what speaks", composeButtonLabel({ state: "failed", queuePosition: null, elapsedMs: null }, "Compose") === "Compose");

  check("ordinals read correctly", ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"].every(
    (want, i) => ordinal([1, 2, 3, 4, 11, 12, 13, 21, 22][i]) === want,
  ));
}

console.log("\n=== D1: the queue does not pace, gate or count requests ===");
{
  // §6b.4: it is an ADMISSION layer above the existing global gate, and must not
  // duplicate it. Asserted against the source so a future edit cannot quietly
  // add a second throttle or a second quota increment.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/lib/ai/compose-queue.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  check("no fetch", !/\bfetch\s*\(/.test(source));
  check("no timer-based pacing", !/setTimeout|setInterval/.test(source));
  check("no quota accounting", !/noteRequestSent|quota|ledger/i.test(source));
  check("no concurrency knob exists to be raised", !/concurrency|maxParallel|maxInFlight/i.test(source));
  check("it does not import the request gate, so it cannot bypass or duplicate it", !/request-queue/.test(source));
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
