import { scanGenericPage, harvestOptionsForFill, type GenericQuestion } from "./detect";
import { setNativeValue, dispatchBlur } from "../../../lib/dom/native-value";
import { attachmentToFile } from "../../../lib/dom/file-transfer";
import { textSimilarity } from "../../../lib/text/fuzzy-match";
import type { FillableAnswer, FileAttachment, FillPayload } from "../../../types/questions";
import type { FillLogEntry, VisibleSectionFillResult } from "../adapter";
import { debugLog } from "../../../lib/debug";

const MATCH_THRESHOLD = 0.55;
const COMBOBOX_OPEN_DELAY_MS = 250;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns null if the file satisfies the input's accept filter, or a reason
// string if it doesn't. Only checks extension/MIME against accept — size
// limits aren't a standard <input> attribute, so those can't be validated
// client-side here.
function acceptViolation(input: HTMLInputElement, file: File): string | null {
  const accept = input.getAttribute("accept");
  if (!accept) {
    return null;
  }
  const tokens = accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  const ok = tokens.some((token) => {
    if (token.startsWith(".")) {
      return name.endsWith(token);
    }
    if (token.endsWith("/*")) {
      return mime.startsWith(token.slice(0, token.length - 1));
    }
    return mime === token;
  });
  return ok ? null : `file type not accepted (form allows: ${accept})`;
}

// Places a File onto a field. Prefers a real <input type=file> (construct a
// DataTransfer, assign to .files, fire input/change — the only mechanism
// frameworks observe). Falls back to a synthetic drop on the nearest
// dropzone-looking ancestor when there's no assignable input. Best-effort:
// some SPA upload widgets intercept neither path, in which case this reports
// failure rather than pretending success.
function attachFileToQuestion(question: GenericQuestion, file: File): string | null {
  const input = question.elements.find(
    (el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === "file",
  );

  if (input) {
    const violation = acceptViolation(input, file);
    if (violation) {
      return violation;
    }
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return null;
    } catch (error) {
      return `couldn't assign file to the input (${error instanceof Error ? error.message : "unknown"})`;
    }
  }

  // Dropzone fallback: dispatch a synthetic drop carrying the file.
  const zone = question.elements[0]?.closest<HTMLElement>('[class*="drop"], [data-testid*="drop"], [aria-label*="drop" i]');
  if (zone) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt } as DragEventInit;
      zone.dispatchEvent(new DragEvent("dragenter", opts));
      zone.dispatchEvent(new DragEvent("dragover", opts));
      zone.dispatchEvent(new DragEvent("drop", opts));
      return null;
    } catch (error) {
      return `dropzone attach failed (${error instanceof Error ? error.message : "unknown"})`;
    }
  }

  return "no reachable file input or dropzone for this field";
}

function labelOf(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label")?.trim() ||
    element.closest("label")?.textContent?.trim() ||
    element.textContent?.trim() ||
    ""
  );
}

function bestMatchIndex(labels: string[], target: string): number {
  let bestIndex = -1;
  let bestScore = MATCH_THRESHOLD;
  labels.forEach((label, index) => {
    const score = textSimilarity(label, target);
    if (score >= bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  return bestIndex;
}

function toDateInputValue(answer: string): string | null {
  const parsed = new Date(answer);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeInputValue(answer: string): string | null {
  const match = answer.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!match) {
    return null;
  }
  let hours = Number(match[1]);
  const minutes = match[2];
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) {
    hours += 12;
  }
  if (meridiem === "am" && hours === 12) {
    hours = 0;
  }
  if (hours > 23 || Number(minutes) > 59) {
    return null;
  }
  return `${String(hours).padStart(2, "0")}:${minutes}`;
}

function fillTextLike(element: HTMLElement, value: string): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setNativeValue(element, value);
    dispatchBlur(element);
    return true;
  }
  if (element.getAttribute("contenteditable") === "true" || element.getAttribute("role") === "textbox") {
    element.focus();
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    dispatchBlur(element);
    return true;
  }
  return false;
}

function fillNativeSelect(element: HTMLElement, answer: string): boolean {
  if (!(element instanceof HTMLSelectElement)) {
    return false;
  }
  const optionTexts = Array.from(element.options).map((option) => option.textContent?.trim() ?? "");
  const index = bestMatchIndex(optionTexts, answer);
  if (index === -1) {
    return false;
  }
  const option = element.options[index];
  if (!option) {
    return false;
  }
  setNativeValue(element, option.value);
  dispatchBlur(element);
  return true;
}

// Custom (div-based) dropdowns: open the control, wait for its options to
// render, then click the best-matching [role="option"]. Options are searched
// document-wide because portal-based UI libraries render them far from the
// trigger. Best-effort by nature.
async function fillCustomCombobox(element: HTMLElement, answer: string): Promise<boolean> {
  element.click();
  await wait(COMBOBOX_OPEN_DELAY_MS);

  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).filter(
    (option) => option.getClientRects().length > 0,
  );
  if (options.length === 0) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }

  const index = bestMatchIndex(
    options.map((option) => labelOf(option)),
    answer,
  );
  const target = index >= 0 ? options[index] : undefined;
  if (!target) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }
  target.click();
  return true;
}

function clickOption(element: HTMLElement): void {
  if (element instanceof HTMLInputElement) {
    // A real click on a native radio/checkbox fires the full event sequence
    // frameworks listen for.
    if (!element.checked || element.type === "radio") {
      element.click();
    }
    return;
  }
  if (element.getAttribute("aria-checked") !== "true") {
    element.click();
  }
}

function fillRadioGroup(question: GenericQuestion, answer: string): boolean {
  const index = bestMatchIndex(question.options, answer);
  const target = index >= 0 ? question.elements[index] : undefined;
  if (!target) {
    return false;
  }
  clickOption(target);
  return true;
}

function fillCheckboxGroup(question: GenericQuestion, answer: string): boolean {
  const tokens = answer
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter(Boolean);
  let matchedAny = false;
  tokens.forEach((token) => {
    const index = bestMatchIndex(question.options, token);
    const target = index >= 0 ? question.elements[index] : undefined;
    if (target) {
      matchedAny = true;
      clickOption(target);
    }
  });
  return matchedAny;
}

// Pairs approved answers with live fields.
//
// STAGE 2a — structural identity FIRST. The answers reaching this frame were
// routed here by frameId, so they belong to this document; when one carries
// the identity key it was scanned under (frameId + domPath + name/id +
// accessibleName), that key re-finds the exact field. Label-text similarity
// is the fallback for when the DOM moved between scan and fill — it cannot
// tell apart the "Employer" of row 1 from the "Employer" of row 4, which is
// exactly the case portals are made of.
// FIX 1 — how often the post-navigation label fallback fired this run. A high
// count means the fill loop is racing re-renders, which is a separate problem
// worth investigating (same signal as `orphanFallbacks()` in the Google path).
let labelFallbackCount = 0;
let labelRefusalCount = 0;

export function labelFallbackStats(): { fallbacks: number; refusals: number } {
  return { fallbacks: labelFallbackCount, refusals: labelRefusalCount };
}

// Test-only reset so each case in tests/fill-match.test.mjs starts from zero.
export function resetLabelFallbackStats(): void {
  labelFallbackCount = 0;
  labelRefusalCount = 0;
}

export interface MatchRefusal {
  answer: FillableAnswer;
  reason: string;
}

export interface AnswerMatchResult {
  matched: Map<GenericQuestion, FillableAnswer>;
  // Answers deliberately NOT filled, each with a reason. These become `failed`
  // rows in the fill report — never silent omissions.
  refusals: MatchRefusal[];
}

// Pairs approved answers with live fields.
//
// STAGE 2a — structural identity FIRST. The answers reaching this frame were
// routed here by frameId, so they belong to this document; when one carries
// the identity key it was scanned under (frameId + domPath + name/id +
// accessibleName), that key re-finds the exact field. Label-text similarity
// is the fallback for when the DOM moved between scan and fill — it cannot
// tell apart the "Employer" of row 1 from the "Employer" of row 4, which is
// exactly the case portals are made of.
//
// FIX 1 — that fallback now REFUSES rather than guessing. When an answer's
// identityKey was invalidated by a navigation (§3c), label similarity must
// produce EXACTLY ONE candidate above threshold. Zero candidates, or several,
// is an ambiguous re-match and the field is failed with a reason — the same
// stance `liveCard()` already takes on ambiguous card re-resolution. A blank
// beats a confidently wrong value on a real application.
export function matchAnswersToQuestions(
  questions: GenericQuestion[],
  answers: FillableAnswer[],
): AnswerMatchResult {
  const fillable = questions.filter(
    (question) => !question.manualOnly && question.fillKind !== "none" && question.fillKind !== "file",
  );

  const matched = new Map<GenericQuestion, FillableAnswer>();
  const used = new Set<FillableAnswer>();
  const refusals: MatchRefusal[] = [];

  const byIdentity = new Map<string, GenericQuestion>();
  fillable.forEach((question) => {
    const key = question.identity?.key;
    if (key && !byIdentity.has(key)) {
      byIdentity.set(key, question);
    }
  });

  answers.forEach((answer) => {
    if (!answer.answer.trim() || !answer.identityKey) {
      return;
    }
    const question = byIdentity.get(answer.identityKey);
    if (question && !matched.has(question)) {
      matched.set(question, answer);
      used.add(answer);
    }
  });

  // FIX 1 — the strict post-navigation path. Handled BEFORE the ordinary fuzzy
  // pass so an invalidated answer can never be quietly resolved by the greedy
  // scorer instead.
  const invalidated = answers.filter(
    (answer) => answer.identityInvalidated && answer.answer.trim() && !used.has(answer),
  );
  invalidated.forEach((answer) => {
    labelFallbackCount += 1;
    const above = fillable
      .filter((question) => !matched.has(question))
      .map((question) => ({ question, score: textSimilarity(question.questionText, answer.questionText) }))
      .filter((entry) => entry.score >= MATCH_THRESHOLD);

    if (above.length === 1) {
      const only = above[0];
      if (only) {
        matched.set(only.question, answer);
        used.add(answer);
        debugLog(
          `EasyFilla(fill): "${answer.questionText}" re-matched by label after a navigation ` +
            `(fallback #${labelFallbackCount}, score ${only.score.toFixed(2)}). Frequent fallbacks mean the ` +
            "fill loop is racing re-renders.",
        );
        return;
      }
    }

    labelRefusalCount += 1;
    used.add(answer); // consumed as a refusal; must not be re-considered below
    const reason =
      above.length === 0
        ? `ambiguous label re-match after navigation — no field on the current page resembles "${answer.questionText}" closely enough to be sure`
        : `ambiguous label re-match after navigation — ${above.length} fields resemble "${answer.questionText}" ` +
          `(${above.map((entry) => `"${entry.question.questionText}"`).join(", ")}) and structure can no longer tell them apart`;
    console.warn(
      `EasyFilla(fill): REFUSING to fill "${answer.questionText}" — ${reason}. ` +
        "Filling the wrong field is worse than leaving it blank.",
    );
    refusals.push({ answer, reason });
  });

  // Ordinary fuzzy pass for whatever identity didn't claim. Unchanged: this is
  // the pre-existing path for answers that never had a structural key, and its
  // greedy assignment is not in scope here.
  const candidates: { question: GenericQuestion; answer: FillableAnswer; score: number }[] = [];
  fillable.forEach((question) => {
    if (matched.has(question)) {
      return;
    }
    answers.forEach((answer) => {
      if (!answer.answer.trim() || used.has(answer)) {
        return;
      }
      const score = textSimilarity(question.questionText, answer.questionText);
      if (score >= MATCH_THRESHOLD) {
        candidates.push({ question, answer, score });
      }
    });
  });

  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach(({ question, answer }) => {
    if (matched.has(question) || used.has(answer)) {
      return;
    }
    matched.set(question, answer);
    used.add(answer);
  });
  return { matched, refusals };
}

function matchAttachmentToQuestion(
  question: GenericQuestion,
  attachments: FileAttachment[],
): FileAttachment | undefined {
  let best: FileAttachment | undefined;
  let bestScore = 0;
  for (const attachment of attachments) {
    const score = textSimilarity(question.questionText, attachment.questionText);
    if (score > bestScore) {
      bestScore = score;
      best = attachment;
    }
  }
  // Exact questionText pairing is expected (the sidepanel keys attachments by
  // the question they were approved for); the fuzzy score just guards against
  // whitespace/label drift between scan and fill.
  return bestScore >= 0.8 ? best : undefined;
}

// Fills the currently visible step only; stepping across wizard pages is
// orchestrated by the sidepanel. Never clicks anything that could submit —
// only field-level controls are touched.
export async function fillVisibleGenericSection(payload: FillPayload): Promise<VisibleSectionFillResult> {
  const { answers, fileAttachments } = payload;
  const { questions } = scanGenericPage();
  const { matched: matches, refusals } = matchAnswersToQuestions(questions, answers);

  const filledQuestions: string[] = [];
  const skippedQuestions: string[] = [];
  const consumedAnswers: string[] = [];
  const attachedFiles: string[] = [];
  const failedAttachments: { questionText: string; reason: string }[] = [];
  // STAGE 2a — a per-field log so a partial fill is loud. The frame layer
  // stamps frameId/frameUrl on every row, so "couldn't fill Country" always
  // says WHICH of the page's frames it happened in.
  const fillLog: FillLogEntry[] = [];

  for (const question of questions) {
    // File-upload questions: attach the approved document rather than typing.
    if (question.type === "file_upload") {
      const attachment = matchAttachmentToQuestion(question, fileAttachments);
      if (!attachment) {
        skippedQuestions.push(`${question.questionText} (no document chosen)`);
        fillLog.push({
          question: question.questionText,
          type: question.type,
          outcome: "skipped",
          reason: "no document chosen for this upload field",
        });
        continue;
      }
      const reason = attachFileToQuestion(question, attachmentToFile(attachment));
      if (reason) {
        failedAttachments.push({ questionText: question.questionText, reason });
        fillLog.push({ question: question.questionText, type: question.type, outcome: "failed", reason });
      } else {
        attachedFiles.push(question.questionText);
        fillLog.push({
          question: question.questionText,
          type: question.type,
          outcome: "filled",
          reason: `attached ${attachment.fileName}`,
        });
      }
      continue;
    }

    const match = matches.get(question);
    if (!match) {
      skippedQuestions.push(
        question.manualOnly ? `${question.questionText} (manual only)` : question.questionText,
      );
      fillLog.push({
        question: question.questionText,
        type: question.type,
        outcome: "skipped",
        reason: question.manualOnly
          ? `manual only — ${question.manualReason ?? "must be completed by a person"}`
          : "no approved answer matched this field",
      });
      continue;
    }

    const element = question.elements[0];

    // STAGE 2a — step 2 of the two-step reveal. The sidepanel has already
    // asked this frame's ancestors to scroll its <iframe> into view; now the
    // field itself is brought into view inside this frame. Widgets that only
    // react when visible (custom comboboxes especially) fail silently
    // otherwise, and a silent failure on an application form is the worst
    // outcome available.
    element?.scrollIntoView({ block: "center", inline: "nearest" });

    let success = false;

    switch (question.fillKind) {
      case "text":
      case "textarea":
      case "contenteditable":
        success = element ? fillTextLike(element, match.answer) : false;
        break;
      case "native-select":
        success = element ? fillNativeSelect(element, match.answer) : false;
        break;
      case "custom-combobox":
        // STAGE 2c — a field the scan's harvest budget deferred has its options
        // read now, on demand, with the more generous fill-time budget. This is
        // the other half of the budget bargain: the scan stays fast, and no
        // field is left unanswerable because of it.
        if (question.optionsPending) {
          const harvested = await harvestOptionsForFill(question);
          debugLog(
            `EasyFilla(harvest): read ${harvested.length} option(s) on demand for "${question.questionText}" ` +
              "(deferred by the scan's harvest budget).",
          );
        }
        success = element ? await fillCustomCombobox(element, match.answer) : false;
        break;
      case "radio-group":
        success = fillRadioGroup(question, match.answer);
        break;
      case "checkbox-group":
        success = fillCheckboxGroup(question, match.answer);
        break;
      case "date": {
        const formatted = toDateInputValue(match.answer);
        success = element && formatted ? fillTextLike(element, formatted) : false;
        break;
      }
      case "time": {
        const formatted = toTimeInputValue(match.answer);
        success = element && formatted ? fillTextLike(element, formatted) : false;
        break;
      }
      default:
        success = false;
    }

    if (success) {
      filledQuestions.push(question.questionText);
      consumedAnswers.push(match.questionText);
      fillLog.push({
        question: question.questionText,
        type: question.type,
        outcome: "filled",
        reason: `wrote via ${question.fillKind}`,
        intended: match.answer,
      });
    } else {
      skippedQuestions.push(`${question.questionText} (could not fill)`);
      fillLog.push({
        question: question.questionText,
        type: question.type,
        outcome: "failed",
        reason: `could not write this ${question.fillKind} control`,
        intended: match.answer,
      });
    }
  }

  // FIX 1 — refused answers are FAILED rows, not omissions. An answer that was
  // approved and then quietly never written is the exact silent-partial-fill
  // bug this whole log exists to prevent.
  refusals.forEach(({ answer, reason }) => {
    skippedQuestions.push(`${answer.questionText} (ambiguous label re-match)`);
    fillLog.push({
      question: answer.questionText,
      type: answer.type,
      outcome: "failed",
      reason,
      intended: answer.answer,
    });
  });

  const stats = labelFallbackStats();
  if (stats.fallbacks > 0) {
    console.log(
      `EasyFilla(fill): post-navigation label fallback fired ${stats.fallbacks} time(s) this run, ` +
        `${stats.refusals} of which were REFUSED as ambiguous. A high fallback count means the fill loop is ` +
        "racing re-renders — investigate that rather than loosening the threshold.",
    );
  }

  return {
    filledQuestions,
    skippedQuestions,
    consumedAnswers,
    attachedFiles,
    failedAttachments,
    fillLog,
    labelFallbacks: stats.fallbacks,
    labelRefusals: stats.refusals,
  };
}

// Scrolls a question into view by its resolved label (used by the shared
// manual-attach pause). Returns whether it was found on the current step.
export function scrollToGenericQuestion(questionText: string): boolean {
  const { questions } = scanGenericPage();
  let best: GenericQuestion | undefined;
  let bestScore = 0.7;
  for (const question of questions) {
    const score = textSimilarity(question.questionText, questionText);
    if (score > bestScore) {
      bestScore = score;
      best = question;
    }
  }
  const target = best?.elements[0];
  if (!target) {
    return false;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}
