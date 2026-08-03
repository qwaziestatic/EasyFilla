import { jsPDF } from "jspdf";
import type { ExtractedQuestionWithSection, QuestionType } from "../../types/questions";
import { applyBestFont } from "./font-support";
import { STATE_DISPLAY, type AnswerState } from "../answer-state";

const MARGIN_MM = 12;
const BOX_PADDING_MM = 4;
const BOX_GAP_MM = 8;
const CONTENT_GAP_MM = 2.5;
// FIX 7.3: a defensive trailing pad inside every box. The reserve/draw math
// is internally consistent, but the embedded multilingual font's real line
// metrics differ from the Helvetica-tuned line-height constants; over a long
// option list that drift can let the next question's number touch the last
// option ("Telegram6."). This pad absorbs the drift so boxes never collide.
const BOX_TRAILING_PAD_MM = 2.5;

const TITLE_FONT_SIZE_PT = 11;
const TITLE_LINE_HEIGHT_MM = 5.2;
const META_FONT_SIZE_PT = 8.5;
const META_LINE_HEIGHT_MM = 4.2;
const OPTION_FONT_SIZE_PT = 9.5;
const OPTION_LINE_HEIGHT_MM = 4.8;
const OPTION_INDENT_MM = 6;
const GLYPH_SIZE_MM = 3;

const SHORT_ANSWER_BOX_HEIGHT_MM = 10;
const PARAGRAPH_ANSWER_BOX_HEIGHT_MM = 22;
const PLACEHOLDER_HEIGHT_MM = META_LINE_HEIGHT_MM;
const ANSWER_BOX_INSET_MM = 2;

const DOC_TITLE_FONT_SIZE_PT = 16;
const DOC_TITLE_HEIGHT_MM = 10;
const LOGO_SIZE_MM = 9; // ~28px header logo, top-left of page 1
const LOGO_GAP_MM = 3;
const SECTION_HEADING_FONT_SIZE_PT = 12;
const SECTION_HEADING_HEIGHT_MM = 9;

const PILL_FONT_SIZE_PT = 7;
const PILL_HEIGHT_MM = 4.6;
const PILL_PADDING_X_MM = 2;
const PILL_RESERVED_WIDTH_MM = 34;

const PURPLE_BORDER: [number, number, number] = [109, 40, 217];
const PURPLE_FILL: [number, number, number] = [245, 243, 255];
const TEXT_COLOR: [number, number, number] = [31, 23, 43];
const META_COLOR: [number, number, number] = [107, 91, 149];
const ANSWER_BOX_BORDER: [number, number, number] = [200, 196, 214];
const ANSWERED_COLOR: [number, number, number] = [22, 163, 74];
const NEEDS_REVIEW_COLOR: [number, number, number] = [180, 120, 8];
const ERROR_COLOR: [number, number, number] = [190, 60, 60];

const NEEDS_INPUT_TEXT = "Not in your documents — needs your input";
// FIX 3.2: an ERROR_RETRY body must NEVER imply the documents lack the answer.
const ERROR_RETRY_TEXT =
  "The AI couldn't be reached for this question, so the answer is unknown — regenerate the report to retry. This is NOT a statement that your documents lack the answer.";

const SINGLE_SELECT_TYPES: ReadonlySet<QuestionType> = new Set(["multiple_choice", "dropdown", "linear_scale"]);
const GRID_TYPES: ReadonlySet<QuestionType> = new Set(["multiple_choice_grid", "checkbox_grid"]);

// The four distinct answer states (3.5), replacing the old catch-all
// "unanswered" that mislabeled factual gaps as "Personal/Subjective":
//   answered        — sourced from the documents
//   suggested       — AI draft, needs verification
//   not-in-docs     — a FACTUAL field simply absent from the documents
//   personal        — inherently only the user can answer
// "not-ai" = plain export mode, no AI involved (no pill).
type AnswerStatus = "not-ai" | "answered" | "suggested" | "not-in-docs" | "conflict" | "from-profile" | "error" | "file-ready" | "file-needed";

// How the sidepanel tells the generator which of the two blank states a
// question is in (from Gemini's `category`). Absent → defaults to
// not-in-docs, the safer "needs input" framing.
export type UnansweredKind = "not_in_documents" | "personal";

interface ResolvedAnswer {
  status: AnswerStatus;
  text: string;
}

// FIX 3.1: the explicit taxonomy state is the SINGLE source of truth. When a
// state is present, both the pill and the body text derive from it here — no
// other code path decides. Falls back to answer/suggestion presence only in
// plain Export mode (no states passed).
function resolveAnswer(
  questionIndex: number,
  answers?: ReadonlyMap<number, string>,
  suggestions?: ReadonlyMap<number, string>,
  states?: ReadonlyMap<number, AnswerState>,
): ResolvedAnswer {
  if (!answers && !suggestions && !states) {
    return { status: "not-ai", text: "" };
  }

  const state = states?.get(questionIndex);
  if (state === "conflicting_sources") {
    // Both candidates live in the source line; NEITHER is presented as the
    // answer. Q1 (Kquinn vs Quinn) is the regression test for this path.
    return { status: "conflict", text: "" };
  }
  if (state === "answered_from_profile") {
    return { status: "from-profile", text: answers?.get(questionIndex)?.trim() ?? "" };
  }
  if (state === "ai_draft_verify") {
    return { status: "suggested", text: (suggestions?.get(questionIndex) ?? answers?.get(questionIndex) ?? "").trim() };
  }
  if (state === "needs_user_input") {
    return { status: "not-in-docs", text: "" };
  }
  if (state === "error_retry") {
    return { status: "error", text: "" };
  }
  if (state === "ready_to_attach") {
    return { status: "file-ready", text: "" };
  }
  if (state === "needs_file") {
    return { status: "file-needed", text: "" };
  }

  const confirmed = answers?.get(questionIndex)?.trim();
  if (confirmed) {
    return { status: "answered", text: confirmed };
  }

  const suggested = suggestions?.get(questionIndex)?.trim();
  if (suggested) {
    return { status: "suggested", text: suggested };
  }

  return { status: "not-in-docs", text: "" };
}

function typeLabel(type: QuestionType): string {
  switch (type) {
    case "short_answer":
      return "Short answer";
    case "paragraph":
      return "Paragraph";
    case "multiple_choice":
      return "Multiple choice";
    case "checkboxes":
      return "Checkboxes";
    case "dropdown":
      return "Dropdown";
    case "linear_scale":
      return "Linear scale";
    case "date":
      return "Date";
    case "time":
      return "Time";
    case "multiple_choice_grid":
      return "Multiple choice grid";
    case "checkbox_grid":
      return "Checkbox grid";
    case "file_upload":
      return "File upload";
    default:
      return "Unknown field";
  }
}

function placeholderText(type: QuestionType): string {
  switch (type) {
    case "date":
      return "Expected answer: a date";
    case "time":
      return "Expected answer: a time";
    case "file_upload":
      return "File upload — attach the file directly in the form.";
    default:
      return "Unrecognized field type.";
  }
}

// Status is conveyed with a colored text pill (like the sidepanel's badge
// chips), never a checkbox/checkmark/cross glyph.
function drawStatusPill(doc: jsPDF, text: string, color: [number, number, number], rightEdgeX: number, centerY: number): void {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(PILL_FONT_SIZE_PT);
  const textWidthMm = doc.getTextWidth(text);
  const pillWidthMm = textWidthMm + PILL_PADDING_X_MM * 2;
  const pillX = rightEdgeX - pillWidthMm;
  const pillY = centerY - PILL_HEIGHT_MM / 2;

  doc.setDrawColor(...color);
  doc.setFillColor(255, 255, 255);
  doc.setLineWidth(0.3);
  doc.roundedRect(pillX, pillY, pillWidthMm, PILL_HEIGHT_MM, PILL_HEIGHT_MM / 2, PILL_HEIGHT_MM / 2, "FD");

  doc.setTextColor(...color);
  doc.text(text, pillX + pillWidthMm / 2, pillY + PILL_HEIGHT_MM / 2 + 1, { align: "center" });
}

function statusPillLabel(status: AnswerStatus): { text: string; color: [number, number, number] } | null {
  switch (status) {
    case "answered":
      return { text: "Answered from documents", color: ANSWERED_COLOR };
    case "suggested":
      return { text: "AI draft — verify", color: NEEDS_REVIEW_COLOR };
    case "not-in-docs":
      return { text: "Needs your input", color: NEEDS_REVIEW_COLOR };
    case "conflict":
      return { text: STATE_DISPLAY.conflicting_sources.label, color: NEEDS_REVIEW_COLOR };
    case "from-profile":
      return { text: STATE_DISPLAY.answered_from_profile.label, color: ANSWERED_COLOR };
    case "error":
      // Reads the live label so the PDF states the real cause (auth / quota /
      // overload / timeout), matching the sidepanel rather than contradicting it.
      return { text: STATE_DISPLAY.error_retry.label, color: ERROR_COLOR };
    case "file-ready":
      return { text: "Ready to attach", color: ANSWERED_COLOR };
    case "file-needed":
      return { text: "Needs a file", color: NEEDS_REVIEW_COLOR };
    default:
      return null;
  }
}

// Blank states show a note instead of an answer. ERROR is distinct from
// not-in-docs: its note must never imply the documents lack the answer.
function isBlankState(status: AnswerStatus): boolean {
  return status === "not-in-docs" || status === "error" || status === "file-ready" || status === "file-needed";
}

function blankNoteFor(status: AnswerStatus): string {
  switch (status) {
    case "error":
      return ERROR_RETRY_TEXT;
    case "file-ready":
      return "A matching document was found — attach the recommended file below during Continue and Fill.";
    case "file-needed":
      return "No matching document uploaded yet — upload one, then attach it here.";
    default:
      return NEEDS_INPUT_TEXT;
  }
}

interface QuestionLayout {
  titleLines: string[];
  metaLines: string[];
  optionLines: string[][];
  matchedOptionIndexes: Set<number>;
  unmatchedAnswerLines: string[];
  freeTextAnswerLines: string[];
  placeholderAnswerLines: string[];
  gridLines: string[];
  totalHeightMm: number;
}

function layoutQuestion(
  doc: jsPDF,
  question: ExtractedQuestionWithSection,
  displayIndex: number,
  contentWidthMm: number,
  resolved: ResolvedAnswer,
  extraNote?: string,
): QuestionLayout {
  const isGrid = GRID_TYPES.has(question.type);
  const isAiMode = resolved.status !== "not-ai" && !isGrid && !question.manualOnly;
  const hasContent = resolved.status === "answered" || resolved.status === "suggested";
  const titleWrapWidthMm =
    isAiMode || question.manualOnly ? contentWidthMm - PILL_RESERVED_WIDTH_MM : contentWidthMm;

  if (question.manualOnly) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(TITLE_FONT_SIZE_PT);
    const manualTitleLines = doc.splitTextToSize(
      `${displayIndex}. ${question.questionText}${question.required ? "  *" : ""}`,
      titleWrapWidthMm,
    ) as string[];

    doc.setFont("helvetica", "italic");
    doc.setFontSize(META_FONT_SIZE_PT);
    const manualMetaLines = doc.splitTextToSize(
      `${typeLabel(question.type)}${question.required ? " · Required" : ""}`,
      contentWidthMm,
    ) as string[];

    doc.setFont("helvetica", "italic");
    doc.setFontSize(OPTION_FONT_SIZE_PT);
    const reason = question.manualReason ? ` (${question.manualReason})` : "";
    const manualBodyLines = doc.splitTextToSize(
      `Manual only${reason} — fill this directly on the page. Never auto-filled, never sent to the AI.`,
      contentWidthMm,
    ) as string[];

    return {
      titleLines: manualTitleLines,
      metaLines: manualMetaLines,
      optionLines: [],
      matchedOptionIndexes: new Set(),
      unmatchedAnswerLines: [],
      freeTextAnswerLines: [],
      placeholderAnswerLines: manualBodyLines,
      gridLines: [],
      totalHeightMm:
        BOX_PADDING_MM * 2 +
        manualTitleLines.length * TITLE_LINE_HEIGHT_MM +
        CONTENT_GAP_MM +
        manualMetaLines.length * META_LINE_HEIGHT_MM +
        CONTENT_GAP_MM +
        manualBodyLines.length * OPTION_LINE_HEIGHT_MM +
        BOX_TRAILING_PAD_MM,
    };
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(TITLE_FONT_SIZE_PT);
  const titleText = `${displayIndex}. ${question.questionText}${question.required ? "  *" : ""}`;
  const titleLines = doc.splitTextToSize(titleText, titleWrapWidthMm) as string[];

  doc.setFont("helvetica", "italic");
  doc.setFontSize(META_FONT_SIZE_PT);
  const metaParts = [typeLabel(question.type)];
  if (question.required) {
    metaParts.push("Required");
  }
  // File-upload questions surface their accepted types and attachment mode.
  if (question.type === "file_upload") {
    if (question.fileConstraints?.accept) {
      metaParts.push(`accepted: ${question.fileConstraints.accept}`);
    }
    if (question.fileConstraints?.maxFiles) {
      metaParts.push(`max ${question.fileConstraints.maxFiles}`);
    }
    if (question.fileConstraints?.sizeLimitText) {
      metaParts.push(question.fileConstraints.sizeLimitText);
    }
    metaParts.push(question.attachmentMode === "manual" ? "attach by hand" : "auto-attach");
  }
  if (extraNote) {
    metaParts.push(extraNote);
  }
  const metaLines = doc.splitTextToSize(metaParts.join(" · "), contentWidthMm) as string[];

  let answerHeightMm: number;
  let optionLines: string[][] = [];
  let matchedOptionIndexes = new Set<number>();
  let unmatchedAnswerLines: string[] = [];
  let freeTextAnswerLines: string[] = [];
  let placeholderAnswerLines: string[] = [];
  let gridLines: string[] = [];

  if (isGrid) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(OPTION_FONT_SIZE_PT);
    if (question.options.length > 0) {
      gridLines.push(...(doc.splitTextToSize(`Columns: ${question.options.join(" | ")}`, contentWidthMm) as string[]));
    }
    const rows = question.rows ?? [];
    rows.forEach((row) => {
      gridLines.push(...(doc.splitTextToSize(`•  ${row}`, contentWidthMm - OPTION_INDENT_MM) as string[]));
    });
    if (gridLines.length === 0) {
      gridLines = doc.splitTextToSize(
        "Grid question — row/column structure could not be read; please review this question directly on the form.",
        contentWidthMm,
      ) as string[];
    }
    answerHeightMm = gridLines.length * OPTION_LINE_HEIGHT_MM;
  } else if (SINGLE_SELECT_TYPES.has(question.type) || question.type === "checkboxes") {
    const isMultiSelect = question.type === "checkboxes";
    doc.setFont("helvetica", "normal");
    doc.setFontSize(OPTION_FONT_SIZE_PT);
    const options = question.options.length > 0 ? question.options : ["(No options detected)"];
    optionLines = options.map((option) => doc.splitTextToSize(option, contentWidthMm - OPTION_INDENT_MM) as string[]);
    answerHeightMm = optionLines.reduce((sum, lines) => sum + lines.length * OPTION_LINE_HEIGHT_MM, 0);

    if (hasContent) {
      const answerTokens = (isMultiSelect ? resolved.text.split(/[,;]/) : [resolved.text]).map((token) =>
        token.trim().toLowerCase(),
      );
      options.forEach((option, i) => {
        if (answerTokens.includes(option.trim().toLowerCase())) {
          matchedOptionIndexes.add(i);
        }
      });

      if (matchedOptionIndexes.size === 0) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(OPTION_FONT_SIZE_PT);
        unmatchedAnswerLines = doc.splitTextToSize(
          `AI answer (not an exact option match): ${resolved.text}`,
          contentWidthMm,
        ) as string[];
        answerHeightMm += CONTENT_GAP_MM + unmatchedAnswerLines.length * OPTION_LINE_HEIGHT_MM;
      }
    } else if (isBlankState(resolved.status)) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(OPTION_FONT_SIZE_PT);
      unmatchedAnswerLines = doc.splitTextToSize(blankNoteFor(resolved.status), contentWidthMm) as string[];
      answerHeightMm += CONTENT_GAP_MM + unmatchedAnswerLines.length * OPTION_LINE_HEIGHT_MM;
    }
  } else if (question.type === "short_answer" || question.type === "paragraph") {
    const fixedHeightMm = question.type === "short_answer" ? SHORT_ANSWER_BOX_HEIGHT_MM : PARAGRAPH_ANSWER_BOX_HEIGHT_MM;
    const displayText = hasContent ? resolved.text : isBlankState(resolved.status) ? blankNoteFor(resolved.status) : "";

    if (displayText) {
      doc.setFont("helvetica", hasContent ? "normal" : "italic");
      doc.setFontSize(OPTION_FONT_SIZE_PT);
      freeTextAnswerLines = doc.splitTextToSize(displayText, contentWidthMm - ANSWER_BOX_INSET_MM * 2) as string[];
      const neededHeightMm = freeTextAnswerLines.length * OPTION_LINE_HEIGHT_MM + ANSWER_BOX_INSET_MM * 2;
      answerHeightMm = Math.max(fixedHeightMm, neededHeightMm);
    } else {
      answerHeightMm = fixedHeightMm;
    }
  } else {
    const displayText = hasContent
      ? `Answer: ${resolved.text}`
      : isBlankState(resolved.status)
        ? blankNoteFor(resolved.status)
        : isAiMode
          ? ""
          : placeholderText(question.type);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(OPTION_FONT_SIZE_PT);
    placeholderAnswerLines = displayText ? (doc.splitTextToSize(displayText, contentWidthMm) as string[]) : [];
    answerHeightMm = placeholderAnswerLines.length > 0 ? placeholderAnswerLines.length * OPTION_LINE_HEIGHT_MM : PLACEHOLDER_HEIGHT_MM;
  }

  const totalHeightMm =
    BOX_PADDING_MM * 2 +
    titleLines.length * TITLE_LINE_HEIGHT_MM +
    CONTENT_GAP_MM +
    metaLines.length * META_LINE_HEIGHT_MM +
    CONTENT_GAP_MM +
    answerHeightMm +
    BOX_TRAILING_PAD_MM;

  return {
    titleLines,
    metaLines,
    optionLines,
    matchedOptionIndexes,
    unmatchedAnswerLines,
    freeTextAnswerLines,
    placeholderAnswerLines,
    gridLines,
    totalHeightMm,
  };
}

function drawQuestionBox(
  doc: jsPDF,
  question: ExtractedQuestionWithSection,
  layout: QuestionLayout,
  x: number,
  yTop: number,
  boxWidthMm: number,
  resolved: ResolvedAnswer,
): void {
  const textX = x + BOX_PADDING_MM;
  const contentWidthMm = boxWidthMm - BOX_PADDING_MM * 2;
  const isGrid = GRID_TYPES.has(question.type);

  doc.setDrawColor(...PURPLE_BORDER);
  doc.setFillColor(...PURPLE_FILL);
  doc.setLineWidth(0.35);
  doc.roundedRect(x, yTop, boxWidthMm, layout.totalHeightMm, 2, 2, "FD");

  let cursorY = yTop + BOX_PADDING_MM;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(TITLE_FONT_SIZE_PT);
  doc.setTextColor(...TEXT_COLOR);
  layout.titleLines.forEach((line, i) => {
    doc.text(line, textX, cursorY + TITLE_LINE_HEIGHT_MM * (i + 0.75));
  });

  // FIX 3.1: pill and body both derive from `resolved` (one source). Manual
  // and grid keep their own pills; everything else comes from the status.
  const pillInfo = question.manualOnly
    ? { text: "Manual Only", color: META_COLOR }
    : isGrid
      ? null
        : statusPillLabel(resolved.status);
  if (pillInfo) {
    drawStatusPill(doc, pillInfo.text, pillInfo.color, x + boxWidthMm - BOX_PADDING_MM, cursorY + TITLE_LINE_HEIGHT_MM * 0.5);
  }

  cursorY += layout.titleLines.length * TITLE_LINE_HEIGHT_MM + CONTENT_GAP_MM;

  doc.setFont("helvetica", "italic");
  doc.setFontSize(META_FONT_SIZE_PT);
  doc.setTextColor(...META_COLOR);
  layout.metaLines.forEach((line, i) => {
    doc.text(line, textX, cursorY + META_LINE_HEIGHT_MM * (i + 0.75));
  });
  cursorY += layout.metaLines.length * META_LINE_HEIGHT_MM + CONTENT_GAP_MM;

  if (question.manualOnly) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(OPTION_FONT_SIZE_PT);
    doc.setTextColor(...META_COLOR);
    layout.placeholderAnswerLines.forEach((line, i) => {
      doc.text(line, textX, cursorY + OPTION_LINE_HEIGHT_MM * (i + 0.75));
    });
    return;
  }

  if (isGrid) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(OPTION_FONT_SIZE_PT);
    doc.setTextColor(...TEXT_COLOR);
    layout.gridLines.forEach((line, i) => {
      doc.text(line, textX, cursorY + OPTION_LINE_HEIGHT_MM * (i + 0.75));
    });
    return;
  }

  if (SINGLE_SELECT_TYPES.has(question.type) || question.type === "checkboxes") {
    const isMultiSelect = question.type === "checkboxes";
    doc.setFont("helvetica", "normal");
    doc.setFontSize(OPTION_FONT_SIZE_PT);

    layout.optionLines.forEach((lines, optionIndex) => {
      const isMatched = layout.matchedOptionIndexes.has(optionIndex);

      doc.setDrawColor(...PURPLE_BORDER);
      if (isMultiSelect) {
        doc.setFillColor(...PURPLE_BORDER);
        doc.rect(textX, cursorY + 0.4, GLYPH_SIZE_MM, GLYPH_SIZE_MM, isMatched ? "FD" : "S");
      } else {
        doc.setFillColor(...PURPLE_BORDER);
        doc.circle(textX + GLYPH_SIZE_MM / 2, cursorY + GLYPH_SIZE_MM / 2 + 0.4, GLYPH_SIZE_MM / 2, isMatched ? "FD" : "S");
      }

      doc.setFont("helvetica", isMatched ? "bold" : "normal");
      doc.setTextColor(...TEXT_COLOR);
      lines.forEach((line, i) => {
        doc.text(line, textX + OPTION_INDENT_MM, cursorY + OPTION_LINE_HEIGHT_MM * (i + 0.75));
      });
      cursorY += lines.length * OPTION_LINE_HEIGHT_MM;
    });

    if (layout.unmatchedAnswerLines.length > 0) {
      cursorY += CONTENT_GAP_MM;
      doc.setFont("helvetica", "italic");
      doc.setFontSize(OPTION_FONT_SIZE_PT);
      doc.setTextColor(...(isBlankState(resolved.status) ? NEEDS_REVIEW_COLOR : ANSWERED_COLOR));
      layout.unmatchedAnswerLines.forEach((line, i) => {
        doc.text(line, textX, cursorY + OPTION_LINE_HEIGHT_MM * (i + 0.75));
      });
    }
  } else if (question.type === "short_answer" || question.type === "paragraph") {
    const boxHeightMm = question.type === "short_answer" ? SHORT_ANSWER_BOX_HEIGHT_MM : PARAGRAPH_ANSWER_BOX_HEIGHT_MM;
    const drawnHeightMm = Math.max(
      boxHeightMm,
      layout.freeTextAnswerLines.length * OPTION_LINE_HEIGHT_MM + ANSWER_BOX_INSET_MM * 2,
    );
    doc.setDrawColor(...ANSWER_BOX_BORDER);
    doc.setLineWidth(0.25);
    doc.rect(textX, cursorY, contentWidthMm, drawnHeightMm - 1.5, "S");

    if (layout.freeTextAnswerLines.length > 0) {
      const isPlaceholderNote = isBlankState(resolved.status) || resolved.status === "suggested";
      doc.setFont("helvetica", isPlaceholderNote ? "italic" : "normal");
      doc.setFontSize(OPTION_FONT_SIZE_PT);
      doc.setTextColor(...(isBlankState(resolved.status) ? NEEDS_REVIEW_COLOR : TEXT_COLOR));
      layout.freeTextAnswerLines.forEach((line, i) => {
        doc.text(line, textX + ANSWER_BOX_INSET_MM, cursorY + ANSWER_BOX_INSET_MM + OPTION_LINE_HEIGHT_MM * (i + 0.75));
      });
    }
  } else if (layout.placeholderAnswerLines.length > 0) {
    const needsInput = resolved.status === "not-in-docs";
    doc.setFont("helvetica", "italic");
    doc.setFontSize(OPTION_FONT_SIZE_PT);
    doc.setTextColor(...(needsInput ? NEEDS_REVIEW_COLOR : META_COLOR));
    layout.placeholderAnswerLines.forEach((line, i) => {
      doc.text(line, textX, cursorY + OPTION_LINE_HEIGHT_MM * (i + 0.75));
    });
  }
}

export interface StructuredPdfOptions {
  answers?: ReadonlyMap<number, string>;
  suggestions?: ReadonlyMap<number, string>;
  sectionTitles?: ReadonlyMap<number, string>;
  // Per-question blank-state classification (from Gemini's category) so a
  // factual gap reads "Not in your documents" and a genuinely personal one
  // reads "Personal — only you can answer" instead of one catch-all.
  categories?: ReadonlyMap<number, UnansweredKind>;
  // File-upload question index → chosen document name (Feature 2).
  fileMatches?: ReadonlyMap<number, string | null>;
  // Composed-answer provenance: question index → grounding document names.
  provenance?: ReadonlyMap<number, string[]>;
  // The corrected taxonomy (Problem 2): explicit per-question state drives
  // the pill; `sources` names where an answered value came from.
  states?: ReadonlyMap<number, AnswerState>;
  sources?: ReadonlyMap<number, string>;
  verified?: boolean;
  // PNG data URL of the brand logo, drawn in the page-1 header (1.5g).
  logoDataUrl?: string | undefined;
}

export function generateStructuredPdf(
  formTitle: string,
  questions: ExtractedQuestionWithSection[],
  options: StructuredPdfOptions = {},
): Blob {
  const { answers, suggestions, sectionTitles, fileMatches, provenance, states, sources, verified = false, logoDataUrl } =
    options;

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidthMm = doc.internal.pageSize.getWidth();
  const pageHeightMm = doc.internal.pageSize.getHeight();
  const boxWidthMm = pageWidthMm - MARGIN_MM * 2;
  const contentWidthMm = boxWidthMm - BOX_PADDING_MM * 2;
  const maxY = pageHeightMm - MARGIN_MM;

  // Register/select an embedded font for the document's actual content and
  // learn which scripts (if any) have no glyph coverage. Rather than
  // silently rendering those as boxes, we print a visible warning banner.
  const allText = [
    formTitle,
    ...questions.map((q) => `${q.questionText} ${q.options.join(" ")} ${(q.rows ?? []).join(" ")}`),
    ...(answers ? Array.from(answers.values()) : []),
    ...(suggestions ? Array.from(suggestions.values()) : []),
  ].join(" ");
  const { unsupportedScripts } = applyBestFont(doc, allText);

  let cursorY = MARGIN_MM;

  // Brand logo in the header, left of the title (1.5g). Subtle, page 1 only;
  // the title shifts right by exactly the logo width + gap so no existing
  // content moves. Wrapped in try/catch so a bad/absent data URL never breaks
  // PDF generation.
  let titleX = MARGIN_MM;
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, "PNG", MARGIN_MM, cursorY, LOGO_SIZE_MM, LOGO_SIZE_MM);
      titleX = MARGIN_MM + LOGO_SIZE_MM + LOGO_GAP_MM;
    } catch (error) {
      console.warn("EasyFilla(pdf): couldn't embed logo, continuing without it", error);
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(DOC_TITLE_FONT_SIZE_PT);
  doc.setTextColor(...TEXT_COLOR);
  doc.text(formTitle || "Google Form Export", titleX, cursorY + DOC_TITLE_HEIGHT_MM * 0.6);

  // PART B.5 — "VERIFIED" claims every answer is confirmed. It must not appear
  // while any answer is a draft, a conflict, or an unanswered gap; those need
  // the user's eyes, and a green VERIFIED badge is precisely what stops them
  // looking. Counts are shown instead.
  const weak = states
    ? [...states.values()].filter(
        (state) =>
          state === "ai_draft_verify" || state === "conflicting_sources" || state === "needs_user_input",
      )
    : [];
  const trulyVerified = verified && weak.length === 0;
  if (verified && !trulyVerified) {
    const drafts = [...(states?.values() ?? [])].filter((s2) => s2 === "ai_draft_verify").length;
    const conflicts = [...(states?.values() ?? [])].filter((s2) => s2 === "conflicting_sources").length;
    const gaps = [...(states?.values() ?? [])].filter((s2) => s2 === "needs_user_input").length;
    const parts = [
      drafts > 0 ? `${drafts} draft${drafts === 1 ? "" : "s"}` : "",
      conflicts > 0 ? `${conflicts} conflict${conflicts === 1 ? "" : "s"}` : "",
      gaps > 0 ? `${gaps} need${gaps === 1 ? "s" : ""} input` : "",
    ].filter(Boolean);
    drawStatusPill(doc, `REVIEW: ${parts.join(", ")}`, NEEDS_REVIEW_COLOR, pageWidthMm - MARGIN_MM, cursorY + DOC_TITLE_HEIGHT_MM * 0.6);
  }
  if (trulyVerified) {
    drawStatusPill(doc, "VERIFIED", ANSWERED_COLOR, pageWidthMm - MARGIN_MM, cursorY + DOC_TITLE_HEIGHT_MM * 0.6);
  }

  cursorY += DOC_TITLE_HEIGHT_MM;

  if (unsupportedScripts.length > 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(META_FONT_SIZE_PT);
    doc.setTextColor(...NEEDS_REVIEW_COLOR);
    const warning = doc.splitTextToSize(
      `Note: this form uses text (${unsupportedScripts.join(", ")}) that the built-in PDF font can't render — ` +
        `it may appear as boxes below. The answers and structure are still correct; view them in the sidepanel ` +
        `for accurate text.`,
      boxWidthMm,
    ) as string[];
    warning.forEach((line, i) => {
      doc.text(line, MARGIN_MM, cursorY + META_LINE_HEIGHT_MM * (i + 0.75));
    });
    cursorY += warning.length * META_LINE_HEIGHT_MM + CONTENT_GAP_MM;
  }

  if (questions.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(META_FONT_SIZE_PT);
    doc.setTextColor(...META_COLOR);
    doc.text("No questions were found on this form.", MARGIN_MM, cursorY + META_LINE_HEIGHT_MM);
    return doc.output("blob");
  }

  let currentSection = -1;
  let currentGroup: string | undefined;
  let displayIndex = 0;

  questions.forEach((question, questionIndex) => {
    displayIndex += 1;
    const resolved = resolveAnswer(questionIndex, answers, suggestions, states);

    if (question.section !== currentSection) {
      currentSection = question.section;
      currentGroup = undefined;

      if (cursorY + SECTION_HEADING_HEIGHT_MM > maxY) {
        doc.addPage();
        cursorY = MARGIN_MM;
      }

      const heading = sectionTitles?.get(currentSection) || `Section ${currentSection}`;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(SECTION_HEADING_FONT_SIZE_PT);
      doc.setTextColor(...PURPLE_BORDER);
      doc.text(heading, MARGIN_MM, cursorY + SECTION_HEADING_HEIGHT_MM * 0.6);
      cursorY += SECTION_HEADING_HEIGHT_MM;
    }

    // Fieldset/heading grouping (generic forms): a small subheading when
    // the group changes within a section.
    if (question.group && question.group !== currentGroup) {
      currentGroup = question.group;

      const groupHeadingHeightMm = META_LINE_HEIGHT_MM + 2;
      if (cursorY + groupHeadingHeightMm > maxY) {
        doc.addPage();
        cursorY = MARGIN_MM;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(META_FONT_SIZE_PT + 1);
      doc.setTextColor(...META_COLOR);
      doc.text(question.group, MARGIN_MM, cursorY + groupHeadingHeightMm * 0.7);
      cursorY += groupHeadingHeightMm;
    }

    // Per-question note: the source of an answered value, the chosen document
    // for a file upload, and/or the provenance of an AI-composed answer.
    const noteBits: string[] = [];
    const source = sources?.get(questionIndex);
    if (source && states?.get(questionIndex) === "answered_from_documents") {
      noteBits.push(`source: ${source}`);
    }
    if (question.type === "file_upload") {
      const chosen = fileMatches?.get(questionIndex);
      noteBits.push(chosen ? `recommended file: ${chosen}` : "no file chosen yet");
    }
    const grounded = provenance?.get(questionIndex);
    if (grounded && grounded.length > 0) {
      noteBits.push(`Composed from your input · ${grounded.join(", ")} — verify`);
    }
    const extraNote = noteBits.length > 0 ? noteBits.join(" · ") : undefined;

    const layout = layoutQuestion(doc, question, displayIndex, contentWidthMm, resolved, extraNote);

    if (cursorY + layout.totalHeightMm > maxY && cursorY > MARGIN_MM) {
      doc.addPage();
      cursorY = MARGIN_MM;
    }

    drawQuestionBox(doc, question, layout, MARGIN_MM, cursorY, boxWidthMm, resolved);
    cursorY += layout.totalHeightMm + BOX_GAP_MM;
  });

  return doc.output("blob");
}
