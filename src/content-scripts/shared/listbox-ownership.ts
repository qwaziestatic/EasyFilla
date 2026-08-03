// ─────────────────────────────────────────────────────────────────────────
// LISTBOX OWNERSHIP — WHICH POPUP BELONGS TO WHICH TRIGGER
//
// ⚠️ THIS EXISTS BECAUSE OF A CONFIRMED LIVE FAILURE (2026-07-30, first live
// run). Two dropdowns failed with "clicked X but the control still shows
// Choose". The listbox opened, options were found, the text matched, a click was
// dispatched — and the selection never committed.
//
// ── THE BUG ──────────────────────────────────────────────────────────────
// `shared/options.ts` finds options with `document.querySelectorAll(
// '[role="option"]')`. That document-wide scan was introduced deliberately, and
// is CORRECT for FINDING options: Google Forms renders them into a detached
// popup outside the question card, so a card-scoped query finds nothing (§4).
//
// But finding is not the same as OWNING. A document-wide scan says nothing about
// which trigger a given option belongs to. On a form with two dropdowns, the
// right option TEXT can be matched inside the WRONG widget's popup — so a real
// option is really clicked, it really selects something, and the control being
// watched never changes. That is exactly the observed symptom.
//
// ── THE FIX ──────────────────────────────────────────────────────────────
// Resolve the owning listbox from the trigger EXPLICITLY, then scope the option
// query to it. The document-wide scan survives only as a last-resort fallback,
// and logs loudly when it fires, because a silent fallback is how this bug hid.
//
// ── WHY THIS MODULE IS DOM-GENERIC ───────────────────────────────────────
// It is written against the narrow structural interface below rather than
// `Element`/`Document`, so the ownership DECISION can be tested without a
// browser or jsdom (neither is available here — §6b's jsdom constraints, and no
// DOM library is installed). The test asserts which listbox wins for a given
// attribute layout. It does NOT — and cannot — assert that a real browser
// dispatches events the way we hope. That stays unverified (§7b).
// ─────────────────────────────────────────────────────────────────────────

/** The slice of `Element` this module actually touches. Real DOM satisfies it. */
export interface OwnerElement {
  getAttribute(name: string): string | null;
  querySelectorAll(selectors: string): ArrayLike<OwnerElement>;
  /**
   * Parameter is `object | null` rather than `OwnerElement | null` deliberately.
   * A real `Element.contains` takes `Node | null`, and neither `Node` nor
   * `OwnerElement` is assignable to the other — so a narrower signature here
   * makes real DOM elements fail to satisfy this interface. `object` is a
   * supertype of `Node`, which keeps both the browser and the test stubs valid.
   */
  contains(other: object | null): boolean;
}

/** The slice of `Document` this module actually touches. */
export interface OwnerDocument {
  getElementById(id: string): OwnerElement | null;
  querySelectorAll(selectors: string): ArrayLike<OwnerElement>;
}

/**
 * How the owning listbox was identified. Ordered from most to least
 * trustworthy; `document-wide-fallback` means ownership could NOT be
 * established and is the state that produced the live failure.
 */
export type OwnershipSource =
  | "aria-controls"
  | "aria-owns"
  | "aria-expanded"
  | "aria-activedescendant"
  | "self"
  | "document-wide-fallback";

export interface OwnershipResolution {
  listbox: OwnerElement | null;
  source: OwnershipSource;
  /** True when ownership is genuinely established, not guessed. */
  trusted: boolean;
  /** For the diagnostic block: what was inspected to decide. */
  detail: string;
}

const LISTBOX_SELECTOR = '[role="listbox"]';
const OPTION_SELECTOR = '[role="option"]';

function toArray(list: ArrayLike<OwnerElement>): OwnerElement[] {
  return Array.prototype.slice.call(list) as OwnerElement[];
}

/** First non-empty id token from a space-separated IDREF list. */
function firstIdRef(value: string | null): string | null {
  if (!value) return null;
  const first = value.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

/**
 * Resolves which listbox the given trigger owns.
 *
 * Order is deliberate — an explicit authored relationship beats an inferred one:
 *   1. `aria-controls` — the trigger states which popup it controls.
 *   2. `aria-owns` — same relationship, older spelling.
 *   3. `aria-expanded="true"` — exactly one listbox is open, so it is the one
 *      that just opened. Ambiguous if several are open, so that is rejected.
 *   4. `aria-activedescendant` — the trigger names its active OPTION; the
 *      listbox containing that option is the owner.
 *   5. The trigger IS a listbox containing options (Google Forms' own trigger
 *      carries `role="listbox"`), so it may own them directly.
 * Failing all of those, ownership is UNKNOWN and the caller must fall back
 * document-wide — loudly.
 */
export function resolveOwningListbox(trigger: OwnerElement, doc: OwnerDocument): OwnershipResolution {
  // 1 & 2 — explicit IDREF relationships.
  for (const attribute of ["aria-controls", "aria-owns"] as const) {
    const id = firstIdRef(trigger.getAttribute(attribute));
    if (id === null) continue;
    const referenced = doc.getElementById(id);
    if (referenced) {
      return {
        listbox: referenced,
        source: attribute,
        trusted: true,
        detail: `${attribute}="${id}" resolved to an element`,
      };
    }
    // A dangling IDREF is worth surfacing: the attribute exists, so the author
    // intended a relationship, and it is broken.
    return {
      listbox: null,
      source: attribute,
      trusted: false,
      detail: `${attribute}="${id}" points at NO element in the document (dangling IDREF)`,
    };
  }

  // 3 — exactly one open listbox.
  const expanded = toArray(doc.querySelectorAll(LISTBOX_SELECTOR)).filter(
    (element) => element.getAttribute("aria-expanded") === "true",
  );
  if (expanded.length === 1) {
    return {
      listbox: expanded[0]!,
      source: "aria-expanded",
      trusted: true,
      detail: 'exactly one [role="listbox"] has aria-expanded="true"',
    };
  }
  if (expanded.length > 1) {
    // Do NOT pick one. Guessing between two open popups is how the wrong widget
    // gets clicked, which is the bug being fixed.
    return {
      listbox: null,
      source: "aria-expanded",
      trusted: false,
      detail: `${expanded.length} listboxes report aria-expanded="true" — ambiguous, refusing to guess`,
    };
  }

  // 4 — the trigger names its active option; find that option's listbox.
  const activeId = firstIdRef(trigger.getAttribute("aria-activedescendant"));
  if (activeId !== null) {
    const active = doc.getElementById(activeId);
    if (active) {
      const owner = toArray(doc.querySelectorAll(LISTBOX_SELECTOR)).find((box) => box.contains(active));
      if (owner) {
        return {
          listbox: owner,
          source: "aria-activedescendant",
          trusted: true,
          detail: `aria-activedescendant="${activeId}" is inside this listbox`,
        };
      }
    }
  }

  // 5 — the trigger itself holds the options. Google Forms' trigger carries
  // role="listbox", so this is a real case rather than a defensive branch.
  if (toArray(trigger.querySelectorAll(OPTION_SELECTOR)).length > 0) {
    return {
      listbox: trigger,
      source: "self",
      trusted: true,
      detail: "the trigger itself contains [role=option] children",
    };
  }

  return {
    listbox: null,
    source: "document-wide-fallback",
    trusted: false,
    detail:
      "no aria-controls/aria-owns, no single expanded listbox, no aria-activedescendant, " +
      "and the trigger holds no options — OWNERSHIP UNKNOWN",
  };
}

/**
 * Options belonging to a resolved listbox. `null` listbox means ownership was
 * not established; the caller decides whether to fall back.
 */
export function optionsWithin(
  listbox: OwnerElement | null,
  isVisible: (option: OwnerElement) => boolean,
): OwnerElement[] {
  if (!listbox) return [];
  return toArray(listbox.querySelectorAll(OPTION_SELECTOR)).filter(isVisible);
}

/**
 * THE ASSERTION that would have caught the live failure.
 *
 * A clicked option MUST be a descendant of the listbox the trigger owns. If it
 * is not, we are about to click a real option in someone else's widget — the
 * click will "work", and the control under observation will never change.
 */
export function optionBelongsToListbox(option: OwnerElement, listbox: OwnerElement | null): boolean {
  if (!listbox) return false;
  // `contains` is true for the element itself; an option that IS the listbox is
  // malformed, but treating it as owned is harmless and avoids a false failure.
  return listbox.contains(option);
}

/**
 * Formats the ownership decision for the diagnostic block. Kept beside the
 * logic so the log cannot describe a decision the code did not make.
 */
export function describeOwnership(resolution: OwnershipResolution): string {
  const verdict = resolution.trusted ? "OWNED" : "UNRESOLVED";
  return `${verdict} via ${resolution.source} — ${resolution.detail}`;
}
