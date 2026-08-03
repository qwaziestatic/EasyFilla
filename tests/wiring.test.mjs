// TASK E3 — wiring: capability-gated routing, cache invalidation on provider
// switch, the misconfigured-provider error, and cross-provider file isolation.
//
// ⚠️ NO LIVE REQUEST. These assert routing DECISIONS and cache verdicts, which
// are pure. Whether either API accepts what we send remains unverified (§1b).
import { geminiProvider } from "./_bundle-gemini-provider.mjs";
import { createAnthropicProvider, toAnthropicBlocks, AnthropicContentError } from "./_bundle-anthropic.mjs";
import { dossierCacheKey, dossierReuseVerdict, dossierRetargetVerdict } from "./_bundle-dossier.mjs";
import { MissingProviderKeyError } from "./_bundle-provider-keys.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const anthropic = createAnthropicProvider({
  loadApiKey: async () => "k",
  resolveModel: async () => "claude-sonnet-5",
});

console.log("\n=== E3: capabilities are declared, not inferred from identity ===");
{
  const required = [
    "supportsFilesApi",
    "maxInlineRequestBytes",
    "maxPerFileBytes",
    "supportedFileMimeTypes",
    "hasDailyQuota",
    "learnsLimitsFromResponseHeaders",
  ];
  [["gemini", geminiProvider], ["anthropic", anthropic]].forEach(([name, provider]) => {
    required.forEach((field) => {
      check(`${name} declares ${field}`, field in provider.capabilities, String(provider.capabilities[field]));
    });
  });
}

console.log("\n=== E3: the two providers genuinely differ (so capability gating is load-bearing) ===");
{
  check(
    "only Gemini has a Files API path in EasyFilla",
    geminiProvider.capabilities.supportsFilesApi === true && anthropic.capabilities.supportsFilesApi === false,
    "Anthropic HAS one, but ours is not implemented (§1b) — the flag describes this code, not the vendor",
  );
  check(
    "only Gemini has a daily quota",
    geminiProvider.capabilities.hasDailyQuota === true && anthropic.capabilities.hasDailyQuota === false,
    "Anthropic is per-minute buckets + a monthly spend cap (§1b)",
  );
  check(
    "only Anthropic learns limits from response headers",
    anthropic.capabilities.learnsLimitsFromResponseHeaders === true &&
      geminiProvider.capabilities.learnsLimitsFromResponseHeaders === false,
  );
  check(
    "inline ceilings differ (18 MB Gemini vs 32 MB Anthropic)",
    geminiProvider.capabilities.maxInlineRequestBytes !== anthropic.capabilities.maxInlineRequestBytes,
    `${geminiProvider.capabilities.maxInlineRequestBytes / 1024 / 1024} vs ${anthropic.capabilities.maxInlineRequestBytes / 1024 / 1024} MB`,
  );
}

console.log("\n=== E3: capability-gated upload routing ===");
{
  // The routing rule Stage A applies, expressed here as the decision itself.
  const route = (capabilities, encodedBytes) => {
    const over = encodedBytes > capabilities.maxInlineRequestBytes;
    if (!over) return "inline";
    return capabilities.supportsFilesApi ? "files-api" : "reject-named-files";
  };

  check("small set → inline on Gemini", route(geminiProvider.capabilities, 1_000_000) === "inline");
  check("small set → inline on Anthropic", route(anthropic.capabilities, 1_000_000) === "inline");
  check(
    "oversized set → Files API on Gemini",
    route(geminiProvider.capabilities, 25 * 1024 * 1024) === "files-api",
  );
  check(
    "oversized set → REJECT WITH NAMED FILES on Anthropic, never a nonexistent upload path",
    route(anthropic.capabilities, 40 * 1024 * 1024) === "reject-named-files",
  );
  check(
    "a set between the two ceilings is inline on Anthropic but Files-API on Gemini",
    route(geminiProvider.capabilities, 20 * 1024 * 1024) === "files-api" &&
      route(anthropic.capabilities, 20 * 1024 * 1024) === "inline",
    "20 MB — the ceilings are genuinely different, so identity-based branching would be wrong here",
  );
}

console.log("\n=== E3: a Gemini file URI must NEVER reach Anthropic ===");
{
  let thrown = null;
  try {
    toAnthropicBlocks([
      { kind: "document", mimeType: "application/pdf", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc" },
    ]);
  } catch (error) {
    thrown = error;
  }
  check("it is refused, not forwarded", thrown instanceof AnthropicContentError);
  check("and the reason says file references are not portable", /not portable/i.test(thrown?.message ?? ""));
  check(
    "the message does not pretend an Anthropic upload happened",
    /not implemented/i.test(thrown?.message ?? ""),
    thrown?.message?.slice(0, 80) + "…",
  );
}

console.log("\n=== E3: provider switching invalidates the dossier cache ===");
{
  const hash = "cv.pdf:1234:abcd";
  const cached = {
    key: dossierCacheKey(hash, "gemini", "gemini-3.5-flash-lite"),
    dossier: {},
    fileCount: 1,
    factCount: 5,
    builtAt: 0,
    model: "gemini-3.5-flash-lite",
    provider: "gemini",
  };

  check(
    "same provider + model + files → reuse",
    dossierReuseVerdict(cached, hash, "gemini", "gemini-3.5-flash-lite").reuse === true,
  );

  const switched = dossierReuseVerdict(cached, hash, "anthropic", "claude-sonnet-5");
  check("switching provider → NO reuse", switched.reuse === false);
  check(
    "and the reason names both providers so the user can be told what is rebuilding",
    /gemini/.test(switched.reason) && /anthropic/.test(switched.reason),
    switched.reason,
  );
  check(
    "the reason explains WHY, not just that it changed",
    /attribute one provider's reading to the other|extraction differs/i.test(switched.reason),
  );

  const modelChanged = dossierReuseVerdict(cached, hash, "gemini", "gemini-3.6-flash");
  check("changing model within a provider → NO reuse", modelChanged.reuse === false);
  check("and names the model change", /gemini-3\.6-flash/.test(modelChanged.reason), modelChanged.reason);

  const filesChanged = dossierReuseVerdict(cached, "different-hash", "gemini", "gemini-3.5-flash-lite");
  check("changing the file set → NO reuse", filesChanged.reuse === false);

  check("no cached dossier → NO reuse, with a reason", dossierReuseVerdict(null, hash, "gemini", "m").reuse === false);

  // ── E3d.1: the SETTINGS-PAGE verdict, which has no file-set hash ──────────
  // Regression: the settings page originally called dossierReuseVerdict with a
  // placeholder hash. Provider and model matched, so it fell through to the
  // final branch and told the user "the uploaded file set has changed" — a
  // claim about files the settings page cannot see, shown to a user who had
  // changed nothing. The hash-free verdict must stay silent instead.
  check(
    "same provider + model → NO rebuild warning, even with no hash available",
    dossierRetargetVerdict(cached, "gemini", "gemini-3.5-flash-lite").rebuild === false,
  );
  check(
    "and it never claims the file set changed, because it cannot know that",
    !/file set/i.test(JSON.stringify(dossierRetargetVerdict(cached, "gemini", "gemini-3.5-flash-lite"))),
  );

  const retargeted = dossierRetargetVerdict(cached, "anthropic", "claude-sonnet-5");
  check("switching provider → rebuild, with a reason", retargeted.rebuild === true);
  check(
    "the reason names both providers",
    /gemini/.test(retargeted.reason) && /anthropic/.test(retargeted.reason),
    retargeted.reason,
  );
  check(
    "changing model within a provider → rebuild",
    dossierRetargetVerdict(cached, "gemini", "gemini-3.6-flash").rebuild === true,
  );
  check(
    "no dossier at all → nothing to warn about",
    dossierRetargetVerdict(null, "gemini", "gemini-3.5-flash-lite").rebuild === false,
  );
  check(
    "a pre-provider dossier → rebuild, and says the builder is unknown",
    dossierRetargetVerdict({ ...cached, provider: undefined }, "gemini", "gemini-3.5-flash-lite").reason ===
      "the cached dossier predates per-provider caching, so which provider built it is unknown",
  );
}

{
  // A dossier cached before per-provider keying must NOT be assumed to match.
  const legacy = { key: "cv.pdf:1:a", dossier: {}, fileCount: 1, factCount: 1, builtAt: 0, model: "m" };
  const verdict = dossierReuseVerdict(legacy, "cv.pdf:1:a", "gemini", "m");
  check("a pre-provider cached dossier is NOT silently reused", verdict.reuse === false);
  check(
    "and the reason says which provider built it is unknown",
    /unknown/i.test(verdict.reason),
    verdict.reason,
  );
}

console.log("\n=== E3: the cache key itself ===");
{
  const a = dossierCacheKey("hash", "gemini", "m1");
  const b = dossierCacheKey("hash", "anthropic", "m1");
  const c = dossierCacheKey("hash", "gemini", "m2");
  check("provider is part of the key", a !== b);
  check("model is part of the key", a !== c);
  check("the content hash is still present (file changes still invalidate)", a.includes("hash"));
}

console.log("\n=== E3: the misconfigured-provider error is specific ===");
{
  const err = new MissingProviderKeyError("anthropic", "Anthropic Claude");
  check("it names the provider whose key is missing", /Anthropic Claude/.test(err.message));
  check("it says what to do", /Settings/i.test(err.message));
  check(
    "it explains that the OTHER provider's key will not be substituted",
    /will not be used|per provider/i.test(err.message),
    err.message.slice(0, 100) + "…",
  );
  check("it is not a generic AI error", !/something went wrong|AI request failed/i.test(err.message));
  check("it carries the provider id for the UI", err.provider === "anthropic");
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
