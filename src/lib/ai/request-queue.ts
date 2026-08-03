import { noteRequestSent } from "./quota-store";

// FIX 3: THE single global gate every Gemini request passes through.
//
// Root cause of the observed 429: several independent call paths (classify,
// compose, elicitation, language-detect, connection-test) each fired their own
// fetch with no shared throttle, so the *total* across operations breached the
// free tier's per-minute limit even though each individual operation batched
// correctly. A per-operation batch is not enough — only a global gate is.
//
// Guarantees:
//  - concurrency 1 (never two in flight)
//  - a rolling 60s window: we PRE-EMPTIVELY wait rather than firing into a
//    known-full window
//  - retries are themselves counted in the window, so a backoff can never
//    feed a 429 storm
//  - server-provided retryDelay is honored when present

export interface QueueStats {
  sessionRequests: number;
  windowRequests: number;
  windowLimit: number;
}

const WINDOW_MS = 60_000;
// Leave headroom under the assumed RPM: quota is enforced server-side across
// everything using the key, and our assumption may be optimistic.
const SAFETY_MARGIN = 2;

let windowTimestamps: number[] = [];
let sessionRequests = 0;
let chain: Promise<unknown> = Promise.resolve();
let currentRpm = 15;
let statsListener: ((stats: QueueStats) => void) | null = null;

export function setQueueRpm(rpm: number): void {
  currentRpm = Math.max(1, rpm);
}

export function onQueueStats(listener: (stats: QueueStats) => void): void {
  statsListener = listener;
}

// A human-readable running commentary. Without this, a legitimate multi-minute
// wait (rate-limit pacing plus retries) is indistinguishable from a hang, which
// is precisely how a stalled request went unnoticed for minutes.
let activityListener: ((message: string) => void) | null = null;

export function onQueueActivity(listener: ((message: string) => void) | null): void {
  activityListener = listener;
}

function reportActivity(message: string): void {
  activityListener?.(message);
}

function effectiveLimit(): number {
  return Math.max(1, currentRpm - SAFETY_MARGIN);
}

export function queueStats(): QueueStats {
  pruneWindow();
  return { sessionRequests, windowRequests: windowTimestamps.length, windowLimit: effectiveLimit() };
}

function emitStats(): void {
  statsListener?.(queueStats());
}

function pruneWindow(): void {
  const cutoff = Date.now() - WINDOW_MS;
  windowTimestamps = windowTimestamps.filter((t) => t > cutoff);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Blocks until firing another request keeps us inside the rolling window.
async function awaitWindowSlot(): Promise<void> {
  for (;;) {
    pruneWindow();
    if (windowTimestamps.length < effectiveLimit()) {
      return;
    }
    const oldest = windowTimestamps[0] ?? Date.now();
    const waitMs = Math.max(250, oldest + WINDOW_MS - Date.now() + 50);
    reportActivity(`Pacing requests to stay within your quota — waiting ${Math.ceil(waitMs / 1000)}s…`);
    console.log(
      `EasyFilla(queue): rolling window full (${windowTimestamps.length}/${effectiveLimit()} in 60s) — ` +
        `pre-emptively waiting ${(waitMs / 1000).toFixed(1)}s rather than firing into a full window.`,
    );
    await sleep(waitMs);
  }
}

// Records that a request is being issued RIGHT NOW. Called for the first
// attempt AND for every retry, so retries consume budget like any other call.
function recordRequest(reason: string): void {
  pruneWindow();
  windowTimestamps.push(Date.now());
  sessionRequests += 1;
  console.log(
    `EasyFilla(queue): request #${sessionRequests} (${reason}) — window ${windowTimestamps.length}/${effectiveLimit()}`,
  );
  emitStats();
}

export interface QueuedAttemptResult<T> {
  value: T;
}

// What the caller's task tells the queue about a failure.
export interface RetryDirective {
  retryable: boolean;
  // Server-provided delay in ms, when the API supplied one (e.g. 46.657s).
  retryAfterMs?: number | undefined;
}

export type QueueTask<T> = () => Promise<T>;

export interface EnqueueOptions {
  label: string;
  maxAttempts?: number;
  // Inspect a thrown error and tell the queue whether/when to retry.
  classify: (error: unknown) => RetryDirective;
}

// STAGE 3 — minimum gap between two consecutive requests leaving this queue.
// Chunked answering fires several requests in a row; with no spacing they land
// inside the same per-minute window and the retry storm becomes self-inflicted.
// Configurable because the right value depends on the key's tier, which Google
// does not publish per model.
let chunkSpacingMs = 1100;
let lastDispatchAt = 0;

export function setChunkSpacingMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) {
    chunkSpacingMs = Math.floor(ms);
  }
}

export function chunkSpacing(): number {
  return chunkSpacingMs;
}

async function awaitChunkSpacing(): Promise<void> {
  if (chunkSpacingMs <= 0) {
    return;
  }
  const since = Date.now() - lastDispatchAt;
  if (lastDispatchAt > 0 && since < chunkSpacingMs) {
    await sleep(chunkSpacingMs - since);
  }
  lastDispatchAt = Date.now();
}

const BASE_BACKOFF_MS = 1500;
const MAX_BACKOFF_MS = 30_000;
// Total time this operation may spend WAITING between attempts. A server-sent
// retryDelay of ~59s honored four times is three minutes of dead UI for a
// limit that clearly isn't clearing; stop and report instead of stalling.
const MAX_TOTAL_BACKOFF_MS = 75_000;

// Serializes onto a single chain (concurrency 1) so no two Gemini calls are
// ever in flight, regardless of which feature initiated them.
export function enqueueGeminiRequest<T>(task: QueueTask<T>, options: EnqueueOptions): Promise<T> {
  const run = async (): Promise<T> => {
    const maxAttempts = options.maxAttempts ?? 4;
    let lastError: unknown;
    let totalBackoffMs = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await awaitWindowSlot();
      // STAGE 3 — configurable spacing between SEQUENTIAL requests. Chunked
      // Stage B runs fire back-to-back through this chain; without a gap, the
      // retries themselves can trip the per-minute limit that caused the retry.
      await awaitChunkSpacing();
      recordRequest(attempt === 1 ? options.label : `${options.label} retry ${attempt - 1}`);
      // STAGE 3 — the daily counter increments HERE, at the one gated
      // chokepoint every model request passes through, including retries.
      // Counting per feature drifts; counting here cannot.
      void noteRequestSent(1);
      reportActivity(
        attempt === 1 ? "Contacting Gemini…" : `Retrying (attempt ${attempt} of ${maxAttempts})…`,
      );
      try {
        return await task();
      } catch (error) {
        lastError = error;
        const directive = options.classify(error);
        if (!directive.retryable || attempt === maxAttempts) {
          throw error;
        }
        // Honor the server's own retryDelay when supplied; else exponential
        // backoff with jitter.
        const backoff =
          directive.retryAfterMs ??
          Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);

        // Waiting longer than the budget can't be justified: if the server is
        // still asking for a minute on the last attempt, the limit isn't the
        // per-minute one and more waiting won't fix it.
        if (totalBackoffMs + backoff > MAX_TOTAL_BACKOFF_MS) {
          console.log(
            `EasyFilla(queue): "${options.label}" would need ${(backoff / 1000).toFixed(0)}s more backoff ` +
              `(${(totalBackoffMs / 1000).toFixed(0)}s already spent, cap ${MAX_TOTAL_BACKOFF_MS / 1000}s) — ` +
              "giving up rather than stalling the UI.",
          );
          throw error;
        }
        totalBackoffMs += backoff;
        reportActivity(
          `Attempt ${attempt} of ${maxAttempts} failed — retrying in ${Math.ceil(backoff / 1000)}s…`,
        );
        console.log(
          `EasyFilla(queue): attempt ${attempt}/${maxAttempts} of "${options.label}" failed — ` +
            `retrying in ${(backoff / 1000).toFixed(1)}s` +
            (directive.retryAfterMs ? " (server-provided retryDelay)" : " (exponential backoff + jitter)"),
        );
        await sleep(backoff);
      }
    }
    throw lastError;
  };

  // Append to the chain; failures don't break the chain for later callers.
  const result = chain.then(run, run);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
