import type {
  ExtractedQuestionWithSection,
  FillableAnswer,
  FileAttachment,
} from "../types/questions";
import {
  MESSAGE_TYPE,
  type GetSectionInfoRequest,
  type ClickNavRequest,
  type ClickNavResponse,
  type FillCurrentSectionRequest,
  type FillCurrentSectionResponse,
  type ScrollToQuestionRequest,
  type ScrollToQuestionResponse,
  type RevealFrameRequest,
  type RevealFrameResponse,
  type ScanAllFramesRequest,
} from "../lib/messaging/messages";
import type { MergedScan } from "../background/frame-registry";
import { extractText, getExtractionDiagnostics, type ExtractionProgress } from "../lib/pdf/extractor";
import { buildDiagnosticsReport, downloadDiagnosticsReport } from "../lib/diagnostics";
import { generateStructuredPdf } from "../lib/pdf/generator";
import {
  matchAnswersWithGemini,
  buildDossier,
  answerFromDossier,
  assessEvidenceAgreement,
  composeAnswers,
  templateElicitation,
  detectLanguageWithGemini,
  MissingApiKeyError,
  GeminiRequestError,
  describeGeminiError,
  DEFAULT_QUESTION_CHUNK,
  type QuestionForAi,
  type AnswerLanguage,
  type ComposeResult,
  type ComposeLength,
  type ComposeTone,
} from "../lib/ai/gemini-client";
import { isComposable } from "../lib/compose/eligibility";
import { fileToAttachment } from "../lib/dom/file-transfer";
import { buildOrReuseProfile, clearProfile } from "../lib/profile/storage";
import { clearDossier, loadCachedDossier, fileSetKey, type Dossier } from "../lib/ai/dossier";

import { queueStats, onQueueStats, onQueueActivity } from "../lib/ai/request-queue";
import { preflight, describeUsage, describeReset, type PreflightResult } from "../lib/ai/request-budget";
import { loadLedger, cachedLedger, onQuotaChange } from "../lib/ai/quota-store";
import { activeProvider } from "../lib/ai/active-provider";
import { debugLog, initDebugLogging } from "../lib/debug";
// B1 — the sidepanel reads only the BOOLEAN. The key string itself never
// enters this module's scope.
import { hasApiKey } from "../lib/storage/provider-keys";
import { applyActiveProviderPacing, describePacing, type PacingDecision } from "../lib/ai/pacing";
import { ComposeQueue, composeButtonLabel } from "../lib/ai/compose-queue";
import {
  INPUT_QUALITY_NOTE,
  INPUT_QUALITY_NOTE_SHORT_FILES,
  INPUT_QUALITY_NOTE_SHORT_SEED,
  isInputNoteDismissed,
  dismissInputNote,
  loadComposeDefaults,
  lengthTargetFor,
  DEFAULT_COMPOSE_DEFAULTS,
  type ComposeLengthChoice,
  type ComposeToneChoice,
  type ComposeDefaults,
} from "../lib/ui-prefs";
import { textSimilarity } from "../lib/text/fuzzy-match";
import { matchQuestionToProfile, SENSITIVE_KEYS } from "../lib/profile/match";
import { detectDeclaration, loadDeclarationDefaults } from "../lib/profile/declarations";
import { profileToPromptContext, type StructuredProfile } from "../lib/profile/types";
import {
  stateDisplay,
  setErrorRetryLabel,
  assertProvenanceIntegrity,
  deriveState,
  type AnswerState,
} from "../lib/answer-state";
import type { FillLogEntry } from "../lib/messaging/messages";
import {
  detectLanguageFromText,
  normalizeLangCode,
  directionForCode,
  displayNameForCode,
  type DetectedLanguage,
} from "../lib/i18n/language";
import { NAV_LABELS } from "../lib/i18n/nav-dictionary";

// Captured at the top of module execution. This <script type="module"> is
// deferred, so it runs AFTER the HTML (including the splash) has parsed and
// painted — so this is a safe lower bound on "splash shown at". Using an
// inline HTML script would be cleaner but MV3's CSP (script-src 'self')
// blocks inline scripts on extension pages.
const splashShownAt = Date.now();

const HTTP_URL_PATTERN = /^https?:\/\//;
const MAX_SECTIONS = 50;
const SECTION_SETTLE_TIMEOUT_MS = 6000;
const SETTLE_POLL_MS = 250;
const GRID_QUESTION_TYPES = new Set(["multiple_choice_grid", "checkbox_grid"]);

// The brand logo as a PNG data URL, loaded once from the extension's own
// bundled icon and embedded into every generated PDF header (1.5g). Undefined
// until loaded (PDFs are only generated well after startup); a failure leaves
// it undefined so PDF generation simply omits the logo.
let logoDataUrl: string | undefined;
void (async () => {
  try {
    const response = await fetch(chrome.runtime.getURL("icons/icon128.png"));
    const blob = await response.blob();
    logoDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("logo read failed"));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.warn("EasyFilla: couldn't load logo for PDF header", error);
  }
})();

const openSettingsButton = document.getElementById("open-settings-button") as HTMLButtonElement;
const adapterModeText = document.getElementById("adapter-mode") as HTMLParagraphElement;
const connectionStatusText = document.getElementById("connection-status") as HTMLParagraphElement;
const grantAccessButton = document.getElementById("grant-access-button") as HTMLButtonElement;
const languageSelect = document.getElementById("language-select") as HTMLSelectElement;
const scanButton = document.getElementById("scan-button") as HTMLButtonElement;
const scanStatus = document.getElementById("scan-status") as HTMLParagraphElement;
const questionsList = document.getElementById("questions-list") as HTMLUListElement;
const documentUpload = document.getElementById("document-upload") as HTMLInputElement;
const uploadedFilesList = document.getElementById("uploaded-files-list") as HTMLUListElement;
const uploadSummaryText = document.getElementById("upload-summary") as HTMLParagraphElement;
const clearFilesButton = document.getElementById("clear-files-button") as HTMLButtonElement;
const dossierStatusText = document.getElementById("dossier-status") as HTMLParagraphElement;
const fillReportSection = document.getElementById("fill-report") as HTMLElement;
const fillReportList = document.getElementById("fill-report-list") as HTMLUListElement;
const retryFailedButton = document.getElementById("retry-failed-button") as HTMLButtonElement;
const rebuildDossierButton = document.getElementById("rebuild-dossier-button") as HTMLButtonElement;
const exportDiagnosticsButton = document.getElementById("export-diagnostics-button") as HTMLButtonElement;
const generatePdfButton = document.getElementById("generate-pdf-button") as HTMLButtonElement;
const generateStatus = document.getElementById("generate-status") as HTMLParagraphElement;
const exportPdfLinkContainer = document.getElementById("export-pdf-link") as HTMLDivElement;
const generateAiReportButton = document.getElementById("generate-ai-report-button") as HTMLButtonElement;
const aiReportStatus = document.getElementById("ai-report-status") as HTMLParagraphElement;
const aiReportPdfLinkContainer = document.getElementById("ai-report-pdf-link") as HTMLDivElement;
const refinementList = document.getElementById("refinement-list") as HTMLUListElement;
const saveRefinementButton = document.getElementById("save-refinement-button") as HTMLButtonElement;
const refinementStatus = document.getElementById("refinement-status") as HTMLParagraphElement;
const composeQueueDepthText = document.getElementById("compose-queue-depth") as HTMLParagraphElement;
const composeLiveRegion = document.getElementById("compose-live-region") as HTMLParagraphElement;
const refinementPdfLinkContainer = document.getElementById("refinement-pdf-link") as HTMLDivElement;
const confirmFillButton = document.getElementById("confirm-fill-button") as HTMLButtonElement;
const confirmFillStatus = document.getElementById("confirm-fill-status") as HTMLParagraphElement;

interface ExtractedDocument {
  fileName: string;
  text: string;
  // Retained so file-upload questions can be attached for real (generic
  // adapter) — the extracted text alone can't be re-encoded into a File.
  file: File;
}

let extractedDocuments: ExtractedDocument[] = [];

// THE RAW UPLOAD LIST — every file the user chose, recorded at selection time
// and NEVER gated on local extraction.
//
// This exists because `extractedDocuments` is populated inside a try/catch: a
// file whose local extraction THREW (unsupported type, OCR timeout, a pdf.js
// failure) was never pushed at all. Those are precisely the scanned PDFs and
// photos that Stage A is for, so the one layer able to read them was the one
// layer that never saw them. Local extraction is enrichment, not a gate.
interface RawUpload {
  file: File;
  extraction: "ok" | "empty" | "failed";
  detail: string;
}
let rawUploads: RawUpload[] = [];

function markExtraction(file: File, extraction: RawUpload["extraction"], detail: string): void {
  const entry = rawUploads.find((u) => u.file === file);
  if (entry) {
    entry.extraction = extraction;
    entry.detail = detail;
  }
}

// Files handed to Stage A. Always the raw list; the comparison against
// `extractedDocuments` is logged so a silent divergence can't recur.
function dossierInputs(): File[] {
  const excluded = rawUploads.filter(
    (u) => !extractedDocuments.some((doc) => doc.file === u.file),
  );
  if (excluded.length > 0) {
    console.warn(
      `[EasyFilla][Dossier] ${rawUploads.length} raw upload(s) vs ${extractedDocuments.length} locally-extracted. ` +
        `${excluded.length} file(s) produced no local text and are being sent to Stage A anyway:`,
      excluded.map((u) => `${u.file.name} — ${u.extraction}: ${u.detail}`),
    );
  }
  console.log(`[EasyFilla][Dossier] Stage A input = ${rawUploads.length} raw file(s).`);
  return rawUploads.map((u) => u.file);
}

// The most recently generated-and-downloaded AI-answered report, kept only
// so "Continue and Fill" (and PDF regeneration after manual refinement)
// always act on exactly what the user just reviewed — not a fresh, possibly-
// different re-scan or re-analysis. `answers` holds only confirmed values —
// either directly sourced from the documents, or a suggestion the user has
// explicitly reviewed and saved via the refinement step — never an
// unreviewed AI guess. `suggestions` holds Gemini's best-effort, unsourced
// guesses for personal/subjective questions, shown for review but never
// used to fill the form on their own.
interface ApprovedReport {
  /**
   * D1 — minted per report GENERATION.
   *
   * Reports are regenerated, and compose jobs outlive a regeneration. Without
   * this a job's result is identified only by question index, so a stale result
   * can land on a freshly-scanned question that happens to occupy the same
   * position. The queue keys every job by `runId` + index.
   */
  runId: string;
  formTitle: string;
  questions: ExtractedQuestionWithSection[];
  sectionTitles: Map<number, string>;
  answers: Map<number, string>;
  suggestions: Map<number, string>;
  // Blank-state classification per question index (Gemini `category`),
  // driving the four PDF/UI states and the hard-fail block on personal /
  // not-in-documents questions with no answer yet.
  categories: Map<number, "not_in_documents" | "personal">;
  // The corrected answerability taxonomy (Problem 2): explicit per-question
  // state, decided after extraction + deterministic matching + the model
  // result. Drives the pills and the fill gate.
  states: Map<number, AnswerState>;
  // For answered_from_documents questions: the source (document name or
  // "your profile") that produced the value.
  sources: Map<number, string>;
  // File-upload question index → chosen uploaded document's fileName (or null
  // = deliberately none). The user can override via a dropdown in review.
  fileMatches: Map<number, string | null>;
  // Composition provenance (Feature 3.3): question index → uploaded document
  // names that grounded an AI-composed draft.
  provenance: Map<number, string[]>;
  // Per-question elicitation prompt + the user's seed (Problem 3).
  elicitations: Map<number, string>;
  seeds: Map<number, string>;
}

// The deterministic profile for the current document set (Problem 1). Built
// on upload, reused across reports; null until documents are processed.
let profile: StructuredProfile | null = null;

// Uploaded documents keyed by fileName for attachment lookup at fill time.
function documentByName(fileName: string): ExtractedDocument | undefined {
  return extractedDocuments.find((doc) => doc.fileName === fileName);
}

// Content keywords that map a file-upload question to the right document
// (a "CV" question should pick the CV, not a passport scan). Deliberately
// small and transparent; the user can always override the pick.
const DOC_KEYWORDS: Record<string, string[]> = {
  cv: ["cv", "curriculum", "resume", "résumé"],
  resume: ["cv", "curriculum", "resume", "résumé"],
  transcript: ["transcript", "grade", "gpa", "marks", "academic record"],
  passport: ["passport", "identity", "id card", "national id"],
  portfolio: ["portfolio", "sample", "work sample"],
  cover: ["cover letter", "motivation letter"],
  certificate: ["certificate", "certification", "diploma", "degree"],
};

function tokensForLabel(label: string): string[] {
  const lower = label.toLowerCase();
  const tokens = new Set<string>();
  for (const [key, synonyms] of Object.entries(DOC_KEYWORDS)) {
    if (lower.includes(key) || synonyms.some((syn) => lower.includes(syn))) {
      synonyms.forEach((syn) => tokens.add(syn));
      tokens.add(key);
    }
  }
  return [...tokens];
}

export interface DocumentMatch {
  fileName: string;
  confidence: "high" | "medium" | "low";
}

// Scores each uploaded document against a file-upload question's label by
// filename overlap and content-keyword hits. Returns the best candidate with
// a coarse confidence, or null if nothing scores above a floor — the review
// UI never silently attaches a low-confidence guess without showing it.
function matchDocumentToFileQuestion(questionLabel: string): DocumentMatch | null {
  if (extractedDocuments.length === 0) {
    return null;
  }
  const keywords = tokensForLabel(questionLabel);
  const labelLower = questionLabel.toLowerCase();

  let best: { doc: ExtractedDocument; score: number } | null = null;
  for (const doc of extractedDocuments) {
    const nameLower = doc.fileName.toLowerCase();
    const contentLower = doc.text.toLowerCase().slice(0, 4000);
    let score = 0;
    // Filename hits are the strongest signal.
    keywords.forEach((kw) => {
      if (nameLower.includes(kw)) {
        score += 3;
      } else if (contentLower.includes(kw)) {
        score += 1;
      }
    });
    // Any shared meaningful word between label and filename.
    labelLower.split(/\W+/).forEach((word) => {
      if (word.length >= 4 && nameLower.includes(word)) {
        score += 1;
      }
    });
    if (!best || score > best.score) {
      best = { doc, score };
    }
  }

  if (!best) {
    return null;
  }
  // With only one uploaded document, default to it at low confidence rather
  // than leaving a file question with nothing proposed.
  if (best.score === 0) {
    return extractedDocuments.length === 1 && extractedDocuments[0]
      ? { fileName: extractedDocuments[0].fileName, confidence: "low" }
      : null;
  }
  const confidence: DocumentMatch["confidence"] = best.score >= 3 ? "high" : best.score >= 1 ? "medium" : "low";
  return { fileName: best.doc.fileName, confidence };
}

let lastApprovedReport: ApprovedReport | null = null;

// Detected form language for the current scan session. `override` (set via
// the sidepanel dropdown) always wins over detection, so a wrong guess is
// never unfixable. `effectiveLanguage()` resolves the two.
let detectedLanguage: DetectedLanguage | null = null;
let languageOverride: string | null = null;

function effectiveLanguageCode(): string {
  return languageOverride ?? detectedLanguage?.code ?? "und";
}

function effectiveAnswerLanguage(): AnswerLanguage | undefined {
  const code = effectiveLanguageCode();
  return code === "und" ? undefined : { code, name: displayNameForCode(code) };
}

function setStatus(message: string): void {
  scanStatus.textContent = message;
}

function setGenerateStatus(message: string): void {
  generateStatus.textContent = message;
}

function setAiReportStatus(message: string): void {
  aiReportStatus.textContent = message;
}

function setRefinementStatus(message: string): void {
  refinementStatus.textContent = message;
}

function setConfirmFillStatus(message: string): void {
  confirmFillStatus.textContent = message;
}

// Populate the override dropdown once with every language the nav
// dictionary knows, plus "Auto-detect". The user's choice always wins over
// detection so a wrong guess is never unfixable.
function populateLanguageDropdown(): void {
  const codes = ["und", ...Object.keys(NAV_LABELS)];
  languageSelect.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "Language: Auto-detect";
  languageSelect.append(auto);
  codes
    .filter((code) => code !== "und")
    .forEach((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = displayNameForCode(code);
      languageSelect.append(option);
    });
}

// Reflects the resolved language into the dropdown selection and applies
// text direction (RTL for Arabic/Hebrew) to the whole panel.
function applyLanguageToUi(): void {
  const code = effectiveLanguageCode();
  if (languageOverride) {
    languageSelect.value = languageOverride;
  } else {
    languageSelect.value = "auto";
  }
  const direction = directionForCode(code);
  document.documentElement.setAttribute("dir", direction);
  const sourceNote = languageOverride
    ? "manual override"
    : detectedLanguage
      ? `detected via ${detectedLanguage.source}`
      : "not detected yet";
  const auto = languageSelect.options[0];
  if (auto) {
    auto.textContent =
      code === "und" ? "Language: Auto-detect" : `Auto-detect (${displayNameForCode(code)}, ${sourceNote})`;
  }
}

languageSelect.addEventListener("change", () => {
  const value = languageSelect.value;
  languageOverride = value === "auto" ? null : value;
  applyLanguageToUi();
  console.log(`EasyFilla: language ${languageOverride ? `overridden to ${languageOverride}` : "reset to auto-detect"}.`);
});

// FIX 4.3: a persistent AI/quota status line in the header, so the user
// always knows whether the model is reachable and why not.
// FIX 3.7: persistent quota indicator — requests used this session and the
// current rolling-window position, updated live from the global queue.
let lastConnectionMessage = "";
let lastConnectionIsError = false;

// E3d.1/E3d.2 — the ACTIVE PROVIDER is visible at all times, and accounting is
// rendered PER PROVIDER. Cached so the synchronous repaint below never awaits.
let activeProviderView: {
  name: string;
  hasDailyQuota: boolean;
  hasMonthlySpendCap: boolean;
  pacing: PacingDecision;
} | null = null;

async function refreshActiveProviderView(): Promise<void> {
  const provider = await activeProvider();
  // 0b — the SAME decision that paces the queue is what gets rendered, so the
  // number on screen cannot drift from the number in force. Previously the
  // sidepanel re-derived its own wording from `perMinuteRequestLimit()` while
  // the queue was paced from an unrelated Gemini constant, which is precisely
  // how a display can be honest about a value that is not the one being used.
  activeProviderView = {
    name: provider.displayName,
    hasDailyQuota: provider.capabilities.hasDailyQuota,
    hasMonthlySpendCap: provider.capabilities.hasMonthlySpendCap,
    pacing: await applyActiveProviderPacing(),
  };
  renderConnectionStatus();
}

function renderConnectionStatus(): void {
  const stats = queueStats();
  const view = activeProviderView;

  // ── E3d.2: DO NOT SHOW A DAILY COUNTER FOR A PROVIDER THAT HAS NO DAILY
  // QUOTA. Gemini resets at midnight Pacific (§4c); Anthropic has per-minute
  // token buckets and a MONTHLY spend cap surfacing as 402 (§1b). Rendering
  // "N requests used today" for Anthropic would be inventing a window that does
  // not exist — the same error as inventing a denominator, one level up.
  const parts: string[] = [];

  if (view) {
    parts.push(`Provider: ${view.name}`);
  }

  if (view?.hasDailyQuota) {
    const ledger = cachedLedger();
    // Still refuses to invent a denominator it has not learned (§4c).
    parts.push(ledger ? describeUsage(ledger) : "usage today: counting…");
  } else if (view) {
    // No daily window to report. State the pace actually in force, with its
    // provenance — learned from a response, our assumption, or not yet known.
    parts.push(`no daily limit; ${describePacing(view.pacing)}`);
  }

  // Its own capability — NOT inferred from the absence of a daily quota.
  if (view?.hasMonthlySpendCap) {
    parts.push("monthly spend cap applies");
  }

  parts.push(`${stats.sessionRequests} this session`);
  // ── 0b: the denominator is our own pacing cap, and it is now DERIVED FROM THE
  // ACTIVE PROVIDER (pacing.ts) rather than from whichever Gemini model happened
  // to be selected. It is still labelled as ours, because a safety margin under
  // a limit is our choice even when the limit itself was learned.
  parts.push(`${stats.windowRequests}/${stats.windowLimit} in the last minute (our pacing cap)`);

  const quota = parts.join(" · ");
  connectionStatusText.textContent = lastConnectionMessage ? `${lastConnectionMessage} — ${quota}` : quota;
  connectionStatusText.classList.toggle("connection-status--error", lastConnectionIsError);
}

void refreshActiveProviderView();

onQueueStats(() => renderConnectionStatus());
// Repaint the moment the ledger changes, so the counter moves per request
// rather than only when the queue reports.
onQuotaChange(() => renderConnectionStatus());
void loadLedger().then(() => renderConnectionStatus());
// B4 — read the verbose-logging preference once, before anything logs.
void initDebugLogging();

function setConnectionStatus(message: string, isError: boolean): void {
  lastConnectionMessage = message;
  lastConnectionIsError = isError;
  renderConnectionStatus();
}

function setAdapterMode(adapter: string, inaccessibleFrames: number): void {
  const label = adapter === "google-forms" ? "Google Forms" : "Generic web form";
  const frameNote =
    inaccessibleFrames > 0
      ? ` — ${inaccessibleFrames} embedded frame(s) on this page can't be read`
      : "";
  adapterModeText.textContent = `Mode: ${label}${frameNote}`;
}

// STAGE 2a — the per-frame breakdown the coverage report gained. Portals put
// their form inside one or more cross-origin iframes; without this the user
// has no way to tell "this form has 6 fields" from "we could only see 6 of
// this form's 41 fields".
let lastFrameCoverage: MergedScan | null = null;

function describeFrameBreakdown(merged: MergedScan): string {
  const scanned = merged.frames.filter((frame) => frame.scanned);
  const blocked = merged.frames.filter((frame) => frame.inaccessibleReason);
  const parts = [`${merged.frames.length} frame(s) found`, `${scanned.length} scanned`];
  if (blocked.length > 0) {
    parts.push(`${blocked.length} inaccessible`);
  }
  return parts.join(", ");
}

// Origins of frames we could not inject into for lack of host access. The
// Grant-access button requests these too — a portal's application iframe is
// routinely on a different origin from the page hosting it, so granting only
// the top-level origin leaves the actual form unreachable.
function missingOriginsFrom(merged: MergedScan): string[] {
  const origins = new Set<string>();
  merged.frames.forEach((frame) => {
    if (frame.inaccessibleReason !== "no-host-access") {
      return;
    }
    try {
      origins.add(new URL(frame.url).origin);
    } catch {
      // about:blank / srcdoc — inherits its parent's access, nothing to ask for.
    }
  });
  return [...origins];
}

function reportFrameCoverage(merged: MergedScan): void {
  lastFrameCoverage = merged;
  setAdapterMode(merged.adapter, merged.frames.filter((frame) => frame.inaccessibleReason).length);

  console.log(
    `EasyFilla(coverage): ${describeFrameBreakdown(merged)}; ` +
      `${merged.questions.length} field(s) after merging` +
      (merged.duplicatesCollapsed.length > 0
        ? `, ${merged.duplicatesCollapsed.length} collapsed on identity key`
        : ""),
  );
  merged.frames.forEach((frame) => {
    if (frame.inaccessibleReason) {
      console.warn(
        `EasyFilla(coverage): frame ${frame.frameId} (${frame.url}) INACCESSIBLE — ` +
          `${frame.inaccessibleReason}: ${frame.inaccessibleDetail}`,
      );
    } else {
      debugLog(
        `EasyFilla(coverage): frame ${frame.frameId} depth ${frame.depth} — ${frame.fieldCount} field(s), ` +
          `placed via ${frame.orderMethod}`,
      );
    }
  });
  // The ordering heuristic is best-effort across cross-origin boundaries. When
  // it can't place a frame it says so here rather than emitting a plausible
  // but wrong order silently.
  merged.orderingWarnings.forEach((warning) => console.warn(`EasyFilla(order): ${warning}`));

  const missing = missingOriginsFrom(merged);
  if (missing.length > 0) {
    pendingAccessOrigins = missing;
    grantAccessButton.hidden = false;
    grantAccessButton.textContent =
      missing.length === 1
        ? `Grant EasyFilla access to ${missing[0]} (an embedded part of this form)`
        : `Grant EasyFilla access to ${missing.length} embedded form origins`;
  }
}

openSettingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function getCombinedExtractedText(): string {
  return extractedDocuments.map((doc) => `# ${doc.fileName}\n\n${doc.text}`).join("\n\n---\n\n");
}

function renderQuestions(questions: ExtractedQuestionWithSection[]): void {
  questionsList.innerHTML = "";

  questions.forEach((question, index) => {
    const item = document.createElement("li");
    item.className = "questions-list__item";

    const text = document.createElement("span");
    text.className = "questions-list__text";
    text.textContent = `${index + 1}. ${question.questionText}`;

    const badge = document.createElement("span");
    badge.className = "badge";
    const badgeParts: string[] = [question.type];
    if (question.required) {
      badgeParts.push("required");
    }
    if (question.manualOnly) {
      badgeParts.push("manual only");
    }
    badge.textContent = badgeParts.join(" · ");

    item.append(text, badge);
    questionsList.append(item);
  });
}

// The sidepanel is a separate document from the form tab — a content script
// only auto-injects into tabs that load/navigate *after* the extension is
// registered, so a tab that was already open when the extension was
// installed or reloaded won't have it yet. Re-injecting explicitly here
// means every action works immediately without the user needing to refresh
// that tab first; the content script's own load guard (see its index.ts)
// makes re-injecting into a tab that already has it a harmless no-op.
let injectionTargetUrl: string | null = null;
// The origins (if any) that injection failed on for lack of host access.
// The "Grant access" button reads this synchronously so it can call
// chrome.permissions.request() during its own click gesture — that API is
// rejected if called after any await, so it can NEVER live inside this
// async injection path.
//
// STAGE 2a — a LIST, not one origin. A portal's application iframe is
// routinely on a different origin from the page embedding it; granting only
// the top-level origin leaves the frame holding the actual form unreachable,
// which looked exactly like "this form has no fields".
let pendingAccessOrigins: string[] = [];

function originOf(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  const [contentScript] = chrome.runtime.getManifest().content_scripts ?? [];
  const files = contentScript?.js;
  if (!files || files.length === 0) {
    return;
  }

  try {
    // STAGE 2a — allFrames. This is what reaches forms rendered inside
    // cross-origin iframes (Workday, Taleo, Greenhouse, SuccessFactors),
    // which is how most real application portals are built. Frames whose
    // origin isn't granted are simply not injected; the service worker's
    // reconciliation reports each of them with a reason rather than letting
    // the scan quietly come back short.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
    // Success — clear any prior "needs access" prompt.
    pendingAccessOrigins = [];
    grantAccessButton.hidden = true;
    return;
  } catch (error) {
    // Injection into a non-Google page fails when no host permission covers
    // it. We CANNOT request permission here (we're past the user gesture),
    // so we reveal the Grant-access button, which requests it from its own
    // click handler. Google Forms is covered by manifest host_permissions
    // and never reaches this branch.
    console.warn(
      "EasyFilla: content script injection failed — this site isn't in EasyFilla's granted hosts yet.",
      error,
    );
    const origin = originOf(injectionTargetUrl);
    if (origin) {
      pendingAccessOrigins = [origin];
      grantAccessButton.hidden = false;
      grantAccessButton.textContent = `Grant EasyFilla access to ${origin}`;
    }
  }
}

// permissions.request() is the FIRST statement in this handler, so the click
// gesture is still active when it runs (any await before it would consume the
// gesture and Chrome would throw "must be called during a user gesture").
grantAccessButton.addEventListener("click", () => {
  const origins = pendingAccessOrigins;
  if (origins.length === 0) {
    return;
  }
  chrome.permissions
    .request({ origins: origins.map((origin) => `${origin}/*`) })
    .then((granted) => {
      const list = origins.join(", ");
      if (granted) {
        pendingAccessOrigins = [];
        grantAccessButton.hidden = true;
        setStatus(`Access granted for ${list}. Click Scan (or the action you wanted) again.`);
      } else {
        setStatus(`Access to ${list} was declined — EasyFilla can't read that part of this page without it.`);
      }
    })
    .catch((error) => {
      console.warn("EasyFilla: permission request failed", error);
      setStatus("Couldn't request access for this site.");
    });
});

async function getActiveFormTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || tab.id === undefined) {
    throw new Error("No active tab found.");
  }
  if (!tab.url || !HTTP_URL_PATTERN.test(tab.url)) {
    throw new Error("Open a web page containing a form first, then try again.");
  }

  injectionTargetUrl = tab.url;
  await ensureContentScriptInjected(tab.id);
  return tab.id;
}

async function scanActiveForm(): Promise<void> {
  scanButton.disabled = true;
  questionsList.innerHTML = "";
  setStatus("Scanning…");

  try {
    const result = await orchestrateScan((section, count) => {
      setStatus(`Scanning section ${section} (${count} question${count === 1 ? "" : "s"})…`);
    });
    renderQuestions(result.questions);
    // STAGE 2a — the coverage line now states the frame breakdown, so a scan
    // that only reached part of an iframed portal says so up front instead of
    // presenting a short field list as if it were the whole form.
    const blocked = lastFrameCoverage?.frames.filter((frame) => frame.inaccessibleReason) ?? [];
    const frameNote = lastFrameCoverage
      ? `; ${describeFrameBreakdown(lastFrameCoverage)}` +
        (blocked.length > 0
          ? ` — unreadable: ${blocked.map((frame) => `${frame.url || `frame ${frame.frameId}`} (${frame.inaccessibleReason})`).join(", ")}`
          : "")
      : "";
    setStatus(
      `${result.questions.length} question${result.questions.length === 1 ? "" : "s"} found ` +
        `(${describeSectionCoverage(result)}${frameNote}).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't scan this page. Make sure a form is open in the active tab, then try again.";
    setStatus(message);
  } finally {
    scanButton.disabled = false;
  }
}

interface UploadedFileRow {
  file: File;
  listItem: HTMLLIElement;
  statusBadge: HTMLSpanElement;
  progressText: HTMLParagraphElement;
  previewText: HTMLPreElement;
}

function createUploadedFileRow(file: File): UploadedFileRow {
  const listItem = document.createElement("li");
  listItem.className = "uploaded-files-list__item";

  const row = document.createElement("div");
  row.className = "uploaded-files-list__row";

  const name = document.createElement("span");
  name.className = "uploaded-files-list__name";
  name.textContent = file.name;

  const statusBadge = document.createElement("span");
  statusBadge.className = "badge";
  statusBadge.textContent = "Pending";

  row.append(name, statusBadge);

  const progressText = document.createElement("p");
  progressText.className = "uploaded-files-list__progress";

  const details = document.createElement("details");
  details.className = "uploaded-files-list__preview";
  const summary = document.createElement("summary");
  summary.textContent = "Extracted text";
  const previewText = document.createElement("pre");
  details.append(summary, previewText);

  listItem.append(row, progressText, details);

  return { file, listItem, statusBadge, progressText, previewText };
}

async function processUploadedFile(row: UploadedFileRow): Promise<void> {
  row.statusBadge.textContent = "Extracting…";

  try {
    const text = await extractText(row.file, (update: ExtractionProgress) => {
      const percent = Math.round(update.progress * 100);
      row.progressText.textContent = `${update.stage} (${percent}%)`;
    });

    row.statusBadge.textContent = "Done";
    row.progressText.textContent = `Extracted ${text.length} characters.`;
    row.previewText.textContent = text || "(no text found)";

    // B4 — this used to dump the ENTIRE extracted text of every uploaded
    // document to the console: passport numbers, national IDs, addresses,
    // dates of birth. A user pasting their console into a bug report was
    // pasting their identity documents with it.
    //
    // The diagnostic it existed for was "did the contact block survive
    // extraction?", which the LENGTH and emptiness answer just as well. The
    // text itself is never logged, at any debug level — the debug flag is a
    // volume control, not a confidentiality boundary.
    console.log(`EasyFilla(extract): "${row.file.name}" — ${text.length} chars of text recovered.`);
    if (text.trim().length === 0) {
      row.progressText.textContent =
        "No text could be read from this file (image-only or empty). Contact matching may fail — try a text-based copy.";
    }

    // Retain every uploaded file (even ones with no extractable text, e.g. a
    // scanned-image CV) so it can still be ATTACHED to a file-upload
    // question; the text — when present — also feeds Gemini.
    extractedDocuments.push({ fileName: row.file.name, text, file: row.file });
    markExtraction(row.file, text.trim() ? "ok" : "empty", `${text.length} chars`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't read text from that file. Try a different copy, or upload it anyway — the AI can read scans directly.";
    row.statusBadge.textContent = "Error";
    // Local extraction failing is no longer fatal to this file: Stage A reads
    // the original bytes and does not depend on this text at all.
    row.progressText.textContent = `${message} — the AI will still read this file directly.`;
    markExtraction(row.file, "failed", message);
  }
}

async function handleFileSelection(files: FileList | null): Promise<void> {
  // ACCUMULATE, never replace. Previously this wiped `extractedDocuments` and
  // the list on every selection, so uploading 2 more files silently destroyed
  // the 5 already processed. Files now add to the existing set; re-selecting
  // the same file (same name+size) is ignored rather than duplicated.
  if (!files || files.length === 0) {
    return;
  }

  const incoming = Array.from(files);
  const existingKeys = new Set(extractedDocuments.map((doc) => `${doc.fileName}:${doc.file.size}`));
  const fresh = incoming.filter((file) => !existingKeys.has(`${file.name}:${file.size}`));
  const duplicates = incoming.length - fresh.length;
  if (duplicates > 0) {
    console.log(`EasyFilla(upload): skipped ${duplicates} already-uploaded file(s).`);
  }
  if (fresh.length === 0) {
    setUploadSummary();
    return;
  }

  // Registered up front, so a later extraction failure cannot remove the file
  // from Stage A's input.
  fresh.forEach((file) => rawUploads.push({ file, extraction: "failed", detail: "not processed yet" }));

  const rows = fresh.map((file) => {
    const row = createUploadedFileRow(file);
    uploadedFilesList.append(row.listItem);
    return row;
  });

  // Processed one at a time: each OCR pass spins up a Tesseract worker
  // (WASM + language data), and running several concurrently would compete
  // for the same CPU/memory budget for no real throughput gain.
  for (const row of rows) {
    await processUploadedFile(row);
  }

  // Deterministic profile extraction (Problem 1.2) — runs once per upload,
  // no model call. Reuses the stored profile (with the user's manual edits)
  // when the document set is unchanged.
  if (extractedDocuments.length > 0) {
    profile = await buildOrReuseProfile(extractedDocuments.map((d) => ({ fileName: d.fileName, text: d.text })));
  } else {
    profile = null;
  }

  setUploadSummary();
  // Allow re-selecting the same file later (the input keeps its value
  // otherwise, and the change event wouldn't fire again).
  documentUpload.value = "";
}

// The AI step is bounded end-to-end. Per-request timeouts alone don't cap it:
// the queue's retries and rate-limit pacing can legitimately stack into many
// minutes, and the user has no way to tell that apart from a dead panel. When
// this fires, the affected questions become error_retry (never "not found"),
// the report is still produced, and the locally-resolved answers are untouched.
const AI_STEP_DEADLINE_MS = 6 * 60_000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new GeminiRequestError(
            `Gemini didn't finish within ${Math.round(ms / 60_000)} minutes. ` +
              "Your locally-answered fields are kept — use Retry for the rest.",
            true,
            "network",
          ),
        ),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// Semantic keys the dossier outranks Tier 0 on. Deliberately limited to
// identity and contact: those are the fields the dossier is demonstrably better
// at (labelled sheets, passport MRZ read from an image) and the ones where a
// confident wrong answer does the most damage on a real application.
const DOSSIER_PRIORITY_KEYS: Record<string, string[]> = {
  name: ["full_name", "name"],
  first_name: ["first_name", "given_name", "full_name"],
  last_name: ["last_name", "surname", "family_name", "full_name"],
  email: ["email", "email_address"],
  phone: ["phone", "phone_number", "mobile"],
  address: ["address", "current_location", "location"],
  city: ["city"],
  country: ["country"],
  nationality: ["nationality", "citizenship"],
  dob: ["date_of_birth", "dob", "birth_date"],
  gender: ["gender", "sex"],
  passport: ["passport_number", "passport"],
  id: ["national_id", "student_id", "id_number"],
  url: ["linkedin", "github", "website", "portfolio"],
};

type Reconciliation =
  | { kind: "tier0" }
  | { kind: "dossier"; dossierValue: string; dossierSource: string; dossierConfidence: string }
  | { kind: "conflict"; dossierValue: string; dossierSource: string; dossierConfidence: string };

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@+]/g, "");
}

// Decides between a Tier 0 profile value and the dossier's value for the same
// semantic field. Tier 0 keeps the field ONLY on a verbatim exact-label match
// ("labelled" rule) that agrees, or when the dossier has nothing to say.
function reconcileWithDossier(
  dossier: Dossier | null,
  key: string,
  tier0Value: string,
  tier0Source: string,
  tier0Rule: string | undefined,
): Reconciliation {
  const candidates = DOSSIER_PRIORITY_KEYS[key];
  if (!dossier || !candidates) {
    return { kind: "tier0" };
  }

  const pool = { ...dossier.identity, ...dossier.contact };
  const hit = candidates.map((name) => pool[name]).find((entry) => entry?.value?.trim());
  if (!hit) {
    return { kind: "tier0" };
  }

  const dossierValue = hit.value.trim();
  const info = { dossierValue, dossierSource: hit.source_filename, dossierConfidence: hit.confidence };

  // Agreement — no conflict to surface. Keep Tier 0's value (it's already
  // shaped for the form) but the dossier has corroborated it.
  if (normalizeForCompare(dossierValue) === normalizeForCompare(tier0Value)) {
    return { kind: "tier0" };
  }

  // A dossier value that is a strict expansion of the Tier 0 one (e.g. the
  // full name vs the first two words) is a refinement, not a disagreement.
  const a = normalizeForCompare(dossierValue);
  const b = normalizeForCompare(tier0Value);
  if (a.includes(b) || b.includes(a)) {
    return a.length >= b.length ? { kind: "dossier", ...info } : { kind: "tier0" };
  }

  // A verbatim labelled match in Tier 0 is the one case it outranks the
  // dossier — a "Full Name | X" table row read locally is hard evidence.
  // But a labelled-vs-labelled disagreement is still a genuine conflict.
  if (tier0Rule === "labelled" && hit.confidence !== "high") {
    console.log(
      `EasyFilla(reconcile): ${key} — keeping Tier 0 "${tier0Value}" (verbatim labelled match from ` +
        `${tier0Source}) over dossier "${dossierValue}" (${hit.confidence} confidence).`,
    );
    return { kind: "tier0" };
  }

  return { kind: "conflict", ...info };
}

function dossierAnswerOptions(): { language?: AnswerLanguage } {
  const language = effectiveAnswerLanguage();
  return language ? { language } : {};
}

// "Dossier: N files, M facts extracted" — the single line that tells the user
// whether answering will cost a Stage-A request or reuse cached work.
async function refreshDossierStatus(): Promise<void> {
  const cached = await loadCachedDossier();
  const fileCount = rawUploads.length;
  rebuildDossierButton.disabled = fileCount === 0;

  if (!cached) {
    dossierStatusText.textContent =
      fileCount === 0 ? "Dossier: not built yet." : `Dossier: not built yet — will be built from ${fileCount} file(s) on the next report.`;
    return;
  }

  const currentKey = await fileSetKey(rawUploads.map((u) => u.file));
  const stale = cached.key !== currentKey;
  dossierStatusText.textContent = stale
    ? `Dossier: out of date (built from ${cached.fileCount} file(s)). Your files changed — it rebuilds on the next report.`
    : `Dossier: ${cached.fileCount} files, ${cached.factCount} facts extracted (${cached.model}, cached — 0 requests to reuse).`;
}

rebuildDossierButton.addEventListener("click", () => {
  void (async () => {
    rebuildDossierButton.disabled = true;
    dossierStatusText.textContent = "Rebuilding dossier…";
    try {
      await clearDossier();
      await buildDossier(dossierInputs(), (stage) => {
        dossierStatusText.textContent = stage;
      });
      await refreshDossierStatus();
    } catch (error) {
      dossierStatusText.textContent = `Dossier rebuild failed: ${describeGeminiError(error)}`;
      console.error("[EasyFilla][Dossier] rebuild failed", error);
    } finally {
      rebuildDossierButton.disabled = rawUploads.length === 0;
    }
  })();
});

// Shows the running total so it's obvious files accumulate rather than replace.
//
// E3d.3 — it also states the ACTIVE PROVIDER'S size ceiling and how close this
// upload set is to it, BEFORE a run. Two reasons: the ceilings differ per
// provider (18 MB Gemini vs 32 MB Anthropic), so the same file set can be fine
// on one and rejected on the other; and neither number has been tested against
// a real upload (§7), so showing it lets a wrong constant be spotted rather
// than discovered as a mysterious failure mid-run.
function setUploadSummary(): void {
  const count = extractedDocuments.length;
  const chars = extractedDocuments.reduce((sum, doc) => sum + doc.text.length, 0);
  if (count === 0) {
    uploadSummaryText.textContent = "";
  } else {
    const base = `${count} document${count === 1 ? "" : "s"} loaded (${chars.toLocaleString()} characters). Adding more keeps these.`;
    uploadSummaryText.textContent = base;
    // Async, appended when it resolves — the count must not wait on a
    // storage read to paint.
    void (async () => {
      const provider = await activeProvider();
      // base64 inflates by 4/3, so the budget is measured on ENCODED bytes —
      // measuring raw would let a set through that 400s on arrival (§2).
      const rawBytes = rawUploads.reduce((sum, upload) => sum + upload.file.size, 0);
      const encoded = Math.ceil((rawBytes * 4) / 3);
      const ceiling = provider.capabilities.maxInlineRequestBytes;
      const pct = Math.round((encoded / ceiling) * 100);
      const detail =
        `~${(encoded / 1024 / 1024).toFixed(1)} MB of ${provider.displayName}'s ` +
        `${(ceiling / 1024 / 1024).toFixed(0)} MB request limit (${pct}%)` +
        (encoded > ceiling
          ? provider.capabilities.supportsFilesApi
            ? " — over the inline budget, so these will be uploaded first."
            : " — OVER THE LIMIT. Remove or downscale the largest files."
          : "");
      uploadSummaryText.textContent = `${base} ${detail}`;
    })();
  }
  exportDiagnosticsButton.disabled = getExtractionDiagnostics().length === 0;
  void refreshDossierStatus();
}

exportDiagnosticsButton.addEventListener("click", () => {
  const report = buildDiagnosticsReport(profile);
  downloadDiagnosticsReport(report);
  console.log(`EasyFilla(diagnostics): exported report (${report.length} chars) for ${getExtractionDiagnostics().length} document(s).`);
});

scanButton.addEventListener("click", () => {
  void scanActiveForm();
});

clearFilesButton.addEventListener("click", () => {
  void (async () => {
    extractedDocuments = [];
    rawUploads = [];
    profile = null;
    uploadedFilesList.innerHTML = "";
    documentUpload.value = "";
    // The stored profile is DERIVED from these documents and is keyed by the
    // document set — without clearing it, re-uploading the same files would
    // reuse the old (possibly mis-parsed) values instead of re-extracting.
    await clearProfile();
    // The dossier is DERIVED from these files; keeping it would answer the next
    // form from documents the user just removed.
    await clearDossier();
    setUploadSummary();
    console.log("EasyFilla(upload): cleared all uploaded documents and the derived profile.");
  })();
});

documentUpload.addEventListener("change", () => {
  void handleFileSelection(documentUpload.files);
});

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on a delay rather than immediately after click(): some browsers
  // process the download asynchronously and revoking too early can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A separate, longer-lived object URL from the one-shot download above —
// this one stays open in the sidepanel so the user can (re)open the PDF to
// review it before acting on it, per the review-before-fill requirement.
// Only revoked when a newer PDF replaces it in the same slot.
const activeLinkUrls = new Map<HTMLDivElement, string>();

function renderDownloadLink(container: HTMLDivElement, blob: Blob, fileName: string, label: string): void {
  const previousUrl = activeLinkUrls.get(container);
  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }

  const url = URL.createObjectURL(blob);
  activeLinkUrls.set(container, url);

  container.innerHTML = "";
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.target = "_blank";
  link.rel = "noopener";
  link.className = "pdf-link";
  link.textContent = label;
  container.append(link);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// chrome.tabs.sendMessage rejects when there's no receiver — which is a
// NORMAL, expected state mid-navigation (the old page's script is gone, the
// new page's isn't attached yet), so it's mapped to undefined for the retry
// loops below rather than treated as an error.
async function sendToTab<T>(
  tabId: number,
  request:
    | GetSectionInfoRequest
    | ClickNavRequest
    | FillCurrentSectionRequest
    | ScrollToQuestionRequest
    | RevealFrameRequest,
  // STAGE 2a — ROUTING. Every message that acts on a field names the frame
  // that owns it. Broadcasting (omitting frameId) delivers to every frame at
  // once, so two frames holding an identically-labelled "Country" would both
  // fuzzy-match and both fill it. Only genuinely page-wide queries may omit it.
  frameId?: number,
): Promise<T | undefined> {
  try {
    const options = frameId === undefined ? undefined : { frameId };
    return (await chrome.tabs.sendMessage(tabId, request, options)) as T | undefined;
  } catch {
    return undefined;
  }
}

// STAGE 2a — the sidepanel no longer talks to "the content script"; on a
// portal there are several. It asks the service worker, which owns the frame
// registry, to enumerate the real frame tree, fan out, reconcile the frames
// that stayed silent, and merge everything into one ordered question list.
async function requestMergedScan(tabId: number): Promise<MergedScan | null> {
  try {
    const request: ScanAllFramesRequest = { type: MESSAGE_TYPE.SCAN_ALL_FRAMES, tabId };
    const merged = (await chrome.runtime.sendMessage(request)) as MergedScan | undefined;
    return merged ?? null;
  } catch (error) {
    console.warn("EasyFilla: the service worker didn't answer the frame scan request.", error);
    return null;
  }
}

// A merged scan is "usable" once at least one frame reported. A page whose
// every frame is silent is a genuine failure and keeps retrying; a page where
// the top frame answered and a child is still loading is not.
function anyFrameScanned(merged: MergedScan | null): merged is MergedScan {
  return Boolean(merged && merged.frames.some((frame) => frame.scanned));
}

async function getSectionInfoWithRetry(tabId: number, timeoutMs: number): Promise<MergedScan | null> {
  const start = Date.now();
  let last: MergedScan | null = null;
  while (Date.now() - start < timeoutMs) {
    await ensureContentScriptInjected(tabId);
    const merged = await requestMergedScan(tabId);
    if (anyFrameScanned(merged)) {
      return merged;
    }
    last = merged;
    await sleep(SETTLE_POLL_MS);
  }
  return last;
}

// After a nav click, waits until the visible section is structurally
// different from the one we left. Handles BOTH ways Google Forms moves
// between sections — an in-place DOM swap and a full page navigation — by
// simply re-injecting and re-asking until the fingerprint changes.
//
// STAGE 2a — the fingerprint is now computed across ALL frames, so a step
// change inside an embedded application frame counts as a section change even
// when the hosting page never moves.
async function waitForDifferentSection(tabId: number, previousFingerprint: string): Promise<MergedScan | null> {
  const start = Date.now();
  while (Date.now() - start < SECTION_SETTLE_TIMEOUT_MS) {
    await sleep(SETTLE_POLL_MS);
    await ensureContentScriptInjected(tabId);
    const merged = await requestMergedScan(tabId);
    if (anyFrameScanned(merged) && merged.fingerprint !== previousFingerprint) {
      return merged;
    }
  }
  return null;
}

interface SectionDriveOutcome {
  sectionsVisited: number;
  stoppedEarly: boolean;
  blockedAtSection: number | null;
}

// The multi-section traversal loop, living HERE in the sidepanel — not in
// the content script — because clicking "Next" on a Google Form can trigger
// a real page navigation that destroys the content script's execution
// context. A loop inside the content script dies at the first such
// navigation (losing everything it collected and stranding the user
// mid-form); this loop survives it, re-attaching to the fresh page each step.
async function driveSections(
  tabId: number,
  onSection: (info: MergedScan, sectionNumber: number) => Promise<void> | void,
): Promise<SectionDriveOutcome> {
  let info = await getSectionInfoWithRetry(tabId, SECTION_SETTLE_TIMEOUT_MS);
  if (!info) {
    throw new Error("The form tab didn't respond. Try reloading it, then run this again.");
  }

  let sectionsVisited = 0;
  let stoppedEarly = false;
  let blockedAtSection: number | null = null;
  let advances = 0;

  for (let section = 1; section <= MAX_SECTIONS; section += 1) {
    console.log(
      `EasyFilla: Section ${section} — ${info.questions.length} question(s) across ` +
        `${info.frames.filter((frame) => frame.scanned).length} frame(s), hasNext=${info.hasNext}` +
        (info.navFrameId !== null ? ` (nav in frame ${info.navFrameId})` : ""),
    );
    await onSection(info, section);
    sectionsVisited = section;

    if (!info.hasNext) {
      break;
    }

    // STAGE 2a — the Next/Continue control frequently lives in the PARENT page
    // chrome while the fields live in the embedded application frame. The
    // worker searched every frame and preferred the one that owns fields; the
    // submit-safety guard is unchanged and runs inside whichever frame this
    // reaches, so routing can't weaken it.
    const clickResult = await sendToTab<ClickNavResponse>(
      tabId,
      { type: MESSAGE_TYPE.CLICK_NAV, direction: "next" },
      info.navFrameId ?? undefined,
    );
    if (!clickResult?.clicked) {
      stoppedEarly = true;
      blockedAtSection = section;
      // Expected stop condition (no confident/clickable "Next"), not an error —
      // logged at info level so it doesn't surface on chrome://extensions.
      // The UI reports this via describeSectionCoverage().
      console.log(`EasyFilla: reached section ${section} with no further "Next" — stopping traversal here.`);
      break;
    }

    const nextInfo = await waitForDifferentSection(tabId, info.fingerprint);
    if (!nextInfo) {
      stoppedEarly = true;
      blockedAtSection = section;
      // Expected stop condition, NOT an error: Google Forms blocks "Next"
      // until required questions on this section are answered. Info-level so
      // it stays out of the extensions Errors page; surfaced to the user in
      // the scan status instead.
      console.log(
        `EasyFilla: section ${section} didn't advance after "Next" — an unanswered required question there is ` +
          `blocking navigation. Scanning what's reachable and stopping (this is expected, not an error).`,
      );
      break;
    }
    info = nextInfo;
    advances += 1;
  }

  console.log(`EasyFilla: traversal done — ${sectionsVisited} section(s) visited; walking back ${advances} step(s)…`);

  for (let i = 0; i < advances; i += 1) {
    const current = await getSectionInfoWithRetry(tabId, SECTION_SETTLE_TIMEOUT_MS);
    if (!current) {
      // Info-level: a restore hiccup, not a crash. The user may end on a
      // different section; not an "error" worth the extensions Errors page.
      console.log("EasyFilla: lost contact with the form tab while restoring the original section.");
      break;
    }
    const backResult = await sendToTab<ClickNavResponse>(
      tabId,
      { type: MESSAGE_TYPE.CLICK_NAV, direction: "back" },
      current.navFrameId ?? undefined,
    );
    if (!backResult?.clicked) {
      console.log(`EasyFilla: couldn't click "Back" while restoring (${advances - i} step(s) remaining).`);
      break;
    }
    await waitForDifferentSection(tabId, current.fingerprint);
  }

  return { sectionsVisited, stoppedEarly, blockedAtSection };
}

interface OrchestratedScanResult {
  formTitle: string;
  questions: ExtractedQuestionWithSection[];
  sectionTitles: Map<number, string>;
  sectionsScanned: number;
  stoppedEarly: boolean;
  blockedAtSection: number | null;
}

// Resolves the form's language once per scan, in the spec's priority order:
// html lang / hl= param → Unicode script heuristic → Gemini probe (only when
// still undetermined and a key exists). Records the result so the sidepanel
// can display it and offer an override.
async function resolveFormLanguage(langHint: string | null, questionLabels: string[]): Promise<void> {
  const fromHint = normalizeLangCode(langHint);
  if (fromHint && fromHint !== "und") {
    detectedLanguage = { code: fromHint, direction: directionForCode(fromHint), source: langHint?.includes("hl") ? "hl-param" : "html-lang" };
    console.log(`EasyFilla: language ${fromHint} (from lang hint "${langHint}")`);
    applyLanguageToUi();
    return;
  }

  const fromScript = detectLanguageFromText(questionLabels);
  if (fromScript && fromScript.code !== "und") {
    detectedLanguage = fromScript;
    console.log(`EasyFilla: language ${fromScript.code} (script heuristic)`);
    applyLanguageToUi();
    return;
  }

  // Latin-script or too-little-text: try the LLM probe, but never block on
  // it — undetermined just means "answer in the questions' language".
  const fromLlm = await detectLanguageWithGemini(questionLabels).catch(() => null);
  if (fromLlm) {
    detectedLanguage = { code: fromLlm, direction: directionForCode(fromLlm), source: "llm" };
    console.log(`EasyFilla: language ${fromLlm} (Gemini probe)`);
  } else {
    detectedLanguage = fromScript ?? { code: "und", direction: "ltr", source: "default" };
    console.log("EasyFilla: language undetermined — answers will follow the questions' language.");
  }
  applyLanguageToUi();
}

async function orchestrateScan(onProgress?: (sectionNumber: number, questionCount: number) => void): Promise<OrchestratedScanResult> {
  const tabId = await getActiveFormTabId();

  let formTitle = "";
  let firstLangHint: string | null = null;
  const questions: ExtractedQuestionWithSection[] = [];
  const sectionTitles = new Map<number, string>();

  const outcome = await driveSections(tabId, (info, section) => {
    formTitle = info.formTitle;
    if (section === 1) {
      firstLangHint = info.langHint;
    }
    // STAGE 2a — per-frame breakdown, plus the Grant-access prompt for any
    // embedded origin we couldn't reach.
    reportFrameCoverage(info);
    if (info.sectionTitle) {
      sectionTitles.set(section, info.sectionTitle);
    }
    // frameId / frameGeneration / identityKey ride along on every question so
    // the eventual answer can be routed back to the frame that owns the field.
    info.questions.forEach((question) => {
      questions.push({
        ...question,
        section,
        frameId: question.frameId,
        frameGeneration: question.frameGeneration,
        frameUrl: question.frameUrl,
        identityKey: question.identityKey,
      });
    });
    onProgress?.(section, info.questions.length);
  });

  if (questions.length === 0) {
    // STAGE 2a — "no questions" on a portal is almost never an empty form; it
    // is a frame we couldn't get into. Naming the frame and the reason is the
    // difference between a dead end and an actionable one (usually: grant
    // access to the embedded origin).
    const blocked = lastFrameCoverage?.frames.filter((frame) => frame.inaccessibleReason) ?? [];
    if (blocked.length > 0) {
      const detail = blocked
        .map((frame) => `${frame.url || `frame ${frame.frameId}`} — ${frame.inaccessibleDetail}`)
        .join("; ");
      throw new Error(
        `No questions could be read. ${blocked.length} embedded frame(s) on this page couldn't be reached: ${detail}`,
      );
    }
    throw new Error("No questions were found on this form.");
  }

  // Only auto-detect if the user hasn't pinned an override this session.
  if (!languageOverride) {
    await resolveFormLanguage(
      firstLangHint,
      questions.map((question) => question.questionText).filter(Boolean),
    );
  }

  console.log(
    `EasyFilla: scan complete — ${questions.length} question(s) across ${outcome.sectionsVisited} section(s), ` +
      `language=${effectiveLanguageCode()}.`,
  );

  return {
    formTitle,
    questions,
    sectionTitles,
    sectionsScanned: outcome.sectionsVisited,
    stoppedEarly: outcome.stoppedEarly,
    blockedAtSection: outcome.blockedAtSection,
  };
}

function describeSectionCoverage(result: OrchestratedScanResult): string {
  const sectionWord = result.sectionsScanned === 1 ? "section" : "sections";
  if (result.stoppedEarly) {
    return (
      `only ${result.sectionsScanned} ${sectionWord} could be reached automatically — blocked after ` +
      `section ${result.blockedAtSection} (likely an unanswered required question there blocking "Next")`
    );
  }
  return `${result.sectionsScanned} ${sectionWord} scanned`;
}

async function exportFormToPdf(): Promise<void> {
  generatePdfButton.disabled = true;
  setGenerateStatus("Scanning form…");

  try {
    const result = await orchestrateScan((section) => {
      setGenerateStatus(`Scanning section ${section}…`);
    });

    setGenerateStatus("Building PDF…");
    const blob = generateStructuredPdf(result.formTitle, result.questions, {
      sectionTitles: result.sectionTitles,
      logoDataUrl,
    });
    const fileName = `easyfilla-form-export-${Date.now()}.pdf`;
    downloadBlob(blob, fileName);
    renderDownloadLink(exportPdfLinkContainer, blob, fileName, "Open exported PDF");

    setGenerateStatus(
      `PDF downloaded — ${result.questions.length} question(s), ${describeSectionCoverage(result)}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't export the form to PDF.";
    setGenerateStatus(message);
  } finally {
    generatePdfButton.disabled = false;
  }
}

generatePdfButton.addEventListener("click", () => {
  void exportFormToPdf();
});

// STAGE 3 — the pre-flight prompt. Shown BEFORE any request is made, so a run
// that cannot finish is never started. "Answer the first N now" is offered
// instead of failing midway, because a partial report the user CHOSE is very
// different from one that stopped when the quota ran out.
type BudgetDecision = "partial" | "cancel";

function awaitBudgetDecision(result: PreflightResult): Promise<BudgetDecision> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "manual-attach";

    const msg = document.createElement("p");
    msg.className = "manual-attach__msg";
    msg.textContent = result.message;

    const partial = document.createElement("button");
    partial.type = "button";
    partial.className = "btn btn--primary";
    partial.textContent = `Answer the first ${result.answerableQuestions} question(s) now`;
    partial.disabled = result.answerableQuestions === 0;

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel — don't spend any requests";

    const finish = (decision: BudgetDecision): void => {
      wrap.remove();
      resolve(decision);
    };
    partial.addEventListener("click", () => finish("partial"));
    cancel.addEventListener("click", () => finish("cancel"));

    wrap.append(msg, partial, cancel);
    aiReportStatus.after(wrap);
  });
}

async function generateAiAnsweredReport(): Promise<void> {
  generateAiReportButton.disabled = true;
  setAiReportStatus("Scanning form…");
  // Set by the pre-flight when the user opts to answer only what fits in the
  // remaining daily budget. 0 = no cap.
  let budgetQuestionCap = 0;

  try {
    if (rawUploads.length === 0) {
      throw new Error("Upload at least one document first, so there's something for the AI to check against.");
    }

    const response = await orchestrateScan((section) => {
      setAiReportStatus(`Scanning section ${section}…`);
    });
    const sectionTitles = response.sectionTitles;

    const answers = new Map<number, string>();
    const suggestions = new Map<number, string>();
    const categories = new Map<number, "not_in_documents" | "personal">();
    const states = new Map<number, AnswerState>();
    const sources = new Map<number, string>();

    // FIX 1: strict tiers — the API is the LAST resort, not the first.
    // TIER 0 (profile, zero API) → TIER 1 (declarations, zero API) → TIER 2
    // (API, only for what's left). This is what stops one quota failure from
    // destroying a whole report.
    // PRECEDENCE INVERSION — the dossier is built BEFORE tiering, not after.
    //
    // Tier 0 is the layer that answered "Full name" with "Computer Engineering"
    // sourced to a student status letter and labelled it "Answered from
    // documents". Nothing downstream could correct that, because Tier 0 short-
    // circuited the question entirely. The dossier reads images and is told to
    // prefer labelled key-value rows, so on identity/contact it is strictly
    // better informed and now outranks Tier 0 there.
    //
    // A Stage-A failure is NOT fatal: tiering proceeds on the profile alone,
    // exactly as before, just without the cross-check.
    // ── STAGE 3: PRE-FLIGHT ──────────────────────────────────────────────
    // Estimate the spend BEFORE anything is spent. Failing halfway burns quota
    // AND leaves a partial report the user didn't ask for. The question count
    // here is an UPPER BOUND (tiering has not run yet and will only reduce it),
    // which is the safe side to err on for a budget check.
    const cachedKey = await fileSetKey(rawUploads.map((upload) => upload.file));
    // Cached only counts if it's the cache for THESE files — the dossier cache
    // keys on a content hash of the file set, so a different upload invalidates.
    const dossierAlreadyCached = (await loadCachedDossier())?.key === cachedKey;
    const upperBoundQuestions = response.questions.filter(
      (question) =>
        !question.manualOnly && question.type !== "file_upload" && !GRID_QUESTION_TYPES.has(question.type),
    ).length;

    const budget = await preflight(await loadLedger(), {
      fileCount: rawUploads.length,
      questionCount: upperBoundQuestions,
      chunkSize: DEFAULT_QUESTION_CHUNK,
      dossierCached: dossierAlreadyCached,
    });
    console.log(`EasyFilla(budget): pre-flight — ${budget.verdict}: ${budget.message}`);

    if (budget.verdict === "exceeds") {
      const decision = await awaitBudgetDecision(budget);
      if (decision === "cancel") {
        setAiReportStatus(
          `Cancelled before spending anything. ${budget.message}`,
        );
        return;
      }
      if (decision === "partial") {
        budgetQuestionCap = budget.answerableQuestions;
        console.log(
          `EasyFilla(budget): proceeding with the first ${budgetQuestionCap} question(s) to stay inside ` +
            "today's remaining quota.",
        );
      }
    }

    let stageADossier: Dossier | null = null;
    let dossierFromCache = false;
    setAiReportStatus("Preparing your document dossier…");
    try {
      const built = await withDeadline(
        buildDossier(dossierInputs(), (stage) => setAiReportStatus(stage)),
        AI_STEP_DEADLINE_MS,
      );
      stageADossier = built.dossier;
      dossierFromCache = built.fromCache;
      await refreshDossierStatus();
    } catch (error) {
      console.warn(
        `[EasyFilla][Dossier] Stage A unavailable (${describeGeminiError(error)}) — ` +
          "continuing with the local profile only. Identity fields will not be cross-checked.",
        error,
      );
      setConnectionStatus(`Dossier unavailable: ${describeGeminiError(error)}`, true);
    }

    setAiReportStatus("Resolving locally (profile & standard declarations)…");
    const CHOICE_TYPES = new Set([
      "multiple_choice",
      "checkboxes",
      "dropdown",
      "linear_scale",
      "multiple_choice_grid",
      "checkbox_grid",
    ]);
    const resolvedLocally = new Set<number>();
    let tier0Count = 0;
    let tier1Count = 0;
    const declarationDefaults = await loadDeclarationDefaults();

    response.questions.forEach((question, index) => {
      if (question.manualOnly) {
        states.set(index, "manual_only");
        return;
      }
      if (GRID_QUESTION_TYPES.has(question.type) || question.type === "file_upload") {
        return; // handled separately below
      }
      const isChoice = CHOICE_TYPES.has(question.type);

      // TIER 0 — profile match (zero API, sensitive fields never transmitted).
      const multiSelect = question.type === "checkboxes" || question.type === "checkbox_grid";
      const match = matchQuestionToProfile(
        question.questionText,
        profile,
        isChoice,
        question.options ?? [],
        multiSelect,
      );
      if (match) {
        resolvedLocally.add(index);
        if (match.constrainedNoValue) {
          // Composite/constrained control we can't fill with a real option
          // (E4, e.g. a "Phone Number" dropdown): needs input, but NOT sent
          // to the API and never stuffed with a non-option value.
          states.set(index, "needs_user_input");
          debugLog(`EasyFilla(tier): Q${index} → TIER0 needs_user_input (constrained ${match.key}, no option) — no API`);
          return;
        }
        // Cross-check identity/contact against the dossier before trusting it.
        const verdict = reconcileWithDossier(stageADossier, match.key, match.value, match.source, match.rule);
        if (verdict.kind === "conflict") {
          states.set(index, "conflicting_sources");
          suggestions.set(index, verdict.dossierValue);
          sources.set(
            index,
            `local extraction says "${match.value}" (${match.source || "documents"}); ` +
              `document dossier says "${verdict.dossierValue}" (${verdict.dossierSource})`,
          );
          // B4 — a conflict IS worth an ungated warning (the user must resolve
          // it), but the two candidate VALUES are document-derived personal
          // data and are not printed. They are already shown in the review UI,
          // which is where the user resolves the conflict anyway.
          console.warn(
            `EasyFilla(tier): Q${index} "${question.questionText}" — CONFLICTING SOURCES for ${match.key}:
` +
              `  Tier 0  : [rule=${match.rule ?? "n/a"}, source=${match.source || "unknown"}]
` +
              `  Dossier : [confidence=${verdict.dossierConfidence}, source=${verdict.dossierSource}]
` +
              "  → surfaced for confirmation in the review panel; NEITHER presented as document-sourced. " +
              "(Values withheld from the console — they are your document data.)",
          );
          return;
        }

        const finalValue = verdict.kind === "dossier" ? verdict.dossierValue : match.value;
        // B-FIX 2: no "your documents" fallback. Tier 0 either knows the file it
        // read the value from, or it has no provenance and must not claim any.
        const finalSource =
          verdict.kind === "dossier"
            ? verdict.dossierSource
            : match.source === "manual"
              ? "your profile"
              : match.source;
        answers.set(index, finalValue);
        states.set(
          index,
          deriveState({
            hasValue: true,
            ...(finalSource ? { source: finalSource } : {}),
            userProvided: match.source === "manual",
          }),
        );
        if (finalSource) {
          sources.set(index, finalSource);
        }
        tier0Count += 1;
        // B4 — gated AND value-free. The field, the key and the source file are
        // what make this diagnostic useful; the resolved value is the user's
        // passport/ID/DOB and is never printed.
        debugLog(
          `EasyFilla(tier): Q${index} "${question.questionText}" → ${verdict.kind === "dossier" ? "DOSSIER" : "TIER0"} ` +
            `${match.key} (${finalValue.length} chars) [${finalSource}]` +
            (SENSITIVE_KEYS.has(match.key) ? " (sensitive — NOT sent to API)" : "") +
            " — no API",
        );
        return;
      }

      // TIER 1 — standard declarations (zero API). Prefilled from reusable
      // defaults when set (AI_DRAFT_VERIFY), else needs user input.
      const decl = detectDeclaration(question.questionText);
      if (decl) {
        resolvedLocally.add(index);
        tier1Count += 1;
        const def = declarationDefaults[decl];
        if (def) {
          suggestions.set(index, def);
          states.set(index, "ai_draft_verify");
          debugLog(`EasyFilla(tier): Q${index} → TIER1 declaration "${decl}" prefilled from your default — no API`);
        } else {
          states.set(index, "needs_user_input");
          debugLog(`EasyFilla(tier): Q${index} → TIER1 declaration "${decl}" (set a default in Options) — no API`);
        }
      }
    });

    // TIER 2 — API, only for questions no tier resolved.
    const allQuestionsForAi: QuestionForAi[] = response.questions
      .map((question, index) => ({ question, index }))
      .filter(
        ({ question, index }) =>
          !GRID_QUESTION_TYPES.has(question.type) &&
          !question.manualOnly &&
          question.type !== "file_upload" &&
          !resolvedLocally.has(index),
      )
      .map(({ question, index }) => ({
        index,
        questionText: question.questionText,
        type: question.type,
        options: question.options,
      }));

    // STAGE 3 — apply the cap the user accepted at pre-flight. Everything past
    // it stays `needs_user_input` with an explicit reason, so a capped run is
    // visibly capped rather than looking like the model had nothing to say.
    const questionsForAi =
      budgetQuestionCap > 0 ? allQuestionsForAi.slice(0, budgetQuestionCap) : allQuestionsForAi;
    const deferredForBudget = allQuestionsForAi.slice(questionsForAi.length);
    deferredForBudget.forEach(({ index }) => {
      states.set(index, "needs_user_input");
      debugLog(
        `EasyFilla(budget): Q${index} deferred — outside today's remaining request budget ` +
          `(resets ${describeReset()}).`,
      );
    });
    if (deferredForBudget.length > 0) {
      setAiReportStatus(
        `Answering the first ${questionsForAi.length} question(s); ${deferredForBudget.length} deferred ` +
          `until the quota resets at ${describeReset()}.`,
      );
    }

    // MANUAL-ONLY CALL SITE 2 of 2 — the model-request boundary. The filter
    // above is the mechanism; this is the assertion that it worked.
    //
    // STAGE 2a made this worth asserting rather than assuming: questions now
    // arrive from SEVERAL frames and are merged before they get here, so a
    // future change to the merge could reorder or reshape them. The flag
    // travels on the question itself, from whichever frame detected it, so it
    // survives merging — but a password reaching a model request is severe
    // enough that it gets checked rather than trusted.
    const leakedManualOnly = questionsForAi.filter((forAi) => response.questions[forAi.index]?.manualOnly);
    if (leakedManualOnly.length > 0) {
      const names = leakedManualOnly.map((q) => `"${q.questionText}"`).join(", ");
      console.error(
        `EasyFilla(tier): ABORTED — ${leakedManualOnly.length} manual-only field(s) reached the model-request ` +
          `boundary: ${names}. These are passwords/payment/login/CAPTCHA fields and must never be transmitted.`,
      );
      throw new Error(
        `Refusing to send ${leakedManualOnly.length} manual-only field(s) to the AI (${names}). ` +
          "This is a bug in the scan/merge path — nothing was transmitted.",
      );
    }

    // FIX 1 acceptance (c): prove the API is the last resort. On a 59-field
    // form this should be a single-digit number, not 59.
    const framesSeen = new Set(response.questions.map((question) => question.frameId ?? 0));
    console.log(
      `EasyFilla(tier): distribution — Tier0(profile)=${tier0Count}, Tier1(declarations)=${tier1Count}, ` +
        `Tier2(API)=${questionsForAi.length} of ${response.questions.length} total across ` +
        `${framesSeen.size} frame(s). ` +
        `${questionsForAi.length === 0 ? "0 API requests." : "1 batched API request."}`,
    );

    if (questionsForAi.length > 0) {
      const analyzing = `Analyzing ${questionsForAi.length} remaining question(s) with Gemini…`;
      setAiReportStatus(analyzing);
      // Surface what the request queue is actually doing. A silent multi-minute
      // wait (rate-limit pacing, retries, a stalled request) previously looked
      // identical to a hang.
      onQueueActivity((message) => setAiReportStatus(`${analyzing} ${message}`));
      try {
        // ── STAGE A ─────────────────────────────────────────────────────
        // Built from the ORIGINAL file bytes, so scans and photos contribute.
        // A cache hit costs zero requests, which is what makes regenerating a
        // report cheap.
        if (!stageADossier) {
          throw new GeminiRequestError(
            "The document dossier couldn't be built, so there is nothing to answer from.",
            true,
            "empty",
          );
        }

        // ── STAGE B ─────────────────────────────────────────────────────
        // Answers against the dossier only — the raw documents never go out
        // again. Chunked, and partial results are kept whatever else fails.
        setAiReportStatus(analyzing);
        const outcome = await withDeadline(
          answerFromDossier(stageADossier, questionsForAi, dossierAnswerOptions()),
          AI_STEP_DEADLINE_MS,
        );

        outcome.answers.forEach((result, index) => {
          const trimmed = result.value.trim();

          if (result.status === "manual_only") {
            states.set(index, "manual_only");
            return;
          }
          if (result.status === "needs_user_input" || !trimmed) {
            states.set(index, "needs_user_input");
            categories.set(index, "not_in_documents");
            if (result.reasoning) {
              console.log(`EasyFilla(StageB): Q${index} needs input — "${result.reasoning}"`);
            }
            return;
          }
          if (result.status === "conflicting_sources") {
            // Show EVERY candidate with the file asserting it; select none.
            const agreement = assessEvidenceAgreement(result.evidence);
            states.set(index, "conflicting_sources");
            sources.set(
              index,
              agreement.groups.map((g) => `"${g.value}" (${g.files.join(", ")})`).join("; "),
            );
            console.warn(
              `EasyFilla(provenance): Q${index} conflicting values across documents — none selected.`,
              agreement.groups,
            );
            return;
          }
          if (result.status === "answered_from_documents") {
            // STRUCTURAL: the cited evidence decides this, not the model's claim
            // and not the shape of the sentence. A choice answer is exempt from
            // needing a filename — its value is one of the form's own option
            // strings, not a quotation from a document.
            // FIX 1: no choice exemption. A selection with no cited file is a
            // guess, whatever the model called it.
            const citedFiles = [...new Set(result.evidence.map((ev) => ev.source_filename))].filter(Boolean);

            if (citedFiles.length > 0) {
              answers.set(index, trimmed);
              states.set(index, "answered_from_documents");
              // FIX 2: list every corroborating file — plurality is strength.
              sources.set(index, citedFiles.join(", "));
              if (citedFiles.length > 1) {
                console.log(`EasyFilla(provenance): Q${index} corroborated by ${citedFiles.length} files: ${citedFiles.join(", ")}`);
              }
            } else {
              states.set(index, "needs_user_input");
              categories.set(index, "not_in_documents");
              console.warn(
                `EasyFilla(provenance): Q${index} claimed document-sourced but cited no file (evidence: []) ` +
                  "— asking instead of asserting.",
              );
            }
            return;
          }
          // drafted — presentable only if a document or the user's own seed
          // backs it; otherwise it is an invention about the user.
          const citedFiles = [...new Set(result.evidence.map((ev) => ev.source_filename))].filter(Boolean);
          const draftState = deriveState({
            hasValue: true,
            composed: true,
            ...(citedFiles.length > 0 ? { source: citedFiles[0]! } : {}),
            // No user seeds exist yet at report-generation time — they are
            // collected in the refinement stage, which composes separately.
            userSeeded: false,
          });
          if (draftState === "needs_user_input") {
            states.set(index, "needs_user_input");
            categories.set(index, "not_in_documents");
            console.warn(
              `EasyFilla(provenance): Q${index} was model-composed with neither a document source nor a user ` +
                "seed — asking instead of asserting.",
            );
            return;
          }
          suggestions.set(index, trimmed);
          states.set(index, "ai_draft_verify");
          if (citedFiles.length > 0) {
            sources.set(index, citedFiles.join(", "));
          }
        });

        // Anything Stage B never returned is unresolved — NOT "not in documents".
        outcome.failedIds.forEach((index) => {
          if (!answers.has(index) && !suggestions.has(index)) {
            states.set(index, "error_retry");
          }
        });
        // Any question with no entry at all also needs input.
        questionsForAi.forEach(({ index }) => {
          if (!states.has(index)) {
            states.set(index, "needs_user_input");
          }
        });
        setConnectionStatus(
          `AI reachable — ${dossierFromCache ? "dossier cached (0 Stage-A requests)" : "dossier rebuilt"}, ` +
            `${outcome.requestsUsed} answering request(s).`,
          false,
        );
      } catch (error) {
        if (error instanceof GeminiRequestError) {
          // Problem 2 / test (f): a quota/network/parse failure marks affected
          // questions ERROR_RETRY — NEVER "not found in documents". The
          // deterministic profile answers from STEP 1 are already set and
          // survive untouched.
          // Label the pill with the REAL class (auth / quota / overload /
          // network / timeout) instead of a blanket "couldn't reach AI".
          setErrorRetryLabel(error.kind);
          questionsForAi.forEach(({ index }) => {
            if (!answers.has(index)) {
              states.set(index, "error_retry");
            }
          });
          setConnectionStatus(describeGeminiError(error), true);
          console.warn(
            `EasyFilla(classify): Gemini failure kind=${error.kind}, retryable=${error.retryable} — ` +
              `affected questions marked error_retry, not "not found". Profile-matched fields preserved.`,
            error,
          );
        } else {
          throw error;
        }
      } finally {
        onQueueActivity(null);
      }
    } else {
      console.log("EasyFilla(classify): every question answered locally from the profile — zero Gemini requests.");
    }

    // File-upload questions (FIX 5): a matched candidate → READY_TO_ATTACH
    // (never "not in your documents"); no candidate → NEEDS_FILE. Never sent
    // to the API either way.
    const fileMatches = new Map<number, string | null>();
    response.questions.forEach((question, index) => {
      if (question.type === "file_upload") {
        const match = matchDocumentToFileQuestion(question.questionText);
        fileMatches.set(index, match?.fileName ?? null);
        states.set(index, match ? "ready_to_attach" : "needs_file");
        console.log(
          `EasyFilla(tier): Q${index} file-upload → ${match ? `ready_to_attach (${match.fileName})` : "needs_file"} — no API`,
        );
      }
    });

    // FIX 4.4: the report is EXACTLY ONE Gemini request (the match call
    // above). Elicitation prompts are NOT fetched here — they'd be a second
    // request. They default to instant offline templates, and tailored
    // prompts are fetched lazily only if/when the user opens Compose.
    const elicitations = new Map<number, string>();
    const seeds = new Map<number, string>();

    setAiReportStatus("Building PDF…");
    const blob = generateStructuredPdf(response.formTitle, response.questions, {
      answers,
      suggestions,
      sectionTitles,
      categories,
      fileMatches,
      states,
      sources,
      logoDataUrl,
    });
    const fileName = `easyfilla-ai-answered-${Date.now()}.pdf`;
    downloadBlob(blob, fileName);
    renderDownloadLink(aiReportPdfLinkContainer, blob, fileName, "Open AI-answered PDF");

    lastApprovedReport = {
      runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      formTitle: response.formTitle,
      questions: response.questions,
      sectionTitles,
      answers,
      suggestions,
      categories,
      states,
      sources,
      fileMatches,
      provenance: new Map(),
      elicitations,
      seeds,
    };
    setConfirmFillStatus("Open the PDF above and review it, then click Continue and Fill when you're ready.");
    renderRefinementQuestions();

    const answeredCount = Array.from(states.values()).filter((s) => s === "answered_from_documents").length;
    const errorCount = Array.from(states.values()).filter((s) => s === "error_retry").length;
    setAiReportStatus(
      `PDF downloaded — ${answeredCount} answered from your documents/profile, ${suggestions.size} AI draft(s) to verify` +
        (errorCount > 0 ? `, ${errorCount} couldn't reach the AI (retry those)` : "") +
        ` (${describeSectionCoverage(response)}).`,
    );
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      setAiReportStatus(`${error.message} Click ⚙ Settings above to add one.`);
    } else {
      const message = error instanceof Error ? error.message : "Couldn't generate the AI-answered report.";
      setAiReportStatus(message);
    }
  } finally {
    generateAiReportButton.disabled = false;
  }
}

generateAiReportButton.addEventListener("click", () => {
  void generateAiAnsweredReport();
});

interface RefinementRow {
  index: number;
  getValue: () => string;
  // Present only for free-text rows: lets Compose write a draft into the same
  // field the "Write myself" path uses.
  setValue?: (value: string) => void;
}

let refinementRows: RefinementRow[] = [];

const SINGLE_SELECT_REFINEMENT_TYPES = new Set(["multiple_choice", "dropdown", "linear_scale"]);

// Per-question compose settings, so "Shorter"/"Longer"/"More formal"
// regenerate with the accumulated preferences rather than resetting.
interface ComposeSettings {
  length: ComposeLength;
  tone: ComposeTone;
  guidance: string;
  // TASK D2 — how many alternative drafts to request for this question.
  // 1 = normal. 2 or 3 come back from ONE request, not N requests.
  variants?: number;
}
// TASK B — settings persist PER QUESTION. Two questions on the same form can
// legitimately want different treatment (a long formal statement of purpose and
// a short conversational "how did you hear about us"), and the previous code
// applied the first question's settings to the whole batch.
const composeSettings = new Map<number, ComposeSettings>();

// The global default from Settings, which SEEDS each question's initial choice
// and is then owned by that question. Changing the global later does not
// retroactively rewrite questions the user has already tuned.
let composeDefaults: ComposeDefaults = { ...DEFAULT_COMPOSE_DEFAULTS };
void loadComposeDefaults().then((defaults) => {
  composeDefaults = defaults;
});

function composeSettingsFor(index: number): ComposeSettings {
  let settings = composeSettings.get(index);
  if (!settings) {
    settings = { length: composeDefaults.length, tone: composeDefaults.tone, guidance: "" };
    composeSettings.set(index, settings);
  }
  return settings;
}

// Runs composition (Feature 3) for one or more question indexes and applies
// each result to its review row. Honors the hard-fail: a not-found result
// leaves the field blank and flags it, never fabricating.
// ═══════════════════════════════════════════════════════════════════════
// TASK C + D1 — PER-QUESTION COMPOSE STATE, THROUGH THE QUEUE
//
// ⚠️ WHY THE PER-ROW BUTTON AND THE "COMPOSE ALL" BUTTON TAKE DIFFERENT PATHS.
// Routing the batch button through a per-question queue would turn ONE request
// covering N questions into N requests. §2 and §6b.4 are explicit that
// throughput comes from BATCHING, and §4c's binding constraint is the daily
// request ceiling — so that "improvement" would multiply the user's cost by N
// to gain nothing. The per-row button composes one question (already one
// request today) and gets full per-question state; the batch button keeps its
// single request and the global status line.
// ═══════════════════════════════════════════════════════════════════════

interface ComposeRowHandles {
  button: HTMLButtonElement;
  cancel: HTMLButtonElement;
  status: HTMLElement;
  restingLabel: string;
}

/**
 * Per-row DOM handles, keyed by question index, so a completion updates ONLY
 * its own row (§6b.3). A closure over the button would break the moment the
 * list re-renders.
 */
const composeRowHandles = new Map<number, ComposeRowHandles>();
/** Question index → the queue key of its live job. */
const composeJobKeys = new Map<number, string>();
let elapsedTicker: number | null = null;

const composeQueue = new ComposeQueue<ComposeResult | null>({
  run: async (job, signal) => {
    const report = lastApprovedReport;
    const question = report?.questions[job.questionIndex];
    if (!report || !question) return null;
    const settings = composeSettingsFor(job.questionIndex);
    const language = effectiveAnswerLanguage();
    const results = await composeAnswers(
      getCombinedExtractedText(),
      extractedDocuments.map((doc) => doc.fileName),
      [
        {
          index: job.questionIndex,
          questionText: question.questionText,
          isEssay: question.type === "paragraph",
          guidance: settings.guidance,
          seed: report.seeds.get(job.questionIndex)?.trim() ?? "",
          length: settings.length,
          tone: settings.tone,
          variants: settings.variants ?? 1,
        },
      ],
      {
        profileContext: profileToPromptContext(profile),
        ...(language ? { language } : {}),
        // The queue owns cancellation; the signal must reach the provider or
        // "cancel" would only stop us listening, not stop the request.
        signal,
      },
    );
    return results.get(job.questionIndex) ?? null;
  },

  deliver: (job, result) => {
    composeJobKeys.delete(job.questionIndex);
    applyComposeResult(job.questionIndex, result);
    announceCompose(`Draft ready for question ${job.questionIndex + 1}.`);
    renderComposeRow(job.questionIndex);
  },

  fail: (job, message) => {
    composeJobKeys.delete(job.questionIndex);
    // §4f/B3 — the CLASSIFIED message surfaces. Never a silent revert, never a
    // generic "something went wrong".
    const handles = composeRowHandles.get(job.questionIndex);
    if (handles) {
      handles.status.textContent = message;
      handles.status.className = "compose__provenance compose__provenance--fail";
    }
    setRefinementStatus(message);
    announceCompose(`Compose failed for question ${job.questionIndex + 1}.`);
    renderComposeRow(job.questionIndex);
  },

  restore: (job) => {
    composeJobKeys.delete(job.questionIndex);
    // The draft as it was when the job STARTED. Cancelling must never leave the
    // user with less than they had.
    if (job.previousDraft !== null) {
      refinementRows.find((row) => row.index === job.questionIndex)?.setValue?.(job.previousDraft);
    }
    const handles = composeRowHandles.get(job.questionIndex);
    if (handles) {
      handles.status.textContent = "Cancelled — your previous draft is back, and no request was charged for it.";
      handles.status.className = "compose__provenance";
    }
    announceCompose(`Compose cancelled for question ${job.questionIndex + 1}.`);
    renderComposeRow(job.questionIndex);
  },

  onChange: (snapshot) => {
    // Repaint every row that has a job, plus the depth line.
    snapshot.jobs.forEach((view) => renderComposeRow(view.questionIndex));
    const depth = composeQueue.describeDepth();
    composeQueueDepthText.textContent = depth ? `Compose queue: ${depth}` : "";
    // A ticker only while something is running, so elapsed seconds advance
    // without a permanent timer.
    if (snapshot.composing > 0 && elapsedTicker === null) {
      elapsedTicker = window.setInterval(() => {
        composeQueue.snapshot().jobs.forEach((view) => renderComposeRow(view.questionIndex));
      }, 1000);
    } else if (snapshot.composing === 0 && elapsedTicker !== null) {
      window.clearInterval(elapsedTicker);
      elapsedTicker = null;
    }
  },
});

/** A polite live region: start and finish are announced, nothing is interrupted. */
function announceCompose(message: string): void {
  composeLiveRegion.textContent = message;
}

function renderComposeRow(index: number): void {
  const handles = composeRowHandles.get(index);
  if (!handles) return;
  const key = composeJobKeys.get(index);
  const view = key ? composeQueue.viewFor(key) : null;
  const active = view?.state === "queued" || view?.state === "running";

  handles.button.textContent = composeButtonLabel(view, handles.restingLabel);
  handles.button.disabled = active;
  // Accessibility: aria-busy while in flight. Only the RUNNING job is busy —
  // a queued job is waiting, not working, and announcing it as busy would be
  // the same lie as showing it a spinner.
  handles.button.setAttribute("aria-busy", view?.state === "running" ? "true" : "false");
  // `running` spins; `queued` gets a STATIC indicator. The CSS class carries
  // this so `prefers-reduced-motion` can drop the animation without changing
  // which state is which.
  handles.button.classList.toggle("compose__btn--running", view?.state === "running");
  handles.button.classList.toggle("compose__btn--queued", view?.state === "queued");

  handles.cancel.hidden = !active;
  handles.cancel.textContent = view?.state === "queued" ? "Cancel (free)" : "Cancel";
  handles.cancel.title =
    view?.state === "queued"
      ? "This job has not been sent yet, so cancelling costs nothing."
      : "Stops the request in flight and restores your previous draft.";
}

function composeOneQueued(index: number): void {
  const report = lastApprovedReport;
  if (!report) {
    setRefinementStatus("Generate an AI-answered report first — composing drafts an answer for a question in it.");
    return;
  }
  if (rawUploads.length === 0) {
    setRefinementStatus("Upload at least one document before composing — drafts must be grounded in your files.");
    return;
  }
  // FIX 2 still applies: an unseeded question with no document context never
  // occupies a payload slot. Checked BEFORE admission so it costs nothing.
  const seed = report.seeds.get(index)?.trim() ?? "";
  if (seed.length === 0 && getCombinedExtractedText().trim().length === 0) {
    report.states.set(index, "needs_user_input");
    const handles = composeRowHandles.get(index);
    if (handles) {
      handles.status.textContent =
        "No API request made — add a few rough notes above (or upload a relevant document) and compose again.";
      handles.status.className = "compose__provenance compose__provenance--fail";
    }
    updateContinueFillGate();
    return;
  }

  const key = composeQueue.enqueue({
    runId: report.runId,
    questionIndex: index,
    // Captured AT START, not at cancel time: by then a partial write may
    // already have replaced what the user had.
    previousDraft: getDraftValue(index) ?? report.answers.get(index) ?? null,
  });
  if (key === null) {
    // Already queued or running — refusing is what stops a double-click from
    // spending two requests.
    return;
  }
  composeJobKeys.set(index, key);
  announceCompose(`Compose requested for question ${index + 1}.`);
  renderComposeRow(index);
}

async function runCompose(indexes: number[]): Promise<void> {
  const report = lastApprovedReport;
  if (!report) {
    // B2 — a button that silently does nothing is indistinguishable from a
    // broken one. Every guard says what is missing and what to do about it.
    setRefinementStatus("Generate an AI-answered report first — composing drafts an answer for a question in it.");
    return;
  }
  if (rawUploads.length === 0) {
    setRefinementStatus("Upload at least one document before composing — drafts must be grounded in your files.");
    return;
  }

  const items = indexes
    .map((index) => ({ index, question: report.questions[index] }))
    .filter((entry): entry is { index: number; question: ExtractedQuestionWithSection } => Boolean(entry.question))
    .map(({ index, question }) => {
      const settings = composeSettingsFor(index);
      const seed = report.seeds.get(index)?.trim() ?? "";
      return {
        index,
        questionText: question.questionText,
        isEssay: question.type === "paragraph",
        guidance: settings.guidance,
        seed,
        // TASK B — carried PER ITEM. Previously the whole batch inherited
        // `composeSettingsFor(firstIndex)`, so composing three questions at
        // once silently applied question 1's length and tone to all three.
        length: settings.length,
        tone: settings.tone,
        variants: settings.variants ?? 1,
      };
    });
  if (items.length === 0) {
    return;
  }

  // FIX 2: HARD-BLOCK unseeded compose AT THE BATCH-ASSEMBLY LAYER. The live
  // 429 evidence showed compose payloads containing "user's seed notes:
  // (none)" — requests that burn quota and cannot produce a grounded answer.
  // An unseeded question with no document context never occupies a payload
  // slot; it's marked needs-input locally with ZERO API cost.
  const hasDocumentContext = getCombinedExtractedText().trim().length > 0;
  const sendable = items.filter((item) => item.seed.length > 0 || hasDocumentContext);
  const blocked = items.filter((item) => !(item.seed.length > 0 || hasDocumentContext));

  blocked.forEach((item) => {
    report.states.set(item.index, "needs_user_input");
    const provenanceEl = document.getElementById(`compose-prov-${item.index}`);
    if (provenanceEl) {
      provenanceEl.textContent =
        "No API request made — add a few rough notes above (or upload a relevant document) and compose again.";
      provenanceEl.className = "compose__provenance compose__provenance--fail";
    }
    console.log(`EasyFilla(compose): Q${item.index} BLOCKED before assembly — empty seed + no document context (0 API cost).`);
  });

  if (sendable.length === 0) {
    setRefinementStatus(
      `No drafts requested — ${blocked.length} question(s) have no notes and no relevant documents. ` +
        `Add a few notes, then compose. (No API request was made.)`,
    );
    updateContinueFillGate();
    return;
  }

  // TASK B — there is no longer a "batch" length/tone. Each item carries its
  // own (see the mapping above), and the model receives them per question.
  const seededCount = sendable.filter((item) => item.seed.length > 0).length;
  console.log(
    `EasyFilla(compose): sending ${sendable.length} question(s) in ONE request ` +
      `(${seededCount} seeded, ${blocked.length} blocked before assembly) —`,
    sendable.map((i) => `Q${i.index} seed:${i.seed ? "yes" : "EMPTY"}`),
  );

  // Names the ACTIVE provider rather than hardcoding Gemini — the user chose
  // where their documents go and the status must not contradict that choice.
  const composingWith = (await activeProvider()).displayName;
  setRefinementStatus(`Composing ${sendable.length} draft${sendable.length === 1 ? "" : "s"} with ${composingWith}…`);
  try {
    const language = effectiveAnswerLanguage();
    const results = await composeAnswers(
      getCombinedExtractedText(),
      extractedDocuments.map((doc) => doc.fileName),
      sendable,
      {
        profileContext: profileToPromptContext(profile),
        ...(language ? { language } : {}),
      },
    );

    let drafted = 0;
    let hardFailed = 0;
    results.forEach((result, index) => {
      // C/D1 — one shared applier, so the batch path and the per-row queued
      // path cannot disagree about state, provenance or wording.
      if (applyComposeResult(index, result) === "drafted") drafted += 1;
      else hardFailed += 1;
    });

    setRefinementStatus(
      `Composed ${drafted} draft${drafted === 1 ? "" : "s"}` +
        (hardFailed > 0 ? `; ${hardFailed} had nothing in your documents and were left for you to write.` : ".") +
        " Review, edit, then Save.",
    );
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      setRefinementStatus(`${error.message} Click ⚙ Settings above to add one.`);
    } else {
      setRefinementStatus(error instanceof Error ? error.message : "Couldn't draft that answer. Try again, or type it yourself in the box below.");
    }
  }
}

/**
 * TASK D2 — side-by-side variant picker.
 *
 * ⚠️ THE PICK CHANGES WORDING, NEVER PROVENANCE (§3, §6b.5). Variants are
 * alternative prose over ONE evidence set, so choosing one does not touch
 * `report.provenance`, the answer state, or the grounded document list. There is
 * deliberately no per-variant evidence to re-apply — if there were, picking a
 * variant could silently swap in a different claim about the user's documents
 * than the one that was verified.
 *
 * Nothing renders unless MORE THAN ONE draft came back, so an evidence-empty
 * compose (whose variants are discarded upstream) shows no chooser at all —
 * there is no "pick one of three" for an answer that should not exist.
 */
function renderVariantPicker(index: number, result: ComposeResult): void {
  const host = document.getElementById(`compose-variants-${index}`);
  if (!host) return;
  host.innerHTML = "";
  if (result.variants.length < 2) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const heading = document.createElement("p");
  heading.className = "compose__variants-heading";
  heading.textContent =
    `${result.variants.length} drafts of the same answer — same facts, different wording. ` +
    "Pick one; the others are discarded.";
  host.append(heading);

  const group = document.createElement("div");
  group.className = "compose__variants";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", `Choose a draft for question ${index + 1}`);

  const buttons: HTMLButtonElement[] = [];
  result.variants.forEach((variant, position) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "compose__variant";
    card.setAttribute("role", "radio");
    // The first variant is already in the textarea, so it starts selected —
    // there is never a state where no draft is chosen.
    card.setAttribute("aria-checked", position === 0 ? "true" : "false");
    card.tabIndex = position === 0 ? 0 : -1;

    const label = document.createElement("span");
    label.className = "compose__variant-label";
    label.textContent = `Draft ${position + 1}${position === 0 ? " (in the box now)" : ""}`;
    const body = document.createElement("span");
    body.className = "compose__variant-text";
    body.textContent = variant;
    card.append(label, body);

    card.addEventListener("click", () => {
      refinementRows.find((r) => r.index === index)?.setValue?.(variant);
      buttons.forEach((other, otherPosition) => {
        other.setAttribute("aria-checked", otherPosition === position ? "true" : "false");
        other.tabIndex = otherPosition === position ? 0 : -1;
      });
      // Says plainly that provenance is unchanged, so a user does not read
      // "picked draft 2" as "re-sourced from different documents".
      setRefinementStatus(
        `Draft ${position + 1} is now in the box. Same sources as before — only the wording changed. Edit, then Save.`,
      );
    });
    buttons.push(card);
    group.append(card);
  });

  host.append(group);
}

/**
 * Applies one compose result to one question's row.
 *
 * Shared by the batch path and the queued per-row path so the two cannot drift
 * in how they set state, provenance or the visible explanation. Returns what
 * happened, letting the batch path keep its aggregate count.
 */
function applyComposeResult(index: number, result: ComposeResult | null): "drafted" | "not-found" {
  const report = lastApprovedReport;
  const row = refinementRows.find((r) => r.index === index);
  const provenanceEl = document.getElementById(`compose-prov-${index}`);

  if (!report || !result || result.notFound) {
    report?.provenance.delete(index);
    report?.states.set(index, "needs_user_input");
    if (provenanceEl) {
      provenanceEl.textContent =
        "No draft produced — your seed was empty and nothing in your documents is relevant. Add a few notes above and compose again, or write it yourself.";
      provenanceEl.className = "compose__provenance compose__provenance--fail";
    }
    return "not-found";
  }

  row?.setValue?.(result.draft);
  report.provenance.set(index, result.groundedDocuments);
  // TASK D2 — offer the alternatives side by side. Rendered only when more than
  // one came back, so a single-draft compose looks exactly as it did.
  renderVariantPicker(index, result);
  if (provenanceEl) {
    const from = result.seedUsed ? "your notes" : "your documents";
    const gapNote = result.gaps.length > 0 ? ` Gaps to add: ${result.gaps.join("; ")}.` : "";
    provenanceEl.textContent = `Composed from ${from}${
      result.groundedDocuments.length ? ` + ${result.groundedDocuments.join(", ")}` : ""
    } — verify before saving.${gapNote}`;
    provenanceEl.className = "compose__provenance";
  }
  return "drafted";
}

// The "Compose with AI" sub-panel for a free-text question: guidance box,
// Compose button, and (after a first compose) shorter/longer/more-formal
// regenerate controls, plus a provenance line.
// FIX 6: a question may be composed only if its label is genuinely
// open-ended AND it's in the NEEDS_USER_INPUT state — never a choice/
// discrete field, and never an ERROR_RETRY (that's an outage to retry).
function composeEligible(
  question: Pick<ExtractedQuestionWithSection, "type" | "questionText" | "manualOnly">,
  index: number,
): boolean {
  return isComposable(question) && lastApprovedReport?.states.get(index) === "needs_user_input";
}

// TASK B — a real radiogroup, not styled divs.
//
// Semantics: role="radiogroup" containing role="radio" buttons with
// aria-checked, and a ROVING TABINDEX so the group is one tab stop. Arrow keys
// move and select within it; Home/End jump to the ends; Enter/Space select the
// focused option. That is the WAI-ARIA radio-group pattern, and it is what a
// screen-reader user will expect when they hear "radio group, Length".
//
// A <select> was rejected deliberately: these are 3-option, always-visible
// choices the user flips between while comparing drafts, and burying them one
// click deep in a dropdown makes that comparison worse.
interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedSpec<T extends string> {
  legend: string;
  options: SegmentedOption<T>[];
  current: () => T;
  onSelect: (value: T) => void;
  // Optional supplementary text announced with the option (e.g. the word range),
  // so the concrete target is available to screen readers, not just visually.
  describe?: (value: T) => string;
}

function buildSegmentedGroup<T extends string>(spec: SegmentedSpec<T>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "segmented";

  const legend = document.createElement("span");
  legend.className = "segmented__legend";
  legend.id = `seg-legend-${segmentedGroupId++}`;
  legend.textContent = spec.legend;

  const group = document.createElement("div");
  group.className = "segmented__group";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-labelledby", legend.id);

  const buttons: HTMLButtonElement[] = [];

  const select = (value: T, focus: boolean): void => {
    spec.onSelect(value);
    sync();
    if (focus) {
      const active = buttons.find((button) => button.dataset.value === value);
      active?.focus();
    }
  };

  const sync = (): void => {
    const current = spec.current();
    buttons.forEach((button) => {
      const isCurrent = button.dataset.value === current;
      button.setAttribute("aria-checked", String(isCurrent));
      // Roving tabindex: exactly one focusable element per group.
      button.tabIndex = isCurrent ? 0 : -1;
      button.classList.toggle("segmented__option--on", isCurrent);
    });
  };

  spec.options.forEach((option, position) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segmented__option";
    button.setAttribute("role", "radio");
    button.dataset.value = option.value;
    button.textContent = option.label;

    const described = spec.describe?.(option.value);
    if (described) {
      // Announced as part of the option name, so "Short" is heard as
      // "Short, 15 to 40 words" rather than an unquantified adjective.
      button.setAttribute("aria-label", `${option.label}, ${described}`);
      button.title = described;
    }

    button.addEventListener("click", () => select(option.value, false));
    button.addEventListener("keydown", (event) => {
      const last = spec.options.length - 1;
      let next: number | null = null;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          next = position === last ? 0 : position + 1;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          next = position === 0 ? last : position - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        case " ":
        case "Enter":
          event.preventDefault();
          select(option.value, true);
          return;
        default:
          return;
      }
      event.preventDefault();
      const target = spec.options[next];
      if (target) {
        select(target.value, true);
      }
    });

    buttons.push(button);
    group.append(button);
  });

  sync();
  wrap.append(legend, group);
  return wrap;
}

let segmentedGroupId = 0;

// Reads the live draft text out of a question's review row, so "does a draft
// already exist?" is answered from the DOM the user is looking at rather than
// from a variable that may lag behind their edits.
function getDraftValue(index: number): string {
  return refinementRows.find((row) => row.index === index)?.getValue().trim() ?? "";
}

function buildComposeControls(
  index: number,
  questionText: string,
  question: ExtractedQuestionWithSection,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "compose";

  // The tailored elicitation prompt (Problem 3.2a): from the batched Gemini
  // call when available, else a question-intent template.
  const elicit = document.createElement("p");
  elicit.className = "compose__elicit";
  elicit.textContent =
    lastApprovedReport?.elicitations.get(index) ?? templateElicitation(questionText);
  wrap.append(elicit);

  // TASK A — the second permanent placement, beside the seed box. Not
  // dismissible: this is the exact moment the advice is actionable, and a user
  // who dismissed the splash note weeks ago still needs it here.
  const seedNote = document.createElement("p");
  seedNote.className = "input-note input-note--seed";
  seedNote.setAttribute("role", "note");
  seedNote.textContent = INPUT_QUALITY_NOTE_SHORT_SEED;
  wrap.append(seedNote);

  // The seed box (Problem 3.2b): rough, unpolished notes to expand.
  const seed = document.createElement("textarea");
  seed.className = "refinement-list__textarea compose__seed";
  seed.rows = 2;
  seed.placeholder = "Your rough notes / bullet points (any language) — the answer is built only from these + your documents";
  seed.value = lastApprovedReport?.seeds.get(index) ?? "";
  seed.addEventListener("input", () => {
    lastApprovedReport?.seeds.set(index, seed.value);
  });
  wrap.append(seed);

  const guidance = document.createElement("input");
  guidance.type = "text";
  guidance.className = "text-input compose__guidance";
  guidance.placeholder = "Optional guidance — e.g. “emphasize my microbiology background, keep it formal”";
  guidance.addEventListener("input", () => {
    composeSettingsFor(index).guidance = guidance.value;
  });

  const COMPOSE_RESTING_LABEL = "✨ Compose from my notes";
  const composeBtn = document.createElement("button");
  composeBtn.type = "button";
  composeBtn.className = "btn btn--secondary compose__btn";
  composeBtn.textContent = COMPOSE_RESTING_LABEL;
  composeBtn.setAttribute("aria-busy", "false");
  composeBtn.addEventListener("click", () => {
    controls.hidden = false;
    // TASK C/D1 — through the QUEUE, so this row gets its own state and the
    // rest of the panel stays usable while it runs.
    composeOneQueued(index);
  });

  // TASK C — cancel, wired to the AbortController the queue owns. Hidden at
  // rest; its label distinguishes the free case from the in-flight one.
  const composeCancel = document.createElement("button");
  composeCancel.type = "button";
  composeCancel.className = "btn btn--tiny compose__cancel";
  composeCancel.textContent = "Cancel";
  composeCancel.hidden = true;
  composeCancel.addEventListener("click", () => {
    const key = composeJobKeys.get(index);
    if (!key) return;
    const verdict = composeQueue.cancel(key);
    if (verdict.cancelled && !verdict.spentRequest) {
      // Worth saying explicitly: this is the cheapest correction available.
      setRefinementStatus("Cancelled before it was sent — no request was used.");
    }
  });

  // TASK B — LENGTH and TONE are two independent segmented groups, never one
  // combined control: a SHORT FORMAL answer has to be expressible, and a single
  // "shorter / more formal" axis made that impossible.
  const controls = document.createElement("div");
  controls.className = "compose__controls";

  const recompose = document.createElement("button");
  recompose.type = "button";
  recompose.className = "btn btn--tiny compose__recompose";
  recompose.textContent = "↻ Recompose with new settings";
  recompose.hidden = true;
  recompose.addEventListener("click", () => {
    recompose.hidden = true;
    void runCompose([index]);
  });

  // Changing length/tone AFTER a draft exists must never silently discard it —
  // the user may have edited that draft by hand. Offer, don't act.
  const onModeChange = (): void => {
    const hasDraft = Boolean(lastApprovedReport?.answers.get(index)?.trim() || getDraftValue(index));
    recompose.hidden = !hasDraft;
    if (hasDraft) {
      setRefinementStatus(
        "Length/tone changed. Your current draft is untouched — press Recompose to rewrite it with the new settings.",
      );
    }
  };

  controls.append(
    buildSegmentedGroup<ComposeLengthChoice>({
      legend: "Length",
      options: [
        { value: "short", label: "Short" },
        { value: "medium", label: "Medium" },
        { value: "long", label: "Long" },
      ],
      current: () => composeSettingsFor(index).length,
      onSelect: (value) => {
        composeSettingsFor(index).length = value;
        onModeChange();
      },
      describe: (value) => {
        const target = lengthTargetFor(value, question.type === "paragraph");
        return `${target.minWords}–${target.maxWords} words`;
      },
    }),
    buildSegmentedGroup<ComposeToneChoice>({
      legend: "Tone",
      options: [
        { value: "neutral", label: "Neutral" },
        { value: "formal", label: "Formal" },
        { value: "conversational", label: "Conversational" },
      ],
      current: () => composeSettingsFor(index).tone,
      onSelect: (value) => {
        composeSettingsFor(index).tone = value;
        onModeChange();
      },
    }),
    // TASK D2 — how many drafts to ask for. All N come back from ONE request,
    // so this costs the same as composing once; the label says so, because a
    // user reasonably assumes "3 drafts" means "3× my daily budget".
    buildSegmentedGroup<"1" | "2" | "3">({
      legend: "Drafts",
      options: [
        { value: "1", label: "1" },
        { value: "2", label: "2" },
        { value: "3", label: "3" },
      ],
      current: () => String(composeSettingsFor(index).variants ?? 1) as "1" | "2" | "3",
      onSelect: (value) => {
        composeSettingsFor(index).variants = Number(value);
        onModeChange();
      },
    }),
    recompose,
  );

  const provenance = document.createElement("p");
  provenance.className = "compose__provenance";
  provenance.id = `compose-prov-${index}`;

  // TASK D2 — host for the side-by-side picker. Empty and hidden until a
  // multi-variant compose returns more than one draft.
  const variantHost = document.createElement("div");
  variantHost.id = `compose-variants-${index}`;
  variantHost.hidden = true;

  wrap.append(guidance, composeBtn, composeCancel, controls, provenance, variantHost);

  // §6b.3 — register the row's DOM handles in a registry keyed by question, so
  // an out-of-order completion updates ONLY its own row. Holding these in a
  // closure would break the moment the list re-renders.
  composeRowHandles.set(index, {
    button: composeBtn,
    cancel: composeCancel,
    status: provenance,
    restingLabel: COMPOSE_RESTING_LABEL,
  });
  renderComposeRow(index);

  return wrap;
}

function createRefinementRow(
  question: ExtractedQuestionWithSection,
  index: number,
  suggestion: string | undefined,
  category: "not_in_documents" | "personal" | undefined,
): { listItem: HTMLLIElement; row: RefinementRow } {
  const listItem = document.createElement("li");
  listItem.className = "refinement-list__item";

  const questionLine = document.createElement("p");
  questionLine.className = "refinement-list__question";
  questionLine.textContent = question.questionText;

  // Problem 2: the pill reflects the explicit taxonomy state, not a
  // "personal/subjective" catch-all.
  const state: AnswerState = lastApprovedReport?.states.get(index) ?? "needs_user_input";
  const display = stateDisplay(state);
  const badge = document.createElement("span");
  badge.className = `badge badge--${display.cssModifier}`;
  badge.textContent = display.label;
  questionLine.append(badge);
  void category; // superseded by `state`; kept in the signature for callers

  listItem.append(questionLine);

  // ERROR_RETRY questions get an explicit retry note — never "not found".
  if (state === "error_retry") {
    const retryNote = document.createElement("p");
    retryNote.className = "refinement-list__hint refinement-list__hint--warn";
    retryNote.textContent =
      "The AI couldn't be reached for this question (quota/network). This does NOT mean your documents lack the answer — regenerate the report to retry.";
    listItem.append(retryNote);
  }

  if (suggestion) {
    const hint = document.createElement("p");
    hint.className = "refinement-list__hint";
    hint.textContent = "AI suggested a starting answer below, drawn loosely from your documents — review and edit it.";
    listItem.append(hint);
  }

  let getValue: () => string;
  let setValue: ((value: string) => void) | undefined;
  const fieldName = `refine-${index}`;

  // THE CHOICE-FILL GAP. Pre-selection used to require an EXACT string match
  // between the AI's answer and the option text. So "3rd Year" vs "Third
  // Year", or any punctuation/spacing difference, left NO radio checked —
  // getValue() returned "", nothing was committed, and the choice shown in
  // the PDF never reached the form. Matching is now fuzzy, with the same
  // threshold the filler uses, so a near-miss still selects the right option.
  const CHOICE_MATCH_THRESHOLD = 0.55;
  const bestOptionFor = (candidate: string | undefined): string | null => {
    const wanted = candidate?.trim();
    if (!wanted) {
      return null;
    }
    let best: { option: string; score: number } | null = null;
    question.options.forEach((option) => {
      const score = textSimilarity(option, wanted);
      if (score >= CHOICE_MATCH_THRESHOLD && (!best || score > best.score)) {
        best = { option, score };
      }
    });
    const chosen = best ? (best as { option: string }).option : null;
    if (chosen && chosen.trim().toLowerCase() !== wanted.toLowerCase()) {
      // Option labels come from the FORM, not from the user's documents, so
      // they are safe to print — but this is per-field chatter, so it is gated.
      debugLog(`EasyFilla(review): Q${index} suggestion "${wanted}" fuzzy-matched to option "${chosen}".`);
    }
    if (!chosen) {
      console.log(
        `EasyFilla(review): Q${index} suggestion "${wanted}" matched NO option among ` +
          `[${question.options.join(" | ")}] — left unselected for you to choose.`,
      );
    }
    return chosen;
  };
  const preselectedOption = bestOptionFor(suggestion);

  if (SINGLE_SELECT_REFINEMENT_TYPES.has(question.type) && question.options.length > 0) {
    const group = document.createElement("div");
    group.className = "refinement-list__options";
    question.options.forEach((option, optionIndex) => {
      const optionLabel = document.createElement("label");
      optionLabel.className = "refinement-list__option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = fieldName;
      radio.value = option;
      radio.id = `${fieldName}-${optionIndex}`;
      radio.checked = preselectedOption !== null && option === preselectedOption;
      optionLabel.append(radio, document.createTextNode(option));
      group.append(optionLabel);
    });
    listItem.append(group);
    getValue = () => group.querySelector<HTMLInputElement>(`input[name="${fieldName}"]:checked`)?.value ?? "";
  } else if (question.type === "checkboxes" && question.options.length > 0) {
    // Same fuzzy rule as radios: each comma/semicolon-separated token is
    // resolved to its closest real option, so near-misses still tick a box.
    const suggestedTokens = new Set(
      (suggestion ?? "")
        .split(/[,;]/)
        .map((token) => bestOptionFor(token))
        .filter((option): option is string => option !== null),
    );
    const group = document.createElement("div");
    group.className = "refinement-list__options";
    question.options.forEach((option, optionIndex) => {
      const optionLabel = document.createElement("label");
      optionLabel.className = "refinement-list__option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = option;
      checkbox.id = `${fieldName}-${optionIndex}`;
      checkbox.checked = suggestedTokens.has(option);
      optionLabel.append(checkbox, document.createTextNode(option));
      group.append(optionLabel);
    });
    listItem.append(group);
    getValue = () =>
      Array.from(group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
        .map((element) => element.value)
        .join(", ");
  } else if (question.type === "paragraph") {
    const textarea = document.createElement("textarea");
    textarea.className = "refinement-list__textarea";
    textarea.rows = 4;
    textarea.value = suggestion ?? "";
    listItem.append(textarea);
    getValue = () => textarea.value;
    setValue = (value) => {
      textarea.value = value;
    };
  } else {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "text-input";
    input.value = suggestion ?? "";
    listItem.append(input);
    getValue = () => input.value;
    setValue = (value) => {
      input.value = value;
    };
  }

  // Feature 3 / FIX 6: the Compose path is offered ONLY on genuinely
  // open-ended questions that need the user's input — never on choice/
  // discrete fields, and never on an ERROR_RETRY question (that's an AI
  // outage to retry, not a prompt to compose).
  if (composeEligible(question, index) && setValue) {
    listItem.append(buildComposeControls(index, question.questionText, question));
  }

  const row: RefinementRow = setValue ? { index, getValue, setValue } : { index, getValue };
  return { listItem, row };
}

// Feature 2.2: a file-upload question's review row — the matched document,
// its confidence, and an override dropdown of all uploaded files. Attachment
// mode is shown plainly (auto vs Google manual). Never a silent pick.
function createFileMatchRow(question: ExtractedQuestionWithSection, index: number): HTMLLIElement {
  const report = lastApprovedReport;
  const listItem = document.createElement("li");
  listItem.className = "refinement-list__item";

  const questionLine = document.createElement("p");
  questionLine.className = "refinement-list__question";
  questionLine.textContent = question.questionText;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = question.attachmentMode === "manual" ? "File · attach by hand" : "File upload";
  questionLine.append(badge);
  listItem.append(questionLine);

  const constraints = question.fileConstraints;
  const constraintBits: string[] = [];
  if (constraints?.accept) {
    constraintBits.push(`accepted: ${constraints.accept}`);
  }
  if (constraints?.maxFiles) {
    constraintBits.push(`max ${constraints.maxFiles} file(s)`);
  }
  if (constraints?.sizeLimitText) {
    constraintBits.push(`limit ${constraints.sizeLimitText}`);
  }
  if (constraintBits.length > 0) {
    const hint = document.createElement("p");
    hint.className = "refinement-list__hint";
    hint.textContent = constraintBits.join(" · ");
    listItem.append(hint);
  }

  const currentPick = report?.fileMatches.get(index) ?? null;
  const match = matchDocumentToFileQuestion(question.questionText);
  if (match) {
    const conf = document.createElement("p");
    conf.className = "refinement-list__hint";
    conf.textContent = `Best match: ${match.fileName} (${match.confidence} confidence). Override below if wrong.`;
    listItem.append(conf);
  }

  const select = document.createElement("select");
  select.className = "text-input";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "— Don't attach —";
  select.append(noneOption);
  extractedDocuments.forEach((doc) => {
    const option = document.createElement("option");
    option.value = doc.fileName;
    option.textContent = doc.fileName;
    option.selected = doc.fileName === currentPick;
    select.append(option);
  });
  select.addEventListener("change", () => {
    report?.fileMatches.set(index, select.value || null);
  });
  listItem.append(select);

  if (question.attachmentMode === "manual") {
    const note = document.createElement("p");
    note.className = "refinement-list__hint refinement-list__hint--warn";
    note.textContent =
      "Google Forms uploads go through Google Drive and can't be attached automatically. " +
      "During Continue and Fill, the extension will pause and prompt you to attach this file by hand.";
    listItem.append(note);
  } else if (extractedDocuments.length === 0) {
    const note = document.createElement("p");
    note.className = "refinement-list__hint";
    note.textContent = "Upload the file in step 2 above, then it can be attached automatically.";
    listItem.append(note);
  }

  return listItem;
}

function renderRefinementQuestions(): void {
  refinementList.innerHTML = "";
  refinementRows = [];
  // D1 — the rows about to be discarded own the only handles to their buttons.
  // Clearing them prevents a late repaint writing to a detached node, and
  // `discardRunsExcept` cancels any job belonging to a superseded run so its
  // result can never land on a freshly-scanned question at the same index.
  composeRowHandles.clear();
  composeJobKeys.clear();
  if (lastApprovedReport) {
    composeQueue.discardRunsExcept(lastApprovedReport.runId);
  }

  const report = lastApprovedReport;
  if (!report) {
    saveRefinementButton.disabled = true;
    setRefinementStatus("");
    return;
  }

  // File-upload questions always show a match/override row (they have no text
  // answer). Text questions show a refine row only when still unanswered.
  const fileQuestions = report.questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => question.type === "file_upload");

  const unanswered = report.questions
    .map((question, index) => ({ question, index }))
    .filter(
      ({ question, index }) =>
        !question.manualOnly && question.type !== "file_upload" && !report.answers.get(index)?.trim(),
    );

  fileQuestions.forEach(({ question, index }) => {
    refinementList.append(createFileMatchRow(question, index));
  });

  const composableBlankIndexes: number[] = [];
  unanswered.forEach(({ question, index }) => {
    const { listItem, row } = createRefinementRow(
      question,
      index,
      report.suggestions.get(index),
      report.categories.get(index),
    );
    refinementRows.push(row);
    refinementList.append(listItem);
    if (composeEligible(question, index)) {
      composableBlankIndexes.push(index);
    }
  });

  // "Compose all" — FIX 2.3: only questions that actually HAVE seeds are
  // composable, and the count shown must be that number, not the total
  // open-ended count. Unseeded questions never enter the request.
  const seededIndexes = composableBlankIndexes.filter(
    (index) => (report.seeds.get(index)?.trim().length ?? 0) > 0,
  );
  if (seededIndexes.length > 1) {
    const composeAllItem = document.createElement("li");
    composeAllItem.className = "refinement-list__item refinement-list__compose-all";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--secondary";
    button.textContent = `✨ Compose all ${seededIndexes.length} seeded answer${seededIndexes.length === 1 ? "" : "s"} (1 request)`;
    button.addEventListener("click", () => void runCompose(seededIndexes));
    composeAllItem.append(button);
    refinementList.prepend(composeAllItem);
  } else if (composableBlankIndexes.length > 1) {
    // Eligible questions exist but none are seeded — say so instead of
    // offering a button that would spend quota for nothing.
    const note = document.createElement("li");
    note.className = "refinement-list__item refinement-list__compose-all";
    note.innerHTML =
      '<p class="panel__hint">Add a few rough notes under any open-ended question to enable “Compose all”. ' +
      "Composing without notes is blocked — it would spend an API request and can't be grounded.</p>";
    refinementList.prepend(note);
  }

  const nothingToDo = unanswered.length === 0 && fileQuestions.length === 0;
  saveRefinementButton.disabled = unanswered.length === 0;
  setRefinementStatus(
    nothingToDo
      ? "All questions were answered by the AI — nothing to refine."
      : `${unanswered.length} question${unanswered.length === 1 ? "" : "s"} need your input` +
          (fileQuestions.length > 0 ? `, ${fileQuestions.length} file upload(s) to confirm.` : "."),
  );

  // Hard-fail gate (3.4): Continue-and-Fill is blocked while any question
  // still has no confirmed answer — the user must write something or the
  // form stays un-filled for that field. Fabrication is never substituted.
  updateContinueFillGate();
}

// Continue-and-Fill is only enabled once every non-manual, non-file question
// either has a confirmed answer or is a grid (handled outside the fill path).
// File uploads never block the gate — attachment is best-effort and their
// absence just means that field is left for the user.
function updateContinueFillGate(): void {
  const report = lastApprovedReport;
  if (!report) {
    confirmFillButton.disabled = true;
    return;
  }
  const outstanding = report.questions.filter(
    (question, index) =>
      !question.manualOnly &&
      !GRID_QUESTION_TYPES.has(question.type) &&
      question.type !== "file_upload" &&
      !report.answers.get(index)?.trim(),
  ).length;

  confirmFillButton.disabled = outstanding > 0;
  if (outstanding > 0) {
    setConfirmFillStatus(
      `${outstanding} question(s) still need an answer (see Review & Refine above). ` +
        `Fill them in and Save to unlock Continue and Fill — nothing is ever auto-fabricated.`,
    );
  }
}

async function saveManualRefinements(): Promise<void> {
  const report = lastApprovedReport;
  if (!report) {
    setRefinementStatus("Generate an AI-answered report first.");
    return;
  }

  saveRefinementButton.disabled = true;

  try {
    let savedCount = 0;
    const blankRows: RefinementRow[] = [];
    refinementRows.forEach((row) => {
      const value = row.getValue().trim();
      if (value) {
        report.answers.set(row.index, value);
        // B-FIX 2: NO placeholder source. A value the user typed has no
        // document behind it; writing "you" into `sources` made an ungrounded
        // answer read like an attribution, which is how the last report looked
        // confidently sourced throughout. Unknown provenance gets nothing.
        report.states.set(
          row.index,
          deriveState({
            hasValue: true,
            ...(report.sources.get(row.index) ? { source: report.sources.get(row.index)! } : {}),
            composed: Boolean(report.provenance.get(row.index)?.length),
            // The user typed or confirmed this in the review UI.
            userProvided: true,
            userSeeded: true,
          }),
        );
        savedCount += 1;
      } else {
        blankRows.push(row);
      }
    });

    // Rows the user left blank go to Gemini for a best-effort default drawn
    // from the uploaded documents, so a saved report never has silently
    // blank fields. These defaults are visible in the Verified PDF and
    // still gated behind Continue and Fill before touching the form.
    let defaultsCount = 0;
    if (blankRows.length > 0 && extractedDocuments.length > 0) {
      setRefinementStatus(`Asking Gemini for default answers to ${blankRows.length} blank question(s)…`);
      const blankQuestions: QuestionForAi[] = [];
      blankRows.forEach((row) => {
        const question = report.questions[row.index];
        if (question && !GRID_QUESTION_TYPES.has(question.type)) {
          blankQuestions.push({
            index: row.index,
            questionText: question.questionText,
            type: question.type,
            options: question.options,
          });
        }
      });

      if (blankQuestions.length > 0) {
        const defaults = await matchAnswersWithGemini(
          getCombinedExtractedText(),
          blankQuestions,
          "defaults",
          effectiveAnswerLanguage(),
        );
        defaults.forEach((result, index) => {
          const trimmed = result.answer.trim();
          if (trimmed && !report.answers.get(index)?.trim()) {
            report.answers.set(index, trimmed);
            defaultsCount += 1;
          }
        });
      }
    }

    if (savedCount + defaultsCount === 0) {
      setRefinementStatus(
        blankRows.length > 0
          ? "Nothing to save — fill in an answer, or upload documents so Gemini can propose defaults."
          : "Fill in at least one answer before saving.",
      );
      return;
    }

    // THE BOUNDARY CHECK (PART B.1). Whatever any upstream path decided, no
    // answer leaves for the PDF claiming "answered from documents" without a
    // document filename behind it. Violations are corrected in place and named.
    // B-FIX 3: log-only is not enough — an integrity failure in the build the
    // user actually runs must be VISIBLE, or a silently-downgraded pill is
    // indistinguishable from a correct one.
    const violations = assertProvenanceIntegrity(report.states, report.sources, {
      throwOnViolation: import.meta.env.DEV,
    });
    if (violations.length > 0) {
      setConnectionStatus(
        `${violations.length} answer(s) were downgraded — provenance check failed: ` +
          `${violations.map((v) => `Q${v.index + 1} → ${stateDisplay(v.corrected).label}`).join(", ")}. ` +
          "They claimed to come from your documents but cited no file.",
        true,
      );
    }

    const blob = generateStructuredPdf(report.formTitle, report.questions, {
      answers: report.answers,
      suggestions: report.suggestions,
      sectionTitles: report.sectionTitles,
      categories: report.categories,
      fileMatches: report.fileMatches,
      provenance: report.provenance,
      states: report.states,
      sources: report.sources,
      verified: true,
      logoDataUrl,
    });
    const fileName = `easyfilla-verified-report-${Date.now()}.pdf`;
    downloadBlob(blob, fileName);
    renderDownloadLink(refinementPdfLinkContainer, blob, fileName, "Open verified PDF");

    renderRefinementQuestions();
    setConfirmFillStatus("The report was updated with your answers — Continue and Fill will include them.");
    const defaultsNote = defaultsCount > 0 ? ` (${defaultsCount} defaulted by Gemini from your documents)` : "";
    setRefinementStatus(
      `Saved ${savedCount + defaultsCount} answer${savedCount + defaultsCount === 1 ? "" : "s"}${defaultsNote} ` +
        `and downloaded the Verified PDF.`,
    );
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      setRefinementStatus(`${error.message} Click ⚙ Settings above to add one.`);
    } else {
      const message = error instanceof Error ? error.message : "Couldn't save those answers. They are still in the boxes above — try Save again.";
      setRefinementStatus(message);
    }
  } finally {
    saveRefinementButton.disabled = false;
  }
}

saveRefinementButton.addEventListener("click", () => {
  void saveManualRefinements();
});

// THE "it shows the right choice but doesn't fill it" FIX.
//
// Two things conspired: (1) an AI-suggested choice lives in `suggestions`,
// not `answers`, and buildFillableAnswers only reads `answers`; (2) a choice
// the user selects in Review & Refine lives only in the DOM until "Save
// Manual Answers" is clicked. So a dropdown could be visibly selected in the
// review and still be absent from the fill payload.
//
// Committing the refinement rows fixes both at once, because each row's
// getValue() reads the ACTUAL control state the user is looking at — whether
// that came from a pre-selected AI suggestion or their own click. What you
// see in the review is now what gets filled.
function commitPendingRefinements(report: ApprovedReport): number {
  let committed = 0;
  refinementRows.forEach((row) => {
    const value = row.getValue().trim();
    if (!value) {
      return;
    }
    if (report.answers.get(row.index)?.trim() === value) {
      return; // already committed, nothing to do
    }
    report.answers.set(row.index, value);
    report.states.set(
      row.index,
      deriveState({
        hasValue: true,
        ...(report.sources.get(row.index) ? { source: report.sources.get(row.index)! } : {}),
        composed: Boolean(report.provenance.get(row.index)?.length),
        userProvided: true,
        userSeeded: true,
      }),
    );
    committed += 1;
    // B4 — the VALUE is not logged: it is document-derived personal data.
    // Which question was committed is the useful part.
    debugLog(`EasyFilla(fill): committed reviewed answer for Q${row.index} (${value.length} chars).`);
  });
  return committed;
}

// MANUAL-ONLY CALL SITE 1 of 2 (the other is the Tier-2 `questionsForAi`
// filter). Passwords, payment fields, login forms and CAPTCHAs never enter a
// fill payload — and with STAGE 2a this holds PER FRAME, because the flag
// travels on the question itself from whichever frame detected it, not from
// any page-level state.
function buildFillableAnswers(report: ApprovedReport): FillableAnswer[] {
  const fillable: FillableAnswer[] = [];

  report.questions.forEach((question, index) => {
    if (question.manualOnly) {
      return;
    }
    const answer = report.answers.get(index)?.trim();
    if (answer) {
      fillable.push({
        questionText: question.questionText,
        type: question.type,
        options: question.options,
        answer,
        // Routing data. Undefined only for questions scanned before this
        // existed; sendToTab then falls back to a broadcast, which is the
        // pre-2a behaviour and correct for a single-frame page.
        ...(question.frameId !== undefined ? { frameId: question.frameId } : {}),
        ...(question.frameGeneration !== undefined ? { frameGeneration: question.frameGeneration } : {}),
        ...(question.identityKey ? { identityKey: question.identityKey } : {}),
      });
    }
  });

  return fillable;
}

// True when any answer in the group was scanned at a different generation of
// the frame than the one currently loaded — i.e. the frame navigated between
// the scan and the fill and these answers describe a document that is gone.
function answerGenerationMismatch(answers: FillableAnswer[], currentGeneration: number | undefined): boolean {
  if (currentGeneration === undefined) {
    return false; // nothing to compare against; don't invent a failure
  }
  return answers.some(
    (answer) => answer.frameGeneration !== undefined && answer.frameGeneration !== currentGeneration,
  );
}

// Which frame each answer belongs to, in a stable order. Answers with no
// frameId are grouped under `null` and broadcast, preserving single-frame
// behaviour exactly.
function groupAnswersByFrame(answers: FillableAnswer[]): Map<number | null, FillableAnswer[]> {
  const groups = new Map<number | null, FillableAnswer[]>();
  answers.forEach((answer) => {
    const key = answer.frameId ?? null;
    groups.set(key, [...(groups.get(key) ?? []), answer]);
  });
  return groups;
}

// STAGE 2a — step 1 of the two-step reveal, walked TOP-DOWN.
//
// A child frame can scroll within itself but cannot scroll its own <iframe>
// element into view: that element belongs to the parent's document, which a
// cross-origin child cannot touch. So each ancestor is asked, outermost
// first, to scroll the iframe holding the next frame down into view. Only
// then does the owning frame scroll to the field (see generic/fill.ts).
// Without this, widgets that only react when visible failed silently.
async function revealFrameChain(tabId: number, frameId: number, merged: MergedScan): Promise<void> {
  const placementByFrame = new Map(merged.placements.map((placement) => [placement.frameId, placement]));

  // Walk up to the root collecting (parentFrameId, iframeIndex) pairs.
  const chain: { parentFrameId: number; iframeIndex: number }[] = [];
  let current = frameId;
  const guard = new Set<number>();
  while (!guard.has(current)) {
    guard.add(current);
    const placement = placementByFrame.get(current);
    if (!placement || placement.parentFrameId < 0) {
      break;
    }
    if (placement.iframeIndex !== null) {
      chain.push({ parentFrameId: placement.parentFrameId, iframeIndex: placement.iframeIndex });
    } else {
      // Unplaced frame: we know its parent but not which iframe it is, so we
      // cannot reveal it. Say so — a silent skip here reads downstream as an
      // unexplained fill failure.
      console.warn(
        `EasyFilla(reveal): frame ${current} could not be located within frame ${placement.parentFrameId} ` +
          `(${placement.note ?? "no reason recorded"}), so its <iframe> can't be scrolled into view. ` +
          "Fields inside it may fail to fill if their widgets require visibility.",
      );
    }
    current = placement.parentFrameId;
  }

  // Outermost first: revealing an inner iframe is pointless while its own
  // container is still off-screen.
  for (const step of chain.reverse()) {
    const response = await sendToTab<RevealFrameResponse>(
      tabId,
      { type: MESSAGE_TYPE.REVEAL_FRAME, iframeIndex: step.iframeIndex },
      step.parentFrameId,
    );
    if (!response?.revealed) {
      console.warn(
        `EasyFilla(reveal): frame ${step.parentFrameId} couldn't reveal its iframe #${step.iframeIndex}` +
          (response?.reason ? ` — ${response.reason}` : " — no response"),
      );
    }
  }
}

// Encodes every AUTO-mode file question that has a chosen document into a
// FileAttachment. Manual (Google) file questions are handled by the pause,
// not here. Runs once before filling and passed to every section.
async function buildFileAttachments(report: ApprovedReport): Promise<FileAttachment[]> {
  const attachments: FileAttachment[] = [];
  for (const [index, question] of report.questions.entries()) {
    if (question.type !== "file_upload" || question.attachmentMode !== "auto") {
      continue;
    }
    const chosen = report.fileMatches.get(index);
    if (!chosen) {
      continue;
    }
    const doc = documentByName(chosen);
    if (doc) {
      attachments.push(await fileToAttachment(question.questionText, doc.file));
    }
  }
  return attachments;
}

// The Google Forms manual-attach pause (Feature 2.4). Shows a prompt naming
// the recommended file and blocks until the user confirms they've attached
// it by hand, then resumes the fill sequence.
function awaitManualAttach(questionText: string, fileName: string | null): Promise<void> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "manual-attach";
    const msg = document.createElement("p");
    msg.className = "manual-attach__msg";
    msg.textContent = fileName
      ? `Attach "${fileName}" to “${questionText}” on the form (scrolled into view), then click Continue.`
      : `Attach your file to “${questionText}” on the form, then click Continue.`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--primary";
    button.textContent = "I've attached it — Continue";
    button.addEventListener("click", () => {
      wrap.remove();
      resolve();
    });
    wrap.append(msg, button);
    confirmFillStatus.after(wrap);
  });
}

async function confirmAndFillForm(): Promise<void> {
  const report = lastApprovedReport;
  if (!report) {
    setConfirmFillStatus("Generate an AI-answered report first, and review it before continuing.");
    return;
  }

  // Capture whatever the user is currently looking at in Review & Refine
  // BEFORE building the payload — otherwise a selected choice they never
  // explicitly "saved" is silently dropped.
  const committed = commitPendingRefinements(report);
  if (committed > 0) {
    console.log(`EasyFilla(fill): committed ${committed} reviewed answer(s) from the review panel before filling.`);
  }

  const fillableAnswers = buildFillableAnswers(report);
  const fileAttachments = await buildFileAttachments(report);
  if (fillableAnswers.length === 0 && fileAttachments.length === 0) {
    const anyManualFiles = report.questions.some(
      (q) => q.type === "file_upload" && q.attachmentMode === "manual",
    );
    if (!anyManualFiles) {
      setConfirmFillStatus("The approved report has no answers or files to fill in.");
      return;
    }
  }

  confirmFillButton.disabled = true;
  setConfirmFillStatus("Filling form…");

  try {
    const tabId = await getActiveFormTabId();

    // Same sidepanel-driven, navigation-surviving stepping as scanning:
    // fill whatever's visible, advance, repeat, then walk back. Answers
    // already used on one section are dropped from the pool for the next.
    let remainingAnswers = [...fillableAnswers];
    let filledCount = 0;
    let attachedCount = 0;
    const attachFailures: string[] = [];
    const combinedFillLog: FillLogEntry[] = [];
    // FIX 1 — instrumentation for the post-navigation label fallback, summed
    // across every frame and every section of this run.
    let labelFallbackTotal = 0;
    let labelRefusalTotal = 0;

    const outcome = await driveSections(tabId, async (info, section) => {
      setConfirmFillStatus(`Filling section ${section}…`);

      // STAGE 2a — FILL ROUTING. Answers go to the frame that owns the field,
      // one frame at a time, never broadcast.
      const liveFrames = new Map(info.frames.map((frame) => [frame.frameId, frame]));
      const liveGenerations = new Map(
        info.questions.map((question) => [question.frameId, question.frameGeneration]),
      );
      const groups = groupAnswersByFrame(remainingAnswers);

      for (const [frameId, groupAnswers] of groups) {
        let answersForFrame = groupAnswers;

        if (frameId !== null) {
          const frame = liveFrames.get(frameId);

          // REMOVED frame — nothing to fill into. Its pending answers fail
          // with a reason rather than being routed somewhere else or dropped.
          if (!frame) {
            groupAnswers.forEach((answer) => {
              combinedFillLog.push({
                question: answer.questionText,
                type: answer.type,
                outcome: "failed",
                reason: `the frame this field was found in (frame ${frameId}) is no longer on the page`,
                frameId,
              });
            });
            continue;
          }

          // Present but unreadable right now (sandboxed, load error, access
          // not granted). Say which, rather than reporting a silent no-op.
          if (!frame.scanned) {
            groupAnswers.forEach((answer) => {
              combinedFillLog.push({
                question: answer.questionText,
                type: answer.type,
                outcome: "failed",
                reason: `frame ${frameId} is not readable right now — ${frame.inaccessibleDetail ?? frame.inaccessibleReason ?? "it did not respond"}`,
                frameId,
                frameUrl: frame.url,
              });
            });
            continue;
          }

          // NAVIGATED frame. This is NOT a failure: a wizard's own "Next"
          // click is a navigation, so failing here would break every
          // multi-step form. What it does invalidate is the structural
          // identityKey — it was computed against the previous document and
          // may now point at a different field. So the key is dropped and the
          // fill falls back to label matching, which re-resolves against the
          // live DOM inside the frame. Stated, not silent.
          if (answerGenerationMismatch(groupAnswers, liveGenerations.get(frameId))) {
            console.log(
              `EasyFilla(fill): frame ${frameId} navigated since these answers were produced. ` +
                `Dropping their structural identity keys (they describe the previous document) and ` +
                `matching by label against the current one instead — which REFUSES rather than guessing ` +
                "when the label is ambiguous (FIX 1).",
            );
            answersForFrame = groupAnswers.map(({ identityKey: _stale, ...answer }) => ({
              ...answer,
              identityInvalidated: true,
            }));
          }

          // Two-step reveal before anything is clicked in this frame.
          await revealFrameChain(tabId, frameId, info);
        }

        const request: FillCurrentSectionRequest = {
          type: MESSAGE_TYPE.FILL_CURRENT_SECTION,
          answers: answersForFrame,
          fileAttachments,
        };
        const result = await sendToTab<FillCurrentSectionResponse>(
          tabId,
          request,
          frameId ?? undefined,
        );
        if (result) {
          filledCount += result.filledQuestions.length;
          attachedCount += result.attachedFiles.length;
          labelFallbackTotal += result.labelFallbacks ?? 0;
          labelRefusalTotal += result.labelRefusals ?? 0;
          result.failedAttachments.forEach((f) =>
            attachFailures.push(`${f.questionText}${frameId !== null ? ` (frame ${frameId})` : ""}: ${f.reason}`),
          );
          if (result.fillLog) {
            combinedFillLog.push(...result.fillLog);
          }
          const consumed = new Set(result.consumedAnswers);
          remainingAnswers = remainingAnswers.filter((answer) => !consumed.has(answer.questionText));
        } else {
          // Info-level: a transient no-response while filling, not a crash —
          // keep it off the extensions Errors page.
          console.log(
            `EasyFilla: no fill response from ${frameId === null ? "the page" : `frame ${frameId}`} ` +
              `on section ${section} (continuing).`,
          );
        }
      }

      // Manual (Google Drive) file uploads on THIS section: scroll each into
      // view and pause for the user to attach by hand before advancing.
      const manualFileQuestions = info.questions.filter(
        (q) => q.type === "file_upload" && q.attachmentMode === "manual",
      );
      for (const fileQuestion of manualFileQuestions) {
        const reportIndex = report.questions.findIndex((q) => q.questionText === fileQuestion.questionText);
        const chosen = reportIndex >= 0 ? report.fileMatches.get(reportIndex) ?? null : null;
        const scrollRequest: ScrollToQuestionRequest = {
          type: MESSAGE_TYPE.SCROLL_TO_QUESTION,
          questionText: fileQuestion.questionText,
        };
        // Two-step reveal here too: the user is about to attach a file by
        // hand, so the field must actually be on screen, iframe and all.
        await revealFrameChain(tabId, fileQuestion.frameId, info);
        await sendToTab<ScrollToQuestionResponse>(tabId, scrollRequest, fileQuestion.frameId);
        setConfirmFillStatus(`Paused: attach a file to “${fileQuestion.questionText}” on the form.`);
        await awaitManualAttach(fileQuestion.questionText, chosen);
      }
    });

    const sectionWord = outcome.sectionsVisited === 1 ? "section" : "sections";
    const earlyNote = outcome.stoppedEarly
      ? ` Sections after section ${outcome.blockedAtSection} couldn't be reached automatically, so they weren't filled.`
      : "";
    const attachNote =
      attachedCount > 0 || attachFailures.length > 0
        ? ` Attached ${attachedCount} file(s)${attachFailures.length ? `; ${attachFailures.length} attachment(s) failed (see console)` : ""}.`
        : "";
    if (attachFailures.length > 0) {
      console.warn("EasyFilla: attachment failures", attachFailures);
    }
    // FIX 1 — end-of-run fallback report. This is a health signal, not noise:
    // the fallback only fires when a frame navigated mid-fill, so a high count
    // means the fill loop is racing re-renders and should be investigated
    // rather than worked around by loosening the match threshold.
    const fallbackNote =
      labelFallbackTotal > 0
        ? ` Label re-matching after navigation fired ${labelFallbackTotal} time(s)` +
          (labelRefusalTotal > 0
            ? `, and ${labelRefusalTotal} field(s) were left blank because the label was ambiguous — ` +
              "filling the wrong field would have been worse."
            : ".")
        : "";
    if (labelFallbackTotal > 0) {
      console.log(
        `EasyFilla(fill): post-navigation label fallback fired ${labelFallbackTotal} time(s) across this run, ` +
          `${labelRefusalTotal} refused as ambiguous. A high count means the fill loop is racing re-renders.`,
      );
    }
    // THE FILL REPORT. A partial fill must be loud: the user should never have
    // to scroll the form to discover that two dropdowns were left on "Choose".
    lastFillLog = combinedFillLog;
    renderFillReport(combinedFillLog);
    const notFilled = combinedFillLog.filter((r) => r.outcome !== "filled");
    const headline =
      notFilled.length === 0
        ? `Filled ${filledCount} of ${fillableAnswers.length} answered questions across ${outcome.sectionsVisited} ${sectionWord}.`
        : `Filled ${filledCount} of ${combinedFillLog.length} — ${notFilled.length} need manual entry: ` +
          `${notFilled.map((r) => `“${r.question}”`).join(", ")}.`;
    setConfirmFillStatus(
      `${headline}${attachNote}${earlyNote}${fallbackNote} Nothing was submitted — review the form, ` +
        `then click its own Submit button yourself when you're ready.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't fill the form.";
    setConfirmFillStatus(message);
  } finally {
    confirmFillButton.disabled = false;
  }
}

// Per-question fill report (PART A.4). Rendered into the panel, not just the
// console, and clicking a failed row scrolls that field into view on the form.
// The last run's per-field outcomes, so "Retry failed fields" can re-attempt
// ONLY the failures — no report regeneration, no Stage A or Stage B request.
let lastFillLog: FillLogEntry[] = [];

async function retryFailedFields(): Promise<void> {
  const report = lastApprovedReport;
  const failed = lastFillLog.filter((entry) => entry.outcome !== "filled");
  if (!report || failed.length === 0) {
    return;
  }
  retryFailedButton.disabled = true;
  setConfirmFillStatus(`Retrying ${failed.length} field(s)…`);
  try {
    const tabId = await getActiveFormTabId();
    const failedQuestions = new Set(failed.map((entry) => entry.question));
    // Reuses the EXISTING approved answers — nothing is re-generated, so this
    // costs zero API requests.
    const retryAnswers = buildFillableAnswers(report).filter((answer) => failedQuestions.has(answer.questionText));
    if (retryAnswers.length === 0) {
      setConfirmFillStatus("Nothing to retry — the failed fields have no approved answer to write.");
      return;
    }

    // Routed retries: same rule as the first attempt. A retry that broadcast
    // would hand every frame every failed answer to fuzzy-match.
    // Re-enumerate the frame tree before retrying: a retry happens long after
    // the fill, and frames may have navigated, appeared or gone in between.
    // Reusing the old placement map would reveal the wrong iframe. Costs no
    // API requests — this is browser state only.
    const frameContext = (await requestMergedScan(tabId)) ?? lastFrameCoverage;
    if (frameContext) {
      reportFrameCoverage(frameContext);
    }

    const log: FillLogEntry[] = [];
    for (const [frameId, groupAnswers] of groupAnswersByFrame(retryAnswers)) {
      if (frameId !== null && frameContext) {
        const frame = frameContext.frames.find((candidate) => candidate.frameId === frameId);
        if (!frame || !frame.scanned) {
          groupAnswers.forEach((answer) => {
            log.push({
              question: answer.questionText,
              type: answer.type,
              outcome: "failed",
              reason: frame
                ? `frame ${frameId} is not readable right now — ${frame.inaccessibleDetail ?? "it did not respond"}`
                : `the frame this field was found in (frame ${frameId}) is no longer on the page`,
              frameId,
            });
          });
          continue;
        }
        await revealFrameChain(tabId, frameId, frameContext);
      }
      const result = await sendToTab<FillCurrentSectionResponse>(
        tabId,
        {
          type: MESSAGE_TYPE.FILL_CURRENT_SECTION,
          answers: groupAnswers,
          fileAttachments: [],
        },
        frameId ?? undefined,
      );
      log.push(...(result?.fillLog ?? []));
    }
    // Merge: a retried field's new outcome replaces its previous row.
    const merged = lastFillLog.map((entry) => log.find((r) => r.question === entry.question) ?? entry);
    lastFillLog = merged;
    renderFillReport(merged);
    const stillFailing = merged.filter((entry) => entry.outcome !== "filled");
    setConfirmFillStatus(
      stillFailing.length === 0
        ? `Retry succeeded — all ${merged.length} fields are now filled.`
        : `Retry filled ${failed.length - stillFailing.length} of ${failed.length}; ` +
          `${stillFailing.length} still need manual entry: ${stillFailing.map((r) => `“${r.question}”`).join(", ")}.`,
    );
  } catch (error) {
    setConfirmFillStatus(error instanceof Error ? error.message : "Couldn't retry those fields. Reload the form tab, then run Fill again.");
  } finally {
    retryFailedButton.disabled = false;
  }
}

retryFailedButton.addEventListener("click", () => {
  void retryFailedFields();
});

function renderFillReport(log: FillLogEntry[]): void {
  fillReportList.innerHTML = "";
  if (log.length === 0) {
    fillReportSection.hidden = true;
    return;
  }
  fillReportSection.hidden = false;
  const failedCount = log.filter((entry) => entry.outcome !== "filled").length;
  retryFailedButton.hidden = failedCount === 0;
  retryFailedButton.textContent = `Retry ${failedCount} failed field${failedCount === 1 ? "" : "s"}`;

  const order = { failed: 0, skipped: 1, filled: 2 } as const;
  [...log]
    .sort((a, b) => order[a.outcome] - order[b.outcome])
    .forEach((entry) => {
      const item = document.createElement("li");
      item.className = `fill-report__row fill-report__row--${entry.outcome}`;

      const label = document.createElement("span");
      label.className = "fill-report__question";
      label.textContent = entry.question;

      const badge = document.createElement("span");
      badge.className = `badge badge--${entry.outcome === "filled" ? "answered" : entry.outcome === "failed" ? "error" : "needs-input"}`;
      badge.textContent = entry.outcome;

      const reason = document.createElement("p");
      reason.className = "fill-report__reason";
      // STAGE 2a — a failure names its frame. "Couldn't fill Country" is not
      // actionable on a page where three frames each have one.
      const frameNote =
        entry.frameId !== undefined && entry.frameId > 0
          ? ` (in the embedded frame at ${entry.frameUrl ?? `frame ${entry.frameId}`})`
          : "";
      // PART 2 — a file-upload row NAMES the document it matched, turning a dead
      // end into a two-second task. The match already exists (`fileMatches`);
      // it was simply never surfaced in the report the user actually reads.
      let attachmentNote = "";
      if (entry.type === "file_upload") {
        const reportIndex = lastApprovedReport?.questions.findIndex((q) => q.questionText === entry.question) ?? -1;
        const chosen = reportIndex >= 0 ? lastApprovedReport?.fileMatches.get(reportIndex) ?? null : null;
        attachmentNote = chosen
          ? ` → attach your ${chosen}`
          : " → no matching document uploaded, so there is nothing to suggest";
      }
      reason.textContent =
        entry.outcome === "filled" ? entry.reason : `${entry.reason}${frameNote}${attachmentNote}`;

      item.append(badge, label, reason);

      if (entry.outcome !== "filled") {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "link-button";
        jump.textContent = "Show me on the form";
        jump.addEventListener("click", () => {
          void (async () => {
            const tabId = await getActiveFormTabId();
            if (entry.frameId !== undefined && lastFrameCoverage) {
              await revealFrameChain(tabId, entry.frameId, lastFrameCoverage);
            }
            await sendToTab(
              tabId,
              { type: MESSAGE_TYPE.SCROLL_TO_QUESTION, questionText: entry.question },
              entry.frameId,
            );
          })();
        });
        item.append(jump);
      }
      fillReportList.append(item);
    });
}

confirmFillButton.addEventListener("click", () => {
  void confirmAndFillForm();
});

// ── Task 2: startup-splash dismissal ─────────────────────────────────────
// The splash node is rendered on first paint by index.html. We remove it once
// startup init settles, honoring a MIN 400ms display (so it never flashes) and
// a MAX 2.5s cap (so a hung init never traps the user behind it).
// The splash plays a deliberate ~3.8s branded intro: logo in → three bars
// fill left-to-right → a finger-snap pop + spark burst at ~2.5s. MIN holds it
// until that sequence finishes even on an instant load; MAX still releases a
// hung init a little after the show would have ended.
const SPLASH_MIN_MS = 3800;
const SPLASH_MAX_MS = 6000;
const SPLASH_FADE_MS = 240;
/**
 * PART 3 — per-word delay for the staggered notice reveal.
 *
 * Six words × 170ms ends at ~1.0s after the note's own start delay, comfortably
 * inside the ~3.8s intro. This is a CSS delay only; it never gates the splash.
 */
export const SPLASH_WORD_STAGGER_MS = 170;
let splashDismissed = false;

/**
 * Fires when the splash is dismissed — including a user skip.
 *
 * The notice reveal subscribes so a skipped intro lands the full line at once
 * rather than freezing it mid-stagger.
 */
const splashSkipListeners: (() => void)[] = [];
function onSplashSkipped(listener: () => void): void {
  splashSkipListeners.push(listener);
  // Already gone: run immediately so a late subscriber is never left waiting.
  if (splashDismissed) listener();
}

function dismissSplash(): void {
  if (splashDismissed) {
    return;
  }
  splashDismissed = true;
  // Announce BEFORE the fade begins, so the full text is on screen for the
  // fade rather than appearing as it disappears.
  splashSkipListeners.forEach((listener) => listener());
  const splash = document.getElementById("splash");
  if (!splash) {
    return;
  }
  const waitMs = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  window.setTimeout(() => {
    splash.classList.add("splash--hide");
    // Remove the node entirely (not just hide) after the fade completes.
    window.setTimeout(() => splash.remove(), SPLASH_FADE_MS + 20);
  }, waitMs);
}

// Hard cap: dismiss no later than SPLASH_MAX_MS after first paint, whatever
// happens during init.
window.setTimeout(dismissSplash, Math.max(0, SPLASH_MAX_MS - (Date.now() - splashShownAt)));

// ── TASK A: expectation-setting note ─────────────────────────────────────
// Output quality is bounded by input quality, and users cannot know that from
// the interface alone. The note is shown three times over: once on the splash
// (dismissible forever), and permanently at the two points where it is
// actionable — beside the upload zone and beside every seed box.
//
// It must NOT delay or block the splash: the reveal below is a plain `hidden`
// toggle that races nothing. The splash's MIN/MAX dismissal timers above are
// untouched, so the animation stays exactly as skippable as it was. If the
// storage read is slow and the splash has already gone, nothing is shown —
// which is correct, not a bug.
void (async () => {
  const noteText = document.getElementById("splash-note-text");
  const noteWrap = document.getElementById("splash-note");
  const dismissBtn = document.getElementById("splash-note-dismiss");
  if (!noteText || !noteWrap || !dismissBtn) {
    return;
  }
  // ── PART 3: STAGGERED REVEAL, per word ─────────────────────────────────
  // Deliberately NOT a typewriter. A typewriter delays comprehension — the
  // reader waits for the sentence to finish before it means anything — and on a
  // 3.8s splash that wastes most of the window. Whole words fading in are
  // legible from the first frame and simply arrive.
  //
  // ⚠️ IT MUST NOT DELAY OR BLOCK THE SPLASH. Every word is placed in the DOM
  // immediately; only its CSS opacity is animated, via a per-word delay. There
  // is no timer, no await between words, and nothing the splash's own MIN/MAX
  // dismissal timers can wait on. If this code never ran, the splash would
  // behave identically.
  const words = INPUT_QUALITY_NOTE.split(/\s+/).filter((word) => word.length > 0);
  noteText.textContent = "";
  // The full line stays available to assistive tech as ONE string: a screen
  // reader must not hear six separately-announced fragments.
  noteText.setAttribute("aria-label", INPUT_QUALITY_NOTE);
  words.forEach((word, index) => {
    const span = document.createElement("span");
    span.className = "splash__note-word";
    // Trailing space inside the span keeps normal word spacing without relying
    // on inline-block margins.
    span.textContent = index === words.length - 1 ? word : `${word} `;
    span.style.setProperty("--word-delay", `${index * SPLASH_WORD_STAGGER_MS}ms`);
    noteText.append(span);
  });

  /**
   * Lands the full line instantly.
   *
   * Called when the user skips: a skipped intro must not leave the hook
   * half-revealed, which would be worse than not animating it at all.
   */
  const revealNoteImmediately = (): void => {
    noteText.classList.add("splash__note--revealed");
  };
  onSplashSkipped(revealNoteImmediately);

  if (!(await isInputNoteDismissed()) && !splashDismissed) {
    noteWrap.hidden = false;
  } else if (splashDismissed) {
    // The splash already went while storage was being read. Nothing to show.
    return;
  }

  dismissBtn.addEventListener("click", () => {
    noteWrap.hidden = true;
    void dismissInputNote();
    // Dismissing the note is a deliberate "I've read it" — it should not also
    // cut the intro short, and it must not extend it.
  });
})();

// The two permanent placements. Populated from the same constants as the
// splash copy so the three can never drift apart.
{
  const filesNote = document.getElementById("input-note-files");
  if (filesNote) {
    filesNote.textContent = INPUT_QUALITY_NOTE_SHORT_FILES;
  }
}

populateLanguageDropdown();
applyLanguageToUi();

// Best-effort warm-up: if a form-bearing page is already the active tab
// when the side panel opens, attach the content script right away and show
// which adapter mode applies — no button click or page refresh needed. No
// permission prompt fires here (that only happens from the Grant-access
// button's own click); if injection needs access, that button is revealed.
// Dismisses the startup splash once this settles (success OR failure).
void (async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !tab.url || !HTTP_URL_PATTERN.test(tab.url)) {
      adapterModeText.textContent = "Mode: open a web page with a form, then use the buttons below.";
      return;
    }
    // B2 — FIRST RUN. On a cold install the user has no key, no documents and
    // no scan. Discovering the key requirement only by pressing a button and
    // getting an error is a bad first minute, so the panel leads with the next
    // thing to do. Only the boolean is read here — never the key itself.
    // E5: the check follows the ACTIVE provider. Hardcoding Gemini here told a
    // correctly-configured Anthropic user to go and add a Gemini key, and read
    // the state of a key that is not in use — both wrong, one of them a
    // needless read of the inactive provider's storage entry.
    const activeForHint = await activeProvider();
    const nextStep = !(await hasApiKey(activeForHint.id))
      ? ` Next: add your ${activeForHint.displayName} API key in Settings, then upload the documents to ` +
        "answer from. Scanning and PDF export work without a key."
      : rawUploads.length === 0
        ? " Next: upload the documents to answer from (CV, transcript, ID). Every answer is traced back to one " +
          "of them; anything not found stays blank for you."
        : "";

    injectionTargetUrl = tab.url; // lets ensureContentScriptInjected reveal Grant-access if needed
    await ensureContentScriptInjected(tab.id);
    const info = await requestMergedScan(tab.id);
    if (anyFrameScanned(info)) {
      reportFrameCoverage(info);
      const scanned = info.frames.filter((frame) => frame.scanned).length;
      setStatus(
        `${info.questions.length} field(s) detected on the current step across ${scanned} frame(s). ` +
          `Scan to cover every step.${nextStep}`,
      );
    } else if (nextStep) {
      setStatus(`EasyFilla is ready.${nextStep}`);
    } else {
      adapterModeText.textContent =
        "Mode: not connected yet — click Scan (you may be asked to grant access to this site).";
    }
  } finally {
    dismissSplash();
  }
})();
