import { assessEvidenceAgreement } from "./_bundle-agree.mjs";
let fails = 0;
const check = (name, cond, detail) => { if (!cond) fails++; console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const ev = (file, value) => ({ dossier_path: "x", source_filename: file, implied_value: value, snippet: "" });

console.log("\n=== STAGE 1: evidence agreement ===");
let r = assessEvidenceAgreement([
  ev("Jane_Doe_Resume_Updated.pdf", "Electrical and Computer Engineering"),
  ev("Jane_Doe_Personal_Reference_Sheet.pdf", "Electrical and Computer Engineering"),
]);
check("identical values across 2 files → agree", r.agree, `${r.groups.length} group(s)`);

// STAGE 0a: an acronym/expansion pair from DIFFERENT files only agrees when the
// dossier itself links them. Initials alone are not identity.
const DOSSIER_LINKING_ECE =
  '{"department":{"value":"Electrical and Computer Engineering (ECE)","source_filename":"sheet.pdf"}}';

r = assessEvidenceAgreement(
  [ev("resume.pdf", "ECE"), ev("sheet.pdf", "Electrical and Computer Engineering")],
  DOSSIER_LINKING_ECE,
);
check("acronym vs its expansion, dossier links them → agree", r.agree, `${r.groups.length} group(s)`);

r = assessEvidenceAgreement(
  [ev("resume.pdf", "ECE"), ev("other.pdf", "Electronics and Communication Engineering")],
  DOSSIER_LINKING_ECE,
);
check("ECE vs a DIFFERENT expansion sharing initials → CONFLICT", !r.agree,
  r.groups.map(g => `"${g.value}" (${g.files.join(",")})`).join(" vs "));

r = assessEvidenceAgreement([ev("resume.pdf", "ECE"), ev("sheet.pdf", "Electrical and Computer Engineering")], "");
check("acronym vs expansion, dossier does NOT link → CONFLICT (fails safe)", !r.agree,
  `${r.groups.length} group(s)`);

r = assessEvidenceAgreement([ev("sheet.pdf", "ECE"), ev("sheet.pdf", "Electrical and Computer Engineering")], "");
check("acronym vs expansion within the SAME file → agree", r.agree, `${r.groups.length} group(s)`);

r = assessEvidenceAgreement([
  ev("resume.pdf", "  Electrical and   Computer Engineering "),
  ev("sheet.pdf", "electrical and computer engineering"),
]);
check("whitespace/case differences → agree (normalization)", r.agree, `${r.groups.length} group(s)`);

r = assessEvidenceAgreement([
  // ⚠️ THESE TWO MUST DIFFER — this case asserts that two documents stating
  // DIFFERENT phone numbers produce `conflicting_sources`. A scrub that
  // collapsed both to one synthetic value silently turned the conflict test
  // into an agreement test, which is how a regression guard stops guarding.
  ev("resume.pdf", "+15550123456"),
  ev("sheet.pdf", "+15550199999"),
]);
check("two different phone numbers → CONFLICT", !r.agree,
  r.groups.map(g => `"${g.value}" (${g.files.join(",")})`).join(" vs "));

r = assessEvidenceAgreement([
  ev("passport.pdf", "Jane Quinn Doe"),
  ev("scan.pdf", "Jane Kquinn Doe"),
]);
check("Kquinn vs Quinn → CONFLICT", !r.agree,
  r.groups.map(g => `"${g.value}"`).join(" vs "));

r = assessEvidenceAgreement([ev("a.pdf", "X")]);
check("single entry → agree", r.agree);
r = assessEvidenceAgreement([]);
check("empty evidence → agree (no manufactured conflict)", r.agree);

r = assessEvidenceAgreement([
  ev("a.pdf", "Riverton University"),
  ev("b.pdf", "Riverton University"),
  ev("c.pdf", "Riverton University — RIT"),
]);
check("3 files, one a suffix-extension → agree, all files listed (containment)", r.agree && r.groups[0].files.length === 3,
  `files=${r.groups[0]?.files.length}`);

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
