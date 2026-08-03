// ─────────────────────────────────────────────────────────────────────────
// QUOTA LEDGER PERSISTENCE (STAGE 3)
//
// The chrome.storage half of the request budget. All the DECISIONS live in
// `request-budget.ts`, which is pure and covered by `node tests/run.mjs`; this
// file only reads, writes, and notifies.
//
// Keyed by the PACIFIC calendar date, because that is where the quota window
// actually falls:
//   "Requests per day (RPD) quotas reset at midnight Pacific time."
//   <https://ai.google.dev/gemini-api/docs/rate-limits>  (fetched 2026-07-28)
// ─────────────────────────────────────────────────────────────────────────

import {
  emptyLedger,
  pacificDayKey,
  recordRequests,
  rollOver,
  learnLimit,
  setUserLimit,
  classifyQuotaWindow,
  type QuotaLedger,
} from "./request-budget";

const STORAGE_KEY = "easyfilla.quotaLedger.v1";

type Listener = (ledger: QuotaLedger) => void;
const listeners = new Set<Listener>();

// Mirrored in memory so the live counter can render synchronously without an
// await on every paint.
let cached: QuotaLedger | null = null;

export function onQuotaChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(ledger: QuotaLedger): void {
  cached = ledger;
  listeners.forEach((listener) => {
    try {
      listener(ledger);
    } catch (error) {
      console.warn("EasyFilla(quota): a usage listener threw.", error);
    }
  });
}

function isLedger(value: unknown): value is QuotaLedger {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as QuotaLedger).day === "string" &&
    typeof (value as QuotaLedger).used === "number"
  );
}

export async function loadLedger(): Promise<QuotaLedger> {
  if (cached) {
    const rolled = rollOver(cached, new Date());
    if (rolled !== cached) {
      await saveLedger(rolled);
    }
    return rolled;
  }
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw = stored[STORAGE_KEY];
    const ledger = isLedger(raw) ? rollOver(raw, new Date()) : emptyLedger(pacificDayKey());
    cached = ledger;
    return ledger;
  } catch (error) {
    // Storage unavailable is not a reason to block a request — it is a reason
    // to stop counting and say so. Silently counting wrong would be worse.
    console.warn("EasyFilla(quota): couldn't read the usage ledger; counting is disabled this session.", error);
    const ledger = emptyLedger(pacificDayKey());
    cached = ledger;
    return ledger;
  }
}

export async function saveLedger(ledger: QuotaLedger): Promise<void> {
  cached = ledger;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: ledger });
  } catch (error) {
    console.warn("EasyFilla(quota): couldn't persist the usage ledger.", error);
  }
  notify(ledger);
}

export function cachedLedger(): QuotaLedger | null {
  return cached;
}

// Called once per ACTUAL outbound model request, from the single gated
// chokepoint in the request queue — not per feature, or the count drifts.
export async function noteRequestSent(count = 1): Promise<QuotaLedger> {
  const ledger = await loadLedger();
  const updated = recordRequests(ledger, count, new Date());
  await saveLedger(updated);
  return updated;
}

// Learn the real daily allowance from a 429 rather than guessing one. Only a
// DAILY violation teaches us anything about the daily limit — a per-minute
// violation's value is an RPM figure and would be a wrong denominator.
export async function noteObservedDailyLimit(
  observed: number,
  haystack: string,
  retryAfterMs?: number,
): Promise<void> {
  if (classifyQuotaWindow(haystack, retryAfterMs) !== "daily") {
    return;
  }
  const ledger = await loadLedger();
  if (ledger.limitSource === "user") {
    return; // an explicit user setting outranks an inferred one
  }
  const updated = learnLimit(ledger, observed);
  if (updated !== ledger) {
    console.log(
      `EasyFilla(quota): learned the daily request limit from a quota error — ${observed}/day. ` +
        "This was not guessed; Google does not publish it per model.",
    );
    await saveLedger(updated);
  }
}

export async function setDailyLimit(limit: number | null): Promise<QuotaLedger> {
  const ledger = await loadLedger();
  const updated = setUserLimit(ledger, limit);
  await saveLedger(updated);
  return updated;
}

// When a daily quota IS hit, we know the answer exactly: everything used so far
// was the allowance. Recording it means the next run's pre-flight is accurate.
export async function noteDailyQuotaExhausted(): Promise<QuotaLedger> {
  const ledger = await loadLedger();
  if (ledger.limitSource === "user" || ledger.used <= 0) {
    return ledger;
  }
  const updated = learnLimit(ledger, ledger.used);
  await saveLedger(updated);
  return updated;
}
