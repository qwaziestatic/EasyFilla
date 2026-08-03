// ─────────────────────────────────────────────────────────────────────────
// CROSS-PROVIDER OUTPUT PARITY (TASK E2, requirement 5)
//
// ONE validator. Stage A must return the same dossier shape and Stage B the
// same answer objects on BOTH providers — otherwise the provenance state
// machine (§3) would have to know which vendor ran, and the moment it does,
// every guarantee in §3 becomes provider-specific.
//
// ── WHY THIS IS THE PARITY POINT AND NOT THE WIRE FORMAT ────────────────
// The two providers differ everywhere below this line: `response_format` vs
// `output_config.format`, uppercase vs lowercase schema types, inline data vs
// image/document blocks. None of that matters upstream. What matters is that
// the PARSED OBJECT is identical in shape, because that object is what §3
// derives provenance from.
//
// The `evidence` array is the load-bearing part. §3:
//   · non-empty with real filenames → answered_from_documents
//   · EMPTY                          → needs_user_input, for ALL question types
//   · several files, same value      → corroboration
//   · several files, different values→ conflicting_sources
// `implied_value` exists because snippets are prose and cannot be compared;
// `assessEvidenceAgreement()` reads it directly. A provider that omitted it
// would silently collapse corroboration and conflict into one another.
// ─────────────────────────────────────────────────────────────────────────

export interface ParityIssue {
  path: string;
  problem: string;
}

export interface ParityResult {
  ok: boolean;
  issues: ParityIssue[];
}

function fail(issues: ParityIssue[], path: string, problem: string): void {
  issues.push({ path, problem });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Stage B: one answer object ───────────────────────────────────────────
// Every field §3 reads must be present and of the right type on both
// providers. `snippet` may be EMPTY (§3 permits that for choice questions) but
// must be PRESENT — empty and absent are different, and only one of them is
// allowed.
export function validateEvidenceEntry(entry: unknown, path: string, issues: ParityIssue[]): void {
  if (!isPlainObject(entry)) {
    fail(issues, path, "evidence entry is not an object");
    return;
  }
  for (const field of ["dossier_path", "source_filename", "snippet", "implied_value"] as const) {
    if (!(field in entry)) {
      fail(
        issues,
        `${path}.${field}`,
        field === "snippet"
          ? "missing — §3 allows an EMPTY snippet on choice questions, but never an absent one"
          : field === "implied_value"
            ? "missing — assessEvidenceAgreement() compares implied_value, not snippets; " +
              "without it corroboration and conflict cannot be told apart (§3)"
            : "missing",
      );
      continue;
    }
    if (typeof entry[field] !== "string") {
      fail(issues, `${path}.${field}`, `expected a string, got ${typeof entry[field]}`);
    }
  }
}

export function validateAnswerObject(answer: unknown, path: string, issues: ParityIssue[]): void {
  if (!isPlainObject(answer)) {
    fail(issues, path, "answer is not an object");
    return;
  }
  if (typeof answer.question_id !== "number") {
    fail(issues, `${path}.question_id`, `expected a number, got ${typeof answer.question_id}`);
  }
  if (typeof answer.value !== "string") {
    fail(issues, `${path}.value`, `expected a string, got ${typeof answer.value}`);
  }
  // THE CRITICAL ONE. `evidence` must be an ARRAY on both providers, and an
  // EMPTY array is a valid, expected outcome (§3) — not an error, and not
  // something a provider may omit or null out. `needs_user_input` is derived
  // from emptiness, so a missing array and an empty array must not be conflated.
  if (!Array.isArray(answer.evidence)) {
    fail(
      issues,
      `${path}.evidence`,
      "expected an array. An EMPTY array is correct and expected (§3 derives needs_user_input from it); " +
        "omitting the field entirely is not.",
    );
    return;
  }
  answer.evidence.forEach((entry, index) => {
    validateEvidenceEntry(entry, `${path}.evidence[${index}]`, issues);
  });
}

export function validateStageBOutput(parsed: unknown): ParityResult {
  const issues: ParityIssue[] = [];
  const answers = isPlainObject(parsed) ? parsed.answers : parsed;
  if (!Array.isArray(answers)) {
    fail(issues, "answers", "expected an array of answer objects");
    return { ok: false, issues };
  }
  answers.forEach((answer, index) => validateAnswerObject(answer, `answers[${index}]`, issues));
  return { ok: issues.length === 0, issues };
}

// ── Stage A: the dossier ─────────────────────────────────────────────────
// Every scalar carries `source_filename` + `confidence` (§2). Provenance
// downstream depends on the filename being a real filename — §3's
// `isDocumentSource()` requires an extension — so a provider that returned a
// bare label here would produce answers that look attributed but are not.
export function validateDossierScalar(node: unknown, path: string, issues: ParityIssue[]): void {
  if (!isPlainObject(node)) {
    fail(issues, path, "dossier scalar is not an object");
    return;
  }
  if (!("value" in node)) {
    fail(issues, `${path}.value`, "missing");
  }
  if (typeof node.source_filename !== "string") {
    fail(issues, `${path}.source_filename`, `expected a string, got ${typeof node.source_filename}`);
  }
  if (typeof node.confidence !== "string") {
    fail(issues, `${path}.confidence`, `expected a string, got ${typeof node.confidence}`);
  }
}

export function validateStageAOutput(parsed: unknown): ParityResult {
  const issues: ParityIssue[] = [];
  if (!isPlainObject(parsed)) {
    fail(issues, "#", "dossier is not an object");
    return { ok: false, issues };
  }

  // Walk every leaf that looks like a dossier scalar (has `value`), wherever
  // it sits. The dossier's shape evolves; what must not change is that every
  // scalar it contains carries its provenance with it.
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) {
      return;
    }
    if ("value" in node) {
      validateDossierScalar(node, path, issues);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, path === "#" ? key : `${path}.${key}`);
    }
  };
  walk(parsed, "#");

  return { ok: issues.length === 0, issues };
}

/**
 * Asserts two providers produced structurally equivalent output.
 *
 * Compares SHAPE, never content: two providers will legitimately word an
 * answer differently, and requiring identical text would be a test that can
 * only be satisfied by luck.
 */
export function assertShapeParity(a: unknown, b: unknown, path = "#"): ParityIssue[] {
  const issues: ParityIssue[] = [];

  const shapeOf = (value: unknown): string =>
    Array.isArray(value) ? "array" : value === null ? "null" : typeof value;

  const walk = (left: unknown, right: unknown, at: string): void => {
    if (shapeOf(left) !== shapeOf(right)) {
      fail(issues, at, `shape differs: ${shapeOf(left)} vs ${shapeOf(right)}`);
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      // Length may legitimately differ (different numbers of evidence
      // entries); element SHAPE may not.
      const sample = Math.min(left.length, right.length);
      for (let index = 0; index < sample; index += 1) {
        walk(left[index], right[index], `${at}[${index}]`);
      }
      return;
    }
    if (isPlainObject(left) && isPlainObject(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        if (!(key in left)) {
          fail(issues, `${at}.${key}`, "present on one provider only");
          continue;
        }
        if (!(key in right)) {
          fail(issues, `${at}.${key}`, "present on one provider only");
          continue;
        }
        walk(left[key], right[key], `${at}.${key}`);
      }
    }
  };

  walk(a, b, path);
  return issues;
}
