import { dedupeByIdentity, accessibleNameFrom } from "./_bundle-identity.mjs";

let fails = 0;
const check = (name, cond, detail) => { if (!cond) fails++; console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const q = (text, key) => ({ questionText: text, identity: { key } });

console.log("\n=== STAGE 2b: identity-key dedup ===");

// The 59-field case: labels repeat per employment row but structure differs.
const repeated = [
  q("Employer", "0|form>div[1]>input|employer_1|employer"),
  q("Start date", "0|form>div[1]>input[2]|start_1|start date"),
  q("Employer", "0|form>div[2]>input|employer_2|employer"),
  q("Start date", "0|form>div[2]>input[2]|start_2|start date"),
];
let r = dedupeByIdentity(repeated);
check("repeated LABELS with distinct structure are all kept", r.kept.length === 4,
  `kept ${r.kept.length}/4, removed ${r.removed.length}`);

// A genuinely duplicated field (same frame, same path, same name).
const trueDupes = [
  q("Email", "0|form>input|email|email"),
  q("Email", "0|form>input|email|email"),
  q("Email", "1|form>input|email|email"),
];
r = dedupeByIdentity(trueDupes);
check("identical identity keys collapse to one", r.kept.length === 2,
  `kept ${r.kept.length} (same-frame dupe removed, other frame retained)`);
check("removed entries are reported, not silently dropped", r.removed.length === 1,
  `removed=${r.removed.length}`);

// Same field, different frames → distinct.
r = dedupeByIdentity([q("Name", "0|form>input|n|name"), q("Name", "2|form>input|n|name")]);
check("same field in different frames stays distinct", r.kept.length === 2);

// Items with no identity are never dropped.
r = dedupeByIdentity([{ questionText: "A" }, { questionText: "A" }]);
check("items without an identity key are never collapsed", r.kept.length === 2);

console.log("\n=== STAGE 2b: accessible-name priority ===");
check("label[for] beats everything", accessibleNameFrom({
  labelFor: "Legal name", ariaLabel: "name", placeholder: "Enter name", nearbyText: "Section 3",
}).from === "labelFor");
check("aria-label beats aria-labelledby", accessibleNameFrom({
  ariaLabel: "Phone", ariaLabelledBy: "Contact",
}).from === "ariaLabel");
check("legend beats placeholder", accessibleNameFrom({
  legend: "Employment history", placeholder: "MM/YYYY",
}).from === "legend");
check("nearby text is only used when nothing else exists", accessibleNameFrom({
  nearbyText: "Previous field label",
}).from === "nearbyText");
check("whitespace is collapsed", accessibleNameFrom({ labelFor: "  Full   name \n" }).name === "Full name",
  JSON.stringify(accessibleNameFrom({ labelFor: "  Full   name \n" }).name));
check("no sources → empty", accessibleNameFrom({}).from === "none");

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
