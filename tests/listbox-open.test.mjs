// ─────────────────────────────────────────────────────────────────────────
// PART 1 — THE SECOND LIVE DROPDOWN FAILURE (2026-07-31)
//
// Live instrumentation:
//   "Amharic" was clicked and no commit signal changed. Tried: the option node
//   [pointerdown → mousedown → pointerup → mouseup → click]; its deepest
//   text-bearing descendant [same]; keyboard: focus listbox → ArrowDown ×1 →
//   Enter. Ownership: OWNED via self. The control still shows "Choose".
//
// CAUSE: Google Forms keeps [role="option"] in the DOM at ALL times, inside the
// listbox, even when CLOSED. The readiness poll waited for options to appear, so
// it succeeded on the first tick — before the widget opened — and every strategy
// then fired at inert nodes.
//
// The first assertion below is THE regression: finding options while
// aria-expanded="false" must NOT count as ready.
// ─────────────────────────────────────────────────────────────────────────
import {
  isListboxExpanded,
  isReadyForSelection,
  isPlaceholderOptionNode,
  selectableOptions,
  matchOption,
  currentSelectedIndex,
  keyboardPlanFor,
} from "./_bundle-listbox-selection.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A minimal option node: only getAttribute + textContent are read. */
const opt = (attrs = {}, text = "") => ({
  attrs,
  textContent: text,
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  },
});
const box = (expanded) => ({ getAttribute: (n) => (n === "aria-expanded" ? expanded : null) });

console.log("\n=== PART 1a: THE REGRESSION — options present ≠ ready ===");
{
  // Exactly the live DOM: a CLOSED listbox that already contains its options.
  const closedWithOptions = box("false");
  check(
    "⚠️ a CLOSED listbox holding options is NOT ready",
    isReadyForSelection(closedWithOptions, 12) === false,
    "this is the live failure: the old poll saw 12 options and proceeded immediately",
  );
  check("an OPEN listbox holding options IS ready", isReadyForSelection(box("true"), 12) === true);
  check(
    "an OPEN listbox with no options is not ready either",
    isReadyForSelection(box("true"), 0) === false,
    "openness alone is not enough — there must be something to pick",
  );
  check("a missing aria-expanded is treated as closed", isReadyForSelection(box(null), 12) === false);
  check("aria-expanded='false' is closed", isListboxExpanded(box("false")) === false);
  check("aria-expanded='true' is open", isListboxExpanded(box("true")) === true);
  check("a null listbox is closed, not a crash", isListboxExpanded(null) === false);
  check(
    "only the exact string 'true' counts",
    isListboxExpanded(box("TRUE")) === false && isListboxExpanded(box("1")) === false,
    "aria attributes are strings; a loose truthiness check would accept 'false'",
  );
}

console.log("\n=== PART 1c: the placeholder is excluded from matching AND counting ===");
{
  const placeholderByValue = opt({ "data-value": "" }, "Choose");
  const placeholderByText = opt({}, "Choose");
  const real = opt({ "data-value": "am" }, "Amharic");

  check("an empty data-value marks the placeholder", isPlaceholderOptionNode(placeholderByValue) === true);
  check("so does the word 'Choose' when data-value is absent", isPlaceholderOptionNode(placeholderByText) === true);
  check("'Select' and dashes are placeholders too", isPlaceholderOptionNode(opt({}, "Select")) === true && isPlaceholderOptionNode(opt({}, "—")) === true);
  check("a real option is not a placeholder", isPlaceholderOptionNode(real) === false);
  check(
    "an option whose TEXT is empty is a placeholder",
    isPlaceholderOptionNode(opt({ "data-value": "x" }, "   ")) === true,
  );

  const all = [placeholderByValue, real, opt({ "data-value": "en" }, "English")];
  check("selectableOptions drops it", selectableOptions(all).length === 2);
  check(
    "⚠️ and the surviving INDICES shift accordingly",
    selectableOptions(all).indexOf(real) === 0,
    "counting the placeholder would offset every keyboard press by one",
  );
  check("'Choose' can never be matched as an answer", matchOption(all, "Choose") === null);
}

console.log("\n=== PART 1c: matching is data-value FIRST, then text tiers, never fuzzy ===");
{
  const options = [
    opt({ "data-value": "" }, "Choose"),
    opt({ "data-value": "am" }, "Amharic"),
    // Internal double space: `labelOf` already trims, so LEADING/TRAILING
    // whitespace is absorbed by the exact-text tier. Only interior whitespace
    // actually reaches the normalizing tier — an earlier version of this test
    // used trailing spaces and proved nothing.
    opt({ "data-value": "en" }, "Riverton  City"),
    opt({ "data-value": "or" }, "Oromo"),
  ];

  const byValue = matchOption(options, "am");
  check("data-value wins", byValue?.strategy === "data-value" && byValue.index === 0, byValue?.strategy);
  check(
    "it is preferred because it is what Google submits",
    matchOption(options, "am").option.getAttribute("aria-label") === null,
    "matched on the value, not the rendered label",
  );

  const byExact = matchOption(options, "Amharic");
  check("exact text is next", byExact?.strategy === "exact-text" && byExact.index === 0);
  check("case-insensitive is third", matchOption(options, "amharic")?.strategy === "case-insensitive");
  check(
    "whitespace-normalized is last",
    matchOption(options, "Riverton City")?.strategy === "whitespace-normalized",
    "the option renders with an interior double space",
  );
  check(
    "trailing whitespace is absorbed earlier, by exact-text",
    matchOption(options, "Oromo  ")?.strategy === "exact-text",
    "labelOf trims, so only INTERIOR whitespace reaches the normalizing tier",
  );

  // The bar that must never move.
  check("⚠️ a near-miss is REFUSED, not guessed", matchOption(options, "Amharik") === null);
  check("a substring is refused", matchOption(options, "Amhar") === null);
  check("a superstring is refused", matchOption(options, "Amharic language") === null);
  check("an empty request is refused", matchOption(options, "   ") === null);
  check("indices are over SELECTABLE options only", matchOption(options, "Oromo")?.index === 2);
}

console.log("\n=== PART 1e: the corrected keyboard arithmetic ===");
{
  // The old code pressed ArrowDown (targetIndex + 1) times on a CLOSED listbox,
  // where the FIRST press is consumed OPENING it. The live run pressed
  // ArrowDown ×1 and landed on nothing.
  const options = [
    opt({ "data-value": "" }, "Choose"),
    opt({ "data-value": "am" }, "Amharic"),
    opt({ "data-value": "en" }, "English"),
    opt({ "data-value": "or" }, "Oromo"),
  ];

  check("nothing selected yet → current index is -1", currentSelectedIndex(options) === -1);
  const fromNothing = keyboardPlanFor(-1, 0);
  check(
    "from nothing to the FIRST option is one ArrowDown",
    fromNothing.key === "ArrowDown" && fromNothing.presses === 1,
    `${fromNothing.key} ×${fromNothing.presses}`,
  );

  const selected = [
    opt({ "data-value": "" }, "Choose"),
    opt({ "data-value": "am" }, "Amharic"),
    opt({ "data-value": "en", "aria-selected": "true" }, "English"),
    opt({ "data-value": "or" }, "Oromo"),
  ];
  check("a selected option is found at its SELECTABLE index", currentSelectedIndex(selected) === 1);

  const forward = keyboardPlanFor(1, 2);
  check("moving down is ArrowDown ×1", forward.key === "ArrowDown" && forward.presses === 1);
  const backward = keyboardPlanFor(2, 0);
  check(
    "⚠️ moving UP uses ArrowUp, not a wrap-around of ArrowDowns",
    backward.key === "ArrowUp" && backward.presses === 2,
    `${backward.key} ×${backward.presses}`,
  );
  check("already on target is zero presses", keyboardPlanFor(2, 2).presses === 0);
  check(
    "the plan is RELATIVE, so it never assumes the list starts at the top",
    keyboardPlanFor(5, 7).presses === 2 && keyboardPlanFor(7, 5).presses === 2,
  );
}

console.log("\n=== PART 1: the fill path opens BEFORE it searches ===");
{
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/content-scripts/google-forms/filler.ts", "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const fn = code.slice(code.indexOf("async function fillDropdown"));

  const openIdx = fn.indexOf("isListboxExpanded(listbox)");
  const optionsIdx = fn.indexOf("readOptions()");
  check("the open step exists", openIdx > -1);
  check("⚠️ options are read only AFTER the open poll", openIdx < optionsIdx, `open@${openIdx} < read@${optionsIdx}`);
  check(
    "failing to open is a DISTINCT failure reason",
    /could not open the dropdown/.test(code),
    "never again confused with 'clicked but did not commit'",
  );
  check(
    "the un-opened failure says nothing was clicked",
    /no wrong answer was selected/.test(code),
  );
  check("the open step has its own timeout constant", /LISTBOX_OPEN_TIMEOUT_MS = \d+/.test(code));
  check(
    "the keyboard path ensures the listbox is OPEN before arrowing",
    fn.indexOf("keyboardPlanFor") > fn.indexOf('key: "Enter", bubbles: true'),
    "the old code arrowed on a closed listbox, losing the first press to opening",
  );
  check("failure closes with Escape and restores focus (1f)", /const restore = \(\): void =>/.test(fn) && /previouslyFocused\?\.focus\?\.\(\)/.test(fn));
  check("aria-expanded is recorded before AND after the open step (1g)", /setExpanded\(expandedBefore/.test(fn));
  check(
    "the diagnostic block prints both values",
    /aria-expanded BEFORE open/.test(code) && /aria-expanded AFTER open/.test(code),
  );
  check(
    "and flags the never-opened case loudly",
    /NEVER OPENED — nothing inside it is interactive/.test(code),
  );
  check(
    "the virtualized-list scroller is still used for long lists",
    /findOptionWithScrolling\(question\.questionText/.test(fn),
    "country lists run 200+ entries and may not be in the DOM until scrolled",
  );
  check(
    "the document-wide fallback survives for portalled popups",
    /waitForOptionsIn\(question\.questionText/.test(fn),
  );
  check(
    "the stale comment claiming options do not exist until opened is gone",
    !/options DO NOT EXIST until the listbox is opened/.test(source),
    "the live run disproved it; leaving it would mislead the next session",
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
