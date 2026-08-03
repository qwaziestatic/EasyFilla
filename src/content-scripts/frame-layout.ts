// ─────────────────────────────────────────────────────────────────────────
// PER-FRAME LAYOUT REPORTING (STAGE 2a)
//
// Ordering questions across cross-origin frames is genuinely hard: no frame
// can see another frame's layout, and the service worker has no DOM at all.
// The only workable split is that each frame reports the two things it alone
// can observe, and the worker stitches them together:
//
//   1. a single document-order sequence covering BOTH its own fields and its
//      child <iframe> elements — so a child frame's questions can be spliced
//      in exactly where its iframe sits, not appended after everything;
//   2. `window.frameElement`, readable only when the parent is same-origin,
//      which gives an EXACT answer to "which of my parent's iframes am I?".
//
// Cross-origin frames have no (2), so the worker falls back to matching the
// parent's iframe src against the frame's url. See frame-registry.ts for
// that heuristic and its documented failure mode (redirects).
// ─────────────────────────────────────────────────────────────────────────

import type { ChildFrameRef } from "../lib/messaging/messages";

// Rows on a real form are rarely pixel-aligned; bucketing absorbs baseline
// jitter so two controls on one visual row don't order by a 2px difference.
const ROW_BUCKET_PX = 8;

interface Positioned {
  top: number;
  left: number;
  hasRect: boolean;
}

function positionOf(element: Element): Positioned {
  const rect = element.getBoundingClientRect();
  const scrollY = typeof window.scrollY === "number" ? window.scrollY : 0;
  const scrollX = typeof window.scrollX === "number" ? window.scrollX : 0;
  const hasRect = rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.left !== 0;
  return {
    top: Math.round((rect.top + scrollY) / ROW_BUCKET_PX),
    left: Math.round(rect.left + scrollX),
    hasRect,
  };
}

// Enumerates every <iframe> in this document, in document order. The index is
// the join key the child frame reports back via window.frameElement.
function iframeElements(): HTMLIFrameElement[] {
  return Array.from(document.querySelectorAll("iframe"));
}

export interface FrameLayout {
  // Parallel to the questions handed in: each question's index in this
  // frame's combined (fields ∪ child iframes) reading order.
  questionOrders: number[];
  childFrames: ChildFrameRef[];
  selfIframeIndex: number | null;
}

// This frame's own index among its parent's <iframe> elements — an exact
// placement, available only when the parent document is same-origin.
// Cross-origin frames get null here and are placed heuristically instead.
export function readSelfIframeIndex(): number | null {
  try {
    const element = window.frameElement;
    if (!element) {
      return null; // top-level frame, or cross-origin (spec returns null)
    }
    const owner = element.ownerDocument;
    if (!owner) {
      return null;
    }
    const index = Array.from(owner.querySelectorAll("iframe")).indexOf(element as HTMLIFrameElement);
    return index >= 0 ? index : null;
  } catch {
    // Older engines throw SecurityError instead of returning null.
    return null;
  }
}

// Builds one reading order over this frame's fields and its child iframes.
//
// Primary key is the bounding rect (row bucket, then x) because that is the
// order a person reads the form in; document order is the tiebreak and the
// fallback for anything with no box (detached, display:none, or a question
// with no anchor element at all, like the synthetic CAPTCHA entry).
export function computeFrameLayout(anchors: (Element | null)[]): FrameLayout {
  const frames = iframeElements();

  type Entry =
    | { kind: "question"; index: number; element: Element | null }
    | { kind: "frame"; index: number; element: HTMLIFrameElement };

  const entries: Entry[] = [
    ...anchors.map((element, index) => ({ kind: "question" as const, index, element })),
    ...frames.map((element, index) => ({ kind: "frame" as const, index, element })),
  ];

  // Document order for every entry that has an element, resolved once.
  const documentOrder = new Map<Element, number>();
  const all = entries.map((entry) => entry.element).filter((element): element is Element => element !== null);
  const sortedByDocument = [...new Set(all)].sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  });
  sortedByDocument.forEach((element, index) => documentOrder.set(element, index));

  const ranked = entries.map((entry) => {
    const position = entry.element ? positionOf(entry.element) : null;
    const docIndex = entry.element ? documentOrder.get(entry.element) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    return { entry, position, docIndex };
  });

  ranked.sort((a, b) => {
    // Anything without a box sorts last, in document order among themselves.
    const aPositioned = a.position?.hasRect ?? false;
    const bPositioned = b.position?.hasRect ?? false;
    if (aPositioned !== bPositioned) {
      return aPositioned ? -1 : 1;
    }
    if (aPositioned && bPositioned && a.position && b.position) {
      if (a.position.top !== b.position.top) {
        return a.position.top - b.position.top;
      }
      if (a.position.left !== b.position.left) {
        return a.position.left - b.position.left;
      }
    }
    return a.docIndex - b.docIndex;
  });

  const questionOrders = new Array<number>(anchors.length).fill(0);
  const frameOrders = new Array<number>(frames.length).fill(0);
  ranked.forEach(({ entry }, order) => {
    if (entry.kind === "question") {
      questionOrders[entry.index] = order;
    } else {
      frameOrders[entry.index] = order;
    }
  });

  const childFrames: ChildFrameRef[] = frames.map((element, index) => ({
    iframeIndex: index,
    // The `src` PROPERTY is the resolved absolute URL; the attribute is not.
    // "" for srcdoc / about:blank / javascript: frames.
    src: element.src ?? "",
    order: frameOrders[index] ?? order0(index, ranked.length),
    sandbox: element.getAttribute("sandbox"),
    hasSrcdoc: element.hasAttribute("srcdoc"),
  }));

  return { questionOrders, childFrames, selfIframeIndex: readSelfIframeIndex() };
}

function order0(index: number, total: number): number {
  return total + index;
}
