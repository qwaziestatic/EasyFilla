// ─────────────────────────────────────────────────────────────────────────
// PART 3 — SPLASH NOTICE: STAGGERED REVEAL, SHORTER COPY
//
// The hook must arrive gradually, must never delay or block the splash, must
// land in full if the user skips, must not stagger under reduced motion, and
// must still be announced to assistive tech.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import {
  INPUT_QUALITY_NOTE,
  INPUT_QUALITY_NOTE_SHORT_FILES,
  INPUT_QUALITY_NOTE_SHORT_SEED,
} from "./_bundle-uiprefs.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const html = readFileSync("src/sidepanel/index.html", "utf8");
const panel = readFileSync("src/sidepanel/sidepanel.ts", "utf8");
const splashCss = html.slice(html.indexOf("#splash {"), html.indexOf("</style>"));

/**
 * Source with comments removed.
 *
 * Assertions about CODE must read code. The comment explaining that there is
 * "no timer, no await between words" contains the very tokens being searched
 * for, so matching raw text failed on the documentation of the rule. Same
 * correction as `tests/key-security.test.mjs`.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const panelCode = stripComments(panel);

console.log("\n=== PART 3: the splash copy is ONE short line ===");
{
  check("the chosen hook is recorded", INPUT_QUALITY_NOTE === "Great files make great answers.", INPUT_QUALITY_NOTE);
  check("it is a single sentence", (INPUT_QUALITY_NOTE.match(/[.!?]/g) ?? []).length === 1);
  check("it is short enough to read during a 3.8s intro", INPUT_QUALITY_NOTE.length <= 48, `${INPUT_QUALITY_NOTE.length} chars`);
  check("it is a handful of words", INPUT_QUALITY_NOTE.split(/\s+/).length <= 6, `${INPUT_QUALITY_NOTE.split(/\s+/).length} words`);

  // The substance must NOT have been deleted along with the paragraph — it moves
  // to the two permanent inline notes, which is the §4g contract.
  check(
    "the upload-zone note still carries the actionable detail",
    INPUT_QUALITY_NOTE_SHORT_FILES.length > 60 && /upload/i.test(INPUT_QUALITY_NOTE_SHORT_FILES),
    `${INPUT_QUALITY_NOTE_SHORT_FILES.length} chars`,
  );
  check(
    "the seed-box note still carries the actionable detail",
    INPUT_QUALITY_NOTE_SHORT_SEED.length > 60 && /seed|sentence/i.test(INPUT_QUALITY_NOTE_SHORT_SEED),
    `${INPUT_QUALITY_NOTE_SHORT_SEED.length} chars`,
  );
  check(
    "the splash hook is SHORTER than both inline notes (it is a hook, not the guidance)",
    INPUT_QUALITY_NOTE.length < INPUT_QUALITY_NOTE_SHORT_FILES.length &&
      INPUT_QUALITY_NOTE.length < INPUT_QUALITY_NOTE_SHORT_SEED.length,
  );
  check(
    "the copy lives in ui-prefs.ts so the three placements cannot drift",
    /INPUT_QUALITY_NOTE\b/.test(panel) && !panel.includes("Great files make great answers"),
    "the string itself must not be duplicated in the panel",
  );
}

console.log("\n=== PART 3: the reveal is a per-word stagger, not a typewriter ===");
{
  check("words are split and wrapped individually", /INPUT_QUALITY_NOTE\.split\(/.test(panel));
  check("each word gets its own delay", /--word-delay/.test(panel) && /--word-delay/.test(splashCss));
  check("the stagger constant is defined once", /SPLASH_WORD_STAGGER_MS = \d+/.test(panel));
  check(
    "whole words animate (a typewriter would emit characters)",
    !/split\(""\)/.test(panel) && /split\(\/\\s\+\//.test(panel),
    "per-character reveal delays comprehension until the sentence completes",
  );
  check("only opacity/transform animate, so there is no per-frame layout", /@keyframes splash-note-word/.test(splashCss));
  const keyframe = splashCss.slice(splashCss.indexOf("@keyframes splash-note-word"));
  check(
    "the keyframe touches neither width nor height",
    !/width:|height:/.test(keyframe.slice(0, 220)),
  );
}

console.log("\n=== PART 3: it must NOT delay or block the splash ===");
{
  // The splash's own timers must be untouched by the reveal.
  check("SPLASH_MIN_MS is unchanged at 3800", /SPLASH_MIN_MS = 3800/.test(panel));
  check("SPLASH_MAX_MS is unchanged at 6000", /SPLASH_MAX_MS = 6000/.test(panel));

  // The reveal must not await anything between words, and must not push the
  // dismissal out with a timer of its own.
  // The word-building loop itself: from the split to the end of forEach.
  const revealBlock = panelCode.slice(
    panelCode.indexOf("const words = INPUT_QUALITY_NOTE.split"),
    panelCode.indexOf("const revealNoteImmediately"),
  );
  check("the word loop was located", revealBlock.length > 0 && revealBlock.includes("noteText.append"));
  check("it contains no await between words", !/await/.test(revealBlock), "an await per word would gate the intro");
  check("it sets no timer", !/setTimeout|setInterval/.test(revealBlock));
  check(
    "the stagger is expressed as a CSS delay, not JS scheduling",
    /animation-delay: calc\(/.test(splashCss),
  );

  // dismissSplash must be synchronous up to the point it notifies subscribers —
  // nothing there may await the reveal.
  const dismissBody = panelCode.slice(
    panelCode.indexOf("function dismissSplash(): void {"),
    panelCode.indexOf("window.setTimeout(dismissSplash"),
  );
  check("dismissSplash notifies subscribers", /splashSkipListeners\.forEach/.test(dismissBody));
  check("and dismissSplash awaits nothing", !/await/.test(dismissBody), "the intro must never wait on the notice");
}

console.log("\n=== PART 3: a SKIP lands the full line immediately ===");
{
  check("a skip hook exists", /function onSplashSkipped\(/.test(panel));
  check("the reveal subscribes to it", /onSplashSkipped\(revealNoteImmediately\)/.test(panel));
  check("dismissSplash notifies subscribers", /splashSkipListeners\.forEach\(\(listener\) => listener\(\)\)/.test(panel));
  check(
    "it notifies BEFORE the fade starts, so the text is visible during the fade",
    panel.indexOf("splashSkipListeners.forEach") < panel.indexOf('splash.classList.add("splash--hide")'),
  );
  check(
    "a late subscriber still gets the full text (splash already gone)",
    /if \(splashDismissed\) listener\(\);/.test(panel),
  );
  check("the revealed state overrides every per-word delay", /\.splash__note--revealed \.splash__note-word/.test(splashCss));
  const revealed = splashCss.slice(splashCss.indexOf(".splash__note--revealed"));
  check("and it sets animation: none with full opacity", /animation: none;[\s\S]{0,80}opacity: 1;/.test(revealed));
}

console.log("\n=== PART 3: prefers-reduced-motion shows the text at once ===");
{
  const reducedBlocks = splashCss.split("@media (prefers-reduced-motion: reduce)").slice(1).join("\n");
  check("a reduced-motion block exists", reducedBlocks.length > 0);
  check("the per-word animation is disabled there", /\.splash__note-word\s*\{[^}]*animation: none/.test(reducedBlocks));
  check("with full opacity, so nothing is left invisible", /\.splash__note-word\s*\{[^}]*opacity: 1/.test(reducedBlocks));
  check("and no transform offset remains", /\.splash__note-word\s*\{[^}]*transform: none/.test(reducedBlocks));
}

console.log("\n=== PART 3: it is still announced to assistive tech ===");
{
  check(
    "the notice keeps role=note",
    /id="splash-note"[^>]*role="note"/.test(html),
  );
  check(
    "⚠️ the splash is NOT blanket aria-hidden",
    !/<div id="splash"[^>]*aria-hidden/.test(html),
    "a blanket aria-hidden would hide the notice entirely",
  );
  check(
    "aria-hidden is on the decorative logo wrap only",
    /class="splash__logo-wrap" aria-hidden="true"/.test(html),
  );
  check("and on the decorative bars", /class="splash__bars" aria-hidden="true"/.test(html));
  check(
    "the split line is exposed as ONE label, not six fragments",
    /setAttribute\("aria-label", INPUT_QUALITY_NOTE\)/.test(panel),
    "a screen reader must not announce each word separately",
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
