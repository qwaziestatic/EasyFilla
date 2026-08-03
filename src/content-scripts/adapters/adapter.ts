import type { ExtractedQuestion, FillPayload } from "../../types/questions";
import type { AdapterName } from "../../lib/messaging/messages";
import type { NavResolution } from "./nav-resolver";

export interface AdapterSectionData {
  formTitle: string;
  sectionTitle: string | null;
  questions: ExtractedQuestion[];
  hasNext: boolean;
  inaccessibleFrames: number;
  // Raw language signals the adapter can read from the DOM/URL — the shared
  // core combines these with script heuristics and the user override. null
  // when the adapter finds nothing.
  langHint: string | null;
  // STAGE 2a — one anchor element per question, parallel to `questions`.
  // Used ONLY by the content script's frame layer, to interleave this frame's
  // fields with its child <iframe> elements in true document order before
  // anything crosses the message boundary (elements can't be serialized, and
  // the service worker has no DOM to compute this from).
  orderAnchors?: (Element | null)[];
  // Structural identity key per question, parallel to `questions`. Computed
  // by the adapter because only it holds the elements. NEVER label text.
  identityKeys?: string[];
}

// One row per field the driver touched, so the sidepanel can render a per-
// question fill report. A silent partial fill was the bug; a loud one is fine.
import type { FillLogEntry } from "../../lib/messaging/messages";
export type { FillLogEntry };

// STAGE 2e — emitted after every scan so the user never has to guess what was
// missed. Includes hard limits (canvas/PDF-rendered forms) stated plainly.
export interface CoverageReport {
  adapter: "googleForms" | "generic";
  frameId: number;
  fieldsFound: number;
  byType: Record<string, number>;
  duplicatesCollapsed: number;
  inaccessibleFrames: number;
  manualOnly: number;
  // Choice fields that produced ZERO options — an extraction failure, not an
  // empty form. Visible rather than silently unanswerable.
  //
  // STAGE 2c: this now means "zero options AFTER a harvest attempt", which is a
  // strictly stronger claim than before (the scanner used not to open lazily-
  // rendered widgets at all). Fields the harvest budget never reached are
  // counted in `optionsPending` instead and are NOT failures.
  choiceWithNoOptions: number;
  // Choice fields deferred to fill-time harvesting because the per-scan budget
  // ran out. Not a failure; stated so the two cases can't be confused.
  optionsPending: number;
  // Why the harvest stopped early, when it did.
  harvestBudgetReason?: string;
  harvestedWidgets: number;
  // No DOM to read at all. A hard limit, not a bug.
  canvasOrPdfRendered: boolean;
}

export interface VisibleSectionFillResult {
  filledQuestions: string[];
  skippedQuestions: string[];
  consumedAnswers: string[];
  attachedFiles: string[];
  failedAttachments: { questionText: string; reason: string }[];
  // Optional so the generic adapter can adopt it incrementally.
  fillLog?: FillLogEntry[];
  // FIX 1 — post-navigation label-fallback instrumentation (see generic/fill.ts).
  labelFallbacks?: number;
  labelRefusals?: number;
}

// One adapter per site family. Adapters only know how to DETECT fields and
// FILL them on the currently visible section/step of their kind of page —
// everything else (traversal orchestration, PDF generation, Gemini
// answering, review workflow) is shared core that talks to adapters through
// this interface and must not care which one is active.
export interface FormAdapter {
  readonly name: AdapterName;
  getSectionData(): Promise<AdapterSectionData>;
  // Returns a resolution (not a bare element) so the message handler can
  // enforce the submit-safety invariant: only a confident, non-submit
  // result is ever clicked. Resolving (not clicking) here also lets the
  // handler respond BEFORE clicking — a nav click may destroy this context.
  resolveNav(direction: "next" | "back"): NavResolution;
  fillVisibleSection(payload: FillPayload): Promise<VisibleSectionFillResult>;
  // Scrolls a question into view by its text (used by the Google Forms
  // manual-attach pause). Returns whether it was found on the visible step.
  scrollToQuestion(questionText: string): boolean;
}
