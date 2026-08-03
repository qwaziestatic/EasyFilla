// ─────────────────────────────────────────────────────────────────────────
// PART 2 — file uploads are manual_only, permanently
// PART 3 — date fields are fillable, and REFUSE when ambiguous
//
// ⚠️ THE INVARIANT UNDER TEST IN PART 3:
// A WRONG DATE OF BIRTH ON AN APPLICATION IS WORSE THAN A BLANK ONE.
// "03/04/2001" is 3 April in most of the world and 4 March in the US. Every
// assertion below exists to keep that guess from ever being made silently.
// ─────────────────────────────────────────────────────────────────────────
import { parseKnownDate, toInputDateValue, detectDateOrder } from "./_bundle-date-format.mjs";
import { readFileSync } from "node:fs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const code = (file) =>
  readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("\n=== PART 3: unambiguous dates are parsed ===");
{
  const iso = parseKnownDate("2001-04-03");
  check("ISO year-first parses", iso.ok === true && iso.date.year === 2001 && iso.date.month === 4 && iso.date.day === 3);
  check("and says how it read it", /ISO year-first/.test(iso.interpretation ?? ""));

  const worded = parseKnownDate("3 April 2001");
  check("a month named in words parses", worded.ok === true && worded.date.month === 4 && worded.date.day === 3);
  const wordedUs = parseKnownDate("April 3, 2001");
  check("month-first in words parses identically", wordedUs.ok === true && wordedUs.date.month === 4 && wordedUs.date.day === 3);
  check("an abbreviated month works", parseKnownDate("3 Apr 2001").ok === true);

  // One component > 12 forces the reading — no ambiguity to refuse.
  const forcedDay = parseKnownDate("25/04/2001");
  check("25/04 must be day-first (25 is no month)", forcedDay.ok === true && forcedDay.date.day === 25 && forcedDay.date.month === 4);
  check("and it says the reading was forced", /forced/.test(forcedDay.interpretation ?? ""));
  const forcedMonth = parseKnownDate("04/25/2001");
  check("04/25 must be month-first", forcedMonth.ok === true && forcedMonth.date.month === 4 && forcedMonth.date.day === 25);
}

console.log("\n=== PART 3: ⚠️ THE REFUSAL — ambiguity is never guessed ===");
{
  const ambiguous = parseKnownDate("03/04/2001");
  check("⚠️ 03/04/2001 is REFUSED with no order stated", ambiguous.ok === false);
  check("and the reason names both readings", /day\/month or month\/day/.test(ambiguous.reason ?? ""), ambiguous.reason);
  check(
    "and says why refusing is right",
    /worse than a blank one/.test(ambiguous.reason ?? ""),
    "the user should understand this is a deliberate choice, not a parser failure",
  );
  check("and tells the user what to do", /Settings|yourself/.test(ambiguous.reason ?? ""));

  // A STATED order resolves it — and the two orders disagree, which is the point.
  const dmy = parseKnownDate("03/04/2001", "DMY");
  const mdy = parseKnownDate("03/04/2001", "MDY");
  check("a stated D/M/Y order resolves it to 3 April", dmy.ok === true && dmy.date.day === 3 && dmy.date.month === 4);
  check("a stated M/D/Y order resolves it to 4 March", mdy.ok === true && mdy.date.day === 4 && mdy.date.month === 3);
  check(
    "⚠️ the two readings are genuinely different dates",
    dmy.date.month !== mdy.date.month,
    "which is exactly why guessing is forbidden",
  );
}

console.log("\n=== PART 3: impossible and unrecognised values fail by name ===");
{
  check("31 February is refused", parseKnownDate("2001-02-31").ok === false);
  check("month 13 is refused", parseKnownDate("2001-13-01").ok === false);
  check("day 0 is refused", parseKnownDate("2001-01-00").ok === false);
  check("29 Feb in a non-leap year is refused", parseKnownDate("2001-02-29").ok === false);
  check("29 Feb in a leap year is accepted", parseKnownDate("2000-02-29").ok === true);
  check("1900 was not a leap year", parseKnownDate("1900-02-29").ok === false);
  check("both components > 12 is refused", parseKnownDate("25/26/2001").ok === false);
  check("an empty value is refused", parseKnownDate("   ").ok === false);
  check("free text is refused", parseKnownDate("sometime in 2001").ok === false);
  check(
    "every refusal carries a reason string",
    ["2001-02-31", "25/26/2001", "   ", "sometime in 2001"].every((v) => (parseKnownDate(v).reason ?? "").length > 10),
  );
}

console.log("\n=== PART 3: the input value format and order detection ===");
{
  check("a native date input gets YYYY-MM-DD", toInputDateValue({ year: 2001, month: 4, day: 3 }) === "2001-04-03");
  check("single digits are zero-padded", toInputDateValue({ year: 999, month: 1, day: 2 }) === "0999-01-02");

  check("a DD/MM/YYYY hint is detected", detectDateOrder("DD/MM/YYYY") === "DMY");
  check("an MM/DD/YYYY hint is detected", detectDateOrder("MM/DD/YYYY") === "MDY");
  check("a YYYY-MM-DD hint is detected", detectDateOrder("YYYY-MM-DD") === "YMD");
  check("⚠️ an absent hint is 'unknown', never a default", detectDateOrder(null) === "unknown");
  check("and an unrecognised hint is 'unknown' too", detectDateOrder("your date of birth") === "unknown");
}

console.log("\n=== PART 3: the fill path uses it, and verifies by re-querying ===");
{
  const filler = code("src/content-scripts/google-forms/filler.ts");
  check("date joined the fillable types", /"date",/.test(filler));
  check("and the fill dispatch", /case "date":\s*\n\s*result = await fillDateVerified/.test(filler));
  check("the old blanket skip comment is gone", !/date\/time\/file_upload rely/.test(filler));
  check("a native input[type=date] is handled", /SELECTORS\.dateInput/.test(filler));
  check("split day/month/year inputs are handled", /\\bday\\b\|\\bdd\\b/.test(filler));
  check(
    "the read-back RE-QUERIES rather than reusing the written reference",
    /const reread = \(\)/.test(filler) && /liveCard\(question, ordinal\)/.test(filler),
  );
  check("the conversion is logged", /date "\$\{value\}" → /.test(filler));
  check(
    "a refusal propagates as a named failure, not a silent skip",
    /return fail\(parsed\.reason\)/.test(filler),
  );
}

console.log("\n=== PART 2: file uploads are manual_only and excluded from requests ===");
{
  const extractor = code("src/content-scripts/google-forms/extractor.ts");
  const detect = code("src/content-scripts/adapters/generic/detect.ts");

  check("Google Forms marks file uploads manualOnly", /question\.manualOnly = true;/.test(extractor));
  check(
    "the generic adapter does too",
    /manual\.manualOnly \|\| type === "file_upload"/.test(detect),
    "so the exclusion holds on every adapter, not just Google Forms",
  );

  // The structural claim: the request filter keys on manualOnly, so marking it
  // once excludes it everywhere rather than relying on per-call-site type checks.
  const sidepanel = code("src/sidepanel/sidepanel.ts");
  check(
    "the model-request filter excludes manualOnly questions",
    /!question\.manualOnly/.test(sidepanel),
  );
  check(
    "and file uploads specifically",
    /question\.type !== "file_upload"/.test(sidepanel),
    "belt and braces: the type check remains as well",
  );

  const filler = code("src/content-scripts/google-forms/filler.ts");
  check(
    "the fill report explains WHY in plain language",
    /file uploads go through Google Drive and cannot be automated/.test(filler),
  );
  check(
    "and tells the user to do it themselves",
    /Attach this one yourself/.test(filler),
  );
  check(
    "the report names the matched document (the useful compromise)",
    /attach your \$\{chosen\}/.test(sidepanel),
  );
  check(
    "and says plainly when nothing matched",
    /no matching document uploaded/.test(sidepanel),
  );
}

console.log("\n=== PART 4a: the dismissed intro tip is recoverable ===");
{
  const prefs = code("src/lib/ui-prefs.ts");
  const options = code("src/options/options.ts");
  check("a reset exists", /export async function resetInputNote/.test(prefs));
  check("the first-run default is explicit — only `true` hides it", /stored\[NOTE_KEY\] === true/.test(prefs));
  check("Settings exposes the reset", /reset-intro-tip-button/.test(options));
  check("and reports the current state", /Currently hidden|Currently shown/.test(options));
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
