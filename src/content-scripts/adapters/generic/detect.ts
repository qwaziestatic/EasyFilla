import { fieldIdentity, dedupeByIdentity, currentFrameId, type FieldIdentity } from "../identity";
import {
  harvestOneWidget,
  HarvestBudgetTracker,
  DEFAULT_HARVEST_BUDGET,
  FILL_TIME_HARVEST_BUDGET,
  type HarvestBudget,
} from "../../shared/options";
import type { CoverageReport } from "../adapter";
import { debugLog } from "../../../lib/debug";

// Choice types that are unanswerable without options.
const CHOICE_TYPES_NEEDING_OPTIONS = new Set(["multiple_choice", "checkboxes", "dropdown", "linear_scale"]);
import type { ExtractedQuestion, FileConstraints, QuestionType } from "../../../types/questions";

export type GenericFillKind =
  | "text"
  | "textarea"
  | "contenteditable"
  | "native-select"
  | "custom-combobox"
  | "radio-group"
  | "checkbox-group"
  | "date"
  | "time"
  | "file"
  | "none";

export interface GenericQuestion extends ExtractedQuestion {
  fillKind: GenericFillKind;
  // The element(s) to act on when filling: the input itself for text-likes,
  // the individual option elements for radio/checkbox groups.
  elements: HTMLElement[];
  // frameId + domPath + name/id + accessibleName. Set for every question with
  // an anchor element; used for dedup at scan time and to re-find the exact
  // field at fill time instead of fuzzy-matching label text.
  identity?: FieldIdentity;
}

export interface GenericPageScan {
  questions: GenericQuestion[];
  sectionTitle: string | null;
  inaccessibleFrames: number;
  coverage?: CoverageReport;
}


const FIELD_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[contenteditable="true"]',
].join(", ");

const SKIPPED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const PAYMENT_PATTERN = /card[\s_-]?number|cc[\s_-]?num|cvv|cvc|security[\s_-]?code|expir/i;
const CAPTCHA_FRAME_PATTERN = /recaptcha|hcaptcha|turnstile/i;

type SearchRoot = Document | ShadowRoot;

// Collects every readable root WITHIN THIS FRAME: its own document plus open
// shadow roots at any depth.
//
// STAGE 2a — this deliberately no longer descends into same-origin iframe
// documents. With `all_frames` every frame runs its own content script and
// reports its own fields under its own frameId. A parent that also walked
// into its children would report those fields a SECOND time, under the
// PARENT's frameId and with a DOM path rooted in the child document — so the
// identity key would differ and dedup (which keys on frameId + path) could
// not collapse them. The result would be every same-origin embedded field
// listed twice. Frame traversal now belongs to the service worker's registry,
// which reconciles against the real frame tree.
function collectSearchRoots(): { roots: SearchRoot[]; inaccessibleFrames: number } {
  const roots: SearchRoot[] = [document];

  // Open shadow roots, breadth-first, including shadow-within-shadow.
  const shadowQueue: SearchRoot[] = [...roots];
  while (shadowQueue.length > 0) {
    const root = shadowQueue.shift();
    if (!root) {
      break;
    }
    root.querySelectorAll("*").forEach((element) => {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        shadowQueue.push(shadow);
      }
    });
  }

  // The only frame-level blocker this frame can diagnose by itself: a child
  // iframe sandboxed without allow-scripts can never run a content script, so
  // no amount of injection will reach it. Everything else about the frame
  // tree (which frames exist, which stayed silent and why) is reconciled by
  // the service worker against chrome.webNavigation.getAllFrames.
  const permanentlyBlocked = Array.from(document.querySelectorAll("iframe")).filter((frame) => {
    const sandbox = frame.getAttribute("sandbox");
    return sandbox !== null && !sandbox.split(/\s+/).includes("allow-scripts");
  }).length;

  return { roots, inaccessibleFrames: permanentlyBlocked };
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

function cleanText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function prettifyIdentifier(raw: string): string {
  return cleanText(
    raw
      .replace(/[[\]]/g, " ")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2"),
  );
}

function labelFromAriaLabelledBy(element: HTMLElement): string {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
  const root = element.getRootNode() as SearchRoot;
  return cleanText(
    ids
      .map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
      .join(" "),
  );
}

function nearestPrecedingText(element: HTMLElement): string {
  // Walk backwards through siblings (then up the ancestor chain) looking for
  // short human text — the typical "label rendered as a plain <div> above
  // the input" pattern.
  let node: HTMLElement | null = element;
  for (let depth = 0; depth < 4 && node; depth += 1) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      const text = cleanText(sibling.textContent);
      if (text && text.length <= 140 && !sibling.querySelector(FIELD_SELECTOR)) {
        return text;
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return "";
}

// Accessible-name priority (STAGE 2b): label[for] → wrapping <label> →
// aria-label → aria-labelledby → <legend> → placeholder → nearest preceding
// text → prettified name/id. Nearby-text scraping is deliberately near the
// bottom; it is a guess, not a name.
export function resolveFieldLabel(element: HTMLElement): string {
  const root = element.getRootNode() as SearchRoot;

  if (element.id) {
    const explicit = root.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    const text = cleanText(explicit?.textContent);
    if (text) {
      return text;
    }
  }

  const wrapping = element.closest("label");
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input, textarea, select").forEach((nested) => nested.remove());
    const text = cleanText(clone.textContent);
    if (text) {
      return text;
    }
  }

  const ariaLabel = cleanText(element.getAttribute("aria-label"));
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = labelFromAriaLabelledBy(element);
  if (labelledBy) {
    return labelledBy;
  }

  // STAGE 2b: <legend> sits above placeholder in the accessible-name priority.
  // Fieldset-wrapped groups on portal forms often carry their only real label
  // there, and without this the code fell through to nearby-text scraping.
  const legend = cleanText(element.closest("fieldset")?.querySelector("legend")?.textContent);
  if (legend) {
    return legend;
  }

  const placeholder = cleanText(element.getAttribute("placeholder"));
  if (placeholder) {
    return placeholder;
  }

  // LAST RESORT. On dense portal layouts this reliably picks up the previous
  // field's text, so everything above is preferred.
  const preceding = nearestPrecedingText(element);
  if (preceding) {
    return preceding;
  }

  const name = element.getAttribute("name") ?? element.id;
  return name ? prettifyIdentifier(name) : "";
}

function isRequired(element: HTMLElement, label: string): boolean {
  if ((element as HTMLInputElement).required || element.getAttribute("aria-required") === "true") {
    return true;
  }
  return /\*\s*$/.test(label);
}

function resolveGroup(element: HTMLElement, headings: { el: Element; text: string }[]): string | undefined {
  const fieldset = element.closest("fieldset");
  const legend = cleanText(fieldset?.querySelector("legend")?.textContent);
  if (legend) {
    return legend;
  }

  // Nearest heading that precedes this element in document order.
  let best: string | undefined;
  for (const heading of headings) {
    const position = heading.el.compareDocumentPosition(element);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      best = heading.text;
    } else {
      break;
    }
  }
  return best;
}

interface ManualCheck {
  manualOnly: boolean;
  reason?: string;
}

function checkManualOnly(element: HTMLElement, label: string): ManualCheck {
  const input = element as HTMLInputElement;
  if (input.type === "password") {
    return { manualOnly: true, reason: "password field" };
  }

  const identity = `${element.getAttribute("autocomplete") ?? ""} ${element.getAttribute("name") ?? ""} ${element.id} ${label}`;
  if (element.getAttribute("autocomplete")?.startsWith("cc-") || PAYMENT_PATTERN.test(identity)) {
    return { manualOnly: true, reason: "payment card field" };
  }

  // A small form containing a password field is treated as a login form —
  // all its fields become manual-only.
  const form = element.closest("form");
  if (form && form.querySelector('input[type="password"]')) {
    const visibleFields = Array.from(form.querySelectorAll<HTMLElement>("input, textarea, select")).filter(
      (el) => !SKIPPED_INPUT_TYPES.has((el as HTMLInputElement).type) && isVisible(el),
    );
    if (visibleFields.length <= 4) {
      return { manualOnly: true, reason: "part of a login form" };
    }
  }

  return { manualOnly: false };
}

function detectCaptcha(roots: SearchRoot[]): boolean {
  return roots.some((root) => {
    const frames = Array.from(root.querySelectorAll("iframe"));
    if (frames.some((frame) => CAPTCHA_FRAME_PATTERN.test(frame.src))) {
      return true;
    }
    return root.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile") !== null;
  });
}

interface Candidate {
  element: HTMLElement;
  label: string;
  required: boolean;
  group: string | undefined;
  manual: ManualCheck;
}

function fileConstraintsOf(input: HTMLInputElement): FileConstraints {
  const accept = cleanText(input.getAttribute("accept")) || null;
  return { accept, multiple: input.multiple };
}

function classifyStandalone(candidate: Candidate): GenericQuestion | null {
  const { element, label, required, group, manual } = candidate;
  const input = element as HTMLInputElement;
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role");

  let type: QuestionType;
  let fillKind: GenericFillKind;
  let options: string[] = [];
  let fileConstraints: FileConstraints | undefined;

  if (tag === "select") {
    type = "dropdown";
    fillKind = "native-select";
    options = Array.from((element as HTMLSelectElement).options)
      .map((option) => cleanText(option.textContent))
      .filter((text, index) => text.length > 0 && !(index === 0 && /^(select|choose|--)/i.test(text)));
  } else if (role === "combobox" || role === "listbox") {
    // A custom (div-based) dropdown: options usually only exist in the DOM
    // while it's open, so they can't be listed here.
    type = "dropdown";
    fillKind = "custom-combobox";
  } else if (tag === "textarea") {
    type = "paragraph";
    fillKind = "textarea";
  } else if (element.getAttribute("contenteditable") === "true" || role === "textbox") {
    type = "paragraph";
    fillKind = "contenteditable";
  } else if (tag === "input") {
    switch (input.type) {
      case "date":
        type = "date";
        fillKind = "date";
        break;
      case "time":
        type = "time";
        fillKind = "time";
        break;
      case "file":
        type = "file_upload";
        fillKind = "file";
        fileConstraints = fileConstraintsOf(input);
        break;
      default:
        // text, email, tel, url, number, search, password (already flagged
        // manual-only above but still listed in the PDF).
        type = "short_answer";
        fillKind = "text";
        break;
    }
  } else {
    return null;
  }

  const question: GenericQuestion = {
    questionText: label,
    type,
    options,
    required,
    fillKind: manual.manualOnly ? "none" : fillKind,
    elements: [element],
  };
  if (group) {
    question.group = group;
  }
  if (fileConstraints) {
    question.fileConstraints = fileConstraints;
    // Generic pages expose a reachable <input type=file>: the extension can
    // attach the file itself (subject to the fill path succeeding).
    question.attachmentMode = "auto";
  }
  // File uploads are manual-only for the same reason on every adapter: a local
  // file cannot be injected into a picker we do not control.
  if (manual.manualOnly || type === "file_upload") {
    question.manualOnly = true;
    if (manual.reason) {
      question.manualReason = manual.reason;
    }
  }
  return question;
}

function groupKeyFor(candidate: Candidate, kind: "radio" | "checkbox"): string {
  const element = candidate.element;
  const name = element.getAttribute("name");
  const form = element.closest("form");
  const ariaGroup = element.closest('[role="radiogroup"], [role="group"]');
  if (name) {
    return `${kind}:name:${form ? "in-form" : "no-form"}:${name}`;
  }
  if (ariaGroup) {
    return `${kind}:aria:${Array.from(ariaGroup.parentElement?.children ?? []).indexOf(ariaGroup)}`;
  }
  return `${kind}:solo:${Math.random()}`;
}

function questionLabelForGroup(candidates: Candidate[]): string {
  const first = candidates[0];
  if (!first) {
    return "";
  }
  const container = first.element.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (container) {
    const legend = cleanText(container.querySelector("legend")?.textContent);
    if (legend) {
      return legend;
    }
    const ariaLabel = cleanText(container.getAttribute("aria-label"));
    if (ariaLabel) {
      return ariaLabel;
    }
  }
  const preceding = nearestPrecedingText(first.element);
  if (preceding) {
    return preceding;
  }
  const name = first.element.getAttribute("name");
  return name ? prettifyIdentifier(name) : first.label;
}

// Placeholder option text, kept deliberately conservative: this only filters
// prompts ("Select…", "Choose one", "—"), never real answers. Over-filtering
// here would silently shrink a real option list.
// Structure: an optional "please", a prompt verb, an optional article, an
// optional generic noun, and an optional trailing ellipsis — and NOTHING else.
// Anchoring the whole string is what keeps real answers safe: "Select Committee
// Member" and "Choose Your Own Adventure" both leave unmatched words after the
// prompt words, so neither matches. Over-filtering here would silently shrink a
// real option list, which is worse than leaving a prompt in it.
const PLACEHOLDER_OPTION_RE = new RegExp(
  "^(?:" +
    "--+|—+|\\.{3}|…" + // -- , em-dashes, ... , …
    "|(?:please\\s+)?(?:select|choose|pick)" +
    "(?:\\s+(?:an?|one|your))?" +
    "(?:\\s+(?:option|choice|value|item|one))?" +
    "\\s*(?:\\.{0,3}|…)" +
    "|please\\s+select\\b.*" + // "Please select a country"
    "|none\\s+selected" +
    ")$",
  "i",
);

export function isGenericPlaceholderOption(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }
  if (/^[\s\p{P}\p{S}]+$/u.test(normalized)) {
    return true;
  }
  return PLACEHOLDER_OPTION_RE.test(normalized);
}

// STAGE 2c — opens lazily-rendered choice widgets so the SCANNER can report
// their options. Runs after the synchronous scan (which stays synchronous
// because the fill path and scroll path both call it).
//
// Non-destructive by construction: `harvestOneWidget` captures scroll + focus,
// opens, reads, closes, restores. Budgeted, because opening 20 dropdowns
// serially on a large portal is slow, visibly flickers, and can trip page-level
// rate limiting. When the budget runs out the remaining fields are marked
// `optionsPending` and harvested ON DEMAND at fill time instead of blocking the
// scan — which is strictly better than a scan that takes 40 seconds.
export interface HarvestPassResult {
  harvested: number;
  pending: number;
  failed: number;
  skipped: number;
  budgetReason: string | null;
  elapsedMs: number;
}

function needsHarvest(question: GenericQuestion): boolean {
  return (
    question.fillKind === "custom-combobox" &&
    !question.manualOnly &&
    (question.options?.length ?? 0) === 0 &&
    Boolean(question.elements[0])
  );
}

export async function harvestChoiceOptions(
  questions: GenericQuestion[],
  budget: HarvestBudget = DEFAULT_HARVEST_BUDGET,
): Promise<HarvestPassResult> {
  const tracker = new HarvestBudgetTracker(budget);
  const result: HarvestPassResult = {
    harvested: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    budgetReason: null,
    elapsedMs: 0,
  };
  const started = Date.now();

  for (const question of questions) {
    if (!needsHarvest(question)) {
      continue;
    }
    const trigger = question.elements[0];
    if (!trigger) {
      continue;
    }

    if (!tracker.canHarvest()) {
      // Not a failure — deferred. Stated as such so the coverage report can
      // tell "we ran out of budget" apart from "extraction broke".
      question.optionsPending = true;
      result.pending += 1;
      result.budgetReason ??= tracker.exhaustionReason();
      continue;
    }

    const harvest = await harvestOneWidget(
      { trigger, manualOnly: Boolean(question.manualOnly), isPlaceholder: isGenericPlaceholderOption },
      budget,
    );
    tracker.record();

    if (harvest.outcome === "harvested") {
      question.options = harvest.options;
      question.optionsPending = false;
      result.harvested += 1;
    } else if (harvest.outcome === "empty") {
      // A successful open that yields nothing is an EXTRACTION FAILURE and
      // stays visible in the coverage report. Do not paper over it.
      question.optionsPending = false;
      result.failed += 1;
      console.warn(
        `EasyFilla(harvest): "${question.questionText}" opened but produced ZERO options. ` +
          "That is an extraction failure, not an empty list — the field cannot be answered as it stands.",
      );
    } else {
      result.skipped += 1;
      debugLog(`EasyFilla(harvest): "${question.questionText}" not harvested (${harvest.outcome}).`);
    }
  }

  result.elapsedMs = Date.now() - started;
  if (result.harvested > 0 || result.pending > 0 || result.failed > 0) {
    console.log(
      `EasyFilla(harvest): ${result.harvested} widget(s) harvested, ${result.failed} empty, ` +
        `${result.pending} deferred to fill time, ${result.skipped} skipped, in ${result.elapsedMs}ms` +
        (result.budgetReason ? ` — ${result.budgetReason}` : ""),
    );
  }
  return result;
}

// On-demand harvest for ONE field at fill time, for the fields the scan budget
// deferred. Uses the more generous fill-time budget: here we know the field
// actually needs a value, so one widget is worth waiting longer for.
// Recomputes the option-related coverage counters AFTER the harvest pass, so
// "zero options" is only ever claimed about a widget we actually opened.
export function applyHarvestToCoverage(
  coverage: CoverageReport,
  questions: GenericQuestion[],
  harvest: HarvestPassResult,
): CoverageReport {
  const pending = questions.filter((question) => question.optionsPending).length;
  const emptyAfterAttempt = questions.filter(
    (question) =>
      CHOICE_TYPES_NEEDING_OPTIONS.has(question.type) &&
      (question.options?.length ?? 0) === 0 &&
      !question.optionsPending,
  ).length;

  const updated: CoverageReport = {
    ...coverage,
    choiceWithNoOptions: emptyAfterAttempt,
    optionsPending: pending,
    harvestedWidgets: harvest.harvested,
  };
  if (harvest.budgetReason) {
    updated.harvestBudgetReason = harvest.budgetReason;
  }

  if (emptyAfterAttempt > 0) {
    console.warn(
      `EasyFilla(coverage): ${emptyAfterAttempt} choice field(s) yielded ZERO options after a harvest attempt — ` +
        "extraction failure, not an empty form. They cannot be answered until this is fixed.",
    );
  }
  if (pending > 0) {
    console.log(
      `EasyFilla(coverage): ${pending} choice field(s) were not harvested this scan ` +
        `(${harvest.budgetReason ?? "budget"}). They are NOT failures — their options are read on demand at fill time.`,
    );
  }
  return updated;
}

export async function harvestOptionsForFill(question: GenericQuestion): Promise<string[]> {
  const trigger = question.elements[0];
  if (!trigger || question.manualOnly) {
    return question.options ?? [];
  }
  const harvest = await harvestOneWidget(
    { trigger, manualOnly: Boolean(question.manualOnly), isPlaceholder: isGenericPlaceholderOption },
    FILL_TIME_HARVEST_BUDGET,
  );
  if (harvest.outcome === "harvested") {
    question.options = harvest.options;
    question.optionsPending = false;
  }
  return question.options ?? [];
}

export function scanGenericPage(): GenericPageScan {
  const { roots, inaccessibleFrames } = collectSearchRoots();

  const headings = roots.flatMap((root) =>
    Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, legend"))
      .map((el) => ({ el, text: cleanText(el.textContent) }))
      .filter((h) => h.text.length > 0 && h.text.length <= 120),
  );

  let rawFields: HTMLElement[] = roots.flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(FIELD_SELECTOR)),
  );
  rawFields = rawFields.filter((element) => {
    const input = element as HTMLInputElement;
    if (element.tagName.toLowerCase() === "input" && SKIPPED_INPUT_TYPES.has(input.type)) {
      return false;
    }
    if (input.disabled) {
      return false;
    }
    return isVisible(element);
  });

  // Noise reduction: if the page has <form> elements that contain several
  // fields, restrict to those — this drops stray site-chrome inputs like a
  // header search box. Pages that build forms without <form> tags keep the
  // whole-page field set.
  const formsWithFields = new Set<HTMLFormElement>();
  rawFields.forEach((element) => {
    const form = element.closest("form");
    if (form) {
      formsWithFields.add(form);
    }
  });
  const substantialForms = Array.from(formsWithFields).filter(
    (form) => rawFields.filter((el) => form.contains(el)).length >= 2,
  );
  if (substantialForms.length > 0) {
    const before = rawFields.length;
    rawFields = rawFields.filter((element) => substantialForms.some((form) => form.contains(element)));
    console.log(
      `EasyFilla(generic): restricting to ${substantialForms.length} form(s) with ≥2 fields ` +
        `(${before} → ${rawFields.length} candidate fields).`,
    );
  }

  const candidates: Candidate[] = rawFields.map((element) => {
    const label = resolveFieldLabel(element);
    return {
      element,
      label,
      required: isRequired(element, label),
      group: resolveGroup(element, headings),
      manual: checkManualOnly(element, label),
    };
  });

  const questions: GenericQuestion[] = [];
  const radioGroups = new Map<string, Candidate[]>();
  const checkboxGroups = new Map<string, Candidate[]>();

  candidates.forEach((candidate) => {
    const input = candidate.element as HTMLInputElement;
    const role = candidate.element.getAttribute("role");
    const isRadio = input.type === "radio" || role === "radio";
    const isCheckbox = input.type === "checkbox" || role === "checkbox";

    if (isRadio) {
      const key = groupKeyFor(candidate, "radio");
      radioGroups.set(key, [...(radioGroups.get(key) ?? []), candidate]);
      return;
    }
    if (isCheckbox) {
      const key = groupKeyFor(candidate, "checkbox");
      checkboxGroups.set(key, [...(checkboxGroups.get(key) ?? []), candidate]);
      return;
    }

    const question = classifyStandalone(candidate);
    if (question && question.questionText) {
      questions.push(question);
    }
  });

  radioGroups.forEach((members) => {
    const first = members[0];
    if (!first) {
      return;
    }
    const manual = members.find((m) => m.manual.manualOnly)?.manual ?? { manualOnly: false };
    const question: GenericQuestion = {
      questionText: questionLabelForGroup(members),
      type: "multiple_choice",
      options: members.map((m) => m.label).filter(Boolean),
      required: members.some((m) => m.required),
      fillKind: manual.manualOnly ? "none" : "radio-group",
      elements: members.map((m) => m.element),
    };
    if (first.group) {
      question.group = first.group;
    }
    if (manual.manualOnly) {
      question.manualOnly = true;
      if (manual.reason) {
        question.manualReason = manual.reason;
      }
    }
    if (question.questionText) {
      questions.push(question);
    }
  });

  checkboxGroups.forEach((members) => {
    const first = members[0];
    if (!first) {
      return;
    }
    const manual = members.find((m) => m.manual.manualOnly)?.manual ?? { manualOnly: false };
    const isGroup = members.length > 1;
    const question: GenericQuestion = {
      questionText: isGroup ? questionLabelForGroup(members) : first.label,
      type: "checkboxes",
      options: members.map((m) => m.label).filter(Boolean),
      required: members.some((m) => m.required),
      fillKind: manual.manualOnly ? "none" : "checkbox-group",
      elements: members.map((m) => m.element),
    };
    if (first.group) {
      question.group = first.group;
    }
    if (manual.manualOnly) {
      question.manualOnly = true;
      if (manual.reason) {
        question.manualReason = manual.reason;
      }
    }
    if (question.questionText) {
      questions.push(question);
    }
  });

  if (detectCaptcha(roots)) {
    questions.push({
      questionText: "CAPTCHA verification",
      type: "unknown",
      options: [],
      required: false,
      manualOnly: true,
      manualReason: "CAPTCHA — must be completed by a person",
      fillKind: "none",
      elements: [],
    });
  }

  // Keep DOM order for everything that has a position.
  questions.sort((a, b) => {
    const elementA = a.elements[0];
    const elementB = b.elements[0];
    if (!elementA || !elementB) {
      return 0;
    }
    const position = elementA.compareDocumentPosition(elementB);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  });

  // STAGE 2b — deduplicate on STRUCTURAL identity, never on label text.
  // Portals repeat labels ("Employer", "Start date") once per repeated row; a
  // text-keyed dedup collapses genuinely distinct fields, and a 59-field form
  // previously reported ~50% duplicates because of it.
  const withIdentity = questions.map((question) => {
    const anchor = question.elements[0];
    return anchor
      ? { ...question, identity: fieldIdentity(anchor, currentFrameId(), question.questionText) }
      : question;
  });
  const { kept, removed } = dedupeByIdentity(withIdentity);
  if (removed.length > 0) {
    console.log(
      `EasyFilla(generic): collapsed ${removed.length} structurally identical field(s).`,
      removed.map((r) => r.item.questionText),
    );
  }

  const mainHeading = cleanText(document.querySelector("h1")?.textContent);
  const sectionTitle = mainHeading || null;

  // STAGE 2e — coverage report. The user should never have to guess what a scan
  // missed. Canvas- and PDF-rendered forms have no DOM to read at all and are
  // stated as out of reach rather than silently producing zero fields.
  const byType = new Map<string, number>();
  kept.forEach((q) => byType.set(q.type, (byType.get(q.type) ?? 0) + 1));
  const canvasOnly =
    kept.length === 0 && document.querySelectorAll("canvas, embed[type='application/pdf'], object[type='application/pdf']").length > 0;

  const coverage: CoverageReport = {
    adapter: "generic",
    frameId: currentFrameId(),
    fieldsFound: kept.length,
    byType: Object.fromEntries(byType),
    duplicatesCollapsed: removed.length,
    inaccessibleFrames,
    manualOnly: kept.filter((q) => q.manualOnly).length,
    // STAGE 2c — before harvesting, every lazily-rendered widget looks like a
    // zero-option field. These two counters are recomputed by
    // `applyHarvestToCoverage()` once the harvest pass has run, so the
    // "extraction failure" claim is only made about widgets we actually opened.
    choiceWithNoOptions: kept.filter((q) => CHOICE_TYPES_NEEDING_OPTIONS.has(q.type) && (q.options?.length ?? 0) === 0)
      .length,
    optionsPending: 0,
    harvestedWidgets: 0,
    canvasOrPdfRendered: canvasOnly,
  };

  console.log("EasyFilla(coverage):", coverage);
  if (canvasOnly) {
    console.warn(
      "EasyFilla(coverage): this page renders its form to canvas or an embedded PDF. There is no DOM to read, " +
        "so no fields can be detected. This is a hard limit, not a bug.",
    );
  }

  return { questions: kept, sectionTitle, inaccessibleFrames, coverage };
}
