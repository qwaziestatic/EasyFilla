// ─────────────────────────────────────────────────────────────────────────
// 0b — PACING COMES FROM THE ACTIVE PROVIDER, NOT FROM A GEMINI CONSTANT
//
// The defect: `setQueueRpm` was called from exactly one place — Gemini's
// `activeModel()` — with the selected GEMINI model's `assumedRpm`. Selecting
// Anthropic therefore paced the queue from a Gemini number, and Anthropic's
// real limits (returned in response headers) never took effect.
//
// §3: pacing drives SPACING ONLY. Nothing here may express a concurrency count.
// ─────────────────────────────────────────────────────────────────────────
import {
  decidePacing,
  describePacing,
  spacingForRpm,
  UNLEARNED_FALLBACK_RPM,
} from "./_bundle-pacing.mjs";
import { MODEL_OPTIONS } from "./_bundle-model-config.mjs";
import {
  noteAnthropicRateHeaders,
  anthropicPerMinuteLimit,
  resetAnthropicLearnedLimits,
} from "./_bundle-anthropic.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Every RPM figure that exists anywhere in Gemini's configuration. If an
// Anthropic pacing decision equals any of these, it was borrowed.
const GEMINI_RPM_CONSTANTS = [...new Set(MODEL_OPTIONS.map((m) => m.assumedRpm))];

console.log("\n=== 0b: Anthropic pacing is never derived from a Gemini constant ===");
{
  check(
    "Gemini's constants are present, so this test is not vacuous",
    GEMINI_RPM_CONSTANTS.length > 0,
    GEMINI_RPM_CONSTANTS.join(", "),
  );

  // Unlearned Anthropic: nothing known, so the conservative fallback applies.
  const unlearned = decidePacing({
    providerId: "anthropic",
    providerName: "Anthropic Claude",
    learnsFromHeaders: true,
    reportedLimit: null,
  });
  check("with no response seen, Anthropic uses the unlearned fallback", unlearned.basis === "unlearned-fallback");
  check(
    "and that fallback is NOT any Gemini assumedRpm",
    !GEMINI_RPM_CONSTANTS.includes(unlearned.requestsPerMinute),
    `${unlearned.requestsPerMinute} vs gemini {${GEMINI_RPM_CONSTANTS.join(", ")}}`,
  );
  check("it is not reported as learned", unlearned.learned === false);
  check(
    "and it says plainly that the real limit is not yet known",
    /until a response states the real limit/.test(describePacing(unlearned)),
    describePacing(unlearned),
  );

  // Learned Anthropic: the number came from a real response header.
  const learned = decidePacing({
    providerId: "anthropic",
    providerName: "Anthropic Claude",
    learnsFromHeaders: true,
    reportedLimit: 50,
  });
  check("a header-supplied limit is used verbatim", learned.requestsPerMinute === 50);
  check("and is reported as LEARNED", learned.learned === true && learned.basis === "learned-from-response");
  check(
    "the description credits the response headers",
    /learned from response headers/.test(describePacing(learned)),
    describePacing(learned),
  );
}

console.log("\n=== 0b: Gemini still paces from its own assumption, and says so ===");
{
  const gemini = decidePacing({
    providerId: "gemini",
    providerName: "Google Gemini",
    learnsFromHeaders: false,
    reportedLimit: 15,
  });
  check("Gemini paces from its reported figure", gemini.requestsPerMinute === 15);
  check("but it is an ASSUMPTION, never 'learned'", gemini.basis === "provider-assumption" && gemini.learned === false);
  check(
    "and the wording does not claim the API stated it",
    /our assumption, not stated by the API/.test(describePacing(gemini)),
    describePacing(gemini),
  );

  // A provider that does not learn AND reports nothing must not silently run fast.
  const blind = decidePacing({
    providerId: "gemini",
    providerName: "Google Gemini",
    learnsFromHeaders: false,
    reportedLimit: null,
  });
  check("no figure at all → conservative fallback, not unlimited", blind.requestsPerMinute === UNLEARNED_FALLBACK_RPM);
}

console.log("\n=== 0b: the learned value actually comes from the header ===");
{
  resetAnthropicLearnedLimits();
  check("nothing is known before a response", anthropicPerMinuteLimit() === null);

  // Exactly the header Anthropic documents (§1b).
  noteAnthropicRateHeaders({
    get: (name) => (name === "anthropic-ratelimit-requests-limit" ? "50" : null),
  });
  check("after one response the limit is learned", anthropicPerMinuteLimit() === 50);

  const afterLearning = decidePacing({
    providerId: "anthropic",
    providerName: "Anthropic Claude",
    learnsFromHeaders: true,
    reportedLimit: anthropicPerMinuteLimit(),
  });
  check(
    "and pacing now follows the response, not the fallback",
    afterLearning.requestsPerMinute === 50 && afterLearning.basis === "learned-from-response",
  );

  // A header that is absent or junk must not overwrite what was learned, and
  // must not be parsed into a number that paces the queue wrongly.
  noteAnthropicRateHeaders({ get: () => null });
  check("a response without the header does not erase the learned value", anthropicPerMinuteLimit() === 50);
  noteAnthropicRateHeaders({ get: () => "not-a-number" });
  check("an unparseable header is ignored rather than paced from", anthropicPerMinuteLimit() === 50);
  noteAnthropicRateHeaders({ get: () => "0" });
  check("a zero limit is rejected — it would mean 'never send anything'", anthropicPerMinuteLimit() === 50);
  resetAnthropicLearnedLimits();
}

console.log("\n=== 0b/§3: spacing only — no concurrency anywhere in the decision ===");
{
  const decision = decidePacing({
    providerId: "anthropic",
    providerName: "Anthropic Claude",
    learnsFromHeaders: true,
    reportedLimit: 60,
  });
  const keys = Object.keys(decision);
  check(
    "the decision exposes no concurrency field",
    !keys.some((k) => /concurren|parallel|inflight|workers/i.test(k)),
    keys.join(", "),
  );
  check("60/min → 900ms spacing (90% of the even 1000ms gap)", decision.spacingMs === 900, String(decision.spacingMs));
  check("spacing rises as the limit falls", spacingForRpm(5) > spacingForRpm(50));
  check("spacing is always positive, even at an absurd limit", spacingForRpm(100000) >= 0);
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
