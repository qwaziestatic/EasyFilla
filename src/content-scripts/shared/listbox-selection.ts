// ─────────────────────────────────────────────────────────────────────────
// LISTBOX SELECTION — OPENNESS, MATCHING, AND KEYBOARD ARITHMETIC
//
// ⚠️ THIS EXISTS BECAUSE OF THE SECOND LIVE DROPDOWN FAILURE (2026-07-31).
//
// Instrumentation from the run:
//   "Amharic" was clicked and no commit signal changed. Tried: the option node
//   [pointerdown → mousedown → pointerup → mouseup → click]; its deepest
//   text-bearing descendant [same]; keyboard: focus listbox → ArrowDown ×1 →
//   Enter. Ownership: OWNED via self — the trigger itself contains
//   [role="option"] children. The control still shows "Choose".
//
// ── THE BUG ──────────────────────────────────────────────────────────────
// Google Forms keeps `[role="option"]` nodes in the DOM AT ALL TIMES, inside
// the listbox, even while it is CLOSED. The readiness poll waited for option
// nodes to appear — so it succeeded on the first tick, before the widget had
// opened, and every subsequent strategy fired at inert, non-interactive nodes.
//
// A previous session's comment asserted the opposite ("the options DO NOT EXIST
// until the listbox is opened"). That was written from the detached-popup
// behaviour and was never checked against a live DOM. The live run disproves it.
//
// ── THE RULE ─────────────────────────────────────────────────────────────
// **OPENNESS IS `aria-expanded="true"`. IT IS NEVER THE PRESENCE OF OPTIONS.**
// Presence proves the markup exists; only aria-expanded proves the widget is
// interactive. Everything in this module follows from that distinction.
//
// Pure and DOM-generic so the decisions can be tested without a browser (no DOM
// library is installed — §6b). It decides WHAT to click and HOW FAR to arrow;
// the caller does the dispatching.
// ─────────────────────────────────────────────────────────────────────────

/** The slice of `Element` this module reads. Real DOM satisfies it. */
export interface SelectableOption {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/** How a match was made, weakest last. Reported so a run is diagnosable. */
export type MatchStrategy =
  | "data-value"
  | "exact-text"
  | "case-insensitive"
  | "whitespace-normalized";

export interface OptionMatch<T> {
  option: T;
  index: number;
  strategy: MatchStrategy;
}

/**
 * Is this listbox OPEN?
 *
 * The single readiness signal. `aria-expanded` is authored by the widget itself
 * and flips only when it actually opens.
 */
export function isListboxExpanded(listbox: { getAttribute(name: string): string | null } | null): boolean {
  return listbox?.getAttribute("aria-expanded") === "true";
}

/**
 * ⚠️ THE REGRESSION PREDICATE.
 *
 * Returns true only when the widget is genuinely ready to be interacted with.
 * Finding options while `aria-expanded` is false must NEVER count as ready —
 * that is precisely the condition that produced the live failure.
 */
export function isReadyForSelection(
  listbox: { getAttribute(name: string): string | null } | null,
  optionCount: number,
): boolean {
  return isListboxExpanded(listbox) && optionCount > 0;
}

const PLACEHOLDER_TEXT = /^(choose|select|please select|pick one|--+|—)$/i;

/**
 * The "Choose" row. Google Forms gives it an EMPTY `data-value`, which is the
 * reliable signal; the text check is a fallback for builds that omit it.
 *
 * It must be excluded from both matching and counting: counting it shifts every
 * keyboard index by one, which is its own class of wrong-answer bug.
 */
export function isPlaceholderOptionNode(option: SelectableOption): boolean {
  const dataValue = option.getAttribute("data-value");
  if (dataValue !== null && dataValue.trim() === "") return true;
  const text = (option.getAttribute("aria-label") ?? option.textContent ?? "").trim();
  if (text === "") return true;
  return PLACEHOLDER_TEXT.test(text);
}

/** Selectable options, placeholder removed. */
export function selectableOptions<T extends SelectableOption>(options: readonly T[]): T[] {
  return options.filter((option) => !isPlaceholderOptionNode(option));
}

function labelOf(option: SelectableOption): string {
  return (option.getAttribute("aria-label") ?? option.textContent ?? "").trim();
}

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Finds the option to click.
 *
 * ⚠️ STRICT ONLY, IN A FIXED ORDER — fuzzy matching is banned on this path (§4).
 * A blank beats a confidently wrong selection on a real application.
 *
 *   1. `data-value` — what Google Forms actually submits. More stable than
 *      rendered text, which can carry markup, whitespace or a translation.
 *   2. exact rendered text
 *   3. trimmed / case-insensitive
 *   4. whitespace-normalized
 *
 * The placeholder is excluded before any comparison, so "Choose" can never be
 * selected as an answer.
 */
export function matchOption<T extends SelectableOption>(options: readonly T[], wanted: string): OptionMatch<T> | null {
  const candidates = selectableOptions(options);
  const want = wanted.trim();
  if (want === "") return null;

  const at = (option: T): number => candidates.indexOf(option);

  const byDataValue = candidates.find((option) => (option.getAttribute("data-value") ?? "").trim() === want);
  if (byDataValue) return { option: byDataValue, index: at(byDataValue), strategy: "data-value" };

  const byExact = candidates.find((option) => labelOf(option) === want);
  if (byExact) return { option: byExact, index: at(byExact), strategy: "exact-text" };

  const lower = want.toLowerCase();
  const byCase = candidates.find((option) => labelOf(option).toLowerCase() === lower);
  if (byCase) return { option: byCase, index: at(byCase), strategy: "case-insensitive" };

  const normalized = collapse(want).toLowerCase();
  const byWhitespace = candidates.find((option) => collapse(labelOf(option)).toLowerCase() === normalized);
  if (byWhitespace) return { option: byWhitespace, index: at(byWhitespace), strategy: "whitespace-normalized" };

  return null;
}

/** Index of the currently selected option among the SELECTABLE ones, or -1. */
export function currentSelectedIndex<T extends SelectableOption>(options: readonly T[]): number {
  return selectableOptions(options).findIndex((option) => option.getAttribute("aria-selected") === "true");
}

export interface KeyboardPlan {
  key: "ArrowDown" | "ArrowUp";
  presses: number;
}

/**
 * How far to arrow, from where the widget currently sits to the target.
 *
 * ⚠️ THE KEYBOARD BUG THIS FIXES. The old code pressed `ArrowDown` (targetIndex
 * + 1) times on a CLOSED listbox. On a closed widget the FIRST ArrowDown is
 * consumed OPENING it, so every press after that was off by one — and the run
 * that motivated this used ArrowDown ×1, which merely opened the list and then
 * pressed Enter on whatever was highlighted.
 *
 * This function assumes the widget is ALREADY OPEN and computes a relative move
 * from the currently-highlighted row. When nothing is selected yet, Google
 * highlights the placeholder, so the effective start is "one before the first
 * selectable option" — i.e. -1.
 */
export function keyboardPlanFor(currentIndex: number, targetIndex: number): KeyboardPlan {
  const delta = targetIndex - currentIndex;
  return delta >= 0 ? { key: "ArrowDown", presses: delta } : { key: "ArrowUp", presses: -delta };
}
