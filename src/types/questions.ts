export type QuestionType =
  | "short_answer"
  | "paragraph"
  | "multiple_choice"
  | "checkboxes"
  | "dropdown"
  | "linear_scale"
  | "date"
  | "time"
  | "multiple_choice_grid"
  | "checkbox_grid"
  | "file_upload"
  | "unknown";

// Constraints a file-upload field exposes, rendered in the PDF and used to
// validate a candidate document before attaching it.
export interface FileConstraints {
  accept: string | null; // raw accept attribute / parsed type list, e.g. ".pdf,.docx"
  multiple: boolean;
  maxFiles?: number; // parsed from the page where exposed (e.g. Google Forms text)
  sizeLimitText?: string; // human string if the page exposes one
}

// How a file-upload question can be satisfied:
//   auto   = generic page with a reachable <input type=file>/dropzone; the
//            extension can attach the file itself via DataTransfer.
//   manual = Google Forms (Drive picker in a cross-origin iframe) — the
//            content script CANNOT attach; the user attaches by hand while
//            Continue-and-Fill pauses and names the recommended file.
export type AttachmentMode = "auto" | "manual";

export interface ExtractedQuestion {
  questionText: string;
  type: QuestionType;
  options: string[];
  required: boolean;
  // Only populated for multiple_choice_grid/checkbox_grid: the grid's row
  // labels, with `options` holding the (shared) column labels.
  rows?: string[];
  // Set by adapters for fields that must never be auto-filled or sent to
  // the AI: passwords, payment-card fields, login forms, CAPTCHAs. The PDF
  // marks these "Manual Only"; every AI/fill path skips them.
  manualOnly?: boolean;
  manualReason?: string;
  // Visual grouping within a section (fieldset legend / nearest preceding
  // heading on generic forms) — rendered as a subheading in the PDF.
  group?: string;
  // Only for type === "file_upload".
  fileConstraints?: FileConstraints;
  attachmentMode?: AttachmentMode;
  // STAGE 2c — a lazily-rendered choice widget whose options the scan's harvest
  // budget did not reach. NOT an extraction failure: it is harvested on demand
  // at fill time. Distinct from a choice field with zero options AFTER a
  // successful harvest attempt, which IS a failure and stays reported as one.
  optionsPending?: boolean;
}

export interface ExtractedQuestionWithSection extends ExtractedQuestion {
  section: number;
  // STAGE 2a — which frame this question was scanned in, and the registry
  // generation it was scanned at. Carried all the way from the scan to the
  // fill so the answer can be routed back to the frame that owns the field
  // instead of broadcast to every frame on the page.
  frameId?: number;
  frameGeneration?: number;
  frameUrl?: string;
  identityKey?: string;
}

// A user-approved answer, carrying enough of the question's shape
// (questionText/type/options) for the content script to fuzzy-match it
// against a freshly re-scanned live DOM question — it can't rely on any
// element reference or index surviving the round trip to the sidepanel.
export interface FillableAnswer {
  questionText: string;
  type: QuestionType;
  options: string[];
  answer: string;
  // STAGE 2a — the frame this answer belongs to. Answers are ROUTED with
  // chrome.tabs.sendMessage(tabId, msg, { frameId }), never broadcast: a
  // broadcast lets every frame fuzzy-match every answer, and two frames with
  // an identically-labelled "Country" field would both fill it.
  frameId?: number;
  // The registry's generation counter for that frame at scan time. If the
  // frame navigated since, the counters differ and the answer is refused
  // rather than written into a stale document.
  frameGeneration?: number;
  // Structural identity from the scan (frameId + domPath + name/id +
  // accessibleName). Lets the fill path re-find the EXACT field instead of
  // fuzzy-matching label text, which is what collapses repeated portal rows.
  identityKey?: string;
  // FIX 1 — set when the frame navigated after this answer was produced, so
  // `identityKey` was dropped as stale (§3c) and the fill must fall back to
  // label similarity. Label text is the LEAST reliable signal in this codebase
  // (a 59-field form produced ~50% duplicate labels — the whole reason dedup
  // keys on structure instead). The fallback is allowed; silently picking a
  // winner among several label matches is not, so this flag makes the fill
  // path apply a strict one-candidate-or-refuse rule.
  identityInvalidated?: boolean;
}

// A user-approved document → file-upload-question pairing, sent to the
// content script so it can reconstruct the File and attach it. Bytes travel
// base64-encoded because chrome messaging JSON-serializes payloads (a raw
// ArrayBuffer would not survive the round trip).
export interface FileAttachment {
  questionText: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

// Everything the content script needs to fill one visible section/step.
export interface FillPayload {
  answers: FillableAnswer[];
  fileAttachments: FileAttachment[];
}
