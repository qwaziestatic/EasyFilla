// ─────────────────────────────────────────────────────────────────────────
// UI PREFERENCES (TASK A / TASK B)
//
// Small, local-only preferences that shape the interface rather than the
// answers: whether the expectation-setting note has been dismissed, and the
// default compose length/tone that seeds each question's initial choice.
//
// Deliberately separate from the answer/provenance path — nothing here can
// influence grounding. Length and tone change PROSE, never evidence.
// ─────────────────────────────────────────────────────────────────────────

// TASK B — word-count targets. These are explicit ranges, not adjectives:
// "short" told the model nothing reproducible, and two runs of the same
// setting produced answers of wildly different size. The numbers below are the
// contract, and they are the numbers written into the Stage B instruction.
//
// Recorded in HANDOFF.md §4g. Change them there and here together.
export type ComposeLengthChoice = "short" | "medium" | "long";
export type ComposeToneChoice = "neutral" | "formal" | "conversational";

export interface LengthTarget {
  minWords: number;
  maxWords: number;
  label: string;
}

// Two scales: an open-ended "essay" question needs more room than a one-line
// short-answer field, and forcing them onto one scale made Short unusable on
// essays and Long absurd on a single-line field.
export const LENGTH_TARGETS: Record<ComposeLengthChoice, { short: LengthTarget; essay: LengthTarget }> = {
  short: {
    short: { minWords: 15, maxWords: 40, label: "Short" },
    essay: { minWords: 60, maxWords: 110, label: "Short" },
  },
  medium: {
    short: { minWords: 40, maxWords: 80, label: "Medium" },
    essay: { minWords: 120, maxWords: 220, label: "Medium" },
  },
  long: {
    short: { minWords: 80, maxWords: 140, label: "Long" },
    essay: { minWords: 230, maxWords: 400, label: "Long" },
  },
};

export function lengthTargetFor(choice: ComposeLengthChoice, isEssay: boolean): LengthTarget {
  const pair = LENGTH_TARGETS[choice] ?? LENGTH_TARGETS.medium;
  return isEssay ? pair.essay : pair.short;
}

export const TONE_INSTRUCTIONS: Record<ComposeToneChoice, string> = {
  neutral:
    "Tone: neutral and plain. Straightforward professional prose. No slogans, no salesmanship, no filler adjectives.",
  formal:
    "Tone: formal. Complete sentences, no contractions, restrained vocabulary, third-person framing where natural. " +
    "Formality changes register only — it must not add claims to pad the register.",
  conversational:
    "Tone: conversational. First person, contractions allowed, direct and readable. Still specific and " +
    "professional — conversational does not mean vague.",
};

export interface ComposeDefaults {
  length: ComposeLengthChoice;
  tone: ComposeToneChoice;
}

export const DEFAULT_COMPOSE_DEFAULTS: ComposeDefaults = { length: "medium", tone: "neutral" };

const NOTE_KEY = "easyfilla.inputQualityNoteDismissed";
const DEFAULTS_KEY = "easyfilla.composeDefaults";

/**
 * Has the user dismissed the splash tip?
 *
 * ⚠️ FIRST-RUN DEFAULT IS EXPLICIT: only the literal `true` counts as dismissed.
 * An absent key, `false`, `null`, or any other value means SHOW IT. A fresh
 * install therefore always sees the tip.
 *
 * This flag caused a real diagnosis problem: the tip is dismissible forever, so
 * once a tester pressed "Got it" in any earlier session it never returned — and
 * a permanently-dismissed tip is indistinguishable from a feature that was never
 * built. `resetInputNote()` and the Settings control exist so that state is
 * recoverable and observable rather than a dead end.
 */
export async function isInputNoteDismissed(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(NOTE_KEY);
    return stored[NOTE_KEY] === true;
  } catch {
    // Storage unavailable: show the note. Showing it twice is a smaller cost
    // than never showing it.
    return false;
  }
}

/** Undismisses the splash tip so it shows again on the next panel open. */
export async function resetInputNote(): Promise<void> {
  try {
    await chrome.storage.local.remove(NOTE_KEY);
  } catch {
    // Non-fatal: the tip simply stays dismissed.
  }
}

export async function dismissInputNote(): Promise<void> {
  try {
    await chrome.storage.local.set({ [NOTE_KEY]: true });
  } catch {
    // Non-fatal — it will reappear next session.
  }
}

function isLength(value: unknown): value is ComposeLengthChoice {
  return value === "short" || value === "medium" || value === "long";
}

function isTone(value: unknown): value is ComposeToneChoice {
  return value === "neutral" || value === "formal" || value === "conversational";
}

export async function loadComposeDefaults(): Promise<ComposeDefaults> {
  try {
    const stored = await chrome.storage.local.get(DEFAULTS_KEY);
    const raw = stored[DEFAULTS_KEY] as Partial<ComposeDefaults> | undefined;
    return {
      length: isLength(raw?.length) ? raw.length : DEFAULT_COMPOSE_DEFAULTS.length,
      tone: isTone(raw?.tone) ? raw.tone : DEFAULT_COMPOSE_DEFAULTS.tone,
    };
  } catch {
    return { ...DEFAULT_COMPOSE_DEFAULTS };
  }
}

export async function saveComposeDefaults(defaults: ComposeDefaults): Promise<void> {
  try {
    await chrome.storage.local.set({ [DEFAULTS_KEY]: defaults });
  } catch {
    // Non-fatal.
  }
}

// TASK A — the note itself, in one place so the splash and both inline copies
// cannot drift apart.
/**
 * The SPLASH hook — one short line, revealed as the logo animates.
 *
 * ⚠️ THIS IS A HOOK, NOT THE GUIDANCE. It replaced a two-sentence paragraph that
 * nobody finishes reading during a 3.8s intro. The actionable substance did NOT
 * disappear: it lives in the two PERMANENT inline notes below, at the moments it
 * is actually useful (choosing files, writing a seed). §4g is explicit that
 * those two are not dismissible for exactly this reason — a user who dismissed
 * the splash weeks ago still needs the advice at the point of action.
 *
 * Chosen from three candidates:
 *   - "Your files in. Your answers out."   → describes the mechanism, but says
 *     nothing about quality depending on the input, which is the whole point.
 *   - "As good as what you feed it."       → carries the dependency, but leads
 *     with a limitation on first launch.
 *   - "Great files make great answers."    → ✅ CHOSEN. Carries the same
 *     expectation (output is bounded by input) in a positive frame, and reads as
 *     an invitation to upload good documents rather than a disclaimer.
 */
export const INPUT_QUALITY_NOTE = "Great files make great answers.";

// Compact wording for the two permanent inline placements, where the full
// sentence would crowd the control it sits beside.
export const INPUT_QUALITY_NOTE_SHORT_FILES =
  "Output quality is bounded by what you upload. CV, ID and a reference sheet give it the most to work with.";

export const INPUT_QUALITY_NOTE_SHORT_SEED =
  "A sentence or two of your own here is what the draft is built from. Thin seed, thin answer — it will not invent the difference.";
