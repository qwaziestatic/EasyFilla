import type { ExtractedQuestion, FillableAnswer, FileAttachment } from "../../types/questions";

// The content script is deliberately stateless: one message = one action on
// the CURRENTLY VISIBLE section only. Multi-section traversal is
// orchestrated from the sidepanel, because clicking "Next" on a Google Form
// can trigger a real page navigation that destroys the content script's
// execution context — any loop living inside the content script dies
// mid-traversal (which is exactly what produced one-section-only scans and
// left the user stranded on the last section).
export const MESSAGE_TYPE = {
  GET_SECTION_INFO: "GET_SECTION_INFO",
  CLICK_NAV: "CLICK_NAV",
  FILL_CURRENT_SECTION: "FILL_CURRENT_SECTION",
  SCROLL_TO_QUESTION: "SCROLL_TO_QUESTION",
  // STAGE 2a — frame plumbing.
  FRAME_HELLO: "FRAME_HELLO",
  REVEAL_FRAME: "REVEAL_FRAME",
  SCAN_ALL_FRAMES: "SCAN_ALL_FRAMES",
} as const;

// ── STAGE 2a: FRAME IDENTITY HANDSHAKE ───────────────────────────────────
// A content script CANNOT read its own frameId — there is no DOM or
// extension API that exposes it from inside the frame. It must ASK: the
// frame posts FRAME_HELLO to the service worker, which reads `sender.frameId`
// / `sender.url` (values only the browser can supply) and echoes them back.
//
// Until that round trip completes the frame does not know who it is, and an
// unidentified frame MUST NOT scan: every identity key begins with frameId
// (see adapters/identity.ts), so two unidentified frames would mint colliding
// keys and the dedup pass would delete one frame's fields as "duplicates" of
// the other's.
export interface FrameHelloRequest {
  type: typeof MESSAGE_TYPE.FRAME_HELLO;
  // The frame's own view of itself, for cross-checking against the sender.
  // Never used as the frameId — only the worker's answer is authoritative.
  href: string;
  isTopWindow: boolean;
}

export interface FrameHelloResponse {
  frameId: number;
  tabId: number;
  // The URL as the BROWSER sees it, which can differ from document.href for
  // about:blank/srcdoc frames; the ordering heuristic matches on this.
  url: string;
}

export function isFrameHelloRequest(message: unknown): message is FrameHelloRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === MESSAGE_TYPE.FRAME_HELLO
  );
}

export interface GetSectionInfoRequest {
  type: typeof MESSAGE_TYPE.GET_SECTION_INFO;
}

export type AdapterName = "google-forms" | "generic";

// ── STAGE 2a: PER-FRAME ORDERING INPUTS ──────────────────────────────────
// Ordering questions across cross-origin frames is genuinely hard: no frame
// can see any other frame's layout, and the service worker sees no layout at
// all. So each frame reports the two things only IT can know, and the worker
// stitches them together (see background/frame-registry.ts).

// One <iframe> element as seen by the frame that CONTAINS it.
export interface ChildFrameRef {
  // Index among all <iframe> elements in this document, in document order.
  // This is the join key when the child can read `window.frameElement`.
  iframeIndex: number;
  // Resolved absolute src, or "" for srcdoc / about:blank / javascript: frames.
  src: string;
  // Position in the reporting frame's combined document-order sequence of
  // (fields ∪ child iframes) — this is what lets a child frame's questions be
  // spliced into the parent's list at the point where the iframe sits, rather
  // than appended after everything.
  order: number;
  // Raw sandbox attribute, or null when absent. A sandbox WITHOUT
  // allow-scripts cannot run a content script — that frame is permanently
  // inaccessible and must not be retried.
  sandbox: string | null;
  hasSrcdoc: boolean;
}

// A question plus the ordering/identity data the merge needs.
export interface FrameQuestion extends ExtractedQuestion {
  // Index in this frame's combined (fields ∪ child iframes) document order.
  order: number;
  // frameId + domPath + name/id + accessibleName. NEVER label text.
  identityKey: string;
}

export interface GetSectionInfoResponse {
  adapter: AdapterName;
  formTitle: string;
  sectionTitle: string | null;
  questions: FrameQuestion[];
  hasNext: boolean;
  // Same-document unreadable regions. With all_frames scanning this is no
  // longer how iframes are counted — the service worker reconciles the real
  // frame tree — but it is kept for adapters that still see opaque embeds.
  inaccessibleFrames: number;
  // Raw language hint from <html lang> / hl= param, or null. The sidepanel
  // combines this with script heuristics and any user override.
  langHint: string | null;
  // Structural identity of the visible section; the sidepanel compares
  // fingerprints before/after a nav click to confirm the section actually
  // changed (works for both in-place DOM swaps and full page loads).
  fingerprint: string;

  // ── frame-scan additions ──
  // The frameId this scan came from, as told to us by the service worker.
  // Never guessed: a frame that has not completed the handshake refuses to
  // scan and answers with `identified: false` instead.
  frameId: number;
  identified: boolean;
  // Why this frame produced nothing, when it produced nothing.
  unidentifiedReason?: string;
  // Every <iframe> in this document, document order.
  childFrames: ChildFrameRef[];
  // From `window.frameElement` — readable ONLY when the parent document is
  // same-origin. When present it is an EXACT parent-slot resolution; when
  // null the worker falls back to matching src against url, which is
  // imperfect under redirects.
  selfIframeIndex: number | null;
}

export function isGetSectionInfoRequest(message: unknown): message is GetSectionInfoRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === MESSAGE_TYPE.GET_SECTION_INFO
  );
}

export interface ClickNavRequest {
  type: typeof MESSAGE_TYPE.CLICK_NAV;
  direction: "next" | "back";
}

export interface ClickNavResponse {
  clicked: boolean;
  // When clicked=false, why — so the sidepanel can distinguish "final
  // section reached" from "ambiguous, refused to guess" and report it.
  reason?: string;
  method?: string;
}

export function isClickNavRequest(message: unknown): message is ClickNavRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === MESSAGE_TYPE.CLICK_NAV &&
    ((message as { direction?: unknown }).direction === "next" ||
      (message as { direction?: unknown }).direction === "back")
  );
}

export interface FillCurrentSectionRequest {
  type: typeof MESSAGE_TYPE.FILL_CURRENT_SECTION;
  answers: FillableAnswer[];
  fileAttachments: FileAttachment[];
}

export interface AttachmentFailure {
  questionText: string;
  reason: string;
}

export interface FillLogEntry {
  question: string;
  type: string;
  outcome: "filled" | "failed" | "skipped";
  reason: string;
  intended?: string;
  observed?: string;
  // STAGE 2a — which frame this row happened in. Stamped centrally by the
  // content script's message handler so a failure can always name its frame;
  // "couldn't fill Country" is not actionable when three frames have one.
  frameId?: number;
  frameUrl?: string;
}

export interface FillCurrentSectionResponse {
  filledQuestions: string[];
  skippedQuestions: string[];
  // questionText of each answer that was successfully used, so the
  // sidepanel can drop it from the remaining pool before the next section.
  consumedAnswers: string[];
  // File-upload questions that were attached (auto/generic path) and those
  // that failed, with a per-field reason.
  attachedFiles: string[];
  failedAttachments: AttachmentFailure[];
  // Per-field outcome + reason, so the sidepanel can show a fill report rather
  // than leaving the user to discover unfilled fields by scrolling the form.
  fillLog?: FillLogEntry[];
  // FIX 1 — how often this frame fell back to label matching after a
  // navigation invalidated an answer's structural identity key, and how many
  // of those were REFUSED as ambiguous. Reported at end of run: a high
  // fallback count means the fill loop is racing re-renders.
  labelFallbacks?: number;
  labelRefusals?: number;
}

export function isFillCurrentSectionRequest(message: unknown): message is FillCurrentSectionRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === MESSAGE_TYPE.FILL_CURRENT_SECTION &&
    Array.isArray((message as { answers?: unknown }).answers)
  );
}

// Used by the Google Forms manual-attach pause: scroll the named file-upload
// question into view so the user can attach to the right field by hand.
export interface ScrollToQuestionRequest {
  type: typeof MESSAGE_TYPE.SCROLL_TO_QUESTION;
  questionText: string;
}

export interface ScrollToQuestionResponse {
  found: boolean;
}

// ── STAGE 2a: TWO-STEP REVEAL ────────────────────────────────────────────
// A child frame can scroll *within itself* but cannot scroll its own <iframe>
// element into view — that element lives in the parent's document, which a
// cross-origin child cannot touch. Widgets that only respond when visible
// therefore fail silently: the child dutifully scrolls to a field that is
// still off-screen from the user's (and the compositor's) point of view.
//
// So the reveal runs top-down: the sidepanel walks the ancestor chain,
// asking each frame to scrollIntoView the <iframe> holding the next frame
// down, and only then does the owning frame scroll to the field itself.
export interface RevealFrameRequest {
  type: typeof MESSAGE_TYPE.REVEAL_FRAME;
  // Index among this document's <iframe> elements (see ChildFrameRef).
  iframeIndex: number;
}

export interface RevealFrameResponse {
  revealed: boolean;
  reason?: string;
}

export function isRevealFrameRequest(message: unknown): message is RevealFrameRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === MESSAGE_TYPE.REVEAL_FRAME &&
    typeof (message as { iframeIndex?: unknown }).iframeIndex === "number"
  );
}

// ── STAGE 2a: MERGED SCAN (sidepanel → service worker) ────────────────────
// The sidepanel no longer talks to "the content script" — there may be a
// dozen. It asks the worker, which owns the frame registry, to enumerate the
// tree, fan out, reconcile silence, and merge.
export interface ScanAllFramesRequest {
  type: typeof MESSAGE_TYPE.SCAN_ALL_FRAMES;
  tabId: number;
}

export function isScanAllFramesRequest(message: unknown): message is ScanAllFramesRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === MESSAGE_TYPE.SCAN_ALL_FRAMES &&
    typeof (message as { tabId?: unknown }).tabId === "number"
  );
}

export function isScrollToQuestionRequest(message: unknown): message is ScrollToQuestionRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === MESSAGE_TYPE.SCROLL_TO_QUESTION &&
    typeof (message as { questionText?: unknown }).questionText === "string"
  );
}
