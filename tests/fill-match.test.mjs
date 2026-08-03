// FIX 1 — the post-navigation label fallback must REFUSE rather than guess.
//
// Synthetic question/answer shapes only. No DOM: matchAnswersToQuestions works
// on plain data (label text, identity key, fillKind), which is exactly the part
// worth pinning. Real captured markup is still pending (§6, STAGE 5).
import {
  matchAnswersToQuestions,
  labelFallbackStats,
  resetLabelFallbackStats,
} from "./_bundle-fillmatch.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const q = (questionText, key, extra = {}) => ({
  questionText,
  type: "short_answer",
  options: [],
  required: false,
  fillKind: "text",
  elements: [],
  ...(key ? { identity: { frameId: 0, path: "p", nameOrId: "n", accessibleName: questionText, key } } : {}),
  ...extra,
});

const a = (questionText, answer, extra = {}) => ({
  questionText,
  type: "short_answer",
  options: [],
  answer,
  ...extra,
});

console.log("\n=== FIX 1: structural identity still wins when it is valid ===");

{
  resetLabelFallbackStats();
  const questions = [q("Employer", "0|div[1]>input|emp_1|employer"), q("Employer", "0|div[2]>input|emp_2|employer")];
  const answers = [
    a("Employer", "Acme Ltd", { identityKey: "0|div[2]>input|emp_2|employer" }),
  ];
  const { matched, refusals } = matchAnswersToQuestions(questions, answers);
  check(
    "an intact identity key picks the exact repeated row, not the first match",
    matched.get(questions[1])?.answer === "Acme Ltd" && !matched.has(questions[0]),
    `matched row2=${matched.get(questions[1])?.answer}, row1=${matched.get(questions[0])?.answer}`,
  );
  check("no refusal when identity resolves it", refusals.length === 0);
  check("the fallback counter does not move on the identity path", labelFallbackStats().fallbacks === 0);
}

console.log("\n=== FIX 1: ambiguous label re-match after navigation is REFUSED ===");

// THE case this exists for: a navigation invalidated the key, and the label
// alone cannot tell two repeated portal rows apart.
{
  resetLabelFallbackStats();
  const questions = [q("Employer", "0|div[1]>input|emp_1|employer"), q("Employer", "0|div[2]>input|emp_2|employer")];
  const answers = [a("Employer", "Acme Ltd", { identityInvalidated: true })];
  const { matched, refusals } = matchAnswersToQuestions(questions, answers);

  check("nothing is filled when several fields share the label", matched.size === 0, `matched ${matched.size}`);
  check("the answer is refused, not silently dropped", refusals.length === 1);
  check(
    "the refusal reason is the specified one",
    /^ambiguous label re-match after navigation/.test(refusals[0]?.reason ?? ""),
    refusals[0]?.reason,
  );
  check("the refusal names the competing fields", /"Employer", "Employer"/.test(refusals[0]?.reason ?? ""));
  check("the fallback fired once and refused once", labelFallbackStats().fallbacks === 1 && labelFallbackStats().refusals === 1);
}

// No candidate clears the threshold — also a refusal, not a best guess.
{
  resetLabelFallbackStats();
  const questions = [q("Date of birth", "0|a"), q("Postal code", "0|b")];
  const answers = [a("Highest qualification attained", "BSc", { identityInvalidated: true })];
  const { matched, refusals } = matchAnswersToQuestions(questions, answers);
  check("nothing is filled when no field resembles the answer", matched.size === 0);
  check("that is refused too", refusals.length === 1);
  check(
    "and the reason says nothing resembled it",
    /no field on the current page resembles/.test(refusals[0]?.reason ?? ""),
    refusals[0]?.reason,
  );
  check("it counts as a refusal", labelFallbackStats().refusals === 1);
}

// Exactly one candidate: the fallback is ALLOWED to fill. Refusing everything
// would make the fallback useless; the rule is one-candidate-or-refuse.
{
  resetLabelFallbackStats();
  const questions = [q("Home address", "0|a"), q("Postal code", "0|b")];
  const answers = [a("Postal code", "1000", { identityInvalidated: true })];
  const { matched, refusals } = matchAnswersToQuestions(questions, answers);
  check("a single unambiguous label match is filled", matched.get(questions[1])?.answer === "1000");
  check("with no refusal", refusals.length === 0);
  check("but it is still counted as a fallback", labelFallbackStats().fallbacks === 1 && labelFallbackStats().refusals === 0);
}

console.log("\n=== FIX 1: refusal does not leak into the ordinary path ===");

// An answer that never had a structural key (pre-2a, or an adapter that emits
// none) keeps the previous greedy behaviour — that path is not in scope and
// must not start refusing.
{
  resetLabelFallbackStats();
  const questions = [q("Employer", "0|a"), q("Employer name", "0|b")];
  const answers = [a("Employer", "Acme Ltd")];
  const { matched, refusals } = matchAnswersToQuestions(questions, answers);
  check(
    "an answer with no identity key is still matched greedily, not refused",
    matched.size === 1 && refusals.length === 0,
    `matched ${matched.size}, refusals ${refusals.length}`,
  );
  check("and does not touch the fallback counter", labelFallbackStats().fallbacks === 0);
}

// A refused answer must not be picked up by the greedy pass afterwards — that
// would reintroduce exactly the silent winner-picking being removed.
{
  resetLabelFallbackStats();
  const questions = [q("Employer", "0|a"), q("Employer", "0|b")];
  const answers = [a("Employer", "Acme Ltd", { identityInvalidated: true })];
  const { matched, refusals } = matchAnswersToQuestions(questions, answers);
  check(
    "a refused answer is NOT rescued by the greedy fuzzy pass",
    matched.size === 0 && refusals.length === 1,
    `matched ${matched.size}`,
  );
}

console.log("\n=== FIX 1: manual-only fields are never a fallback candidate ===");

{
  resetLabelFallbackStats();
  const questions = [
    q("Password", "0|p", { manualOnly: true, manualReason: "password field", fillKind: "none" }),
    q("Password", "0|p2", { manualOnly: true, manualReason: "password field", fillKind: "none" }),
  ];
  const answers = [a("Password", "hunter2", { identityInvalidated: true })];
  const { matched, refusals } = matchAnswersToQuestions(questions, answers);
  check("manual-only fields are excluded from matching entirely", matched.size === 0);
  check(
    "so the answer is refused for having no candidate, never written to a password field",
    refusals.length === 1 && /no field on the current page resembles/.test(refusals[0]?.reason ?? ""),
    refusals[0]?.reason,
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
