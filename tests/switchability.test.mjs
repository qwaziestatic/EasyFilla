// ═══════════════════════════════════════════════════════════════════════
// TASK E3c STEP 3 — THE SWITCHABILITY PROOF
//
// This is what closes "capabilities wired" versus "providers switchable".
// Everything before it proved the plumbing EXISTS; this proves a request
// actually LEAVES through a chosen provider.
//
// A mock provider is registered and selected, then Stage A and Stage B are run
// end to end. The mock asserts what it received. NO API KEY IS NEEDED and no
// network call is made — which is the point: switchability is a routing
// property, and routing can be proven without either vendor.
// ═══════════════════════════════════════════════════════════════════════

const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key ?? {});
        const out = {};
        keys.forEach((k) => {
          if (storage.has(k)) out[k] = storage.get(k);
        });
        return out;
      },
      set: async (items) => Object.entries(items).forEach(([k, v]) => storage.set(k, v)),
      remove: async (key) => (Array.isArray(key) ? key : [key]).forEach((k) => storage.delete(k)),
    },
    session: { get: async () => ({}), set: async () => {} },
  },
};

// Deliberately NO Gemini key — if anything still reached Gemini directly it
// would fail on the missing key, which is itself a useful signal.
globalThis.fetch = async () => {
  throw new Error("NETWORK REACHED — a call site bypassed the provider interface.");
};

// Registry and orchestration MUST come from the same bundle — see the
// re-export note in gemini-client.ts.
const { registerProvider, getProvider, buildDossier, answerFromDossier } = await import("./_bundle-orchestration.mjs");

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── The mock provider ────────────────────────────────────────────────────
const received = [];
const mock = {
  id: "gemini", // occupies the selected slot; identity is irrelevant to routing
  displayName: "Mock Provider",
  dataDestination: "nowhere (test double)",
  capabilities: {
    supportsFilesApi: false,
    maxInlineRequestBytes: 32 * 1024 * 1024,
    maxPerFileBytes: null,
    supportedFileMimeTypes: new Set(["application/pdf", "image/png"]),
    hasDailyQuota: false,
    learnsLimitsFromResponseHeaders: true,
  },
  activeModel: async () => "mock-model-1",
  perMinuteRequestLimit: async () => 60,
  complete: async (request) => {
    received.push(request);
    const isDossier = request.label === "dossier-build";
    return {
      text: isDossier
        ? JSON.stringify({
            identity: [{ key: "full_name", value: "Mock Person", source_filename: "cv.pdf", confidence: "high" }],
            contact: [], skills: [], preferences: [], education: [], experience: [],
          })
        : JSON.stringify([
            { question_id: 0, status: "answered", value: "Mock Person", evidence: [
              { dossier_path: "identity.full_name", source_filename: "cv.pdf", snippet: "Name: Mock Person", implied_value: "Mock Person" },
            ] },
          ]),
      structured: isDossier
        ? {
            identity: [{ key: "full_name", value: "Mock Person", source_filename: "cv.pdf", confidence: "high" }],
            contact: [], skills: [], preferences: [], education: [], experience: [],
          }
        : [
            { question_id: 0, status: "answered", value: "Mock Person", evidence: [
              { dossier_path: "identity.full_name", source_filename: "cv.pdf", snippet: "Name: Mock Person", implied_value: "Mock Person" },
            ] },
          ],
      usage: { inputTokens: 10, outputTokens: 20 },
      finishReason: "stop",
      provider: "gemini",
      model: "mock-model-1",
    };
  },
};

registerProvider(mock);
check("the mock is the selected provider", getProvider("gemini") === mock);

console.log("\n=== STAGE A runs end to end through the selected provider ===");
{
  received.length = 0;
  storage.delete("easyfilla.dossier");
  const file = new File([new Uint8Array(16).fill(3)], "cv.pdf", { type: "application/pdf" });

  const result = await buildDossier([file]);

  check("Stage A completed without touching the network", received.length === 1, `${received.length} complete() call(s)`);
  check("the dossier was built from the mock's response", result?.dossier?.identity?.full_name?.value === "Mock Person");

  const request = received[0];
  check("the mock received a system instruction", typeof request.system === "string" && request.system.length > 0);
  check("the mock received a schema", request.schema !== undefined);
  check("the mock received the label", request.label === "dossier-build");
  check("the mock received reasoningEffort (provider-neutral)", request.reasoningEffort === "medium");
  check(
    "the mock received the file as a PART, not as Gemini-shaped bytes",
    Array.isArray(request.parts) && request.parts.some((p) => p.kind === "document" || p.kind === "image"),
    JSON.stringify(request.parts?.map((p) => p.kind)),
  );
  check(
    "the filename is announced immediately before its bytes (source attribution)",
    request.parts[0]?.kind === "text" && request.parts[0]?.text?.includes("cv.pdf"),
  );

  // THE TRAP, proven at the interface: the orchestrator must NOT send maxTokens.
  check(
    "the orchestrator did NOT send maxTokens (Anthropic supplies its own default)",
    request.maxTokens === undefined,
    `maxTokens=${request.maxTokens}`,
  );
}

console.log("\n=== STAGE B runs end to end through the selected provider ===");
{
  received.length = 0;
  const dossier = {
    identity: { full_name: { value: "Mock Person", source_filename: "cv.pdf", confidence: "high" } },
    contact: {}, skills: {}, preferences: {}, education: [], experience: [],
  };
  const outcome = await answerFromDossier(dossier, [
    { index: 0, questionText: "Full name", type: "short_answer", options: [] },
  ], { chunkSize: 12 });

  check("Stage B completed without touching the network", received.length === 1, `${received.length} complete() call(s)`);
  check("an answer came back", outcome?.answers?.size >= 1 || outcome?.answers?.length >= 1, JSON.stringify(Object.keys(outcome ?? {})));

  const request = received[0];
  check("the mock received Stage B's system instruction", typeof request.system === "string" && request.system.length > 0);
  check("the mock received Stage B's schema", request.schema !== undefined);
  check("the label identifies the batch", /answer-batch/.test(request.label ?? ""), request.label);
  check("no maxTokens on Stage B either", request.maxTokens === undefined);
}

console.log("\n=== E3d.0: NO PATH sends user content to an unselected provider ===");
{
  // THE NON-NEGOTIABLE. Before E3d these three called Gemini directly. With
  // another provider selected that meant one of two failures:
  //   · a missing-Gemini-key error on a run the user configured correctly, or
  //   · the form's own text silently sent to Google — which makes the privacy
  //     disclosure FALSE, since it promises content goes to the chosen provider.
  //
  // `globalThis.fetch` throws on any call, so ANY direct Gemini traffic fails
  // the test loudly rather than passing unnoticed.
  const { matchAnswersWithGemini, generateElicitationPrompts, detectLanguageWithGemini } =
    await import("./_bundle-orchestration.mjs");

  const paths = [
    [
      "matchAnswersWithGemini (carries the form's question text)",
      () => matchAnswersWithGemini("document text", [{ index: 0, questionText: "Full name", type: "short_answer", options: [] }]),
    ],
    [
      "generateElicitationPrompts (carries the form's question text)",
      () => generateElicitationPrompts([{ index: 0, questionText: "Why this role?" }]),
    ],
    [
      "detectLanguageWithGemini (carries the form's own labels)",
      () => detectLanguageWithGemini(["Nombre completo", "Correo electrónico"]),
    ],
    // testProviderConnection is exercised separately: with NO key it must
    // short-circuit WITHOUT calling complete(), which is correct behaviour and
    // would fail a "went through the provider" assertion for the right reason.
  ];

  for (const [name, run] of paths) {
    received.length = 0;
    let networkError = null;
    try {
      await run();
    } catch (error) {
      if (/NETWORK REACHED/.test(error?.message ?? "")) networkError = error;
    }
    check(`${name} — ZERO direct Gemini traffic`, networkError === null, networkError ? "REACHED THE NETWORK" : "routed via complete()");
    check(`${name} — went through the selected provider`, received.length >= 1, `${received.length} complete() call(s)`);
  }
}

{
  // The connection test must report on the SELECTED provider, not Gemini.
  const { testProviderConnection } = await import("./_bundle-orchestration.mjs");
  storage.set("easyfilla.activeProvider", "gemini"); // the mock occupies this slot
  storage.set("geminiApiKey", "present-for-this-check");
  received.length = 0;
  const result = await testProviderConnection();
  check("the connection test succeeds through the mock", result.ok === true, result.message);
  check("and names the provider it actually tested", /Mock Provider/.test(result.message), result.message);
  check("it sent only a ping, never user content", received[0]?.parts?.[0]?.text === "ping");
  storage.delete("geminiApiKey");
}

console.log("\n=== the provenance layer cannot tell which provider ran ===");
{
  // §3 parity: Stage B's parsed output must satisfy the shared validator
  // regardless of who produced it. The mock is neither Gemini nor Anthropic.
  const { validateStageBOutput } = await import("./_bundle-parity.mjs");
  const mockOutput = {
    answers: [
      { question_id: 0, value: "Mock Person", evidence: [
        { dossier_path: "identity.full_name", source_filename: "cv.pdf", snippet: "Name: Mock Person", implied_value: "Mock Person" },
      ] },
    ],
  };
  const verdict = validateStageBOutput(mockOutput);
  check("a third, unknown provider's output satisfies the same validator", verdict.ok === true, JSON.stringify(verdict.issues));
}

console.log("\n=== E3d.2: every provider declares every capability EXPLICITLY ===");
{
  // A missing capability key reads as `undefined`, which is falsy, which means a
  // provider that simply FORGOT to declare `hasDailyQuota` renders exactly like
  // one that truthfully has none. There is no way to tell those apart at the
  // call site, so the completeness check has to live here.
  const REQUIRED = [
    "supportsFilesApi",
    "maxInlineRequestBytes",
    "maxPerFileBytes",
    "supportedFileMimeTypes",
    "hasDailyQuota",
    "learnsLimitsFromResponseHeaders",
    "hasMonthlySpendCap",
  ];
  // ⚠️ NOT via `getProvider` — the mock above was registered under the id
  // "gemini" and still occupies that slot, so the registry would hand back the
  // mock's capabilities and this would assert nothing. Import the real
  // implementations directly.
  const { geminiProvider } = await import("./_bundle-gemini-provider.mjs");
  const { createAnthropicProvider } = await import("./_bundle-anthropic.mjs");
  const anthropicProvider = createAnthropicProvider({
    loadApiKey: async () => null,
    resolveModel: async () => "claude-test",
    saveModel: async () => {},
  });

  for (const provider of [geminiProvider, anthropicProvider]) {
    const caps = provider.capabilities;
    const missing = REQUIRED.filter((key) => !(key in caps));
    check(`${provider.id} declares all ${REQUIRED.length} capabilities`, missing.length === 0, missing.join(", "));
    // `maxPerFileBytes` is legitimately null; none may be undefined.
    const undef = REQUIRED.filter((key) => caps[key] === undefined);
    check(`${provider.id} leaves no capability undefined`, undef.length === 0, undef.join(", "));
  }

  // The rule the sidepanel renderer depends on: these two are INDEPENDENT.
  // Gemini has a daily quota and no monthly cap; Anthropic the reverse. If a
  // future edit re-derives one from the other, this fails.
  const gemini = geminiProvider.capabilities;
  const anthropic = anthropicProvider.capabilities;
  check(
    "a monthly spend cap is NOT inferable from the absence of a daily quota",
    gemini.hasDailyQuota === true &&
      gemini.hasMonthlySpendCap === false &&
      anthropic.hasDailyQuota === false &&
      anthropic.hasMonthlySpendCap === true,
    `gemini(daily=${gemini.hasDailyQuota}, monthly=${gemini.hasMonthlySpendCap}) ` +
      `anthropic(daily=${anthropic.hasDailyQuota}, monthly=${anthropic.hasMonthlySpendCap})`,
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
