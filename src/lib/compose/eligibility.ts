import type { ExtractedQuestion } from "../../types/questions";

// Words that signal an open-ended prompt worth composing prose for.
const OPEN_ENDED_HINTS = [
  "describe",
  "explain",
  "why",
  "motivation",
  "objective",
  "experience",
  "tell us",
  "about yourself",
  "goals",
  "statement",
  "essay",
  "reason",
  "background",
  "achievement",
  "strength",
  "challenge",
  "contribution",
  "plan",
  "elaborate",
  "discuss",
];

// Words that signal a discrete value that must NOT be free-composed, even on
// a short-answer field (an ID number is not an essay prompt).
const DISCRETE_HINTS = [
  "id number",
  "id no",
  "identification",
  "passport",
  "phone",
  "mobile",
  "email",
  "e-mail",
  "date of birth",
  "dob",
  "zip",
  "postal",
  "postcode",
  "ssn",
  "tax",
  "account number",
  "url",
  "website",
  "first name",
  "last name",
  "full name",
];

function normalize(text: string): string {
  return text.toLowerCase();
}

// Composition (Feature 3) applies to paragraph questions unconditionally, and
// to short-answer questions whose label reads as open-ended prose rather than
// a discrete value. Never to choice/date/file/grid questions, and never to
// manual-only fields.
export function isComposable(question: Pick<ExtractedQuestion, "type" | "questionText" | "manualOnly">): boolean {
  if (question.manualOnly) {
    return false;
  }
  if (question.type === "paragraph") {
    return true;
  }
  if (question.type !== "short_answer") {
    return false;
  }

  const label = normalize(question.questionText);
  if (DISCRETE_HINTS.some((hint) => label.includes(hint))) {
    return false;
  }
  return OPEN_ENDED_HINTS.some((hint) => label.includes(hint));
}
