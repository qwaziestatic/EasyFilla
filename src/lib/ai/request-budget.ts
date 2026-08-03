// ─────────────────────────────────────────────────────────────────────────
// REQUEST BUDGET AND QUOTA DEFENCE (STAGE 3)
//
// Daily free-tier quota exhaustion is what produced the original ~59s retry
// loop: the client kept honouring a server `retryDelay` for a quota that would
// not clear until midnight. The classifier fix stopped the looping; this module
// stops the SPEND — it counts requests, predicts them before they are made, and
// refuses to start work it can already tell will not finish.
//
// ── VERIFIED AGAINST LIVE DOCS (fetched 2026-07-28) ──────────────────────
//   "Requests per day (RPD) quotas reset at midnight Pacific time."
//   <https://ai.google.dev/gemini-api/docs/rate-limits>
//
// That reset boundary is the ONLY quota fact the docs state unconditionally,
// and it is why every window here is keyed on the PACIFIC calendar date rather
// than the user's local date or UTC.
//
// ── WHAT THE DOCS DELIBERATELY DO NOT GIVE US ────────────────────────────
// The numeric free-tier RPD is NOT published per model on the rate-limits page;
// it directs you to the AI Studio dashboard, says limits "are not guaranteed
// and actual capacity may vary", and the free-tier Flash allowance has already
// been cut once (widely reported 250 → 20 RPD in Dec 2025).
//
// So this module NEVER hardcodes a limit it cannot verify. `limit` starts
// `null` = UNKNOWN, and the UI says "N used today (daily limit unknown)"
// rather than inventing a denominator. A limit becomes known only when the
// user sets one, or when a real 429 tells us. Guessing here would produce
// exactly the confident-but-wrong reporting this codebase keeps fighting.
// ─────────────────────────────────────────────────────────────────────────

export type LimitSource = "unknown" | "user" | "observed-429";

export interface QuotaLedger {
  // Pacific calendar date, "YYYY-MM-DD". The rollover key.
  day: string;
  used: number;
  // null = genuinely unknown. Never a guess.
  limit: number | null;
  limitSource: LimitSource;
}

export function emptyLedger(day: string): QuotaLedger {
  return { day, used: 0, limit: null, limitSource: "unknown" };
}

// ── The Pacific-midnight boundary ────────────────────────────────────────
// Uses the IANA zone so PST/PDT transitions are handled by the platform. A
// fixed UTC-8 would drift by an hour for two-thirds of the year and roll the
// counter over at the wrong moment every spring.

export function pacificDayKey(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which sorts and compares as a plain string.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// The instant of the next 00:00 Pacific strictly after `now`.
export function nextPacificMidnight(now: Date = new Date()): Date {
  // Walk forward in hours from now until the Pacific day key changes, then
  // narrow to the minute. Cheap, and correct across DST without hand-rolled
  // offset arithmetic (on a spring-forward day, local midnight still exists;
  // on fall-back the first occurrence is the right one).
  const today = pacificDayKey(now);
  let coarse = new Date(now.getTime());
  for (let hour = 1; hour <= 26; hour += 1) {
    coarse = new Date(now.getTime() + hour * 3600_000);
    if (pacificDayKey(coarse) !== today) {
      break;
    }
  }
  let fine = new Date(coarse.getTime() - 3600_000);
  for (let minute = 1; minute <= 60; minute += 1) {
    const probe = new Date(fine.getTime() + minute * 60_000);
    if (pacificDayKey(probe) !== today) {
      return probe;
    }
  }
  return coarse;
}

export function describeReset(now: Date = new Date()): string {
  return nextPacificMidnight(now).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Accounting ───────────────────────────────────────────────────────────

// Rolls the ledger over when the Pacific date has changed. Pure: returns a new
// ledger rather than mutating, so the caller decides when to persist.
export function rollOver(ledger: QuotaLedger, now: Date = new Date()): QuotaLedger {
  const day = pacificDayKey(now);
  if (ledger.day === day) {
    return ledger;
  }
  // A learned limit survives the rollover — it is a property of the key/model,
  // not of the day. The COUNT does not.
  return { day, used: 0, limit: ledger.limit, limitSource: ledger.limitSource };
}

export function recordRequests(ledger: QuotaLedger, count = 1, now: Date = new Date()): QuotaLedger {
  const rolled = rollOver(ledger, now);
  return { ...rolled, used: rolled.used + count };
}

export function remaining(ledger: QuotaLedger): number | null {
  if (ledger.limit === null) {
    return null;
  }
  return Math.max(0, ledger.limit - ledger.used);
}

// Learn the real limit from a 429. Google's QuotaFailure violations carry the
// value in a few shapes; the caller extracts it and hands us a number.
export function learnLimit(ledger: QuotaLedger, observed: number): QuotaLedger {
  if (!Number.isFinite(observed) || observed <= 0) {
    return ledger;
  }
  return { ...ledger, limit: observed, limitSource: "observed-429" };
}

export function setUserLimit(ledger: QuotaLedger, limit: number | null): QuotaLedger {
  if (limit === null) {
    return { ...ledger, limit: null, limitSource: "unknown" };
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return ledger;
  }
  return { ...ledger, limit: Math.floor(limit), limitSource: "user" };
}

export function describeUsage(ledger: QuotaLedger): string {
  if (ledger.limit === null) {
    return `${ledger.used} request${ledger.used === 1 ? "" : "s"} used today (daily limit unknown)`;
  }
  return `${ledger.used} of ${ledger.limit} requests used today`;
}

// ── Pre-flight estimate ──────────────────────────────────────────────────
// Predicts the request count BEFORE anything is spent, so a run that cannot
// finish is not started. Failing halfway through burns quota AND leaves the
// user with a partial report they did not ask for.

export interface EstimateInput {
  // Files going into Stage A. Zero when the dossier is already cached.
  fileCount: number;
  // Questions that survived Tier 0/1 and actually need the model.
  questionCount: number;
  chunkSize: number;
  dossierCached: boolean;
  // Stage A retries once on a safety block (§2). Counted as possible, not
  // certain, so the estimate is a RANGE — presenting the floor as the cost is
  // how a run "unexpectedly" exceeds its budget.
  includeSafetyRetry?: boolean;
}

export interface RequestEstimate {
  stageA: number;
  stageB: number;
  min: number;
  max: number;
}

export function estimateRequests(input: EstimateInput): RequestEstimate {
  const stageA = input.dossierCached || input.fileCount === 0 ? 0 : 1;
  const stageB = input.questionCount === 0 ? 0 : Math.ceil(input.questionCount / Math.max(1, input.chunkSize));
  const min = stageA + stageB;
  // Worst case: Stage A's one safety retry, plus one Stage B retry chunk for
  // partial failures (§2 keeps answered indices and retries only failed ids).
  const max = min + (stageA > 0 && input.includeSafetyRetry !== false ? 1 : 0) + (stageB > 0 ? 1 : 0);
  return { stageA, stageB, min, max };
}

export type PreflightVerdict = "ok" | "unknown-limit" | "tight" | "exceeds";

export interface PreflightResult {
  verdict: PreflightVerdict;
  estimate: RequestEstimate;
  remaining: number | null;
  // How many questions CAN be answered inside the remaining budget. Offered
  // instead of failing midway.
  answerableQuestions: number;
  message: string;
}

export function preflight(
  ledger: QuotaLedger,
  input: EstimateInput,
  now: Date = new Date(),
): PreflightResult {
  const rolled = rollOver(ledger, now);
  const estimate = estimateRequests(input);
  const left = remaining(rolled);

  if (left === null) {
    return {
      verdict: "unknown-limit",
      estimate,
      remaining: null,
      answerableQuestions: input.questionCount,
      message:
        `This will use about ${estimate.min}–${estimate.max} request(s). ` +
        `${rolled.used} have been used today. The daily limit for this key isn't known — ` +
        "Google doesn't publish it per model, so EasyFilla won't guess one. " +
        "Set it in Options if you know it, and it will be learned automatically from the first quota error.",
    };
  }

  if (estimate.max <= left) {
    return {
      verdict: "ok",
      estimate,
      remaining: left,
      answerableQuestions: input.questionCount,
      message: `This will use about ${estimate.min}–${estimate.max} of your ${left} remaining request(s) today.`,
    };
  }

  // How many questions fit? Stage A must be paid first; whatever is left goes
  // to Stage B chunks.
  const forStageB = Math.max(0, left - estimate.stageA);
  const answerableQuestions = Math.max(0, forStageB * input.chunkSize);

  if (estimate.min <= left) {
    return {
      verdict: "tight",
      estimate,
      remaining: left,
      answerableQuestions: input.questionCount,
      message:
        `This needs ${estimate.min} request(s) and you have ${left} left today. ` +
        `It fits, but only just — if a chunk fails and retries, it may not finish. ` +
        `Resets at ${describeReset(now)} (00:00 Pacific).`,
    };
  }

  return {
    verdict: "exceeds",
    estimate,
    remaining: left,
    answerableQuestions,
    message:
      `This needs about ${estimate.min}–${estimate.max} requests but only ${left} remain today. ` +
      (answerableQuestions > 0
        ? `You can answer the first ${answerableQuestions} question(s) now and the rest after the quota resets at ${describeReset(now)} (00:00 Pacific).`
        : `There isn't enough budget left to start. The quota resets at ${describeReset(now)} (00:00 Pacific).`),
  };
}

// ── Classifier verification helpers ──────────────────────────────────────
// Re-verified against the metric names Google actually returns. The trap:
// `free_tier` appears in BOTH per-minute and per-day violations, e.g.
//   generativelanguage.googleapis.com/generate_content_free_tier_requests
//   GenerateRequestsPerMinutePerProjectPerModel-FreeTier
//   GenerateRequestsPerDayPerProjectPerModel-FreeTier
// so treating any `free_tier` string as DAILY stops work that would have
// succeeded after 60 seconds. Per-day and per-minute signals are therefore
// checked BEFORE the bare free-tier wording.

export function looksPerDay(haystack: string): boolean {
  return /per[_ -]?day|perday|\bdaily\b|requests?[_ -]?per[_ -]?day/i.test(haystack);
}

export function looksPerMinute(haystack: string): boolean {
  return /per[_ -]?minute|perminute|per[_ -]?min\b|input[_ -]?token[_ -]?count|\brpm\b/i.test(haystack);
}

// `retryAfterMs` matters: a per-minute limit comes with a short server-supplied
// delay, a daily one does not (or supplies an implausibly long one).
export function classifyQuotaWindow(
  haystack: string,
  retryAfterMs?: number,
): "daily" | "per_minute" {
  if (looksPerDay(haystack)) {
    return "daily";
  }
  if (looksPerMinute(haystack)) {
    return "per_minute";
  }
  if (/free[_ -]?tier/i.test(haystack)) {
    // Bare free-tier wording with no window token. A short retryDelay means the
    // server expects this to clear soon, so it is per-minute.
    const shortDelay = retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= 120_000;
    return shortDelay ? "per_minute" : "daily";
  }
  return "per_minute";
}

// Pulls a numeric quota value out of a 429's QuotaFailure violations, so the
// real limit can be LEARNED instead of guessed.
export function extractObservedLimit(details: unknown[]): number | null {
  for (const detail of details) {
    const violations = (detail as { violations?: Record<string, unknown>[] }).violations;
    if (!Array.isArray(violations)) {
      continue;
    }
    for (const violation of violations) {
      const raw = violation.quotaValue ?? violation.quotaLimitValue ?? violation.limit;
      const value = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }
  return null;
}
