// The corrected answerability taxonomy (Problem 2). Mutually exclusive
// states, decided AFTER extraction + deterministic matching + the model
// result — never a default. The product-owner rule: a question is only
// "needs user input" when the answer is genuinely absent from ALL documents
// and the profile; something present (however personal) is answered.
export type AnswerState =
  | "answered_from_documents" // value found in documents/profile — show source
  | "ai_draft_verify" // inferred/synthesized, not explicitly stated — verify
  | "needs_user_input" // genuinely absent everywhere — user's own knowledge
  | "manual_only" // password/payment/CAPTCHA — never sent to AI
  | "ready_to_attach" // file-upload with a matched uploaded document (FIX 5)
  | "needs_file" // file-upload with no suitable uploaded document (FIX 5)
  | "error_retry" // quota/network/parse failure — NOT "not found"
  // Two layers extracted DIFFERENT values for the same field. Presenting either
  // one as "answered from documents" would hide a real disagreement behind
  // false confidence, which is how "Full name = Computer Engineering" survived.
  | "conflicting_sources"
  // Resolved from the user's saved profile / prior answers, NOT from a document.
  | "answered_from_profile";

export interface StateDisplay {
  label: string;
  // RGB for the PDF pill.
  color: [number, number, number];
  // CSS modifier suffix for the sidepanel badge.
  cssModifier: string;
}

export const STATE_DISPLAY: Record<AnswerState, StateDisplay> = {
  answered_from_documents: { label: "Answered from documents", color: [22, 163, 74], cssModifier: "answered" },
  ai_draft_verify: { label: "AI draft — verify", color: [180, 120, 8], cssModifier: "draft" },
  needs_user_input: { label: "Needs your input", color: [180, 120, 8], cssModifier: "needs-input" },
  manual_only: { label: "Manual only", color: [107, 91, 149], cssModifier: "manual" },
  ready_to_attach: { label: "Ready to attach", color: [22, 163, 74], cssModifier: "answered" },
  needs_file: { label: "Needs a file", color: [180, 120, 8], cssModifier: "needs-input" },
  error_retry: { label: "Couldn't reach AI — retry", color: [190, 60, 60], cssModifier: "error" },
  conflicting_sources: { label: "Conflicting sources — please confirm", color: [180, 120, 8], cssModifier: "needs-input" },
  answered_from_profile: { label: "From you — not a document", color: [22, 163, 74], cssModifier: "answered" },
};

// ── PROVENANCE IS THE SOURCE OF TRUTH (PART B.1) ─────────────────────────
// Status is DERIVED from provenance, never assigned beside it. Every path that
// used to call states.set("answered_from_documents") independently is now
// funnelled through deriveState(), and assertProvenanceIntegrity() re-checks
// the invariant at the PDF boundary.
//
// The bug this closes: a report where every question was pilled "Answered from
// documents" — including ones whose own source line read "source: you", and
// including one whose reconciliation had already DETECTED a conflict.

// A real document source is a filename. "you", "your profile", "your documents"
// are not documents and must never render as document-sourced.
const FILENAME_RE = /\.[A-Za-z0-9]{2,5}$/;

export function isDocumentSource(source: string | undefined): boolean {
  const trimmed = (source ?? "").trim();
  if (!trimmed) {
    return false;
  }
  // A conflict line names two files; that is not a single clean provenance.
  if (/;/.test(trimmed)) {
    return false;
  }
  return FILENAME_RE.test(trimmed);
}

export function isProfileSource(source: string | undefined): boolean {
  return /^(you|your profile|manual|your saved profile)$/i.test((source ?? "").trim());
}

export interface Provenance {
  // The filename a value came from, if any.
  source?: string;
  // True when the model composed the text rather than lifting it from a source.
  composed?: boolean;
  // True when the user supplied a seed that the composition expanded.
  userSeeded?: boolean;
  // Set when two layers disagreed.
  conflict?: boolean;
  manualOnly?: boolean;
  // The user typed or explicitly confirmed this in the review UI. Valid
  // provenance — but it is NOT a document, and must never render as one.
  userProvided?: boolean;
  hasValue: boolean;
}

export function deriveState(p: Provenance): AnswerState {
  if (p.manualOnly) {
    return "manual_only";
  }
  if (p.conflict) {
    return "conflicting_sources";
  }
  if (!p.hasValue) {
    return "needs_user_input";
  }
  if (isDocumentSource(p.source) && !p.composed) {
    return "answered_from_documents";
  }
  if (isProfileSource(p.source) && !p.composed) {
    return "answered_from_profile";
  }
  if (p.userProvided && !p.composed) {
    return "answered_from_profile";
  }
  // Composed text is a draft. It is only presentable at all when it expanded
  // something the user actually supplied, or a real document backed it;
  // otherwise it is an invention about the user and must be asked, not asserted.
  if (p.composed && (p.userSeeded || isDocumentSource(p.source))) {
    return "ai_draft_verify";
  }
  return "needs_user_input";
}

export interface ProvenanceViolation {
  index: number;
  state: AnswerState;
  source: string;
  corrected: AnswerState;
}

// Enforced at the PDF boundary. In dev this throws; in production it downgrades
// and logs, because shipping a wrong pill is worse than shipping a blank one.
export function assertProvenanceIntegrity(
  states: Map<number, AnswerState>,
  sources: ReadonlyMap<number, string>,
  options: { throwOnViolation: boolean },
): ProvenanceViolation[] {
  const violations: ProvenanceViolation[] = [];
  states.forEach((state, index) => {
    if (state !== "answered_from_documents") {
      return;
    }
    const source = sources.get(index) ?? "";
    if (isDocumentSource(source)) {
      return;
    }
    const corrected: AnswerState = isProfileSource(source) ? "answered_from_profile" : "ai_draft_verify";
    violations.push({ index, state, source, corrected });
    states.set(index, corrected);
  });

  if (violations.length > 0) {
    const detail = violations
      .map((v) => `  Q${v.index + 1}: source="${v.source || "(none)"}" → ${v.corrected}`)
      .join("\n");
    const message =
      `PROVENANCE VIOLATION: ${violations.length} answer(s) claimed "answered from documents" ` +
      `without a document filename:\n${detail}`;
    if (options.throwOnViolation) {
      throw new Error(message);
    }
    console.error(`EasyFilla(provenance): ${message}`);
  }
  return violations;
}

export function stateDisplay(state: AnswerState): StateDisplay {
  return STATE_DISPLAY[state];
}

// "Couldn't reach AI" was shown for every failure class — including ones where
// the AI was reached and answered with a precise refusal (bad key, exhausted
// quota, overloaded, safety block). That mislabel sent debugging in the wrong
// direction. The AI answers are produced by ONE batched request, so every
// error_retry question in a run shares a cause; this sets the label for that run.
const ERROR_LABELS: Record<string, string> = {
  invalid_key: "AI auth error — check API key",
  daily_quota: "AI quota exhausted — resets later",
  rate_limit_minute: "AI rate limit — retry shortly",
  overloaded: "AI overloaded — retry shortly",
  bad_request: "AI rejected the request",
  timeout: "AI timed out — retry",
  network: "Couldn't reach AI (network)",
  blocked: "AI blocked this content",
  empty: "AI returned nothing usable",
  parse: "AI response unreadable — retry",
  server: "AI server error — retry",
};

const DEFAULT_ERROR_LABEL = "AI failed — retry";

export function setErrorRetryLabel(kind: string | null): void {
  const entry = STATE_DISPLAY.error_retry;
  entry.label = (kind && ERROR_LABELS[kind]) || DEFAULT_ERROR_LABEL;
}
