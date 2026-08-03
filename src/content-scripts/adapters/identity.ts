// ─────────────────────────────────────────────────────────────────────────
// FIELD IDENTITY (STAGE 2b)
//
// Deduplication MUST key on structural identity, never on label text. A 59-field
// application form produced ~50% duplicate questions because portals reuse the
// same visible label many times ("Start date", "End date", "Employer" repeated
// per employment row). Text-keyed dedup collapses genuinely distinct fields and
// text-keyed matching fills the wrong one.
//
// The key is: frameId + DOM path + name/id + accessible name.
// ─────────────────────────────────────────────────────────────────────────

// A structural path from the document root. Uses tag + nth-of-type at each
// level, which is stable across re-renders in a way that class names are not.
export function domPath(element: Element, maxDepth = 12): string {
  const parts: string[] = [];
  let node: Element | null = element;
  let depth = 0;

  while (node && node.nodeType === 1 && depth < maxDepth) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html" || tag === "body") {
      break;
    }
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}[${siblings.indexOf(node) + 1}]` : tag);
    node = parent;
    depth += 1;
  }
  return parts.join(">");
}

export interface FieldIdentity {
  frameId: number;
  path: string;
  nameOrId: string;
  accessibleName: string;
  key: string;
}

export function fieldIdentity(element: Element, frameId: number, accessibleName: string): FieldIdentity {
  const nameOrId =
    element.getAttribute("name") ??
    element.getAttribute("id") ??
    element.getAttribute("data-automation-id") ?? // Workday
    "";
  const path = domPath(element);
  return {
    frameId,
    path,
    nameOrId,
    accessibleName,
    // Normalized so trivial whitespace/case differences don't split one field
    // into two, while structure still separates genuinely distinct fields.
    key: [frameId, path, nameOrId, accessibleName.replace(/\s+/g, " ").trim().toLowerCase()].join("|"),
  };
}

// Deduplicates on identity key, keeping first-seen order. Returns the removed
// entries so the coverage report can state what was collapsed and why.
export function dedupeByIdentity<T>(
  items: T[],
): { kept: T[]; removed: { item: T; duplicateOf: string }[] } {
  const seen = new Map<string, T>();
  const kept: T[] = [];
  const removed: { item: T; duplicateOf: string }[] = [];

  for (const item of items) {
    const key = (item as { identity?: FieldIdentity }).identity?.key;
    if (!key) {
      kept.push(item);
      continue;
    }
    if (seen.has(key)) {
      removed.push({ item, duplicateOf: key });
      continue;
    }
    seen.set(key, item);
    kept.push(item);
  }
  return { kept, removed };
}

// ── ACCESSIBLE NAME (STAGE 2b) ────────────────────────────────────────────
// Priority per the spec: label[for] / wrapping <label> → aria-label →
// aria-labelledby → <legend> → placeholder. Nearby-text scraping is a
// LAST resort only, because on dense portal layouts it reliably picks up the
// previous field's text.
export interface AccessibleNameSources {
  labelFor?: string;
  wrappingLabel?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  legend?: string;
  placeholder?: string;
  nearbyText?: string;
  prettifiedIdentifier?: string;
}

export function accessibleNameFrom(sources: AccessibleNameSources): { name: string; from: keyof AccessibleNameSources | "none" } {
  const order: (keyof AccessibleNameSources)[] = [
    "labelFor",
    "wrappingLabel",
    "ariaLabel",
    "ariaLabelledBy",
    "legend",
    "placeholder",
    "nearbyText",
    "prettifiedIdentifier",
  ];
  for (const source of order) {
    const value = sources[source]?.replace(/\s+/g, " ").trim();
    if (value) {
      return { name: value, from: source };
    }
  }
  return { name: "", from: "none" };
}

// The frame this content script instance is running in. `window.top === window`
// identifies the main frame; sub-frames get a stable per-session id assigned by
// the service worker and stashed here. Falls back to 0 so single-frame pages
// behave exactly as before.
let assignedFrameId = 0;

export function setFrameId(id: number): void {
  assignedFrameId = id;
}

export function currentFrameId(): number {
  return assignedFrameId;
}
