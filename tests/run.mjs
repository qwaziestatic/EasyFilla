// Logic tests that need no browser and no API key.
//   node tests/run.mjs
// Bundles the units under test with esbuild, then runs each suite.
import { execFileSync, execSync } from "node:child_process";
import { rmSync } from "node:fs";



const bundles = [
  ["src/lib/ai/gemini-client.ts", "tests/_bundle-agree.mjs", "assessEvidenceAgreement"],
  ["src/lib/profile/extract.ts", "tests/_bundle-profile.mjs", "extractProfileFromDocuments"],
  ["src/content-scripts/adapters/identity.ts", "tests/_bundle-identity.mjs", "dedupeByIdentity"],
  // STAGE 2a. frame-registry.ts is deliberately free of chrome APIs and DOM so
  // the hard parts — cross-frame ordering, dedup, lifecycle — are testable
  // here instead of only in a live browser.
  ["src/background/frame-registry.ts", "tests/_bundle-frames.mjs", "mergeFrameScans"],
  // FIX 1. matchAnswersToQuestions is plain data in / plain data out (labels,
  // identity keys, fillKind), so the ambiguity refusal is testable without a DOM.
  ["src/content-scripts/adapters/generic/fill.ts", "tests/_bundle-fillmatch.mjs", "matchAnswersToQuestions"],
  // STAGE 2c. The budget tracker is pure arithmetic over an injected clock; the
  // DOM half of harvesting needs real captured markup and is NOT faked.
  ["src/content-scripts/shared/options.ts", "tests/_bundle-harvest.mjs", "HarvestBudgetTracker"],
  ["src/content-scripts/adapters/generic/detect.ts", "tests/_bundle-detect.mjs", "isGenericPlaceholderOption"],
  // STAGE 3. request-budget.ts is pure (injected clock, no chrome.storage), so
  // the Pacific-midnight rollover and the quota classifier are testable here.
  ["src/lib/ai/request-budget.ts", "tests/_bundle-budget.mjs", "preflight"],
  // STAGE 4. Cache expiry and size validation are pure; the network half is
  // NOT faked (a fake would validate the fake — see HANDOFF.md §1).
  ["src/lib/ai/files-api.ts", "tests/_bundle-files.mjs", "pruneUploadCache"],
  // TASK B. ui-prefs.ts is pure data + pure functions.
  ["src/lib/ui-prefs.ts", "tests/_bundle-uiprefs.mjs", "lengthTargetFor"],
  // TASK E ACCEPTANCE GATE. transport.ts is pure (no chrome APIs, no DOM), so
  // its exact wire output can be pinned byte-for-byte against a golden file.
  ["src/lib/ai/transport.ts", "tests/_bundle-transport.mjs", "buildWireRequest"],
  // TASK E2 — all pure: shape builders, a schema transformer, and classifiers
  // over doc-transcribed error bodies. NO live request is made.
  ["src/lib/ai/providers/anthropic-provider.ts", "tests/_bundle-anthropic.mjs", "buildAnthropicBody"],
  ["src/lib/ai/providers/anthropic-schema.ts", "tests/_bundle-anthropic-schema.mjs", "adaptSchemaForAnthropic"],
  ["src/lib/ai/parity.ts", "tests/_bundle-parity.mjs", "validateStageBOutput"],
  ["src/lib/ai/provider.ts", "tests/_bundle-provider.mjs", "isRetryableClass"],
  ["src/lib/ai/dossier.ts", "tests/_bundle-dossier.mjs", "DOSSIER_SCHEMA"],
  // TASK E3 — capability routing, cache verdicts, key errors. All pure.
  ["src/lib/ai/providers/gemini-provider.ts", "tests/_bundle-gemini-provider.mjs", "geminiProvider"],
  ["src/lib/storage/provider-keys.ts", "tests/_bundle-provider-keys.mjs", "MissingProviderKeyError"],
  ["src/lib/ai/pacing.ts", "tests/_bundle-pacing.mjs", "decidePacing"],
  ["src/lib/ai/compose-queue.ts", "tests/_bundle-compose-queue.mjs", "ComposeQueue"],
  ["src/content-scripts/shared/listbox-ownership.ts", "tests/_bundle-listbox-ownership.mjs", "resolveOwningListbox"],
  ["src/content-scripts/shared/listbox-selection.ts", "tests/_bundle-listbox-selection.mjs", "matchOption"],
  ["src/lib/text/date-format.ts", "tests/_bundle-date-format.mjs", "parseKnownDate"],
  ["src/content-scripts/google-forms/filler.ts", "tests/_bundle-filler.mjs", "CLICK_EVENT_SEQUENCE"],
  ["src/lib/ai/model-config.ts", "tests/_bundle-model-config.mjs", "MODEL_OPTIONS"],
  // TASK E3b STEP 0 — the ORCHESTRATION golden. Pins what Stage A/B/compose
  // PASS IN (system instructions carrying §3 invariants, schema identity, part
  // order), which the transport golden cannot see. Captured PRE-extraction.
  ["src/lib/ai/gemini-client.ts", "tests/_bundle-orchestration.mjs", "buildDossier"],
];

for (const [entry, out] of bundles) {
  // esbuild is not a project dependency (Vite uses rolldown), so it comes from
  // npx. That needs a shell on Windows, hence execSync over execFileSync.
  execSync(
    `npx --yes esbuild ${entry} --bundle --format=esm --platform=node --outfile=${out} --log-level=error`,
    { stdio: "inherit" },
  );
}

let failed = 0;
for (const suite of [
  "tests/evidence-agreement.test.mjs",
  "tests/identity.test.mjs",
  "tests/frames.test.mjs",
  "tests/fill-match.test.mjs",
  "tests/harvest.test.mjs",
  "tests/quota.test.mjs",
  "tests/files-api.test.mjs",
  "tests/compose-modes.test.mjs",
  "tests/gemini-wire.test.mjs",
  "tests/anthropic.test.mjs",
  "tests/wiring.test.mjs",
  "tests/orchestration-golden.test.mjs",
  "tests/safety-retry.test.mjs",
  "tests/switchability.test.mjs",
  "tests/key-security.test.mjs",
  "tests/manifest.test.mjs",
  "tests/pacing.test.mjs",
  "tests/capability-source.test.mjs",
  "tests/compose-queue.test.mjs",
  "tests/dropdown-ownership.test.mjs",
  "tests/listbox-open.test.mjs",
  "tests/dates-and-uploads.test.mjs",
  "tests/theme-contrast.test.mjs",
  "tests/splash-notice.test.mjs",
  "tests/variants.test.mjs",
  "tests/profile-extract.test.mjs",
]) {
  try {
    execFileSync(process.execPath, [suite], { stdio: "inherit" });
  } catch {
    failed += 1;
  }
}

for (const [, out] of bundles) {
  rmSync(out, { force: true });
}
process.exit(failed === 0 ? 0 : 1);
