// Enforces "answers come solely from the uploaded files" in CODE, not just in
// the prompt. A model instruction is a request; this is a check.
//
// Scope is deliberate. We can only verify values that SHOULD appear verbatim
// in the documents:
//   - short factual values (name, email, phone, ID, employer, institution…)
// We deliberately do NOT check:
//   - choice/dropdown answers — these are the FORM's option strings and
//     legitimately never appear in a CV
//   - paragraphs/essays — legitimate paraphrase; these carry their own
//     provenance and are always review-required anyway

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tokens too generic to prove grounding on their own.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "was", "are", "not", "yes", "no", "n/a", "na", "none",
]);

export interface GroundingResult {
  grounded: boolean;
  reason: string;
}

// Is `value` actually supported by the uploaded document text?
export function isGroundedInDocuments(value: string, documentCorpus: string): GroundingResult {
  const needle = normalize(value);
  if (!needle) {
    return { grounded: false, reason: "empty value" };
  }
  const haystack = normalize(documentCorpus);
  if (!haystack) {
    return { grounded: false, reason: "no document text available to verify against" };
  }

  // Whole-value match is the strongest signal.
  if (haystack.includes(needle)) {
    return { grounded: true, reason: "value appears verbatim in your documents" };
  }

  // Otherwise require the distinctive tokens to be present. Digit runs
  // (IDs, phone numbers, years) are compared with separators stripped, since
  // formatting differs between a document and a form field.
  const digitsOnly = value.replace(/\D/g, "");
  if (digitsOnly.length >= 5 && documentCorpus.replace(/\D/g, "").includes(digitsOnly)) {
    return { grounded: true, reason: "digits match your documents (formatting differs)" };
  }

  const tokens = needle.split(" ").filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (tokens.length === 0) {
    // Nothing distinctive to verify (e.g. "yes") — don't claim it's ungrounded.
    return { grounded: true, reason: "no distinctive tokens to verify" };
  }
  const present = tokens.filter((token) => haystack.includes(token));
  if (present.length === tokens.length) {
    return { grounded: true, reason: "all significant terms appear in your documents" };
  }

  const missing = tokens.filter((token) => !haystack.includes(token));
  return {
    grounded: false,
    reason: `not found in your documents (missing: ${missing.slice(0, 4).join(", ")})`,
  };
}
