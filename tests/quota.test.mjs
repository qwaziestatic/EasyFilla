// STAGE 3 — request budget: quota accounting, Pacific-midnight rollover,
// pre-flight estimation, and the daily-vs-per-minute classifier.
//
// The reset boundary under test is a VERIFIED fact, not an assumption:
//   "Requests per day (RPD) quotas reset at midnight Pacific time."
//   https://ai.google.dev/gemini-api/docs/rate-limits  (fetched 2026-07-28)
import {
  emptyLedger,
  pacificDayKey,
  nextPacificMidnight,
  rollOver,
  recordRequests,
  remaining,
  learnLimit,
  setUserLimit,
  describeUsage,
  estimateRequests,
  preflight,
  classifyQuotaWindow,
  looksPerDay,
  looksPerMinute,
  extractObservedLimit,
} from "./_bundle-budget.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n=== STAGE 3: the window is the PACIFIC day, not local or UTC ===");

{
  // 2026-03-10T05:30:00Z is 21:30 on 2026-03-09 in Los Angeles (PDT, UTC-7).
  // A UTC-keyed counter would already have rolled over; a Pacific-keyed one
  // must not, because the quota has not reset yet.
  const lateEvening = new Date("2026-03-10T05:30:00Z");
  check(
    "an instant that is already tomorrow in UTC is still today in Pacific",
    pacificDayKey(lateEvening) === "2026-03-09",
    pacificDayKey(lateEvening),
  );

  // 08:30Z the same day is 01:30 Pacific — now it HAS rolled.
  const afterMidnight = new Date("2026-03-10T08:30:00Z");
  check(
    "and rolls only once Pacific midnight has actually passed",
    pacificDayKey(afterMidnight) === "2026-03-10",
    pacificDayKey(afterMidnight),
  );
}

{
  // DST correctness. US DST began 2026-03-08; a hardcoded UTC-8 would place
  // midnight an hour wrong for two-thirds of the year.
  const summer = new Date("2026-07-15T06:30:00Z"); // 23:30 Jul 14 PDT (UTC-7)
  check("summer (PDT, UTC-7) keys to the previous day at 06:30Z", pacificDayKey(summer) === "2026-07-14", pacificDayKey(summer));
  const winter = new Date("2026-12-15T07:30:00Z"); // 23:30 Dec 14 PST (UTC-8)
  check("winter (PST, UTC-8) keys to the previous day at 07:30Z", pacificDayKey(winter) === "2026-12-14", pacificDayKey(winter));
  const winterAfter = new Date("2026-12-15T08:30:00Z"); // 00:30 Dec 15 PST
  check("and rolls an hour later in winter than in summer", pacificDayKey(winterAfter) === "2026-12-15", pacificDayKey(winterAfter));
}

{
  const now = new Date("2026-07-15T06:30:00Z"); // 23:30 Pacific
  const reset = nextPacificMidnight(now);
  check("the next reset is within the next hour from 23:30 Pacific", reset.getTime() - now.getTime() <= 3600_000 && reset > now, `${reset.toISOString()}`);
  check("and it lands on the following Pacific day", pacificDayKey(reset) === "2026-07-15", pacificDayKey(reset));
}

console.log("\n=== STAGE 3: accounting and rollover ===");

{
  let ledger = emptyLedger("2026-07-14");
  ledger = recordRequests(ledger, 1, new Date("2026-07-15T06:00:00Z")); // still Jul 14 Pacific
  ledger = recordRequests(ledger, 2, new Date("2026-07-15T06:10:00Z"));
  check("requests accumulate within the same Pacific day", ledger.used === 3, `used=${ledger.used}`);
  check("and the day key is unchanged", ledger.day === "2026-07-14", ledger.day);

  const afterReset = recordRequests(ledger, 1, new Date("2026-07-15T08:00:00Z")); // 01:00 Jul 15 Pacific
  check("crossing Pacific midnight resets the count", afterReset.used === 1, `used=${afterReset.used}`);
  check("and moves the day key", afterReset.day === "2026-07-15", afterReset.day);
}

{
  // A learned limit is a property of the key/model, not of the day, so it must
  // survive a rollover while the COUNT does not.
  let ledger = learnLimit(recordRequests(emptyLedger("2026-07-14"), 5, new Date("2026-07-15T06:00:00Z")), 20);
  check("a learned limit is recorded", ledger.limit === 20 && ledger.limitSource === "observed-429");
  const rolled = rollOver(ledger, new Date("2026-07-15T08:00:00Z"));
  check("the limit survives the rollover", rolled.limit === 20, `limit=${rolled.limit}`);
  check("the count does not", rolled.used === 0, `used=${rolled.used}`);
}

console.log("\n=== STAGE 3: an unknown limit is reported as unknown, never guessed ===");

{
  const fresh = emptyLedger("2026-07-14");
  check("a fresh ledger has NO limit", fresh.limit === null && fresh.limitSource === "unknown");
  check("remaining() is null, not a number", remaining(fresh) === null);
  check(
    "and the UI string says the limit is unknown rather than inventing a denominator",
    /daily limit unknown/.test(describeUsage(fresh)),
    describeUsage(fresh),
  );

  const known = setUserLimit(recordRequests(fresh, 3, new Date("2026-07-15T06:00:00Z")), 20);
  check("a user-set limit gives a real denominator", describeUsage(known) === "3 of 20 requests used today", describeUsage(known));
  check("remaining() subtracts correctly", remaining(known) === 17, String(remaining(known)));
  check("a nonsensical limit is rejected, not stored", setUserLimit(known, -5).limit === 20);
  check("clearing the limit returns to unknown", setUserLimit(known, null).limit === null);
}

console.log("\n=== STAGE 3: pre-flight estimation ===");

{
  const e = estimateRequests({ fileCount: 3, questionCount: 24, chunkSize: 12, dossierCached: false });
  check("Stage A is one request for the whole file set", e.stageA === 1, `stageA=${e.stageA}`);
  check("Stage B is ceil(questions / chunkSize)", e.stageB === 2, `stageB=${e.stageB}`);
  check("the floor is the sum", e.min === 3, `min=${e.min}`);
  check("the ceiling allows for the documented retries", e.max > e.min, `max=${e.max}`);
}

{
  const cached = estimateRequests({ fileCount: 3, questionCount: 12, chunkSize: 12, dossierCached: true });
  check("a cached dossier costs no Stage A request", cached.stageA === 0, `stageA=${cached.stageA}`);
  const nothing = estimateRequests({ fileCount: 0, questionCount: 0, chunkSize: 12, dossierCached: false });
  check("nothing to do costs nothing", nothing.min === 0 && nothing.max === 0);
}

{
  // A partial chunk still costs a whole request.
  const e = estimateRequests({ fileCount: 1, questionCount: 13, chunkSize: 12, dossierCached: true });
  check("13 questions at 12/chunk is 2 requests, not 1", e.stageB === 2, `stageB=${e.stageB}`);
}

console.log("\n=== STAGE 3: pre-flight verdicts ===");

const now = new Date("2026-07-15T06:00:00Z");

{
  const ledger = setUserLimit(emptyLedger(pacificDayKey(now)), 100);
  const result = preflight(ledger, { fileCount: 2, questionCount: 24, chunkSize: 12, dossierCached: false }, now);
  check("plenty of budget → ok", result.verdict === "ok", result.verdict);
  check("all questions are answerable", result.answerableQuestions === 24);
}

{
  const ledger = recordRequests(setUserLimit(emptyLedger(pacificDayKey(now)), 20), 17, now);
  const result = preflight(ledger, { fileCount: 2, questionCount: 24, chunkSize: 12, dossierCached: false }, now);
  check("just enough for the floor but not the ceiling → tight", result.verdict === "tight", `${result.verdict}: ${result.message}`);
}

{
  const ledger = recordRequests(setUserLimit(emptyLedger(pacificDayKey(now)), 20), 18, now);
  const result = preflight(ledger, { fileCount: 2, questionCount: 60, chunkSize: 12, dossierCached: false }, now);
  check("not enough → exceeds", result.verdict === "exceeds", result.verdict);
  check(
    "and it offers a partial run sized to what remains",
    result.answerableQuestions === 12,
    `answerable=${result.answerableQuestions} (2 left − 1 for Stage A = 1 chunk = 12)`,
  );
  check("the message names the reset time", /00:00 Pacific/.test(result.message), result.message);
}

{
  const ledger = recordRequests(setUserLimit(emptyLedger(pacificDayKey(now)), 20), 20, now);
  const result = preflight(ledger, { fileCount: 2, questionCount: 60, chunkSize: 12, dossierCached: false }, now);
  check("fully exhausted → nothing is answerable", result.answerableQuestions === 0, `answerable=${result.answerableQuestions}`);
  check("and it says there isn't enough budget to start", /isn't enough budget/.test(result.message), result.message);
}

{
  const result = preflight(emptyLedger(pacificDayKey(now)), { fileCount: 1, questionCount: 12, chunkSize: 12, dossierCached: false }, now);
  check("an unknown limit does NOT block the run", result.verdict === "unknown-limit", result.verdict);
  // 1 Stage A + 1 Stage B chunk = 2 floor; +1 safety retry +1 chunk retry = 4.
  check("it still reports the expected spend as a range", /2–4 request/.test(result.message), result.message);
  check("and explains why there is no denominator", /won't guess/.test(result.message), result.message);
}

console.log("\n=== STAGE 3: daily-vs-per-minute classifier (the re-verified bug) ===");

// THE BUG: `free_tier` appears in BOTH windows. Treating any free-tier 429 as
// daily stopped runs that would have cleared in 60 seconds.
{
  const perMinuteFreeTier =
    "generativelanguage.googleapis.com/generate_content_free_tier_requests " +
    "GenerateRequestsPerMinutePerProjectPerModel-FreeTier";
  check(
    "a PER-MINUTE free-tier metric is classified per_minute, not daily",
    classifyQuotaWindow(perMinuteFreeTier, 46_657) === "per_minute",
    classifyQuotaWindow(perMinuteFreeTier, 46_657),
  );

  const perDayFreeTier =
    "generativelanguage.googleapis.com/generate_content_free_tier_requests " +
    "GenerateRequestsPerDayPerProjectPerModel-FreeTier";
  check(
    "a PER-DAY free-tier metric is classified daily",
    classifyQuotaWindow(perDayFreeTier) === "daily",
    classifyQuotaWindow(perDayFreeTier),
  );
}

{
  check("bare 'free_tier' with a short retryDelay is treated as per-minute", classifyQuotaWindow("free_tier quota", 30_000) === "per_minute");
  check("bare 'free_tier' with no retryDelay is treated as daily", classifyQuotaWindow("free_tier quota") === "daily");
  check("an input-token-count metric is per-minute", classifyQuotaWindow("generate_content_free_tier_input_token_count") === "per_minute");
  check("an explicit 'requests per day' phrase is daily", classifyQuotaWindow("Quota exceeded for requests per day") === "daily");
  check("a plain rate-limit message with no window token defaults to per-minute (retryable)", classifyQuotaWindow("Too many requests") === "per_minute");
}

{
  check("looksPerDay matches the day metric", looksPerDay("GenerateRequestsPerDayPerProjectPerModel-FreeTier") === true);
  check("looksPerDay does NOT match the minute metric", looksPerDay("GenerateRequestsPerMinutePerProjectPerModel-FreeTier") === false);
  check("looksPerMinute matches the minute metric", looksPerMinute("GenerateRequestsPerMinutePerProjectPerModel-FreeTier") === true);
}

console.log("\n=== STAGE 3: learning the real limit from a 429 ===");

{
  const details = [
    {
      "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      violations: [
        { quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaValue: "20" },
      ],
    },
  ];
  check("the numeric limit is extracted from QuotaFailure violations", extractObservedLimit(details) === 20, String(extractObservedLimit(details)));
  check("no violations → null, never a fabricated number", extractObservedLimit([{ retryDelay: "46s" }]) === null);
  check("a zero/garbage value is rejected", extractObservedLimit([{ violations: [{ quotaValue: "0" }] }]) === null);
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
