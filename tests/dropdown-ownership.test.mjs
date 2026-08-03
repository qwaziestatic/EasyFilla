// ─────────────────────────────────────────────────────────────────────────
// PART 1 — THE FIRST LIVE DROPDOWN FAILURE (2026-07-30)
//
// Observed on a real form:
//   failed — "Current Academic Year or Employment Tenure": clicked "4+ Years"
//            but the control still shows "Choose"
//   failed — "PrimarField of Studyor Department": clicked "ECE" but the control
//            still shows "Choose"
//
// The listbox opened, options were found, text matched, a click was dispatched,
// and the selection never committed.
//
// ⚠️ WHAT THIS SUITE CAN AND CANNOT PROVE.
// No browser and no jsdom is available (no DOM library is installed). These
// tests use a small hand-built DOM stub implementing exactly the methods the
// ownership resolver touches. They therefore prove the DECISION LOGIC: given a
// two-dropdown layout, which listbox is treated as the owner, and whether a
// wrong-widget option is refused. They CANNOT prove that a real browser commits
// the selection — that stays unverified until the next live run (§7b).
// ─────────────────────────────────────────────────────────────────────────
import {
  resolveOwningListbox,
  optionsWithin,
  optionBelongsToListbox,
  describeOwnership,
} from "./_bundle-listbox-ownership.mjs";
import { CLICK_EVENT_SEQUENCE } from "./_bundle-filler.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── A minimal DOM stub ───────────────────────────────────────────────────
// Only what the resolver uses: getAttribute, querySelectorAll, contains, and
// document.getElementById. Selector support is limited to the two attribute
// selectors the resolver passes, which is all that is needed and keeps the stub
// honest about its scope.
class El {
  constructor(attrs = {}, children = []) {
    this.attrs = attrs;
    this.children = children;
    children.forEach((child) => {
      child.parent = this;
    });
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  get descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants]);
  }
  querySelectorAll(selector) {
    const role = /^\[role="([^"]+)"\]$/.exec(selector);
    if (!role) throw new Error(`stub does not support selector: ${selector}`);
    return this.descendants.filter((node) => node.getAttribute("role") === role[1]);
  }
  contains(other) {
    return other === this || this.descendants.includes(other);
  }
}

class Doc {
  constructor(root) {
    this.root = root;
  }
  getElementById(id) {
    return [this.root, ...this.root.descendants].find((node) => node.getAttribute("id") === id) ?? null;
  }
  querySelectorAll(selector) {
    return this.root.querySelectorAll(selector);
  }
}

const option = (id, label) => new El({ role: "option", id, "aria-label": label });
const visible = () => true;

/**
 * THE SHAPE OF THE LIVE FAILURE: two dropdowns, both with their options present
 * in the document, and the wanted text living in the WRONG one.
 *
 * Question A = "Current Academic Year or Employment Tenure" (wants "4+ Years")
 * Question B = "PrimarField of Studyor Department"          (wants "ECE")
 *
 * `linked` controls whether the triggers carry an ownership relationship.
 */
function twoDropdownForm({ linked }) {
  const popupA = new El({ role: "listbox", id: "popup-A" }, [
    option("optA1", "1 Year"),
    option("optA2", "4+ Years"),
  ]);
  const popupB = new El({ role: "listbox", id: "popup-B" }, [
    option("optB1", "ECE"),
    option("optB2", "Mechanical"),
  ]);
  const triggerA = new El(linked ? { role: "listbox", id: "trigA", "aria-controls": "popup-A" } : { role: "listbox", id: "trigA" });
  const triggerB = new El(linked ? { role: "listbox", id: "trigB", "aria-controls": "popup-B" } : { role: "listbox", id: "trigB" });
  // Popups render OUTSIDE the question cards — that is the DOM reality (§4).
  const body = new El({ role: "main" }, [
    new El({ role: "listitem" }, [triggerA]),
    new El({ role: "listitem" }, [triggerB]),
    popupA,
    popupB,
  ]);
  return { doc: new Doc(body), triggerA, triggerB, popupA, popupB };
}

console.log("\n=== PART 1b: ownership is resolved from the trigger, in priority order ===");
{
  const { doc, triggerA, popupA } = twoDropdownForm({ linked: true });
  const resolved = resolveOwningListbox(triggerA, doc);
  check("aria-controls wins", resolved.source === "aria-controls", describeOwnership(resolved));
  check("and resolves to the right popup", resolved.listbox === popupA);
  check("it is trusted", resolved.trusted === true);

  // aria-owns is the same relationship, older spelling.
  const owns = resolveOwningListbox(new El({ "aria-owns": "popup-B" }), doc);
  check("aria-owns is honoured when aria-controls is absent", owns.source === "aria-owns" && owns.trusted === true);

  // A dangling IDREF must NOT silently fall through to a guess — the author
  // stated a relationship and it is broken; that is worth surfacing.
  const dangling = resolveOwningListbox(new El({ "aria-controls": "does-not-exist" }), doc);
  check("a dangling IDREF is reported, not silently ignored", dangling.trusted === false);
  check("and names the broken reference", /dangling IDREF/.test(dangling.detail), dangling.detail);
  check("and yields no listbox to click into", dangling.listbox === null);
}

console.log("\n=== PART 1b: aria-expanded is used only when it is UNAMBIGUOUS ===");
{
  // Exactly one popup open → that is the owner.
  const popupOpen = new El({ role: "listbox", id: "open", "aria-expanded": "true" }, [option("o1", "4+ Years")]);
  const popupShut = new El({ role: "listbox", id: "shut", "aria-expanded": "false" }, [option("o2", "ECE")]);
  const body = new El({ role: "main" }, [popupOpen, popupShut]);
  const one = resolveOwningListbox(new El({}), new Doc(body));
  check("one expanded listbox → it owns the options", one.source === "aria-expanded" && one.listbox === popupOpen);
  check("and it is trusted", one.trusted === true);

  // TWO open popups → refuse. Guessing here is exactly how the wrong widget
  // gets clicked, which is the bug being fixed.
  const bothOpen = new El({ role: "main" }, [
    new El({ role: "listbox", id: "a", "aria-expanded": "true" }, [option("x", "4+ Years")]),
    new El({ role: "listbox", id: "b", "aria-expanded": "true" }, [option("y", "ECE")]),
  ]);
  const ambiguous = resolveOwningListbox(new El({}), new Doc(bothOpen));
  check("⚠️ two expanded listboxes → REFUSES to guess", ambiguous.listbox === null && ambiguous.trusted === false);
  check("and says why", /ambiguous/i.test(ambiguous.detail), ambiguous.detail);
}

console.log("\n=== PART 1b: aria-activedescendant locates the owning listbox ===");
{
  const target = option("live-opt", "4+ Years");
  const popup = new El({ role: "listbox", id: "p" }, [target]);
  const other = new El({ role: "listbox", id: "q" }, [option("z", "ECE")]);
  const body = new El({ role: "main" }, [popup, other]);
  const resolved = resolveOwningListbox(new El({ "aria-activedescendant": "live-opt" }), new Doc(body));
  check("the listbox containing the active option is the owner", resolved.listbox === popup);
  check("source is recorded", resolved.source === "aria-activedescendant" && resolved.trusted === true);
}

console.log("\n=== PART 1b: the trigger may own its options directly ===");
{
  // Google Forms' trigger itself carries role="listbox".
  const trigger = new El({ role: "listbox", id: "t" }, [option("i", "4+ Years")]);
  const resolved = resolveOwningListbox(trigger, new Doc(new El({ role: "main" }, [trigger])));
  check("a trigger holding options owns them", resolved.source === "self" && resolved.listbox === trigger);
}

console.log("\n=== PART 1b: THE REGRESSION — the right text in the WRONG listbox ===");
{
  // This is the live failure, reproduced as a decision problem.
  const { doc, triggerA, popupA, popupB } = twoDropdownForm({ linked: true });

  // Question A wants "4+ Years". A DOCUMENT-WIDE scan sees every option in the
  // page, including question B's — which is what the old code did.
  const documentWide = doc.querySelectorAll('[role="option"]');
  check(
    "a document-wide scan sees options from BOTH dropdowns",
    documentWide.length === 4,
    `${documentWide.length} options across the document`,
  );

  // Ownership-scoped lookup sees only question A's.
  const owned = optionsWithin(resolveOwningListbox(triggerA, doc).listbox, visible);
  check("the ownership-scoped lookup sees only this question's options", owned.length === 2);
  check(
    "and they are the RIGHT ones",
    owned.map((o) => o.getAttribute("aria-label")).join(",") === "1 Year,4+ Years",
    owned.map((o) => o.getAttribute("aria-label")).join(","),
  );
  check(
    "⚠️ question B's options are EXCLUDED, so 'ECE' cannot be clicked for question A",
    !owned.some((o) => o.getAttribute("aria-label") === "ECE"),
  );

  // The assertion that would have caught the failure: an option from the other
  // widget is not owned, and must be refused.
  const foreign = popupB.querySelectorAll('[role="option"]')[0];
  check(
    "⚠️ an option from ANOTHER widget is NOT owned by this trigger",
    optionBelongsToListbox(foreign, popupA) === false,
    "this is the check that turns a silent wrong-widget click into an explicit failure",
  );
  check("a genuinely owned option IS accepted", optionBelongsToListbox(popupA.querySelectorAll('[role="option"]')[1], popupA) === true);
  check("ownership against a null listbox is never assumed", optionBelongsToListbox(foreign, null) === false);
}

console.log("\n=== PART 1b: the document-wide fallback fires ONLY when unresolvable ===");
{
  // No aria-controls, no expanded listbox, no activedescendant, trigger empty.
  const { doc, triggerA } = twoDropdownForm({ linked: false });
  const resolved = resolveOwningListbox(triggerA, doc);
  check("ownership is UNRESOLVED", resolved.trusted === false && resolved.listbox === null);
  check("the source names the fallback", resolved.source === "document-wide-fallback", resolved.source);
  check("the reason is explicit about what was missing", /OWNERSHIP UNKNOWN/.test(resolved.detail), resolved.detail);
  check(
    "an unresolved owner yields no scoped options, forcing the caller to fall back",
    optionsWithin(resolved.listbox, visible).length === 0,
  );
  check("describeOwnership marks it UNRESOLVED for the log", /UNRESOLVED/.test(describeOwnership(resolved)));
}

console.log("\n=== PART 1c: the click dispatches the full event sequence ===");
{
  check(
    "the sequence is pointerdown → mousedown → pointerup → mouseup → click",
    CLICK_EVENT_SEQUENCE.join(",") === "pointerdown,mousedown,pointerup,mouseup,click",
    CLICK_EVENT_SEQUENCE.join(" → "),
  );
  check(
    "mousedown precedes click (many jsaction widgets commit on mousedown)",
    CLICK_EVENT_SEQUENCE.indexOf("mousedown") < CLICK_EVENT_SEQUENCE.indexOf("click"),
  );
  check(
    "pointerdown precedes mousedown, as a real pointer produces",
    CLICK_EVENT_SEQUENCE.indexOf("pointerdown") < CLICK_EVENT_SEQUENCE.indexOf("mousedown"),
  );
  check(
    "up events follow their down events",
    CLICK_EVENT_SEQUENCE.indexOf("pointerup") > CLICK_EVENT_SEQUENCE.indexOf("pointerdown") &&
      CLICK_EVENT_SEQUENCE.indexOf("mouseup") > CLICK_EVENT_SEQUENCE.indexOf("mousedown"),
  );

  // The event FIELDS are asserted against the source, because constructing a
  // real PointerEvent needs a DOM. This is weaker than a behavioural test and is
  // labelled as such — it guards against the fields being dropped again.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/content-scripts/google-forms/filler.ts", "utf8");
  const robust = source.slice(source.indexOf("function robustClick"), source.indexOf("function clickTargetsFor"));
  ["bubbles: true", "composed: true", "button: 0", "buttons: 1", "clientX", "clientY"].forEach((field) => {
    check(`robustClick sets ${field}`, robust.includes(field));
  });
  check("buttons returns to 0 on the up/click events", /buttons: 0/.test(robust), "a held button on mouseup is incoherent");
  check(
    "retry targets include the deepest text node and the [data-value]/[jsaction] ancestor",
    /deepest text-bearing/.test(source) && /\[data-value\],\[jsaction\]/.test(source),
  );
}

console.log("\n=== PART 1e: commit is verified on FOUR independent signals ===");
{
  const { anySignalConfirms, describeSignals } = await import("./_bundle-filler.mjs");
  const none = { triggerText: false, activeDescendant: false, ariaSelected: false, hiddenInput: false };

  check("no signal → not committed", anySignalConfirms(none) === false);
  check("and it reports 'none' for the log", describeSignals(none) === "none");

  // Each signal ALONE is sufficient. Google updates different ones depending on
  // build and timing; requiring all four would fail a genuine commit.
  ["triggerText", "activeDescendant", "ariaSelected", "hiddenInput"].forEach((signal) => {
    check(`${signal} alone confirms a commit`, anySignalConfirms({ ...none, [signal]: true }) === true);
    check(`and ${signal} is named in the report`, describeSignals({ ...none, [signal]: true }) === signal);
  });

  check(
    "several signals are all reported, so the log says what actually moved",
    describeSignals({ triggerText: true, activeDescendant: false, ariaSelected: true, hiddenInput: false }) ===
      "triggerText + ariaSelected",
  );
}

console.log("\n=== PART 1: the failure message names EVERY path attempted ===");
{
  // The live report said only 'clicked "4+ Years" but the control still shows
  // "Choose"', which read as though the keyboard path never ran. It did run —
  // the message just never mentioned it.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/content-scripts/google-forms/filler.ts", "utf8");
  const failure = source.slice(source.indexOf("no commit signal changed"), source.indexOf("no commit signal changed") + 600);
  check("the failure lists what was tried", /Tried: \$\{attempted\.join/.test(failure), "so a future report is diagnosable");
  check("it reports the ownership verdict", /describeOwnership\(ownership\)/.test(failure));
  check(
    "the keyboard attempt is recorded in that list",
    /attempted\.push\(\s*`keyboard: open → from index/.test(source),
    // Updated by PART 1e (2026-07-31). This previously asserted
    // "keyboard: focus listbox → ArrowDown ×N", which was the BUGGY sequence:
    // it arrowed on a CLOSED listbox, where the first press is consumed opening
    // it. The corrected path opens first, then moves RELATIVE to the currently
    // highlighted row — so the recorded message legitimately changed.
    "records the open step and the relative move, not a blind ArrowDown count",
  );
  check(
    "a wrong-widget match is refused with a distinct message",
    /in a listbox this question does not own/.test(source),
  );
  check(
    "and the document-wide fallback warns loudly when it fires",
    /DOCUMENT-WIDE OPTION FALLBACK/.test(source),
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
