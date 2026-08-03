// STAGE 2a — all_frames scanning: merge/ordering, cross-frame dedup, registry
// lifecycle, and inaccessible-frame classification.
//
// Everything here runs on SYNTHETIC frame trees and SYNTHETIC per-frame field
// data — the shapes the content script sends, not captured markup. No DOM
// fixtures are invented: guessed markup would validate the guess rather than
// the code, and real captured markup is due in a later session.
import {
  mergeFrameScans,
  resolveFramePlacements,
  classifyInaccessibleFrame,
  patternCoversUrl,
  FrameRegistry,
} from "./_bundle-frames.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── builders ─────────────────────────────────────────────────────────────
const frame = (frameId, parentFrameId, url, errorOccurred = false) => ({
  frameId,
  parentFrameId,
  url,
  errorOccurred,
});

const question = (text, order, key, extra = {}) => ({
  questionText: text,
  type: "short_answer",
  options: [],
  required: false,
  order,
  identityKey: key,
  ...extra,
});

const iframeRef = (iframeIndex, src, order, sandbox = null) => ({
  iframeIndex,
  src,
  order,
  sandbox,
  hasSrcdoc: false,
});

const scan = (frameId, url, questions, childFrames = [], overrides = {}) => ({
  frameId,
  url,
  adapter: "generic",
  formTitle: `title-${frameId}`,
  sectionTitle: null,
  hasNext: false,
  langHint: null,
  questions,
  childFrames,
  selfIframeIndex: null,
  fingerprint: `fp-${frameId}`,
  ...overrides,
});

const texts = (merged) => merged.questions.map((q) => q.questionText);

// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== STAGE 2a: cross-frame ordering ===");

// The Workday shape: page chrome in the top frame, the application form in a
// cross-origin child. The child's questions must land WHERE ITS IFRAME SITS,
// between the parent's own fields — not appended after them.
{
  const tree = [
    frame(0, -1, "https://portal.example/apply"),
    frame(1, 0, "https://vendor.example/form"),
  ];
  const scans = new Map([
    [
      0,
      scan(
        0,
        "https://portal.example/apply",
        [question("Full name", 0, "0|a"), question("Phone", 2, "0|b")],
        [iframeRef(0, "https://vendor.example/form", 1)],
      ),
    ],
    [1, scan(1, "https://vendor.example/form", [question("Work history", 0, "1|c")])],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });

  check(
    "a cross-origin child's fields are spliced in at its <iframe>'s position",
    JSON.stringify(texts(merged)) === JSON.stringify(["Full name", "Work history", "Phone"]),
    JSON.stringify(texts(merged)),
  );
  check(
    "cross-origin placement is resolved by matching parent src against frame url",
    merged.placements.find((p) => p.frameId === 1)?.method === "src-match",
    merged.placements.find((p) => p.frameId === 1)?.method,
  );
  check("a resolvable tree produces no ordering warnings", merged.orderingWarnings.length === 0);
}

// window.frameElement is EXACT and must beat src matching — which is the only
// thing that can disambiguate two sibling iframes sharing one src.
{
  const tree = [
    frame(0, -1, "https://app.example/"),
    frame(1, 0, "https://app.example/step"),
    frame(2, 0, "https://app.example/step"),
  ];
  const scans = new Map([
    [
      0,
      scan(
        0,
        "https://app.example/",
        [],
        [iframeRef(0, "https://app.example/step", 0), iframeRef(1, "https://app.example/step", 1)],
      ),
    ],
    [1, scan(1, "https://app.example/step", [question("Second box", 0, "1|x")], [], { selfIframeIndex: 1 })],
    [2, scan(2, "https://app.example/step", [question("First box", 0, "2|y")], [], { selfIframeIndex: 0 })],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });

  check(
    "window.frameElement resolves siblings that share one src, and wins over src matching",
    JSON.stringify(texts(merged)) === JSON.stringify(["First box", "Second box"]),
    JSON.stringify(texts(merged)),
  );
  check(
    "the exact path is reported as frame-element, not src-match",
    merged.placements.filter((p) => p.method === "frame-element").length === 2,
  );
}

// THE KNOWN FAILURE MODE. A frame that redirects after load has a url that no
// longer matches the src its parent still advertises. Nothing can bridge that
// from outside, so the merge must SAY the order is uncertain rather than emit
// a confident wrong one — and must still report every field.
{
  const tree = [frame(0, -1, "https://portal.example/"), frame(1, 0, "https://sso.other.example/session/abc")];
  const scans = new Map([
    [
      0,
      scan(
        0,
        "https://portal.example/",
        [question("Name", 0, "0|a")],
        [iframeRef(0, "https://vendor.example/start", 1)],
      ),
    ],
    [1, scan(1, "https://sso.other.example/session/abc", [question("Redirected field", 0, "1|b")])],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });

  check(
    "a redirected frame cannot be placed and is reported as unresolved",
    merged.placements.find((p) => p.frameId === 1)?.method === "unresolved",
  );
  check(
    "an unplaceable frame produces an explicit ordering warning, not silence",
    merged.orderingWarnings.length === 1 && /redirect/.test(merged.orderingWarnings[0]),
    merged.orderingWarnings[0],
  );
  check(
    "an unplaceable frame's fields are still reported, appended after its parent's",
    JSON.stringify(texts(merged)) === JSON.stringify(["Name", "Redirected field"]),
    JSON.stringify(texts(merged)),
  );
}

// Ambiguity must not be resolved by falling through to a looser URL tier.
{
  const tree = [frame(0, -1, "https://a.example/"), frame(1, 0, "https://b.example/x?token=1")];
  const scans = new Map([
    [
      0,
      scan(0, "https://a.example/", [], [iframeRef(0, "https://b.example/x?token=9", 0), iframeRef(1, "https://b.example/x?token=8", 1)]),
    ],
    [1, scan(1, "https://b.example/x?token=1", [question("Which one?", 0, "1|a")])],
  ]);
  const { placements, warnings } = resolveFramePlacements(tree, scans);
  check(
    "two sibling iframes matching only at a loose tier are ambiguous, not guessed",
    placements.find((p) => p.frameId === 1)?.method === "unresolved",
  );
  check("the ambiguity is stated in the warnings", /apart|share/.test(warnings[0] ?? ""), warnings[0]);
}

// Depth-2 nesting: a frame inside a frame inside the page.
{
  const tree = [
    frame(0, -1, "https://p.example/"),
    frame(1, 0, "https://mid.example/"),
    frame(2, 1, "https://deep.example/"),
  ];
  const scans = new Map([
    [0, scan(0, "https://p.example/", [question("Top", 0, "0|a")], [iframeRef(0, "https://mid.example/", 1)])],
    [1, scan(1, "https://mid.example/", [question("Middle", 0, "1|a")], [iframeRef(0, "https://deep.example/", 1)])],
    [2, scan(2, "https://deep.example/", [question("Deep", 0, "2|a")])],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });
  check(
    "nested frames flatten depth-first in reading order",
    JSON.stringify(texts(merged)) === JSON.stringify(["Top", "Middle", "Deep"]),
    JSON.stringify(texts(merged)),
  );
  check("depth is recorded per frame", merged.frames.find((f) => f.frameId === 2)?.depth === 2);
}

// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== STAGE 2a: dedup across frames ===");

// Two frames, identical LABELS, distinct structure. Both are real fields.
// Collapsing them is the 59-field bug wearing a different hat.
{
  const tree = [frame(0, -1, "https://x.example/"), frame(1, 0, "https://y.example/f"), frame(2, 0, "https://z.example/f")];
  const scans = new Map([
    [
      0,
      scan(0, "https://x.example/", [], [iframeRef(0, "https://y.example/f", 0), iframeRef(1, "https://z.example/f", 1)]),
    ],
    [1, scan(1, "https://y.example/f", [question("Email address", 0, "1|form>input|email|email address")])],
    [2, scan(2, "https://z.example/f", [question("Email address", 0, "2|form>input|email|email address")])],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });
  check(
    "identically-labelled fields in DIFFERENT frames are both kept",
    merged.questions.length === 2 && merged.duplicatesCollapsed.length === 0,
    `kept ${merged.questions.length}, collapsed ${merged.duplicatesCollapsed.length}`,
  );
  check(
    "each kept field knows which frame it came from",
    merged.questions[0]?.frameId === 1 && merged.questions[1]?.frameId === 2,
  );
}

// A genuinely duplicated field (same frame, same identity key) still collapses.
{
  const tree = [frame(0, -1, "https://x.example/")];
  const scans = new Map([
    [
      0,
      scan(0, "https://x.example/", [
        question("Email", 0, "0|form>input|email|email"),
        question("Email", 1, "0|form>input|email|email"),
      ]),
    ],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });
  check(
    "a true duplicate within one frame still collapses on the identity key",
    merged.questions.length === 1 && merged.duplicatesCollapsed.length === 1,
    `kept ${merged.questions.length}, collapsed ${merged.duplicatesCollapsed.length}`,
  );
  check(
    "what was collapsed is reported, not silently dropped",
    merged.duplicatesCollapsed[0]?.questionText === "Email" && merged.duplicatesCollapsed[0]?.frameId === 0,
  );
}

// Repeated portal rows: same label, same frame, distinct structure — kept.
{
  const tree = [frame(0, -1, "https://x.example/")];
  const scans = new Map([
    [
      0,
      scan(0, "https://x.example/", [
        question("Employer", 0, "0|form>div[1]>input|employer_1|employer"),
        question("Employer", 1, "0|form>div[2]>input|employer_2|employer"),
      ]),
    ],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });
  check("repeated row labels with distinct structure survive the merge", merged.questions.length === 2);
}

// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== STAGE 2a: manual-only and nav routing survive the merge ===");

{
  const tree = [frame(0, -1, "https://x.example/"), frame(1, 0, "https://y.example/f")];
  const scans = new Map([
    [
      0,
      scan(
        0,
        "https://x.example/",
        [question("Password", 0, "0|p", { manualOnly: true, manualReason: "password field" })],
        [iframeRef(0, "https://y.example/f", 1)],
        { hasNext: true },
      ),
    ],
    [1, scan(1, "https://y.example/f", [question("Given name", 0, "1|g")], [], { hasNext: true })],
  ]);
  const merged = mergeFrameScans({ tree, scans, inaccessible: [] });

  const password = merged.questions.find((q) => q.questionText === "Password");
  check("manualOnly survives per-frame merging", password?.manualOnly === true);
  check("the manual reason survives too", password?.manualReason === "password field");
  check(
    "per-frame coverage counts manual-only fields",
    merged.frames.find((f) => f.frameId === 0)?.manualOnlyCount === 1,
  );
  check(
    "nav is routed to the frame that owns the fields, not just any frame with a Next",
    merged.navFrameId === 1,
    `navFrameId=${merged.navFrameId}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== STAGE 2a: inaccessible frames are recorded, never omitted ===");

{
  const tree = [frame(0, -1, "https://x.example/"), frame(1, 0, "https://y.example/f")];
  const scans = new Map([[0, scan(0, "https://x.example/", [question("Name", 0, "0|a")], [iframeRef(0, "https://y.example/f", 1)])]]);
  const blocked = [
    {
      frameId: 1,
      parentFrameId: 0,
      url: "https://y.example/f",
      reason: "no-host-access",
      detail: "no host access",
      retryable: true,
    },
  ];
  const merged = mergeFrameScans({ tree, scans, inaccessible: blocked });
  const row = merged.frames.find((f) => f.frameId === 1);
  check("a silent frame still appears in the per-frame breakdown", Boolean(row));
  check("it is marked unscanned with a reason", row?.scanned === false && row?.inaccessibleReason === "no-host-access");
  check("frames-found counts it", merged.frames.length === 2);
}

{
  const sandboxed = classifyInaccessibleFrame({
    entry: frame(1, 0, "about:blank"),
    ref: iframeRef(0, "", 0, "allow-forms allow-same-origin"),
    timedOut: true,
  });
  check(
    "a sandbox without allow-scripts is detected",
    sandboxed.reason === "sandboxed-without-allow-scripts",
    sandboxed.reason,
  );
  check("and is NOT retried forever", sandboxed.retryable === false);

  const scriptable = classifyInaccessibleFrame({
    entry: frame(1, 0, "https://y.example/"),
    ref: iframeRef(0, "https://y.example/", 0, "allow-scripts allow-forms"),
    timedOut: true,
  });
  check(
    "a sandbox WITH allow-scripts is not blamed on the sandbox",
    scriptable.reason === "scan-timeout",
    scriptable.reason,
  );

  const errored = classifyInaccessibleFrame({ entry: frame(2, 0, "https://z.example/", true), ref: null, timedOut: true });
  check("a frame the browser failed to load is reported as a load error", errored.reason === "load-error");

  const ungranted = classifyInaccessibleFrame({
    entry: frame(3, 0, "https://vendor.example/f"),
    ref: null,
    grantedOrigins: ["https://portal.example/*"],
    timedOut: true,
  });
  check("a frame on an ungranted origin is reported as such", ungranted.reason === "no-host-access", ungranted.reason);

  const granted = classifyInaccessibleFrame({
    entry: frame(3, 0, "https://vendor.example/f"),
    ref: null,
    grantedOrigins: ["https://*/*"],
    timedOut: true,
  });
  check("a wildcard grant is not misreported as missing access", granted.reason === "scan-timeout", granted.reason);

  const unknown = classifyInaccessibleFrame({ entry: frame(4, 0, "https://q.example/"), ref: null, timedOut: false });
  check("a silent frame with no other explanation says so plainly", unknown.reason === "no-content-script");
}

// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== TASK D: host-permission matching is PATH-sensitive ===");

// THE launch-blocker case. Static access is now the narrow
// `https://docs.google.com/forms/*`, which does NOT cover the Drive-picker
// child frame at /picker. An origin-only check would call that covered, report
// its silence as "no-content-script", and bury the one actionable message.
{
  const granted = ["https://docs.google.com/forms/*", "https://generativelanguage.googleapis.com/*"];
  check(
    "the narrow static grant covers a Forms page",
    patternCoversUrl("https://docs.google.com/forms/d/e/abc/viewform", granted) === true,
  );
  check(
    "but NOT docs.google.com/picker — the path matters",
    patternCoversUrl("https://docs.google.com/picker?protocol=gadgets", granted) === false,
  );
  check(
    "and NOT Docs, Sheets or Drive",
    patternCoversUrl("https://docs.google.com/document/d/abc/edit", granted) === false &&
      patternCoversUrl("https://docs.google.com/spreadsheets/d/abc", granted) === false,
  );
}

{
  const granted = ["https://docs.google.com/forms/*"];
  const picker = classifyInaccessibleFrame({
    entry: frame(2, 0, "https://docs.google.com/picker?protocol=gadgets"),
    ref: null,
    grantedOrigins: granted,
    timedOut: true,
  });
  check(
    "an ungranted same-origin child frame is reported as no-host-access, not silently omitted",
    picker.reason === "no-host-access",
    picker.reason,
  );
  check("and the reason is actionable", /Grant access/.test(picker.detail), picker.detail);
  check("and it is retryable once granted", picker.retryable === true);
}

{
  // Once the user grants the broader origin at runtime, the same frame stops
  // being reported as a permission problem.
  const afterGrant = classifyInaccessibleFrame({
    entry: frame(2, 0, "https://docs.google.com/picker?protocol=gadgets"),
    ref: null,
    grantedOrigins: ["https://docs.google.com/forms/*", "https://docs.google.com/*"],
    timedOut: true,
  });
  check(
    "after a runtime grant it is no longer blamed on permissions",
    afterGrant.reason === "scan-timeout",
    afterGrant.reason,
  );
}

{
  check("<all_urls> covers everything", patternCoversUrl("https://anything.example/x", ["<all_urls>"]) === true);
  check("https://*/* covers any https URL", patternCoversUrl("https://vendor.example/apply", ["https://*/*"]) === true);
  check("https://*/* does NOT cover http", patternCoversUrl("http://vendor.example/apply", ["https://*/*"]) === false);
  check(
    "a *.suffix host pattern covers subdomains and the bare domain",
    patternCoversUrl("https://jobs.workday.com/a", ["https://*.workday.com/*"]) === true &&
      patternCoversUrl("https://workday.com/a", ["https://*.workday.com/*"]) === true,
  );
  check(
    "but not an unrelated host that merely ends similarly",
    patternCoversUrl("https://notworkday.com/a", ["https://*.workday.com/*"]) === false,
  );
  check(
    "a port on the frame URL doesn't defeat the match",
    patternCoversUrl("https://vendor.example:8443/apply", ["https://vendor.example/*"]) === true,
  );
  check(
    "about:blank inherits its parent's access rather than demanding its own grant",
    patternCoversUrl("about:blank", ["https://docs.google.com/forms/*"]) === true,
  );
}

console.log("\n=== STAGE 2a: registry lifecycle ===");

{
  const registry = new FrameRegistry();

  // FRAME ADDED
  registry.noteHello(7, 0, "https://x.example/");
  registry.noteHello(7, 1, "https://y.example/f");
  registry.reconcile(7, [frame(0, -1, "https://x.example/"), frame(1, 0, "https://y.example/f")]);
  registry.recordScan(7, 1, scan(1, "https://y.example/f", [question("A", 0, "1|a")]));
  check("a frame that said hello and scanned is in the registry", registry.scans(7).size === 1);
  check("its parent link comes from the browser's tree", registry.get(7, 1)?.parentFrameId === 0);
  check("an answer scanned at the current generation is accepted", registry.isCurrent(7, 1, 0).ok === true);

  // FRAME NAVIGATED
  registry.noteNavigated(7, 1, "https://y.example/step2");
  check("navigation drops the cached scan", registry.get(7, 1)?.scan === null);
  check("navigation bumps the generation", registry.get(7, 1)?.generation === 1);
  const stale = registry.isCurrent(7, 1, 0);
  check("an answer from the previous generation is refused", stale.ok === false);
  check("and the refusal says why", /navigated/.test(stale.reason ?? ""), stale.reason);
  check("an answer from the new generation is accepted", registry.isCurrent(7, 1, 1).ok === true);

  // FRAME REMOVED
  registry.recordScan(7, 1, scan(1, "https://y.example/step2", [question("B", 0, "1|b")]));
  const { removed } = registry.reconcile(7, [frame(0, -1, "https://x.example/")]);
  check("a frame missing from the tree is reported as removed", removed.length === 1 && removed[0].frameId === 1);
  check("the removal notes that it had scanned fields", removed[0].hadScan === true);
  check("it is dropped from the registry", registry.get(7, 1) === undefined);
  const gone = registry.isCurrent(7, 1, 1);
  check("pending answers for a removed frame are refused with a clear reason", gone.ok === false && /no longer exists/.test(gone.reason ?? ""), gone.reason);

  // TAB CLOSED
  registry.removeTab(7);
  check("closing the tab clears its frames", registry.all(7).length === 0);
}

console.log("\n=== B5: generation counters survive a worker restart ===");

{
  // MV3 kills the worker after ~30s idle. Cached scans don't matter (every
  // scan re-enumerates), but the generation counters are the stale-fill guard.
  const before = new FrameRegistry();
  before.reconcile(9, [frame(0, -1, "https://x.example/"), frame(1, 0, "https://y.example/f")]);
  before.noteNavigated(9, 1, "https://y.example/step2");
  before.noteNavigated(9, 1, "https://y.example/step3");
  const exported = before.exportGenerations();
  check("counters are exported per tab and frame", exported[9]?.[1] === 2, JSON.stringify(exported));
  check("frames still at generation 0 are not persisted (nothing to restore)", exported[9]?.[0] === undefined);

  // A brand-new registry, as after a worker restart.
  const after = new FrameRegistry();
  check(
    "WITHOUT restoring, an answer from generation 2 looks stale",
    after.isCurrent(9, 1, 2).ok === false,
    "safe but lossy — it degrades to the FIX 1 strict label path",
  );
  after.importGenerations(exported);
  check("after restoring, that same answer is accepted again", after.isCurrent(9, 1, 2).ok === true);
  check("and a genuinely older answer is still refused", after.isCurrent(9, 1, 1).ok === false);
}

{
  // A restore must never LOWER a counter this worker instance already advanced:
  // its own observation is newer than anything on disk.
  const registry = new FrameRegistry();
  registry.reconcile(9, [frame(0, -1, "https://x.example/"), frame(1, 0, "https://y.example/f")]);
  registry.noteNavigated(9, 1, "https://y.example/a");
  registry.noteNavigated(9, 1, "https://y.example/b");
  registry.noteNavigated(9, 1, "https://y.example/c"); // live count = 3
  registry.importGenerations({ 9: { 1: 1 } }); // stale value from storage
  check(
    "a stale stored counter never rolls a live one backwards",
    registry.get(9, 1)?.generation === 3,
    `generation=${registry.get(9, 1)?.generation}`,
  );
  check("so a genuinely stale answer stays refused", registry.isCurrent(9, 1, 1).ok === false);
}

{
  const registry = new FrameRegistry();
  registry.importGenerations({ notanumber: { 1: 2 } });
  registry.importGenerations({ 9: { bad: 2 } });
  registry.importGenerations({ 9: { 1: "nope" } });
  check("malformed stored data is ignored rather than throwing", registry.all(9).length <= 1);
}

// Generations reach the merged questions, so the sidepanel can compare them.
{
  const registry = new FrameRegistry();
  registry.reconcile(3, [frame(0, -1, "https://x.example/")]);
  registry.noteNavigated(3, 0, "https://x.example/two");
  registry.recordScan(3, 0, scan(0, "https://x.example/two", [question("A", 0, "0|a")]));
  const merged = mergeFrameScans({
    tree: [frame(0, -1, "https://x.example/two")],
    scans: registry.scans(3),
    inaccessible: [],
    generations: registry.generations(3),
  });
  check("merged questions carry the frame generation they were scanned at", merged.questions[0]?.frameGeneration === 1, String(merged.questions[0]?.frameGeneration));
  check("merged questions carry their frame's url", merged.questions[0]?.frameUrl === "https://x.example/two");
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
