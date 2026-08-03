import { getQuestionElements, isPlaceholderOption, type QuestionElement } from "./extractor";
import { SELECTORS } from "./selectors";
import {
  waitForOptions as sharedWaitForOptions,
  findOptionWithScrolling as sharedFindOptionWithScrolling,
} from "../shared/options";
import {
  isListboxExpanded,
  selectableOptions,
  matchOption,
  currentSelectedIndex,
  keyboardPlanFor,
} from "../shared/listbox-selection";
import {
  resolveOwningListbox,
  optionBelongsToListbox,
  describeOwnership,
  type OwnershipResolution,
} from "../shared/listbox-ownership";
import { textSimilarity } from "../../lib/text/fuzzy-match";
import { setNativeValue } from "../../lib/dom/native-value";
import { debugLog } from "../../lib/debug";
import { parseKnownDate, toInputDateValue, detectDateOrder } from "../../lib/text/date-format";
import type { FillLogEntry } from "../adapters/adapter";
import type { FillableAnswer, FillPayload, QuestionType } from "../../types/questions";
import type { VisibleSectionFillResult } from "../adapters/adapter";

// Below this similarity score, a question/answer pair is treated as "not
// the same question" rather than filled with a best guess — matching by
// fuzzy label text is inherently uncertain, and a wrong-but-plausible-
// looking fill is worse than leaving a field blank for the user to notice.
const MATCH_THRESHOLD = 0.55;
const OPTION_RENDER_TIMEOUT_MS = 3000;
const ARIA_SETTLE_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 60;
const SCROLL_SETTLE_TIMEOUT_MS = 800;
// 1b — how long to wait for aria-expanded to become true after the open click.
const LISTBOX_OPEN_TIMEOUT_MS = 2000;
const KEYSTROKE_GAP_MS = 30;

// multiple_choice_grid/checkbox_grid/time/file_upload/unknown are
// deliberately excluded. Grids need one answer per row, but FillableAnswer
// only carries a single string per question — filling them would mean
// guessing which row a single answer applies to. time/file_upload rely
// on DOM sub-structure (day/month/year fields, file pickers) never verified
// against a live form.
const FILLABLE_TYPES: ReadonlySet<QuestionType> = new Set([
  "short_answer",
  "paragraph",
  "multiple_choice",
  "checkboxes",
  "dropdown",
  "linear_scale",
  // PART 3 — dates ARE fillable: both a native input[type=date] and Google
  // Forms’ split day/month/year inputs. Ambiguous values are refused by name
  // rather than guessed (date-format.ts).
  "date",
]);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOptionLabel(element: Element): string {
  return element.getAttribute("aria-label")?.trim() || element.textContent?.trim() || "";
}

// Google Forms' controls are custom div widgets, and several of them listen
// for pointer/mouse events rather than a synthesized `.click()`. A bare
// .click() can therefore be silently ignored — the option never selects.
// Dispatching the full sequence a real user produces is far more reliable.
// ── 1c: THE FULL SEQUENCE, WITH THE FIELDS jsaction HANDLERS ACTUALLY READ ──
// The previous version omitted `composed`, `button`, `buttons` and coordinates.
// That matters: Google's jsaction handlers are delegated listeners on an
// ancestor, so an event that does not cross shadow boundaries (`composed`) or
// that reports no pressed button (`buttons: 0`, the default) can be filtered out
// as synthetic. Many such widgets commit on MOUSEDOWN, not click — so a
// mousedown that is ignored means the selection never happens no matter how
// correct the click is.
export const CLICK_EVENT_SEQUENCE = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const;

function robustClick(element: HTMLElement): readonly string[] {
  const rect = element.getBoundingClientRect();
  // Centre of the element. A handler that reads coordinates gets a point that
  // is actually inside the target rather than (0,0).
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
  };
  // `buttons` is a BITMASK of held buttons: 1 while the primary button is down,
  // 0 once released. Sending 1 on mouseup/click would be incoherent.
  const down: MouseEventInit = { ...base, buttons: 1 };
  const up: MouseEventInit = { ...base, buttons: 0 };
  const dispatched: string[] = [];

  const fire = (type: string, init: MouseEventInit, pointer: boolean): void => {
    try {
      element.dispatchEvent(
        pointer
          ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
          : new MouseEvent(type, init),
      );
      dispatched.push(type);
    } catch {
      // PointerEvent is unavailable in some contexts; the mouse events carry it.
      dispatched.push(`${type}(unavailable)`);
    }
  };

  fire("pointerdown", down, true);
  fire("mousedown", down, false);
  fire("pointerup", up, true);
  fire("mouseup", up, false);
  element.click();
  dispatched.push("click");
  return dispatched;
}

/**
 * 1c retry targets, in order.
 *
 * A `[role="option"]` is often a wrapper; the node carrying the `jsaction` is
 * sometimes an ancestor and the node the user visually clicks is sometimes a
 * text-bearing descendant. If the option itself does not commit, try those.
 */
function clickTargetsFor(option: HTMLElement): { label: string; element: HTMLElement }[] {
  const targets: { label: string; element: HTMLElement }[] = [{ label: "the option node", element: option }];

  // Deepest element that actually holds the visible text.
  const textBearing = Array.from(option.querySelectorAll<HTMLElement>("*")).filter(
    (node) => (node.textContent ?? "").trim().length > 0 && node.children.length === 0,
  );
  const deepest = textBearing[textBearing.length - 1];
  if (deepest && deepest !== option) {
    targets.push({ label: "its deepest text-bearing descendant", element: deepest });
  }

  const actionable = option.closest<HTMLElement>("[data-value],[jsaction]");
  if (actionable && actionable !== option) {
    targets.push({ label: "its nearest [data-value]/[jsaction] ancestor", element: actionable });
  }
  return targets;
}

// A-FIX 1: verification must read the LIVE DOM, never a variable written during
// the fill, and never a node reference captured before Google re-rendered the
// card. `liveCard` re-resolves the question container by its heading text when
// the captured node has been detached.
// FIX 3: heading text is NOT a unique key. A 59-field form produced ~50%
// duplicate labels; re-resolving by text there lands on the WRONG card and
// verifies the wrong field, which is worse than failing. So: match on text AND
// the question's ordinal position in the current section, and refuse to guess
// when that is still ambiguous.
let orphanFallbackCount = 0;

function liveCard(question: QuestionElement, ordinal: number): Element | null {
  if (question.listitem.isConnected) {
    return question.listitem;
  }

  orphanFallbackCount += 1;
  const all = getQuestionElements();
  const byText = all.filter((q) => q.questionText === question.questionText);

  if (byText.length === 1) {
    console.log(
      `EasyFilla(fill): card for "${question.questionText}" was replaced — re-resolved by unique label ` +
        `(orphan fallback #${orphanFallbackCount}). Frequent fallbacks mean the fill path is racing a re-render.`,
    );
    return byText[0]!.listitem;
  }

  // Duplicate labels: disambiguate by ordinal position within the section.
  const positional = byText.filter((q) => all.indexOf(q) === ordinal);
  if (positional.length === 1) {
    console.log(
      `EasyFilla(fill): card for "${question.questionText}" re-resolved by position ${ordinal} ` +
        `(${byText.length} cards share this label; orphan fallback #${orphanFallbackCount}).`,
    );
    return positional[0]!.listitem;
  }

  console.warn(
    `EasyFilla(fill): AMBIGUOUS card re-resolution for "${question.questionText}" — ${byText.length} cards share ` +
      "this label and position did not disambiguate. Refusing to verify against a possibly-wrong field.",
  );
  return null;
}

export function orphanFallbacks(): number {
  return orphanFallbackCount;
}

// Reads what a dropdown currently displays, so a fill can be VERIFIED rather
// than assumed. Returns "" when it still shows a placeholder.
function dropdownDisplayedValue(listitem: Element): string {
  const listbox = listitem.querySelector(SELECTORS.listbox);
  const selected = listitem.querySelector('[role="option"][aria-selected="true"]');
  const text = (selected?.textContent ?? listbox?.textContent ?? "").trim();
  return isPlaceholderOption(text) ? "" : text;
}

// ── 1e: MULTI-SIGNAL COMMIT VERIFICATION ─────────────────────────────────
// The live failure reported "the control still shows Choose", which is a single
// signal — the trigger's rendered text. That is the WEAKEST of the four
// available, and it is also the one most affected by Google's asynchronous
// re-render: a commit that has happened in the widget's state can still be
// showing stale text for a frame or two.
//
// Worse, `dropdownDisplayedValue` looks for `[role="option"][aria-selected]`
// INSIDE the card — but the options live in a detached popup, so that lookup
// finds nothing and silently degrades to the trigger's text. Reading four
// independent signals means a commit is confirmed by whichever one Google
// actually updates, and a genuine failure is one where NONE of them moved.
export interface CommitSignals {
  triggerText: boolean;
  activeDescendant: boolean;
  ariaSelected: boolean;
  hiddenInput: boolean;
}

export function anySignalConfirms(signals: CommitSignals): boolean {
  return signals.triggerText || signals.activeDescendant || signals.ariaSelected || signals.hiddenInput;
}

export function describeSignals(signals: CommitSignals): string {
  const names = Object.entries(signals)
    .filter(([, confirmed]) => confirmed)
    .map(([name]) => name);
  return names.length > 0 ? names.join(" + ") : "none";
}

function readCommitSignals(card: Element, trigger: HTMLElement, option: HTMLElement | null, expected: string): CommitSignals {
  const want = normalizeOptionText(expected);

  // 1. The trigger's rendered text — the original (and weakest) signal.
  const triggerText = normalizeOptionText(dropdownDisplayedValue(card)) === want;

  // 2. aria-activedescendant on the trigger, resolved to its option's label.
  let activeDescendant = false;
  const activeId = trigger.getAttribute("aria-activedescendant");
  if (activeId) {
    const active = document.getElementById(activeId);
    if (active) activeDescendant = normalizeOptionText(getOptionLabel(active)) === want;
  }

  // 3. The clicked option's own aria-selected, read from the live DOM — this
  //    works even though the option is outside the card, which the card-scoped
  //    lookup above cannot do.
  const ariaSelected = option !== null && option.isConnected && option.getAttribute("aria-selected") === "true";

  // 4. Google Forms mirrors the choice into a hidden input named `entry.*`.
  let hiddenInput = false;
  const hidden = card.querySelectorAll<HTMLInputElement>('input[type="hidden"], input[name^="entry."]');
  hidden.forEach((input) => {
    if (normalizeOptionText(input.value) === want) hiddenInput = true;
  });

  return { triggerText, activeDescendant, ariaSelected, hiddenInput };
}

// ── A-FIX 2: TELEMETRY ────────────────────────────────────────────────────
// The 3s window, 60ms interval and 120ms settle are guesses. They stay as
// defaults, but every wait records what it ACTUALLY observed so the next tuning
// pass uses measurements instead of another guess.
const timings: { field: string; metric: string; ms: number; outcome: string }[] = [];

function recordTiming(field: string, metric: string, ms: number, outcome: string): void {
  timings.push({ field, metric, ms, outcome });
}

export function drainFillTimings(): typeof timings {
  const copy = [...timings];
  timings.length = 0;
  return copy;
}

// Polls a condition until it holds or the deadline passes. There is NO fixed
// sleep anywhere in the fill path — a fixed sleep is either a stall or a race.
async function pollUntil<T>(
  produce: () => T | null,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ value: T | null; elapsedMs: number }> {
  const started = Date.now();
  for (;;) {
    const value = produce();
    if (value !== null) {
      return { value, elapsedMs: Date.now() - started };
    }
    if (Date.now() - started >= timeoutMs) {
      return { value: null, elapsedMs: Date.now() - started };
    }
    await wait(intervalMs);
  }
}

// STRICT option matching (PART A.2). Fuzzy similarity is deliberately NOT used:
// on a real application form, silently selecting the nearest-looking option is
// worse than leaving the field blank for the user. Three tiers, all exact-ish:
//   1. exact string equality
//   2. trimmed + case-insensitive
//   3. whitespace-normalized (collapses the runs Google injects into labels)
// No confident match ⇒ null, and the caller records an explicit failure.
function normalizeOptionText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function findExactOptionMatch(options: HTMLElement[], target: string): HTMLElement | null {
  const labelled = options
    .map((element) => ({ element, label: getOptionLabel(element) }))
    .filter((entry) => entry.label);

  const exact = labelled.find((entry) => entry.label === target);
  if (exact) {
    return exact.element;
  }
  const trimmed = labelled.find((entry) => entry.label.trim().toLowerCase() === target.trim().toLowerCase());
  if (trimmed) {
    return trimmed.element;
  }
  const normalized = labelled.find((entry) => normalizeOptionText(entry.label) === normalizeOptionText(target));
  return normalized?.element ?? null;
}

// NOTE (STAGE 2c): the document-wide `[role="option"]` scan and the virtualized
// list scroller both moved to `shared/options.ts`, because the SCANNER needs
// them too — a choice question with no options cannot be answered, and the
// scanner previously had no way to open a lazily-rendered widget. Google Forms
// renders a dropdown's options into a detached popup outside the question card
// and only after the listbox is opened, so a question-scoped query or a fixed
// sleep both find nothing. That reality is now encoded in one place.

// STAGE 2c — these two now delegate to the SHARED implementation in
// `shared/options.ts`, which the SCANNER also uses. There was previously one
// copy here, reachable only when filling, which is why the scanner could emit
// choice questions with zero options. Two copies would drift; this layer keeps
// only the Google-specific parts (timing instrumentation and strict matching).
async function waitForOptions(field: string, timeoutMs: number): Promise<HTMLElement[]> {
  const { options, elapsedMs } = await sharedWaitForOptions(timeoutMs, isPlaceholderOption);
  recordTiming(field, "options render", elapsedMs, options.length > 0 ? `${options.length} options` : "timeout");
  return options;
}

/**
 * 1b — options belonging to the RESOLVED owning listbox.
 *
 * Falls back to the document-wide scan ONLY when ownership could not be
 * established, and says so at `console.warn` volume. The fallback is retained
 * because the document-wide scan is what fixed the earlier "(No options
 * detected)" bug — removing it would trade this failure for that one. But it is
 * no longer the DEFAULT, and it is no longer silent: a silent fallback is
 * precisely how a wrong-widget click went unnoticed until a live run.
 */
async function waitForOptionsIn(
  field: string,
  ownership: OwnershipResolution,
  timeoutMs: number,
): Promise<HTMLElement[]> {
  if (ownership.trusted && ownership.listbox) {
    const owner = ownership.listbox as unknown as HTMLElement;
    const { value, elapsedMs } = await pollUntil(
      () => {
        const scoped = Array.from(owner.querySelectorAll<HTMLElement>(SELECTORS.listboxOption)).filter(
          (option) => option.getClientRects().length > 0 && !isPlaceholderOption(getOptionLabel(option)),
        );
        return scoped.length > 0 ? scoped : null;
      },
      timeoutMs,
      POLL_INTERVAL_MS,
    );
    const scoped = value ?? [];
    recordTiming(
      field,
      `options render (owned via ${ownership.source})`,
      elapsedMs,
      scoped.length > 0 ? `${scoped.length} owned options` : "timeout",
    );
    if (scoped.length > 0) {
      return scoped;
    }
    // Ownership resolved but the owner holds nothing yet. Fall through rather
    // than failing outright — but the fallback below will log that it fired.
  }

  const wide = await waitForOptions(field, timeoutMs);
  console.warn(
    `EasyFilla(fill): ⚠️ DOCUMENT-WIDE OPTION FALLBACK for "${field}" — ${describeOwnership(ownership)}. ` +
      `Found ${wide.length} option(s) across the whole document, so THEY MAY BELONG TO ANOTHER QUESTION. ` +
      "This is the condition that caused the first live dropdown failure; if a fill fails here, ownership " +
      "resolution is what needs fixing, not the click.",
  );
  return wide;
}

// ── 1a: THE DIAGNOSTIC BLOCK ─────────────────────────────────────────────
// One tagged block per dropdown attempt. This is deliberately verbose and
// deliberately ALWAYS ON for dropdowns: the first live run produced a failure
// that was correctly reported but not diagnosable, and a second run costing the
// user a real quota should not produce the same dead end.
//
// ⚠️ B4 SCOPE. Dropdown option labels are the FORM'S OWN published choices
// ("4+ Years", "ECE"), not content extracted from the user's documents, and the
// existing failure messages already name them. Document text and API keys remain
// absolutely unlogged at any level. Nothing here reads a text-field value.
class DropdownDiagnostics {
  private chosen: { element: HTMLElement; note: string } | null = null;
  private expanded: { before: string | null; after: string | null } | null = null;

  constructor(
    private readonly field: string,
    private readonly trigger: HTMLElement,
    private readonly ownership: OwnershipResolution,
    private readonly candidates: HTMLElement[],
  ) {}

  setChosen(element: HTMLElement, note: string): void {
    this.chosen = { element, note };
  }

  /**
   * 1g — aria-expanded BEFORE and AFTER the open step.
   *
   * ⚠️ THIS PAIR IS THE PROOF. The live failure happened because the code
   * proceeded while the widget was closed. If the fix works, this reads
   * `false → true`; if it still fails, `false → false` says the open click is
   * the problem, not the option click — two different bugs that the previous
   * failure message could not tell apart.
   */
  setExpanded(before: string | null, after: string | null): void {
    this.expanded = { before, after };
  }

  /**
   * Structural description of a node.
   *
   * ⚠️ `data-value` IS THE ANSWER Google submits, so it is reported as
   * present/absent only. Its presence is what matters structurally (it tells us
   * the node is a real option and gives `clickTargetsFor` an ancestor to try);
   * its content tells us nothing we need and is the user's data.
   */
  private static describeNode(element: Element | null): string {
    if (!element) return "(none)";
    const attributes = ["role", "class", "id", "aria-selected", "jsaction"]
      .map((name) => {
        const value = element.getAttribute(name);
        return value === null ? null : `${name}="${value.length > 60 ? `${value.slice(0, 60)}…` : value}"`;
      })
      .filter((entry): entry is string => entry !== null);
    const dataValue = element.getAttribute("data-value");
    if (dataValue !== null) {
      attributes.push(`data-value=<${dataValue.trim() === "" ? "EMPTY — placeholder" : "present, redacted"}>`);
    }
    return `<${element.tagName.toLowerCase()} ${attributes.join(" ")}>`;
  }

  private parentChain(element: Element | null, levels = 3): string {
    const chain: string[] = [];
    let current = element?.parentElement ?? null;
    for (let i = 0; i < levels && current; i += 1) {
      chain.push(DropdownDiagnostics.describeNode(current));
      current = current.parentElement;
    }
    return chain.length > 0 ? chain.join(" ← ") : "(no ancestors)";
  }

  /**
   * ⚠️ SPLIT DELIBERATELY INTO STRUCTURE (always on) AND VALUES (debug only).
   *
   * The debugging workflow tells users to paste this block into a bug report, so
   * anything printed here is effectively published. The user's SELECTED ANSWERS
   * appear in four places that are easy to miss:
   *   - `outerHTML` of the trigger (contains the current selection),
   *   - the candidate option LABELS,
   *   - the trigger's rendered text,
   *   - hidden `entry.*` inputs, which carry the value Google will submit,
   * plus `data-value` on any node, which IS the answer.
   *
   * This is the same class as the B4 leak (§4f) — a log that printed every
   * uploaded document's full text. The structural fields below diagnose the
   * dropdown bug on their own and carry no user data, so they stay always-on;
   * everything value-bearing moves behind `debugLog` (Options → Diagnostics,
   * default OFF).
   */
  emit(outcome: string): void {
    const owner = this.ownership.listbox as unknown as HTMLElement | null;
    const ownedCount = owner ? owner.querySelectorAll(SELECTORS.listboxOption).length : 0;
    const documentWideCount = document.querySelectorAll(SELECTORS.listboxOption).length;
    const chosenEl = this.chosen?.element ?? null;

    // ── ALWAYS ON: structure only. No option text, no field values. ──
    const structural = [
      `EasyFilla(dropdown-diag) ── "${this.field}" ── ${outcome}`,
      `  trigger:                  ${DropdownDiagnostics.describeNode(this.trigger)}`,
      `  aria-controls:            ${this.trigger.getAttribute("aria-controls") ?? "(absent)"}`,
      `  aria-owns:                ${this.trigger.getAttribute("aria-owns") ?? "(absent)"}`,
      `  aria-activedescendant:    ${this.trigger.getAttribute("aria-activedescendant") ?? "(absent)"}`,
      `  aria-expanded BEFORE open: ${this.expanded?.before ?? "(not recorded)"}`,
      `  aria-expanded AFTER open:  ${this.expanded?.after ?? "(not recorded)"}${
        this.expanded?.after === "true" ? "   ✅ the widget really opened" : "   ⚠️ NEVER OPENED — nothing inside it is interactive"
      }`,
      `  OWNERSHIP:                ${describeOwnership(this.ownership)}`,
      `  owning listbox:           ${DropdownDiagnostics.describeNode(owner)}`,
      `  options IN that listbox:  ${ownedCount}`,
      `  options DOCUMENT-WIDE:    ${documentWideCount}${
        documentWideCount !== ownedCount ? "   ⚠️ MISMATCH — other widgets have options in the DOM" : ""
      }`,
      `  candidates considered:    ${this.candidates.length} (labels omitted — enable verbose logging to see them)`,
      `  clicked node:             ${DropdownDiagnostics.describeNode(chosenEl)}`,
      `  clicked node ancestors:   ${this.parentChain(chosenEl)}`,
      `  clicked node owned?:      ${
        chosenEl ? String(optionBelongsToListbox(chosenEl, this.ownership.listbox)) : "n/a"
      }`,
      `  clicked aria-selected:    ${chosenEl?.getAttribute("aria-selected") ?? "(absent)"}`,
      `  event sequence:           ${CLICK_EVENT_SEQUENCE.join(" → ")} (bubbles, composed, button 0, buttons 1→0, centre coords)`,
      `  outcome/strategy:         ${this.chosen?.note ?? "(no click recorded)"}`,
      `  hidden inputs in card:    ${
        this.trigger.closest("[role=listitem]")?.querySelectorAll('input[type="hidden"], input[name^="entry."]').length ?? 0
      } present (values omitted)`,
    ];
    console.log(structural.join("\n"));

    // ── VERBOSE ONLY: everything that can carry the user's answer. ──
    debugLog(
      [
        `EasyFilla(dropdown-diag/verbose) ── "${this.field}"`,
        `  trigger outerHTML:        ${(this.trigger.outerHTML ?? "").slice(0, 300)}`,
        `  candidate labels:         [${this.candidates.map(getOptionLabel).join(" | ")}]`,
        `  trigger rendered text:    "${(this.trigger.textContent ?? "").trim().slice(0, 80)}"`,
        `  hidden input values:      ${Array.from(
          this.trigger.closest("[role=listitem]")?.querySelectorAll<HTMLInputElement>('input[type="hidden"], input[name^="entry."]') ??
            [],
        )
          .map((input) => `${input.name || "(unnamed)"}="${input.value}"`)
          .join(", ") || "(none)"}`,
      ].join("\n"),
    );
  }
}

// Country/nationality dropdowns on real portals run to 200+ entries and may be
// virtualized, so the match often is not in the DOM until the list is scrolled.
async function findOptionWithScrolling(
  field: string,
  initial: HTMLElement[],
  value: string,
): Promise<HTMLElement | null> {
  const { match, optionsSeen, elapsedMs } = await sharedFindOptionWithScrolling(
    initial,
    // STRICT matching stays here: fuzzy option selection is banned on this path
    // (§4). The shared scroller only decides WHERE to look, never what counts.
    (options) => findExactOptionMatch(options, value),
    isPlaceholderOption,
  );
  recordTiming(
    field,
    match ? "option found after scrolling" : "option NOT found after scrolling",
    elapsedMs,
    `${optionsSeen} options seen`,
  );
  return match;
}

// Every driver returns WHY it failed, never a bare boolean — a silent partial
// fill is the bug being fixed here, so an unfillable field must be nameable.
export interface FieldFillResult {
  ok: boolean;
  reason: string;
  observed?: string;
}

function ok(reason: string): FieldFillResult {
  return { ok: true, reason };
}
function fail(reason: string, observed?: string): FieldFillResult {
  return observed === undefined ? { ok: false, reason } : { ok: false, reason, observed };
}

function optionLabels(options: HTMLElement[]): string {
  return options.map((o) => JSON.stringify(getOptionLabel(o))).join(" | ");
}

// Radios and checkboxes are div[role=radio] / div[role=checkbox]; their state
// lives in aria-checked, and `input.checked = true` has no effect on them.
async function clickAndVerifyChecked(card: Element, target: HTMLElement, label: string, optionLabel: string): Promise<boolean> {
  target.scrollIntoView({ block: "center" });
  robustClick(target);

  // Re-query the option out of the live card each poll: the clicked node may
  // have been replaced, and reading the captured reference would then report
  // the state of an orphan.
  const isChecked = (): true | null => {
    const fresh = Array.from(card.querySelectorAll<HTMLElement>('[role="radio"],[role="checkbox"]')).find(
      (el) => getOptionLabel(el) === optionLabel,
    );
    return (fresh ?? target).getAttribute("aria-checked") === "true" ? true : null;
  };

  let result = await pollUntil(isChecked, ARIA_SETTLE_TIMEOUT_MS, POLL_INTERVAL_MS);
  recordTiming(label, "aria-checked settle", result.elapsedMs, result.value ? "ok" : "timeout");
  if (result.value) {
    return true;
  }

  // Retry once via the keyboard, which some builds honour when a synthesized
  // pointer sequence is ignored.
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  result = await pollUntil(isChecked, ARIA_SETTLE_TIMEOUT_MS, POLL_INTERVAL_MS);
  recordTiming(label, "aria-checked settle (keyboard)", result.elapsedMs, result.value ? "ok" : "timeout");
  console.log(`EasyFilla(fill): "${label}" ${result.value ? "checked via keyboard fallback ✓" : "still not checked ✗"}`);
  return Boolean(result.value);
}

async function fillSingleSelect(question: QuestionElement, value: string, ordinal: number): Promise<FieldFillResult> {
  const card = liveCard(question, ordinal);
  if (!card) {
    return fail("ambiguous card re-resolution — refused to verify against a possibly-wrong field");
  }
  const options = Array.from(card.querySelectorAll<HTMLElement>(SELECTORS.radioOption));
  if (options.length === 0) {
    return fail("no radio options found in this question card");
  }
  const target = findExactOptionMatch(options, value);
  if (!target) {
    return fail(`"${value}" matched none of [${optionLabels(options)}] (strict match — refusing to guess)`);
  }

  const settled = await clickAndVerifyChecked(card, target, question.questionText, getOptionLabel(target));
  if (!settled) {
    return fail(`clicked "${getOptionLabel(target)}" but aria-checked never became true`);
  }

  // "Other" options pair the radio with a sibling free-text input.
  const otherInput = target.closest("label,div")?.querySelector<HTMLInputElement>('input[type="text"]');
  if (otherInput && /other/i.test(getOptionLabel(target))) {
    setNativeValue(otherInput, value);
  }
  return ok(`selected "${getOptionLabel(target)}"`);
}

async function fillCheckboxes(question: QuestionElement, value: string, ordinal: number): Promise<FieldFillResult> {
  const card = liveCard(question, ordinal);
  if (!card) {
    return fail("ambiguous card re-resolution — refused to verify against a possibly-wrong field");
  }
  const options = Array.from(card.querySelectorAll<HTMLElement>(SELECTORS.checkboxOption));
  if (options.length === 0) {
    return fail("no checkbox options found in this question card");
  }
  const tokens = value.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return fail("no values to check");
  }

  const selected: string[] = [];
  const unmatched: string[] = [];
  for (const token of tokens) {
    const target = findExactOptionMatch(options, token);
    if (!target) {
      unmatched.push(token);
      continue;
    }
    if (target.getAttribute("aria-checked") === "true") {
      selected.push(getOptionLabel(target));
      continue;
    }
    if (await clickAndVerifyChecked(card, target, `${question.questionText} → ${token}`, getOptionLabel(target))) {
      selected.push(getOptionLabel(target));
    } else {
      unmatched.push(`${token} (click did not register)`);
    }
  }

  if (selected.length === 0) {
    return fail(`none of [${tokens.join(", ")}] matched [${optionLabels(options)}]`);
  }
  if (unmatched.length > 0) {
    return fail(`checked ${selected.length} of ${tokens.length}; unresolved: ${unmatched.join(", ")}`, selected.join(", "));
  }
  return ok(`checked ${selected.join(", ")}`);
}

async function fillDropdown(question: QuestionElement, value: string, ordinal: number): Promise<FieldFillResult> {
  const listbox = question.listitem.querySelector<HTMLElement>(SELECTORS.listbox);
  if (!listbox) {
    return fail("no div[role=listbox] found in this question card");
  }

  // Remember where focus was, so a failed attempt leaves the page as found (1f).
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const expandedBefore = listbox.getAttribute("aria-expanded");

  // ⚠️ A PREVIOUS COMMENT HERE CLAIMED "the options DO NOT EXIST until the
  // listbox is opened". THE LIVE RUN DISPROVED THAT. Google Forms keeps
  // [role="option"] nodes in the DOM at all times, inside the listbox, even
  // while it is CLOSED. Waiting for options to APPEAR therefore succeeded on the
  // first tick — before the widget had opened — and every click after that hit
  // an inert, non-interactive node. Openness is `aria-expanded`, never presence.
  listbox.scrollIntoView({ block: "center" });
  const inView = await pollUntil(
    () => {
      const rect = listbox.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight ? true : null;
    },
    SCROLL_SETTLE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  recordTiming(question.questionText, "scroll into view", inView.elapsedMs, inView.value ? "ok" : "timeout");

  // ── 1b: EXPLICIT OPEN STEP ─────────────────────────────────────────────
  // Dispatch, then WAIT FOR aria-expanded. One retry, because the first pointer
  // sequence can land before the widget has wired its handlers.
  let openSequence = robustClick(listbox);
  let opened = await pollUntil(
    () => (isListboxExpanded(listbox) ? true : null),
    LISTBOX_OPEN_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  if (!opened.value) {
    openSequence = robustClick(listbox);
    opened = await pollUntil(
      () => (isListboxExpanded(listbox) ? true : null),
      LISTBOX_OPEN_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
  }
  recordTiming(question.questionText, "dropdown open", opened.elapsedMs, opened.value ? "expanded" : "never expanded");

  const ownership = resolveOwningListbox(listbox, document);
  const scopeFor = (): HTMLElement =>
    ownership.trusted && ownership.listbox ? (ownership.listbox as unknown as HTMLElement) : listbox;
  const readOptions = (): HTMLElement[] =>
    selectableOptions(Array.from(scopeFor().querySelectorAll<HTMLElement>(SELECTORS.listboxOption)));

  let candidates = readOptions();
  if (candidates.length === 0 && !ownership.trusted) {
    // Ownership unresolved AND nothing in the trigger: this is the portalled
    // popup case (§4), where the options render far from the card. Fall back to
    // the document-wide scan that fixed the earlier "(No options detected)"
    // bug — it warns loudly, so the fallback is never silent.
    candidates = selectableOptions(
      await waitForOptionsIn(question.questionText, ownership, OPTION_RENDER_TIMEOUT_MS),
    );
  }
  const diagnostics = new DropdownDiagnostics(question.questionText, listbox, ownership, candidates);
  diagnostics.setExpanded(expandedBefore, listbox.getAttribute("aria-expanded"));

  const restore = (): void => {
    // 1f — close cleanly and put focus back, so a failure is not also a mess.
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    previouslyFocused?.focus?.();
  };

  if (!opened.value) {
    // A DISTINCT failure from "clicked but did not commit". Conflating the two
    // is what hid this bug: the report said the option was clicked, which was
    // true, while the widget had never opened at all.
    diagnostics.emit("COULD NOT OPEN — aria-expanded never became true");
    restore();
    return fail(
      `could not open the dropdown — aria-expanded stayed "${listbox.getAttribute("aria-expanded") ?? "(absent)"}" ` +
        `after two pointer sequences [${openSequence.join(" → ")}] over ${LISTBOX_OPEN_TIMEOUT_MS}ms. ` +
        "Nothing was clicked inside it, so no wrong answer was selected.",
    );
  }

  if (candidates.length === 0) {
    diagnostics.emit("opened, but no selectable options (only the placeholder)");
    restore();
    return fail("the dropdown opened but contained no selectable options besides the placeholder");
  }

  // ── 1c: MATCH — data-value first, then text tiers. Never fuzzy. ─────────
  let matched = matchOption(candidates, value);
  if (!matched) {
    // Country/nationality lists run to 200+ entries and may be virtualized, so
    // the match often is not in the DOM until the popup is scrolled. Scroll,
    // re-read, and re-match — the scroller only decides WHERE to look, never
    // what counts as a match (§4).
    const revealed = await findOptionWithScrolling(question.questionText, candidates, value);
    if (revealed) {
      candidates = readOptions();
      matched = matchOption(candidates, value);
    }
  }
  if (!matched) {
    diagnostics.emit(`"${value}" matched none of the options`);
    restore();
    return fail(
      `"${value}" matched none of [${optionLabels(candidates)}] (strict match on data-value then text — refusing to guess)`,
    );
  }
  const target = matched.option;

  if (ownership.trusted && !optionBelongsToListbox(target, ownership.listbox)) {
    diagnostics.setChosen(target, "REJECTED — not owned by this trigger");
    diagnostics.emit("matched option belongs to a DIFFERENT widget");
    restore();
    return fail(
      `"${value}" was found, but in a listbox this question does not own ` +
        `(ownership via ${ownership.source}). Refusing to click another question's option.`,
    );
  }

  const card = () => liveCard(question, ordinal) ?? question.listitem;
  const signalsNow = () => readCommitSignals(card(), listbox, target, value);
  const attempted: string[] = [`open: [${openSequence.join(" → ")}] → aria-expanded=true`];

  // ── 1d: CLICK, then poll for ANY commit signal ─────────────────────────
  for (const { label, element } of clickTargetsFor(target)) {
    element.scrollIntoView({ block: "center" });
    const sequence = robustClick(element);
    attempted.push(`${label} [${sequence.join(" → ")}]`);

    const settled = await pollUntil(
      () => {
        const signals = signalsNow();
        return anySignalConfirms(signals) ? signals : null;
      },
      ARIA_SETTLE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    recordTiming(
      question.questionText,
      `dropdown commit (${label})`,
      settled.elapsedMs,
      settled.value ? describeSignals(settled.value) : "no signal moved",
    );
    if (settled.value) {
      diagnostics.setChosen(element, `committed via ${describeSignals(settled.value)}`);
      diagnostics.emit(`SUCCESS after clicking ${label}`);
      return ok(
        `selected "${getOptionLabel(target)}" (matched by ${matched.strategy}; ` +
          `confirmed by ${describeSignals(settled.value)}; ${label})`,
      );
    }
  }

  // ── 1e: CORRECTED KEYBOARD PATH ────────────────────────────────────────
  // The old sequence arrowed on a CLOSED listbox, where the first ArrowDown is
  // consumed OPENING it — so every press after that was off by one. Now: ensure
  // open FIRST, then move RELATIVE to whatever is currently highlighted.
  listbox.focus();
  if (!isListboxExpanded(listbox)) {
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const reopened = await pollUntil(
      () => (isListboxExpanded(listbox) ? true : null),
      LISTBOX_OPEN_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    if (!reopened.value) {
      diagnostics.setChosen(target, "keyboard could not reopen the listbox");
      diagnostics.emit("ALL PATHS FAILED — keyboard could not reopen");
      restore();
      return fail(
        `"${getOptionLabel(target)}" did not commit by pointer, and the listbox would not reopen for the ` +
          `keyboard fallback. Tried: ${attempted.join("; ")}.`,
      );
    }
  }
  // Count from where the widget currently sits, over SELECTABLE options only —
  // including the placeholder would shift every index by one.
  const currentIndex = currentSelectedIndex(candidates);
  const plan = keyboardPlanFor(currentIndex, matched.index);
  for (let i = 0; i < plan.presses; i += 1) {
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: plan.key, bubbles: true }));
    // Inter-keystroke pacing, not a wait-for-condition: a widget that receives
    // 200 arrows in one tick coalesces them and lands on the wrong row.
    await wait(KEYSTROKE_GAP_MS);
  }
  listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  attempted.push(
    `keyboard: open → from index ${currentIndex} to ${matched.index} via ${plan.key} ×${plan.presses} → Enter`,
  );

  const keyboardSettled = await pollUntil(
    () => {
      const signals = signalsNow();
      return anySignalConfirms(signals) ? signals : null;
    },
    ARIA_SETTLE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  recordTiming(
    question.questionText,
    "dropdown commit (keyboard)",
    keyboardSettled.elapsedMs,
    keyboardSettled.value ? describeSignals(keyboardSettled.value) : "no signal moved",
  );
  if (keyboardSettled.value) {
    diagnostics.setChosen(target, `committed via ${describeSignals(keyboardSettled.value)} (keyboard)`);
    diagnostics.emit("SUCCESS via the keyboard path");
    return ok(
      `selected "${getOptionLabel(target)}" (matched by ${matched.strategy}; keyboard fallback; ` +
        `confirmed by ${describeSignals(keyboardSettled.value)})`,
    );
  }

  diagnostics.setChosen(target, "no signal moved on any path");
  diagnostics.emit("ALL PATHS FAILED");
  restore();
  const shown = dropdownDisplayedValue(card());
  return fail(
    `"${getOptionLabel(target)}" was clicked in an OPEN dropdown and no commit signal changed. ` +
      `Tried: ${attempted.join("; ")}. Ownership: ${describeOwnership(ownership)}. ` +
      `The control still shows "${shown || "Choose"}".`,
    shown,
  );
}

// Text fields keep the native-setter approach: React/Angular patch .value, so
// assigning it directly is swallowed unless the native setter is used.
// ── PART 3: DATE FIELDS ──────────────────────────────────────────────────
// Previously skipped with "date fields can't be auto-filled", while the dossier
// held a date of birth the whole time.
//
// ⚠️ A WRONG DATE OF BIRTH IS WORSE THAN A BLANK ONE. Every path here either
// writes a date it can justify or fails with a named reason — it never picks a
// "probably right" reading of an ambiguous value (see `date-format.ts`).
async function fillDateVerified(question: QuestionElement, value: string, ordinal: number): Promise<FieldFillResult> {
  const card = liveCard(question, ordinal);
  if (!card) {
    return fail("ambiguous card re-resolution — refused to verify against a possibly-wrong field");
  }

  // Shape 1: a native date input. It accepts ONLY `YYYY-MM-DD`.
  const nativeInput = card.querySelector<HTMLInputElement>(SELECTORS.dateInput);
  if (nativeInput) {
    const order = detectDateOrder(
      nativeInput.getAttribute("placeholder") ?? nativeInput.getAttribute("aria-label") ?? null,
    );
    const parsed = parseKnownDate(value, order);
    if (!parsed.ok) {
      return fail(parsed.reason);
    }
    const iso = toInputDateValue(parsed.date);
    console.log(
      `EasyFilla(fill): date "${value}" → "${iso}" for a native date input (${parsed.interpretation}).`,
    );
    nativeInput.scrollIntoView({ block: "center" });
    setNativeValue(nativeInput, iso);

    const settled = await pollUntil(
      () =>
        (liveCard(question, ordinal) ?? question.listitem).querySelector<HTMLInputElement>(SELECTORS.dateInput)?.value === iso
          ? true
          : null,
      ARIA_SETTLE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    recordTiming(question.questionText, "date value settle", settled.elapsedMs, settled.value ? "ok" : "timeout");
    const observed =
      (liveCard(question, ordinal) ?? question.listitem).querySelector<HTMLInputElement>(SELECTORS.dateInput)?.value ?? "";
    return settled.value
      ? ok(`set to ${iso} (${parsed.interpretation})`)
      : fail(`wrote ${iso} but the field reads "${observed}"`, observed);
  }

  // Shape 2: Google Forms' split day / month / year inputs. Each is a plain
  // number input, identified by its aria-label.
  const parts = Array.from(card.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="number"]'));
  const partFor = (names: RegExp): HTMLInputElement | null =>
    parts.find((input) => names.test(`${input.getAttribute("aria-label") ?? ""} ${input.getAttribute("placeholder") ?? ""}`)) ??
    null;
  const dayInput = partFor(/\bday\b|\bdd\b/i);
  const monthInput = partFor(/\bmonth\b|\bmm\b/i);
  const yearInput = partFor(/\byear\b|\byyyy\b/i);

  if (dayInput && monthInput && yearInput) {
    // The labels themselves state the order, so nothing is ambiguous here.
    const parsed = parseKnownDate(value, "unknown");
    if (!parsed.ok) {
      return fail(parsed.reason);
    }
    console.log(
      `EasyFilla(fill): date "${value}" → d=${parsed.date.day} m=${parsed.date.month} y=${parsed.date.year} ` +
        `across split inputs (${parsed.interpretation}).`,
    );
    [
      [dayInput, String(parsed.date.day)],
      [monthInput, String(parsed.date.month)],
      [yearInput, String(parsed.date.year)],
    ].forEach(([input, partValue]) => {
      (input as HTMLInputElement).scrollIntoView({ block: "center" });
      setNativeValue(input as HTMLInputElement, partValue as string);
    });

    // Re-query all three, rather than trusting the references just written.
    const reread = (): { d: string; m: string; y: string } => {
      const live = liveCard(question, ordinal) ?? question.listitem;
      const all = Array.from(live.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="number"]'));
      const pick = (names: RegExp): string =>
        all.find((input) => names.test(`${input.getAttribute("aria-label") ?? ""} ${input.getAttribute("placeholder") ?? ""}`))
          ?.value ?? "";
      return { d: pick(/\bday\b|\bdd\b/i), m: pick(/\bmonth\b|\bmm\b/i), y: pick(/\byear\b|\byyyy\b/i) };
    };
    const settled = await pollUntil(
      () => {
        const seen = reread();
        return Number(seen.d) === parsed.date.day &&
          Number(seen.m) === parsed.date.month &&
          Number(seen.y) === parsed.date.year
          ? true
          : null;
      },
      ARIA_SETTLE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    recordTiming(question.questionText, "split date settle", settled.elapsedMs, settled.value ? "ok" : "timeout");
    const seen = reread();
    return settled.value
      ? ok(`set to ${parsed.date.day}/${parsed.date.month}/${parsed.date.year} (${parsed.interpretation})`)
      : fail(`wrote the date but the fields read d="${seen.d}" m="${seen.m}" y="${seen.y}"`);
  }

  return fail(
    "this date question has neither a native date input nor labelled day/month/year fields, so there is no " +
      "field to write to — fill it in yourself.",
  );
}

async function fillShortAnswerVerified(question: QuestionElement, value: string, ordinal: number): Promise<FieldFillResult> {
  const card = liveCard(question, ordinal);
  if (!card) {
    return fail("ambiguous card re-resolution — refused to verify against a possibly-wrong field");
  }
  const input = card.querySelector<HTMLInputElement>(SELECTORS.textInput);
  if (!input) {
    return fail("no text input found in this question card");
  }
  input.scrollIntoView({ block: "center" });
  setNativeValue(input, value);

  // Re-query the input for the read-back rather than reusing the reference we
  // just wrote through.
  const settled = await pollUntil(
    () => ((liveCard(question, ordinal) ?? question.listitem).querySelector<HTMLInputElement>(SELECTORS.textInput)?.value === value ? true : null),
    ARIA_SETTLE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  recordTiming(question.questionText, "text value settle", settled.elapsedMs, settled.value ? "ok" : "timeout");
  const observed = (liveCard(question, ordinal) ?? question.listitem).querySelector<HTMLInputElement>(SELECTORS.textInput)?.value ?? "";
  return settled.value ? ok("typed") : fail(`wrote the value but the field reads "${observed}"`, observed);
}

async function fillParagraphVerified(question: QuestionElement, value: string, ordinal: number): Promise<FieldFillResult> {
  const card = liveCard(question, ordinal);
  if (!card) {
    return fail("ambiguous card re-resolution — refused to verify against a possibly-wrong field");
  }
  const textarea = card.querySelector<HTMLTextAreaElement>(SELECTORS.textarea);
  if (!textarea) {
    return fail("no textarea found in this question card");
  }
  textarea.scrollIntoView({ block: "center" });
  setNativeValue(textarea, value);

  const settled = await pollUntil(
    () => ((liveCard(question, ordinal) ?? question.listitem).querySelector<HTMLTextAreaElement>(SELECTORS.textarea)?.value === value ? true : null),
    ARIA_SETTLE_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );
  recordTiming(question.questionText, "textarea value settle", settled.elapsedMs, settled.value ? "ok" : "timeout");
  const observed = (liveCard(question, ordinal) ?? question.listitem).querySelector<HTMLTextAreaElement>(SELECTORS.textarea)?.value ?? "";
  return settled.value ? ok("typed") : fail(`wrote the value but the field reads "${observed.slice(0, 40)}…"`);
}

function matchAnswersToQuestions(
  questions: QuestionElement[],
  availableAnswers: FillableAnswer[],
): Map<QuestionElement, FillableAnswer> {
  const candidates: { question: QuestionElement; answer: FillableAnswer; score: number }[] = [];

  questions.forEach((question) => {
    if (!FILLABLE_TYPES.has(question.type)) {
      return;
    }
    availableAnswers.forEach((answer) => {
      if (!answer.answer.trim()) {
        return;
      }
      const score = textSimilarity(question.questionText, answer.questionText);
      if (score >= MATCH_THRESHOLD) {
        candidates.push({ question, answer, score });
      }
    });
  });

  // Highest-confidence pairs win first, so a great match for question A
  // can't be starved by a mediocre match assigned earlier to question B.
  candidates.sort((a, b) => b.score - a.score);

  const matched = new Map<QuestionElement, FillableAnswer>();
  const usedAnswers = new Set<FillableAnswer>();

  candidates.forEach(({ question, answer }) => {
    if (matched.has(question) || usedAnswers.has(answer)) {
      return;
    }
    matched.set(question, answer);
    usedAnswers.add(answer);
  });

  return matched;
}

// Fills ONLY the currently visible section — multi-section stepping is
// orchestrated by the sidepanel, which survives the page navigations that
// clicking "Next" can trigger. Never touches Submit: that click is left
// entirely to the user, per the human-in-the-loop requirement this feature
// is built around.
export async function fillVisibleSection(payload: FillPayload): Promise<VisibleSectionFillResult> {
  const { answers } = payload;
  const questions = getQuestionElements();
  const matches = matchAnswersToQuestions(questions, answers);

  const fillLog: FillLogEntry[] = [];
  const filledQuestions: string[] = [];
  const skippedQuestions: string[] = [];
  const consumedAnswers: string[] = [];

  for (const [ordinal, question] of questions.entries()) {
    // Google Forms file uploads can't be attached by a content script (Drive
    // picker in a cross-origin iframe). They're handled by the sidepanel's
    // manual-attach pause, so here they're reported as needing manual action.
    if (question.type === "file_upload") {
      // PART 2 — say WHY, in plain language. "file upload — attach manually"
      // reads like a limitation we might lift; this is a hard limit, and a user
      // deciding whether to wait for a fix deserves to know that.
      fillLog.push({
        question: question.questionText,
        type: question.type,
        outcome: "skipped",
        reason:
          "file uploads go through Google Drive and cannot be automated — the picker attaches from your Drive, " +
          "not from this extension. Attach this one yourself.",
      });
      skippedQuestions.push(`${question.questionText} (attach manually)`);
      continue;
    }

    const match = matches.get(question);

    if (!FILLABLE_TYPES.has(question.type) || !match) {
      const reason = !FILLABLE_TYPES.has(question.type)
        ? `${question.type} fields can't be auto-filled`
        : "no answer in the approved report matched this question";
      fillLog.push({ question: question.questionText, type: question.type, outcome: "skipped", reason });
      skippedQuestions.push(question.questionText);
      continue;
    }

    let result: FieldFillResult;
    switch (question.type) {
      case "short_answer":
        result = await fillShortAnswerVerified(question, match.answer, ordinal);
        break;
      case "paragraph":
        result = await fillParagraphVerified(question, match.answer, ordinal);
        break;
      case "multiple_choice":
      case "linear_scale":
        result = await fillSingleSelect(question, match.answer, ordinal);
        break;
      case "checkboxes":
        result = await fillCheckboxes(question, match.answer, ordinal);
        break;
      case "date":
        result = await fillDateVerified(question, match.answer, ordinal);
        break;
      case "dropdown":
        result = await fillDropdown(question, match.answer, ordinal);
        break;
      default:
        result = fail(`unsupported field type "${question.type}"`);
    }

    fillLog.push({
      question: question.questionText,
      type: question.type,
      outcome: result.ok ? "filled" : "failed",
      reason: result.reason,
      intended: match.answer,
      ...(result.observed !== undefined ? { observed: result.observed } : {}),
    });

    if (result.ok) {
      filledQuestions.push(question.questionText);
      consumedAnswers.push(match.questionText);
    } else {
      // A verified failure is reported as a failure, never quietly as "skipped
      // because nothing matched" — the whole point is that the user must not
      // discover the gap by scrolling the form.
      console.warn(`EasyFilla(fill): FAILED "${question.questionText}" — ${result.reason}`);
      skippedQuestions.push(question.questionText);
    }
  }

  const filled = fillLog.filter((r) => r.outcome === "filled").length;
  const failed = fillLog.filter((r) => r.outcome === "failed");
  console.log(
    `EasyFilla(fill): section complete — filled ${filled} of ${fillLog.length} field(s)` +
      (failed.length > 0 ? `; ${failed.length} need manual entry:` : "."),
    failed.map((r) => `${r.question} — ${r.reason}`),
  );
  console.table?.(fillLog);

  // A-FIX 2: real numbers to tune the defaults against, instead of more guesses.
  const observed = drainFillTimings();
  if (observed.length > 0) {
    console.log(
      `EasyFilla(fill): observed timings (defaults: options ${OPTION_RENDER_TIMEOUT_MS}ms / settle ` +
        `${ARIA_SETTLE_TIMEOUT_MS}ms / poll ${POLL_INTERVAL_MS}ms)`,
    );
    console.table?.(observed);
    const slowest = observed.reduce((a, b) => (b.ms > a.ms ? b : a));
    console.log(`EasyFilla(fill): slowest wait was ${slowest.ms}ms — ${slowest.metric} on "${slowest.field}".`);
  }
  if (orphanFallbacks() > 0) {
    console.warn(
      `EasyFilla(fill): ${orphanFallbacks()} question card(s) were detached mid-fill and had to be re-resolved. ` +
        "A high count means the fill path is racing a Google re-render — a separate problem worth investigating.",
    );
  }

  // Google file uploads are never auto-attached; attachment is manual.
  return { filledQuestions, skippedQuestions, consumedAnswers, attachedFiles: [], failedAttachments: [], fillLog };
}

// Scrolls a Google Forms question into view by its heading text, used by the
// manual-attach pause during Continue-and-Fill.
export function scrollToGoogleQuestion(questionText: string): boolean {
  const questions = getQuestionElements();
  let best: QuestionElement | undefined;
  let bestScore = 0.7;
  for (const question of questions) {
    const score = textSimilarity(question.questionText, questionText);
    if (score > bestScore) {
      bestScore = score;
      best = question;
    }
  }
  if (!best) {
    return false;
  }
  best.listitem.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}
