// ─────────────────────────────────────────────────────────────────────────
// SHARED OPTION HARVESTING (STAGE 2c)
//
// `waitForOptions` and `findOptionWithScrolling` used to live only in
// `google-forms/filler.ts`, so they ran ONLY when filling. The scanner
// therefore emitted choice questions with zero options whenever the widget
// rendered its list lazily — the coverage report named that
// (`choiceWithNoOptions`) but nothing fixed it, and a choice question with no
// options cannot be answered at all.
//
// This module is the single implementation, consumed by BOTH the scanner and
// the fill driver. Two copies would drift, and the fill path is the one place
// in this codebase with no test harness.
//
// THE HARD CONSTRAINT: harvesting at SCAN time touches a page the user has not
// asked us to modify. So it is strictly non-destructive — scroll position and
// focus are captured before and restored after, the widget is closed again,
// and nothing that could navigate or submit is ever clicked.
// ─────────────────────────────────────────────────────────────────────────

// Lazily-rendered custom widgets only. A native <select> already has its
// <option> nodes in the DOM: opening it is pointless, cannot be done
// synthetically in a reliable way, and on some platforms hands control to an
// OS-level popup that we cannot close again.
const CUSTOM_WIDGET_SELECTOR = '[role="listbox"], [role="combobox"]';

// Anything that could leave or submit the page. `robustClick` dispatches a
// full pointer sequence, so opening a widget that turns out to be one of these
// would be indistinguishable from a user submitting the form.
const NEVER_CLICK_SELECTOR =
  'a[href], button[type="submit"], input[type="submit"], input[type="image"], [role="link"]';

export interface HarvestBudget {
  // Maximum widgets opened per scan. 20 dropdowns opened serially on a large
  // portal is slow, visibly flickers the page, and can trip page-level rate
  // limiting or bot detection.
  maxWidgets: number;
  // Wall-clock ceiling for the whole harvest pass, so one pathological widget
  // that never renders options cannot stall the scan.
  maxTotalMs: number;
  // Per-widget ceiling for options to appear after opening.
  perWidgetTimeoutMs: number;
}

export const DEFAULT_HARVEST_BUDGET: HarvestBudget = {
  maxWidgets: 8,
  maxTotalMs: 6000,
  perWidgetTimeoutMs: 1200,
};

// Scan-time harvesting is deliberately stingier than fill-time. At scan time we
// are speculatively opening widgets the user may never answer; at fill time we
// know the field needs a value, so it is worth waiting longer for one widget.
export const FILL_TIME_HARVEST_BUDGET: HarvestBudget = {
  maxWidgets: 1,
  maxTotalMs: 5000,
  perWidgetTimeoutMs: 3000,
};

export type HarvestOutcome =
  | "harvested" // options were read
  | "empty" // widget opened, but produced no options — an extraction FAILURE
  | "skipped-native" // native <select>: options already in the DOM
  | "skipped-manual-only" // never open a widget on a password/payment/login field
  | "skipped-unsafe" // the trigger could navigate or submit
  | "budget-exhausted" // deferred to fill time, not a failure
  | "not-a-widget";

export interface HarvestResult {
  options: string[];
  outcome: HarvestOutcome;
  elapsedMs: number;
  // True when the page state we changed was put back as found.
  restored: boolean;
}

export interface HarvestCounters {
  widgetsOpened: number;
  elapsedMs: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls a condition until it holds or the deadline passes. No fixed sleeps:
// a fixed sleep is either a stall or a race (§4).
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

const POLL_INTERVAL_MS = 60;
const LISTBOX_SCROLL_STEPS = 25;

export function optionLabel(element: Element): string {
  return element.getAttribute("aria-label")?.trim() || element.textContent?.trim() || "";
}

// Custom widgets render their options into a DETACHED popup elsewhere in the
// document, not inside the question card — so this query is deliberately
// document-wide. A question-scoped query finds nothing (§4).
export function renderedOptionElements(isPlaceholder: (text: string) => boolean): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).filter(
    (option) => option.getClientRects().length > 0 && !isPlaceholder(optionLabel(option)),
  );
}

// Waits for lazily-rendered [role="option"] nodes to appear anywhere in the
// document. Shared by scanner and filler — one implementation.
export async function waitForOptions(
  timeoutMs: number,
  isPlaceholder: (text: string) => boolean,
): Promise<{ options: HTMLElement[]; elapsedMs: number }> {
  const { value, elapsedMs } = await pollUntil(
    () => {
      const visible = renderedOptionElements(isPlaceholder);
      return visible.length > 0 ? visible : null;
    },
    timeoutMs,
    POLL_INTERVAL_MS,
  );
  return { options: value ?? [], elapsedMs };
}

// Country/nationality dropdowns on real portals run to 200+ entries and may be
// virtualized, so the match often is not in the DOM until the list is scrolled.
// Scrolls the popup container and re-scans before giving up.
export async function findOptionWithScrolling(
  initial: HTMLElement[],
  matches: (options: HTMLElement[]) => HTMLElement | null,
  isPlaceholder: (text: string) => boolean,
): Promise<{ match: HTMLElement | null; optionsSeen: number; elapsedMs: number }> {
  const started = Date.now();
  const direct = matches(initial);
  if (direct) {
    return { match: direct, optionsSeen: initial.length, elapsedMs: Date.now() - started };
  }

  // The scrollable ancestor of the rendered options is the popup container.
  const container = initial[0]?.closest<HTMLElement>('[role="listbox"],[role="presentation"]') ?? null;
  if (!container || container.scrollHeight <= container.clientHeight) {
    return { match: null, optionsSeen: initial.length, elapsedMs: Date.now() - started };
  }

  const seen = new Set(initial.map((option) => optionLabel(option)));
  let previousCount = -1;
  for (let step = 0; step < LISTBOX_SCROLL_STEPS; step += 1) {
    container.scrollTop = Math.min(container.scrollTop + container.clientHeight * 0.8, container.scrollHeight);
    await wait(POLL_INTERVAL_MS);

    const current = renderedOptionElements(isPlaceholder);
    current.forEach((option) => seen.add(optionLabel(option)));
    const match = matches(current);
    if (match) {
      return { match, optionsSeen: seen.size, elapsedMs: Date.now() - started };
    }
    // Bottom reached and nothing new rendering — stop rather than spin.
    if (
      current.length === previousCount &&
      container.scrollTop + container.clientHeight >= container.scrollHeight - 1
    ) {
      break;
    }
    previousCount = current.length;
  }
  return { match: null, optionsSeen: seen.size, elapsedMs: Date.now() - started };
}

// Scrolls the FULL list into view by scrolling the popup to the end, collecting
// every label it renders on the way. Used at SCAN time, where there is no
// target value to look for — we want the whole option set.
async function collectAllOptionLabels(
  initial: HTMLElement[],
  isPlaceholder: (text: string) => boolean,
  deadline: number,
): Promise<string[]> {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  const record = (options: HTMLElement[]): void => {
    options.forEach((option) => {
      const label = optionLabel(option);
      if (label && !seenSet.has(label)) {
        seenSet.add(label);
        seen.push(label);
      }
    });
  };
  record(initial);

  const container = initial[0]?.closest<HTMLElement>('[role="listbox"],[role="presentation"]') ?? null;
  if (!container || container.scrollHeight <= container.clientHeight) {
    return seen;
  }

  let previousCount = -1;
  for (let step = 0; step < LISTBOX_SCROLL_STEPS; step += 1) {
    if (Date.now() > deadline) {
      break;
    }
    container.scrollTop = Math.min(container.scrollTop + container.clientHeight * 0.8, container.scrollHeight);
    await wait(POLL_INTERVAL_MS);
    const current = renderedOptionElements(isPlaceholder);
    record(current);
    if (
      current.length === previousCount &&
      container.scrollTop + container.clientHeight >= container.scrollHeight - 1
    ) {
      break;
    }
    previousCount = current.length;
  }
  return seen;
}

// ── NON-DESTRUCTIVE STATE CAPTURE ────────────────────────────────────────
// The page must be left exactly as found. Harvesting runs during a SCAN, which
// the user asked for as a read-only operation.

interface PageState {
  scrollX: number;
  scrollY: number;
  activeElement: HTMLElement | null;
  containerScrolls: { element: HTMLElement; top: number; left: number }[];
}

function capturePageState(trigger: HTMLElement): PageState {
  // Every scrollable ancestor of the trigger, because scrollIntoView moves all
  // of them, not just the window.
  const containerScrolls: { element: HTMLElement; top: number; left: number }[] = [];
  let node: HTMLElement | null = trigger.parentElement;
  while (node) {
    if (node.scrollTop !== 0 || node.scrollLeft !== 0) {
      containerScrolls.push({ element: node, top: node.scrollTop, left: node.scrollLeft });
    }
    node = node.parentElement;
  }
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElement: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    containerScrolls,
  };
}

function restorePageState(state: PageState): boolean {
  try {
    state.containerScrolls.forEach(({ element, top, left }) => {
      if (element.isConnected) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    });
    window.scrollTo(state.scrollX, state.scrollY);
    const previous = state.activeElement;
    if (previous && previous.isConnected) {
      previous.focus({ preventScroll: true });
    } else if (document.activeElement instanceof HTMLElement) {
      // Don't leave focus parked inside a widget the user never opened.
      document.activeElement.blur();
    }
    return true;
  } catch {
    return false;
  }
}

// Dispatches the full pointer sequence real widgets listen for. A bare
// `.click()` is silently ignored by several custom-widget implementations.
function openWidget(element: HTMLElement): void {
  const init: MouseEventInit = { bubbles: true, cancelable: true, view: window };
  try {
    element.dispatchEvent(new PointerEvent("pointerdown", init));
  } catch {
    /* PointerEvent unavailable — mouse events below still cover it */
  }
  element.dispatchEvent(new MouseEvent("mousedown", init));
  try {
    element.dispatchEvent(new PointerEvent("pointerup", init));
  } catch {
    /* ignore */
  }
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.click();
}

// Escape first (the standard dismissal), then a click outside if the widget
// ignored it. Never clicks a control — only a neutral point on <body>.
async function closeWidget(element: HTMLElement, isPlaceholder: (text: string) => boolean): Promise<void> {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
  await wait(POLL_INTERVAL_MS);

  if (renderedOptionElements(isPlaceholder).length === 0) {
    return;
  }
  // Still open. A pointerdown on the body is what most click-outside handlers
  // listen for; it cannot activate anything because body is not a control.
  const init: MouseEventInit = { bubbles: true, cancelable: true, view: window };
  try {
    document.body.dispatchEvent(new PointerEvent("pointerdown", init));
  } catch {
    /* ignore */
  }
  document.body.dispatchEvent(new MouseEvent("mousedown", init));
  document.body.dispatchEvent(new MouseEvent("mouseup", init));
  await wait(POLL_INTERVAL_MS);
}

export interface HarvestRequest {
  // The element that opens the widget.
  trigger: HTMLElement;
  // Never open a widget on a manual-only field. Opening a password manager's
  // autofill list or a payment-card dropdown is exactly what manual-only means
  // to avoid, and the value would never be used anyway.
  manualOnly: boolean;
  isPlaceholder: (text: string) => boolean;
}

// Opens ONE widget, reads its options, closes it, restores page state.
export async function harvestOneWidget(
  request: HarvestRequest,
  budget: HarvestBudget,
): Promise<HarvestResult> {
  const started = Date.now();
  const { trigger, manualOnly, isPlaceholder } = request;
  const done = (outcome: HarvestOutcome, options: string[] = [], restored = true): HarvestResult => ({
    options,
    outcome,
    elapsedMs: Date.now() - started,
    restored,
  });

  if (manualOnly) {
    return done("skipped-manual-only");
  }
  // Native <select> already holds its options — never open one.
  if (trigger instanceof HTMLSelectElement || trigger.tagName.toLowerCase() === "select") {
    return done("skipped-native");
  }
  if (!trigger.matches(CUSTOM_WIDGET_SELECTOR)) {
    return done("not-a-widget");
  }
  // Refuse anything that could navigate or submit. The pointer sequence used
  // to open a widget is indistinguishable from a real activation.
  if (trigger.matches(NEVER_CLICK_SELECTOR) || trigger.closest(NEVER_CLICK_SELECTOR)) {
    return done("skipped-unsafe");
  }

  const state = capturePageState(trigger);
  const deadline = started + budget.perWidgetTimeoutMs;
  let restored = true;

  try {
    openWidget(trigger);
    const { options } = await waitForOptions(budget.perWidgetTimeoutMs, isPlaceholder);
    if (options.length === 0) {
      return done("empty", [], restorePageState(state));
    }
    const labels = await collectAllOptionLabels(options, isPlaceholder, deadline);
    await closeWidget(trigger, isPlaceholder);
    restored = restorePageState(state);
    // A successful open that yields nothing usable is still an extraction
    // FAILURE, reported as such — not papered over as an empty question.
    return done(labels.length > 0 ? "harvested" : "empty", labels, restored);
  } catch (error) {
    console.warn("EasyFilla(harvest): widget harvest threw — restoring page state.", error);
    restored = restorePageState(state);
    return done("empty", [], restored);
  } finally {
    if (!restored) {
      console.warn(
        "EasyFilla(harvest): could NOT fully restore scroll/focus after opening a widget. " +
          "The page may be scrolled differently than the user left it.",
      );
    }
  }
}

// Tracks a per-scan budget across many widgets. Pure accounting — no DOM — so
// the budget rules are testable without a browser (tests/harvest.test.mjs).
export class HarvestBudgetTracker {
  private widgetsOpened = 0;
  private readonly startedAt: number;

  constructor(
    private readonly budget: HarvestBudget,
    now: number = Date.now(),
  ) {
    this.startedAt = now;
  }

  // Can another widget be opened? Checks BOTH ceilings: a scan with a generous
  // count but a slow page must still stop on time.
  canHarvest(now: number = Date.now()): boolean {
    if (this.widgetsOpened >= this.budget.maxWidgets) {
      return false;
    }
    return now - this.startedAt < this.budget.maxTotalMs;
  }

  // Why it stopped, for the coverage report. "Budget exhausted" is not a
  // failure — those fields are harvested on demand at fill time instead.
  exhaustionReason(now: number = Date.now()): string | null {
    if (this.widgetsOpened >= this.budget.maxWidgets) {
      return `harvest budget reached (${this.budget.maxWidgets} widgets per scan)`;
    }
    if (now - this.startedAt >= this.budget.maxTotalMs) {
      return `harvest time budget reached (${this.budget.maxTotalMs}ms per scan)`;
    }
    return null;
  }

  record(now: number = Date.now()): void {
    this.widgetsOpened += 1;
    void now;
  }

  stats(now: number = Date.now()): HarvestCounters {
    return { widgetsOpened: this.widgetsOpened, elapsedMs: now - this.startedAt };
  }
}
