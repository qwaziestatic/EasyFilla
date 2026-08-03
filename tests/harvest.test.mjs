// STAGE 2c — harvest budget accounting.
//
// `HarvestBudgetTracker` is pure arithmetic over an injected clock, which is
// the part worth pinning without a browser: the DOM half (open widget, read
// [role="option"], close, restore scroll+focus) needs real captured markup and
// is NOT faked here. Placeholder-option classification is pure text, so that is
// covered too.
import { HarvestBudgetTracker, DEFAULT_HARVEST_BUDGET, FILL_TIME_HARVEST_BUDGET } from "./_bundle-harvest.mjs";
import { isGenericPlaceholderOption } from "./_bundle-detect.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n=== STAGE 2c: harvest budget — widget count ceiling ===");

{
  const budget = { maxWidgets: 3, maxTotalMs: 100000, perWidgetTimeoutMs: 1000 };
  const tracker = new HarvestBudgetTracker(budget, 0);
  check("a fresh tracker allows harvesting", tracker.canHarvest(0) === true);
  tracker.record(10);
  tracker.record(20);
  check("still allowed below the ceiling", tracker.canHarvest(30) === true);
  tracker.record(30);
  check("blocked once the widget ceiling is hit", tracker.canHarvest(40) === false);
  check(
    "and says which ceiling stopped it",
    /3 widgets per scan/.test(tracker.exhaustionReason(40) ?? ""),
    tracker.exhaustionReason(40),
  );
  check("stats report what was opened", tracker.stats(40).widgetsOpened === 3);
}

console.log("\n=== STAGE 2c: harvest budget — wall-clock ceiling ===");

// A generous widget count must NOT let a slow page stall the scan. This is the
// case that matters on a real portal: 8 dropdowns are allowed, but if the first
// three each take 2s, the scan stops rather than running for 16 seconds.
{
  const budget = { maxWidgets: 8, maxTotalMs: 6000, perWidgetTimeoutMs: 1200 };
  const tracker = new HarvestBudgetTracker(budget, 1000);
  tracker.record(3000);
  check("time ceiling not yet reached", tracker.canHarvest(4000) === true);
  check("no exhaustion reason while under budget", tracker.exhaustionReason(4000) === null);
  check("blocked once the time ceiling passes", tracker.canHarvest(7000) === false, "1000 + 6000 = 7000");
  check(
    "and the reason names the time budget, not the count",
    /6000ms per scan/.test(tracker.exhaustionReason(7500) ?? ""),
    tracker.exhaustionReason(7500),
  );
  check(
    "the count ceiling was never the blocker here",
    tracker.stats(7500).widgetsOpened === 1,
    `opened ${tracker.stats(7500).widgetsOpened}`,
  );
}

// Exactly-at-the-boundary behaviour, so the rule is not off by one.
{
  const tracker = new HarvestBudgetTracker({ maxWidgets: 2, maxTotalMs: 500, perWidgetTimeoutMs: 100 }, 0);
  check("blocked exactly AT the time ceiling", tracker.canHarvest(500) === false);
  check("allowed one millisecond before it", tracker.canHarvest(499) === true);
}

console.log("\n=== STAGE 2c: shipped budget defaults are sane ===");

{
  check(
    "scan-time budget is bounded on both count and time",
    DEFAULT_HARVEST_BUDGET.maxWidgets > 0 && DEFAULT_HARVEST_BUDGET.maxTotalMs > 0,
    JSON.stringify(DEFAULT_HARVEST_BUDGET),
  );
  check(
    "a whole scan's harvest cannot exceed its wall-clock budget by construction",
    DEFAULT_HARVEST_BUDGET.maxTotalMs <= 10000,
    `${DEFAULT_HARVEST_BUDGET.maxTotalMs}ms`,
  );
  check(
    "fill-time waits LONGER per widget than scan-time (the field is known to be needed)",
    FILL_TIME_HARVEST_BUDGET.perWidgetTimeoutMs > DEFAULT_HARVEST_BUDGET.perWidgetTimeoutMs,
    `${FILL_TIME_HARVEST_BUDGET.perWidgetTimeoutMs} > ${DEFAULT_HARVEST_BUDGET.perWidgetTimeoutMs}`,
  );
  check(
    "fill-time opens ONE widget — it is on-demand, not a sweep",
    FILL_TIME_HARVEST_BUDGET.maxWidgets === 1,
  );
}

console.log("\n=== STAGE 2c: placeholder options are filtered, real answers are not ===");

{
  const placeholders = ["", "   ", "--", "—", "...", "Select", "Select…", "Select an option", "Choose one", "Please select a country", "None selected"];
  placeholders.forEach((text) =>
    check(`"${text}" is treated as a placeholder`, isGenericPlaceholderOption(text) === true),
  );
}

{
  // Over-filtering would silently shrink a real option list, which is worse
  // than leaving a prompt in it.
  const realAnswers = ["Utopia", "Select Committee Member", "Choose Your Own Adventure", "None of the above", "Other", "N/A", "Chooser"];
  realAnswers.forEach((text) =>
    check(`"${text}" is NOT filtered as a placeholder`, isGenericPlaceholderOption(text) === false),
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
