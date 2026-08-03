// ─────────────────────────────────────────────────────────────────────────
// 0c — ASSUMED CAPABILITIES ARE MARKED, LABELLED, AND EXPLAIN THEIR FAILURE
//
// Gemini's ListModels carries no capability flags, so `supportsStructuredOutputs`
// and `supportsPdf` come back true because THIS APP ASSUMES it. Anthropic reads
// the same two from a per-model `capabilities` object (§1b).
//
// Before 0c that difference existed only in a comment: the data was identical,
// so the UI could not warn and a failure could not name the cause.
// ─────────────────────────────────────────────────────────────────────────
import { diagnoseAssumedCapability } from "./_bundle-provider.mjs";
import { GEMINI_CAPABILITY_SOURCE } from "./_bundle-gemini-provider.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n=== 0c: the two sources are distinguishable in the DATA ===");
{
  check("Gemini declares its capabilities ASSUMED", GEMINI_CAPABILITY_SOURCE === "assumed", GEMINI_CAPABILITY_SOURCE);
}

console.log("\n=== 0c: an assumed-capability failure names the assumption ===");
{
  const schemaFailure = diagnoseAssumedCapability({
    errorClass: "invalid-model",
    hadSchema: true,
    hadFileParts: false,
    capabilitySource: "assumed",
    model: "gemini-3.6-flash",
    providerName: "Google Gemini",
  });
  check("a schema request that 404s produces a diagnosis", schemaFailure !== null);
  check("it names the model", /gemini-3\.6-flash/.test(schemaFailure ?? ""));
  check("it names structured output as the suspect", /structured output/.test(schemaFailure ?? ""));
  check(
    "it says the ASSUMPTION may be wrong, not the user's settings",
    /assum/i.test(schemaFailure ?? "") && /rather than your/i.test(schemaFailure ?? ""),
    schemaFailure ?? "",
  );
  check("it tells the user what to do", /try another model/i.test(schemaFailure ?? ""));

  const fileFailure = diagnoseAssumedCapability({
    errorClass: "invalid-request",
    hadSchema: false,
    hadFileParts: true,
    capabilitySource: "assumed",
    model: "gemini-3.6-flash",
    providerName: "Google Gemini",
  });
  check("a file request names file input as the suspect", /file input/.test(fileFailure ?? ""));
  check("and does NOT blame structured output it never asked for", !/structured output/.test(fileFailure ?? ""));

  const both = diagnoseAssumedCapability({
    errorClass: "invalid-model",
    hadSchema: true,
    hadFileParts: true,
    capabilitySource: "assumed",
    model: "m",
    providerName: "Google Gemini",
  });
  check("a request using both names both", /structured output/.test(both ?? "") && /file input/.test(both ?? ""));
}

console.log("\n=== 0c: the diagnosis is WITHHELD when it would be misleading ===");
{
  // This is the half that keeps the feature honest. A diagnosis attached to
  // every failure is noise that trains users to ignore it.
  check(
    "a REPORTED capability failing is never explained away as our guess",
    diagnoseAssumedCapability({
      errorClass: "invalid-model",
      hadSchema: true,
      hadFileParts: true,
      capabilitySource: "reported",
      model: "claude-sonnet-5",
      providerName: "Anthropic Claude",
    }) === null,
    "Anthropic reports capabilities, so a failure there is a stale list or a provider bug",
  );
  check(
    "a request that exercised NO assumed capability gets no diagnosis",
    diagnoseAssumedCapability({
      errorClass: "invalid-model",
      hadSchema: false,
      hadFileParts: false,
      capabilitySource: "assumed",
      model: "m",
      providerName: "Google Gemini",
    }) === null,
    "a plain text request cannot have failed on structured output or PDF support",
  );
  for (const errorClass of ["auth", "rate-limit-per-minute", "network", "timeout", "safety-blocked", "overloaded"]) {
    check(
      `a ${errorClass} failure is not blamed on capabilities`,
      diagnoseAssumedCapability({
        errorClass,
        hadSchema: true,
        hadFileParts: true,
        capabilitySource: "assumed",
        model: "m",
        providerName: "Google Gemini",
      }) === null,
    );
  }
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
