import { extractProfileFromDocuments } from "./_bundle-profile.mjs";

const get = (facts, field) => facts.filter((f) => f.field === field).map((f) => f.value);
const factFor = (facts, field) => facts.find((f) => f.field === field);

let failures = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const quiet = () => { const o = console.log; console.log = () => {}; return () => { console.log = o; }; };

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 1 — the original four-document set (regression)
// ─────────────────────────────────────────────────────────────────────────
const statusLetter = `College of Technology and Built Environment
School of Electrical and
Computer Engineering
Ref. No: SECE/EXT/0000/00/00
Date: June 22, 2026
To Whom It May Concern,
Subject: Status of a student
This letter is to certify that Jane Quinn, ID No: UGR/0000/00 is an active 4th Year
undergraduate program student at the School of Electrical and Computer Engineering College of
Technology and Built Environment, Riverton University.
Regards,
Dr. Alex Morgan`;

const referenceSheet = `Personal Reference Sheet
Jane Quinn Doe — quick-reference details for applications and forms
Full Name  Jane Quinn Doe
Preferred Name  Janie
Email  jane.doe@example.com
Phone  +15550123456
LinkedIn  linkedin.com/in/jane-doe-000000000
Current Location  Riverton, Utopia
University  Riverton University — Riverton Institute of Technology (RIT)
Department / Major  Electrical and Computer Engineering (Communication Engineering stream)
Class / Year Standing  4th Year
Expected Graduation  2027 G.C. (next year)
Degree Level  Bachelor of Science (B.Sc.)
Technical Skills  Node.js, Express, NestJS, Spring Boot, PostgreSQL, MongoDB, Docker, Kubernetes, JavaScript, TypeScript, React
Languages  Amharic (Native), English (Fluent)`;

const resume = `JANE QUINN DOE
jane.doe@example.com | +15550123456 | Riverton, Utopia | LinkedIn
SUMMARY
Electrical and Computer Engineering student and full-stack developer.`;

const passport = `Republic Of Utopia
PASSPORT  PQ  UTO  EQ0000000
Surname DOE
Given Name JANE QUINN
Nationality UTOPIAN  Sex M
Date of Birth 01 JAN 00   Place of Birth LAKESIDE
PQUTODOE<<JANE<QUINN<<<<<<<<<<<<<<<<
EQ00000000UTO0001010M30010100<<<<<<<<<<<00`;

console.log("\n=== SCENARIO 1: full four-document set (regression) ===");
let restore = quiet();
const s1 = extractProfileFromDocuments([
  { fileName: "student_status_letter.pdf", text: statusLetter },
  { fileName: "Jane_Doe_Personal_Reference_Sheet.pdf", text: referenceSheet },
  { fileName: "Jane_Doe_Resume_Updated.pdf", text: resume },
  { fileName: "passport_scan.pdf", text: passport },
]);
restore();
const n1 = factFor(s1, "name");
check("(a) name is the person, not a department", /jane/i.test(n1?.value ?? "") && !/engineering/i.test(n1?.value ?? ""), `"${n1?.value}" [${n1?.rule}, ${n1?.confidence}, ${n1?.source}]`);
check("(b) email + phone", get(s1, "email").length > 0 && get(s1, "phone").length > 0, `${get(s1, "email")} / ${get(s1, "phone")}`);
// Expectations track the SYNTHETIC MRZ above: document number EQ0000000 and
// birth date 000101 → 2000-01-01. Still an exact-value assertion — the TD3
// column layout (docNo 9, check 1, nationality 3, DOB 6, …) is preserved, so
// this continues to prove the MRZ is really parsed rather than guessed.
check("(c) passport/dob/nationality from MRZ", get(s1, "passport")[0] === "EQ0000000" && get(s1, "dob")[0] === "2000-01-01", `passport=${get(s1, "passport")} dob=${get(s1, "dob")}`);
check("(d) id number", get(s1, "id")[0] === "UGR/0000/00", `${get(s1, "id")}`);
check("(c2) second column not swallowed into first", !/place of birth|sex/i.test(`${get(s1, "dob")} ${get(s1, "nationality")}`), `dob=${get(s1, "dob")} nationality=${get(s1, "nationality")} pob=${get(s1, "place_of_birth")}`);
check("(e) department kept separate from name", /engineering/i.test(get(s1, "department")[0] ?? ""), `${get(s1, "department")}`);

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 2 — PRIMARY GATE: prose-only CV, no key-value table at all
// ─────────────────────────────────────────────────────────────────────────
const proseCv = `School of Electrical and
Computer Engineering
JANE QUINN DOE
jane.doe@example.com | +15550123456 | Riverton, Utopia
linkedin.com/in/jane-doe-000000000

PROFESSIONAL SUMMARY
Final-year Electrical and Computer Engineering student and full-stack developer
with experience building distributed backend services.

EXPERIENCE
Backend Developer Intern, Ethio Telecom, Riverton
Built ingestion pipelines in Node.js and PostgreSQL.`;

console.log("\n=== SCENARIO 2: PROSE-ONLY CV (primary gate) ===");
restore = quiet();
const s2 = extractProfileFromDocuments([{ fileName: "prose_cv.pdf", text: proseCv }]);
restore();
const n2 = factFor(s2, "name");
check(
  "name is the person OR honestly low-confidence — never an institution",
  n2 && /jane/i.test(n2.value) && !/engineering|school|college/i.test(n2.value),
  `"${n2?.value}" [${n2?.rule}, ${n2?.confidence}]`,
);
check("scored high enough to auto-fill", n2?.confidence === "high", `confidence=${n2?.confidence}`);

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — ADVERSARIAL: no name-shaped person line, only an institution
// ─────────────────────────────────────────────────────────────────────────
const noNameDoc = `Computer Engineering Department
Riverton University
This document confirms enrolment for the 2026 academic year.`;

console.log("\n=== SCENARIO 3: no person name present (must refuse) ===");
restore = quiet();
const s3 = extractProfileFromDocuments([{ fileName: "enrolment.pdf", text: noNameDoc }]);
restore();
const n3 = factFor(s3, "name");
check(
  "no confident name is invented",
  !n3 || n3.confidence === "low",
  n3 ? `"${n3.value}" [${n3.rule}, ${n3.confidence}] — low ⇒ not auto-filled` : "no name fact at all",
);

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — FIX A.2: real pdf.js table-flattening shapes
// ─────────────────────────────────────────────────────────────────────────
const shapes = {
  "single space (most common flattening)": `Full Name Jane Quinn Doe
Email jane.doe@example.com
Class / Year Standing 4th Year`,
  "colon separated": `Full Name: Jane Quinn Doe
Email: jane.doe@example.com`,
  "pipe-delimited columns": `Full Name | Jane Quinn Doe
Email | jane.doe@example.com`,
  "dot leaders": `Full Name ......... Jane Quinn Doe
Email ............. jane.doe@example.com`,
  "label and value on separate lines": `Full Name
Jane Quinn Doe
Email
jane.doe@example.com`,
  "wide column gap": `Full Name                 Jane Quinn Doe
Email                     jane.doe@example.com`,
  "value wrapped across lines": `Department / Major  Electrical and Computer
Engineering (Communication stream)
Full Name  Jane Quinn Doe`,
};

console.log("\n=== SCENARIO 4: table-flattening shapes (FIX A.2) ===");
for (const [shape, text] of Object.entries(shapes)) {
  restore = quiet();
  const f = extractProfileFromDocuments([{ fileName: "sheet.pdf", text }]);
  restore();
  const nm = factFor(f, "name");
  const wrapped = get(f, "department")[0] ?? "";
  const ok = shape.startsWith("value wrapped")
    ? /Electrical and Computer Engineering/i.test(wrapped) && nm?.value === "Jane Quinn Doe"
    : nm?.rule === "labelled" && nm.value === "Jane Quinn Doe";
  check(shape, ok, shape.startsWith("value wrapped") ? `department="${wrapped}"` : `"${nm?.value}" [${nm?.rule}]`);
}

// ─────────────────────────────────────────────────────────────────────────
// SCENARIO 5 — prose must NOT be mis-parsed as a table row
// ─────────────────────────────────────────────────────────────────────────
console.log("\n=== SCENARIO 5: prose lines are not table rows ===");
restore = quiet();
const s5 = extractProfileFromDocuments([{
  fileName: "prose.pdf",
  text: `Languages spoken include Amharic and English at a professional level.
Skills demonstrated during the internship were considered exemplary by the team.
Name of the supervising engineer was recorded separately.`,
}]);
restore();
check("no bogus facts harvested from prose", s5.length === 0, s5.map((f) => `${f.field}="${f.value}"`).join(", ") || "none");

console.log(`\n================ ${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`} ================\n`);
process.exit(failures === 0 ? 0 : 1);
