import type { ExtractedQuestion, QuestionType } from "../../types/questions";
import { SELECTORS } from "./selectors";

function getOptionLabel(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) {
    return ariaLabel;
  }
  return element.textContent?.trim() ?? "";
}

// A dropdown's leading "Choose"/"Select…" entry is a placeholder, not an
// answer. Kept deliberately small and multilingual-lite; anything that is
// only punctuation is also treated as a placeholder.
const PLACEHOLDER_OPTION_RE =
  /^(choose|select|select an option|select one|please select|pick one|--+|—+|none|scegli|seleziona|elegir|seleccione|choisir|sélectionner|auswählen|bitte wählen|اختر|ይምረጡ|请选择|選擇)$/i;

export function isPlaceholderOption(option: string): boolean {
  const normalized = option.trim();
  if (!normalized) {
    return true;
  }
  if (/^[\s\p{P}\p{S}]+$/u.test(normalized)) {
    return true;
  }
  return PLACEHOLDER_OPTION_RE.test(normalized);
}

function extractOptions(elements: NodeListOf<Element>): string[] {
  const labels: string[] = [];
  elements.forEach((element) => {
    const label = getOptionLabel(element);
    if (label) {
      labels.push(label);
    }
  });
  return labels;
}

// Best-effort: Google Forms doesn't publish its exact grid markup, so this
// assumes a fairly standard ARIA table/grid pattern (role="row" with a
// role="rowheader" cell for the row label, role="columnheader" cells for
// the shared column labels). If that assumption is wrong for the live
// version of Forms, this degrades to empty rows/columns rather than
// throwing — the question is still correctly typed as a grid, just without
// its row/column detail.
function extractGridStructure(table: Element): { rows: string[]; columns: string[] } {
  const columns = extractOptions(table.querySelectorAll(SELECTORS.columnHeader));

  const rows: string[] = [];
  table.querySelectorAll(SELECTORS.row).forEach((row) => {
    const rowHeader = row.querySelector(SELECTORS.rowHeader);
    const label = rowHeader ? getOptionLabel(rowHeader) : "";
    if (label) {
      rows.push(label);
    }
  });

  return { rows, columns };
}

// Order matters: widgets are checked from most to least specific so a
// composite widget (e.g. a dropdown's hidden filter input) isn't
// misclassified by a later, more generic check (e.g. short_answer).
function classifyQuestion(listitem: Element): { type: QuestionType; options: string[]; rows?: string[] } {
  const table = listitem.querySelector(SELECTORS.table);
  if (table) {
    const isCheckboxGrid = table.querySelector(SELECTORS.checkboxOption) !== null;
    const { rows, columns } = extractGridStructure(table);
    return { type: isCheckboxGrid ? "checkbox_grid" : "multiple_choice_grid", options: columns, rows };
  }
  if (listitem.querySelector(SELECTORS.fileInput)) {
    return { type: "file_upload", options: [] };
  }
  if (listitem.querySelector(SELECTORS.dateInput)) {
    return { type: "date", options: [] };
  }
  if (listitem.querySelector(SELECTORS.timeInput)) {
    return { type: "time", options: [] };
  }
  if (listitem.querySelector(SELECTORS.textarea)) {
    return { type: "paragraph", options: [] };
  }

  const radios = listitem.querySelectorAll(SELECTORS.radioOption);
  if (radios.length > 0) {
    const labels = extractOptions(radios);
    const isLinearScale = labels.length > 0 && labels.every((label) => /^\d+$/.test(label));
    return { type: isLinearScale ? "linear_scale" : "multiple_choice", options: labels };
  }

  const checkboxes = listitem.querySelectorAll(SELECTORS.checkboxOption);
  if (checkboxes.length > 0) {
    return { type: "checkboxes", options: extractOptions(checkboxes) };
  }

  const listboxOptions = listitem.querySelectorAll(SELECTORS.listboxOption);
  if (listboxOptions.length > 0) {
    // Google Forms renders a leading placeholder option ("Choose") inside the
    // listbox. It is NOT a selectable answer — leaving it in meant the model
    // could "answer" a dropdown with "Choose", and it polluted option
    // matching during fill.
    const all = extractOptions(listboxOptions);
    const real = all.filter((option) => !isPlaceholderOption(option));
    if (real.length === 0 && all.length > 0) {
      console.log(
        `EasyFilla(extract): dropdown has only placeholder option(s) [${all.join(" | ")}] — ` +
          "real options likely render on open; they'll be read during fill.",
      );
    }
    return { type: "dropdown", options: real };
  }

  if (listitem.querySelector(SELECTORS.textInput)) {
    return { type: "short_answer", options: [] };
  }

  return { type: "unknown", options: [] };
}

// FIX 7.1: read the heading label robustly. textContent concatenates all
// descendant text nodes, but Google Forms splits a title across inline spans
// and its whitespace can be an NBSP or be missing between adjacent spans,
// producing "Studyor"/"PrimarField". We (a) normalize NBSP/whitespace, and
// (b) when the heading has multiple element children, join their trimmed
// texts with single spaces so a missing inter-span space is restored without
// over-inserting spaces inside a single text run. Raw bytes are logged so a
// live run can confirm the source against the DOM.
function readHeadingLabel(heading: Element): string {
  const direct = (heading.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

  const elementChildren = Array.from(heading.children);
  if (elementChildren.length > 1) {
    const joined = elementChildren
      .map((child) => (child.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    void joined; // span-join removed (FIX 6): it could insert a space mid-word
  }

  // FIX 6: textContent (in `direct`) concatenates every descendant text node
  // in order — it can neither drop nor insert a character. Diagnostic: if
  // collapsing whitespace changed the non-space characters, something is
  // genuinely wrong at the DOM level — surface it rather than hide it.
  const rawForCheck = heading.textContent ?? "";
  if (rawForCheck.replace(/\s+/g, "") !== direct.replace(/\s+/g, "")) {
    console.warn(
      `EasyFilla(label): non-whitespace mismatch — raw="${rawForCheck}" resolved="${direct}". ` +
        "Inspect this heading node.",
    );
  }
  return direct;
}

function extractQuestionText(listitem: Element): { questionText: string; required: boolean } {
  const heading = listitem.querySelector(SELECTORS.heading);
  const rawText = heading ? readHeadingLabel(heading) : "";
  const hasRequiredMarker = Boolean(listitem.querySelector(SELECTORS.requiredMarker));
  const endsWithAsterisk = /\*\s*$/.test(rawText);

  return {
    questionText: rawText.replace(/\*\s*$/, "").trim(),
    required: hasRequiredMarker || endsWithAsterisk,
  };
}

// Google's placeholder titles carry no information and collide across
// sections — treat them as "no title" so the PDF falls back to "Section N".
function isPlaceholderTitle(title: string): boolean {
  return /^untitled (section|form|question)$/i.test(title.trim());
}

export interface QuestionElement extends ExtractedQuestion {
  listitem: Element;
}

export interface SectionInfo {
  // The section's own title/description text, if this section has a
  // listitem that's purely a heading with no answer widget (Google Forms
  // renders section titles as their own listitem, indistinguishable from a
  // question by heading text alone — only the absence of any interactive
  // control tells them apart). Used as the PDF's section heading instead of
  // a generic "Section N" when available.
  title: string | null;
  questions: QuestionElement[];
}

// The element-carrying variant, for callers (the form filler) that need to
// act on the live DOM node, not just read its data. extractQuestions() below
// is a thin projection of this so scanning and filling never classify a
// question two different ways.
export function getSectionInfo(): SectionInfo {
  const listitems = document.querySelectorAll(SELECTORS.questionItem);
  const questions: QuestionElement[] = [];
  let title: string | null = null;

  listitems.forEach((listitem) => {
    const { questionText, required } = extractQuestionText(listitem);
    if (!questionText) {
      // No heading text at all — not a question, not a title either
      // (typically a bare page-break control).
      return;
    }

    const classification = classifyQuestion(listitem);
    const isRealQuestion =
      classification.type !== "unknown" || listitem.querySelector(SELECTORS.interactive) !== null;

    if (!isRealQuestion) {
      // A heading with no answer widget at all: this is the section's own
      // title/description block, not a question. Keep the first non-
      // placeholder one as the section title candidate (FIX 7.2).
      if (title === null && !isPlaceholderTitle(questionText)) {
        title = questionText;
      }
      return;
    }

    const question: QuestionElement = {
      listitem,
      questionText,
      type: classification.type,
      options: classification.options,
      required,
    };
    if (classification.rows) {
      question.rows = classification.rows;
    }
    if (classification.type === "file_upload") {
      // Google Forms file uploads route through a cross-origin Drive picker
      // iframe that a content script cannot drive. Mark for guided MANUAL
      // attachment; parse the "Max N files, X MB, types" hint text if shown.
      question.attachmentMode = "manual";
      question.manualReason = "Google Drive upload — attach by hand";
      // ⚠️ manual_only, ALONGSIDE PASSWORDS AND CAPTCHAS — and permanently.
      // Google Forms file questions open a cross-origin Drive picker and attach
      // from the user's DRIVE. Our documents live in extension storage. There is
      // no <input type="file"> to populate and no way to inject a local file
      // into that picker, so this is a HARD limit, not unfinished work.
      // Marking it here makes every downstream request filter (they all test
      // `manualOnly`) exclude it structurally, rather than by a per-call-site
      // type check that a future path could forget.
      question.manualOnly = true;
      const text = listitem.textContent ?? "";
      const maxFilesMatch = text.match(/(\d+)\s+file/i);
      const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(MB|GB|KB)/i);
      const constraints: NonNullable<ExtractedQuestion["fileConstraints"]> = { accept: null, multiple: false };
      if (maxFilesMatch?.[1]) {
        constraints.maxFiles = Number(maxFilesMatch[1]);
        constraints.multiple = Number(maxFilesMatch[1]) > 1;
      }
      if (sizeMatch?.[0]) {
        constraints.sizeLimitText = sizeMatch[0];
      }
      question.fileConstraints = constraints;
    }
    questions.push(question);
  });

  return { title, questions };
}

export function getQuestionElements(): QuestionElement[] {
  return getSectionInfo().questions;
}

export function extractQuestions(): ExtractedQuestion[] {
  return getQuestionElements().map(({ listitem: _listitem, ...question }) => question);
}
