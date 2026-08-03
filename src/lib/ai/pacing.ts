// ─────────────────────────────────────────────────────────────────────────
// REQUEST PACING — DRIVEN BY THE ACTIVE PROVIDER (E3d/0b)
//
// ⚠️ THE BUG THIS FIXES. `setQueueRpm` was called from ONE place: Gemini's
// `activeModel()`, with the selected GEMINI model's `assumedRpm`. So:
//   - selecting Anthropic still paced the queue from a Gemini constant, and
//   - Anthropic's real limits — which it RETURNS IN RESPONSE HEADERS — were
//     never applied, even though `noteAnthropicRateHeaders` existed to read
//     them. It had zero call sites, so the learning never happened.
// Labelling the sidepanel denominator "(our pacing cap)" made the DISPLAY
// honest and left the BEHAVIOUR wrong. This module fixes the behaviour.
//
// ── §3: THIS DRIVES SPACING ONLY ─────────────────────────────────────────
// Concurrency is 1 and SETTLED. Nothing here returns, accepts or implies a
// concurrency count. The only outputs are the rolling-window size and the
// inter-request gap, both consumed by `request-queue.ts`, which remains the
// single global chokepoint.
// ─────────────────────────────────────────────────────────────────────────

import { setQueueRpm, setChunkSpacingMs } from "./request-queue";
import { activeProvider } from "./active-provider";

/**
 * The pace used when a provider learns its limits from responses but no
 * response has been seen yet.
 *
 * Deliberately LOW. This is not a claim about the provider's real limit — §4c
 * forbids inventing one — it is our own conservative choice for how fast to go
 * while we know nothing. Being too slow costs seconds; being too fast costs a
 * 429 storm, which is the failure this codebase already paid for once (§3).
 */
export const UNLEARNED_FALLBACK_RPM = 5;

export type PacingBasis =
  /** Read from a real response header. The only case that is a FACT. */
  | "learned-from-response"
  /** The provider states a figure we assume (Gemini's `assumedRpm`). */
  | "provider-assumption"
  /** Nothing known yet; `UNLEARNED_FALLBACK_RPM` applied. */
  | "unlearned-fallback";

export interface PacingDecision {
  providerId: string;
  providerName: string;
  requestsPerMinute: number;
  spacingMs: number;
  basis: PacingBasis;
  /** For the UI. True only when a real response supplied the number. */
  learned: boolean;
}

/**
 * 60000/rpm evenly fills the window; 90% of that leaves slack for clock skew
 * without stalling the run. Unchanged from B6 — only its INPUT changed.
 */
export function spacingForRpm(rpm: number): number {
  return Math.floor((60_000 / Math.max(1, rpm)) * 0.9);
}

/**
 * Decides the pace for a provider WITHOUT applying it. Pure given its inputs,
 * so the decision can be asserted directly by test.
 *
 * The branch is on the CAPABILITY `learnsLimitsFromResponseHeaders`, never on
 * provider identity — a third provider that reports headers gets the learned
 * path for free.
 */
export function decidePacing(input: {
  providerId: string;
  providerName: string;
  learnsFromHeaders: boolean;
  reportedLimit: number | null;
}): PacingDecision {
  const { providerId, providerName, learnsFromHeaders, reportedLimit } = input;

  let rpm: number;
  let basis: PacingBasis;

  if (learnsFromHeaders) {
    // A number here came from `anthropic-ratelimit-requests-limit` on a real
    // response. Absent one, we know nothing and must not borrow another
    // provider's figure — that is exactly the defect being fixed.
    if (reportedLimit !== null && reportedLimit > 0) {
      rpm = reportedLimit;
      basis = "learned-from-response";
    } else {
      rpm = UNLEARNED_FALLBACK_RPM;
      basis = "unlearned-fallback";
    }
  } else if (reportedLimit !== null && reportedLimit > 0) {
    // Gemini: a documented-but-unverified assumption in model-config.ts. Pace
    // from it, but never call it learned.
    rpm = reportedLimit;
    basis = "provider-assumption";
  } else {
    rpm = UNLEARNED_FALLBACK_RPM;
    basis = "unlearned-fallback";
  }

  return {
    providerId,
    providerName,
    requestsPerMinute: rpm,
    spacingMs: spacingForRpm(rpm),
    basis,
    learned: basis === "learned-from-response",
  };
}

/** Human-readable provenance, for the sidepanel. Never asserts more than it knows. */
export function describePacing(decision: PacingDecision): string {
  switch (decision.basis) {
    case "learned-from-response":
      return `${decision.requestsPerMinute}/min (learned from response headers)`;
    case "provider-assumption":
      return `${decision.requestsPerMinute}/min (our assumption, not stated by the API)`;
    case "unlearned-fallback":
      return `pacing conservatively at ${decision.requestsPerMinute}/min until a response states the real limit`;
  }
}

/**
 * Resolves the active provider and applies its pace to the global gate.
 *
 * Called at the start of every request-initiating path, so a provider switch
 * re-paces without the user reopening Settings, and so Anthropic's learned
 * limit takes effect on the request AFTER the first response.
 */
export async function applyActiveProviderPacing(): Promise<PacingDecision> {
  const provider = await activeProvider();
  const decision = decidePacing({
    providerId: provider.id,
    providerName: provider.displayName,
    learnsFromHeaders: provider.capabilities.learnsLimitsFromResponseHeaders,
    reportedLimit: await provider.perMinuteRequestLimit(),
  });
  setQueueRpm(decision.requestsPerMinute);
  setChunkSpacingMs(decision.spacingMs);
  return decision;
}
