// ═══════════════════════════════════════════════════════════════════════
// TASK E3c STEP 0 — THE SAFETY-BLOCK RETRY
//
// Stage A's safety fallback is the one behaviour NEITHER golden covers: both
// capture only the happy path, so a regression here would be invisible to
// both. This file exists so the behaviour can be MOVED (into the Gemini
// provider, where it belongs) without being lost.
//
// WHY THE BEHAVIOUR EXISTS (§2): the Interactions API does not accept custom
// safety settings, so a false positive there is unappealable. Stage A's inputs
// are ID photos and personal letters — precisely the shape of a spurious
// block. generateContent DOES accept safetySettings, so a blocked dossier is
// retried there once with BLOCK_ONLY_HIGH rather than failing the whole build
// on one filter decision.
//
// WHY IT MUST NOT TRAVEL WITH THE ORCHESTRATOR: it is transport behaviour —
// two Gemini endpoints with different capabilities. Anthropic has no
// equivalent, and per §3 the orchestrator must not be able to tell which
// provider ran.
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
storage.set("geminiApiKey", "TEST-KEY-NOT-A-REAL-SECRET");

const recorded = [];
let responder = () => ({ steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }] });

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  recorded.push({ url: String(url), body });
  const payload = responder(recorded.length - 1, body, String(url));
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const { buildDossier } = await import("./_bundle-orchestration.mjs");

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const file = () => new File([new Uint8Array(32).fill(7)], "id-scan.pdf", { type: "application/pdf" });

// A safety block is an HTTP 200 with NO usable text and a block reason. That is
// what makes it dangerous: it looks like success to anything not inspecting
// promptFeedback / finishReason.
const BLOCKED = { promptFeedback: { blockReason: "SAFETY" }, candidates: [{ finishReason: "SAFETY" }] };
const GOOD = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              identity: [{ key: "full_name", value: "Test Person", source_filename: "id-scan.pdf", confidence: "high" }],
              contact: [], skills: [], preferences: [], education: [], experience: [],
            }),
          },
        ],
      },
    },
  ],
};

console.log("\n=== E3c STEP 0: Stage A safety-block retry ===");

{
  recorded.length = 0;
  storage.delete("easyfilla.dossier"); // force a build, not a cache hit
  // First call (Interactions) is blocked; the retry must succeed.
  responder = (index) => (index === 0 ? BLOCKED : GOOD);

  const result = await buildDossier([file()]);

  check("the blocked build does NOT throw — it retries", Boolean(result?.dossier));
  check("exactly two requests were made (one blocked, one retry)", recorded.length === 2, `${recorded.length} request(s)`);

  const first = recorded[0];
  const retry = recorded[1];

  check(
    "the FIRST request goes to the Interactions endpoint",
    first?.url.includes("/v1beta/interactions"),
    first?.url,
  );
  check(
    "the RETRY goes to generateContent, not Interactions",
    retry?.url.includes(":generateContent") && !retry?.url.includes("/interactions"),
    retry?.url,
  );

  // The whole point of the fallback: generateContent accepts safetySettings.
  const settings = retry?.body?.safetySettings;
  check("the retry carries safetySettings", Array.isArray(settings), JSON.stringify(settings)?.slice(0, 60));
  check(
    "every threshold is BLOCK_ONLY_HIGH (the loosest available — it does NOT disable filtering)",
    Array.isArray(settings) && settings.length === 4 && settings.every((s) => s.threshold === "BLOCK_ONLY_HIGH"),
    Array.isArray(settings) ? settings.map((s) => s.threshold).join(",") : "absent",
  );
  check(
    "all four harm categories are covered",
    Array.isArray(settings) &&
      ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].every((c) =>
        settings.some((s) => s.category === `HARM_CATEGORY_${c}`),
      ),
  );

  // The retry must send the SAME content — a fallback that quietly changed the
  // payload would be answering a different question.
  check(
    "the retry sends the same number of parts as the original",
    retry?.body?.contents?.[0]?.parts?.length === first?.body?.input?.length,
    `${retry?.body?.contents?.[0]?.parts?.length} vs ${first?.body?.input?.length}`,
  );
  check(
    "the retry preserves the system instruction",
    typeof retry?.body?.systemInstruction?.parts?.[0]?.text === "string" &&
      retry.body.systemInstruction.parts[0].text === first?.body?.system_instruction,
  );
  check(
    "the retry still requests structured output (via the generateContent spelling)",
    retry?.body?.generationConfig?.responseMimeType === "application/json" &&
      Boolean(retry?.body?.generationConfig?.responseSchema),
  );
  check(
    "and its schema types are UPPERCASED for proto3, per the §1 casing split",
    retry?.body?.generationConfig?.responseSchema?.type === "OBJECT",
    retry?.body?.generationConfig?.responseSchema?.type,
  );
}

console.log("\n=== the fallback fires ONLY on a safety block ===");

{
  // A non-safety empty response must NOT trigger the relaxed-threshold retry.
  // Retrying everything with loosened filters would quietly widen what gets
  // sent through reduced safety for reasons that have nothing to do with safety.
  recorded.length = 0;
  storage.delete("easyfilla.dossier");
  responder = () => ({ candidates: [{ finishReason: "MAX_TOKENS" }] });

  let threw = null;
  try {
    await buildDossier([file()]);
  } catch (error) {
    threw = error;
  }
  check("a MAX_TOKENS empty response throws rather than retrying", threw !== null);
  check("and does NOT make a relaxed-safety retry", recorded.length === 1, `${recorded.length} request(s)`);
  check(
    "no request carried safetySettings",
    recorded.every((r) => r.body?.safetySettings === undefined),
  );
}

{
  // A clean success must not retry either.
  recorded.length = 0;
  storage.delete("easyfilla.dossier");
  responder = () => ({ steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({
    identity: [{ key: "full_name", value: "Test Person", source_filename: "id-scan.pdf", confidence: "high" }],
    contact: [], skills: [], preferences: [], education: [], experience: [],
  }) }] }] });

  await buildDossier([file()]);
  check("a successful build makes exactly one request", recorded.length === 1, `${recorded.length} request(s)`);
  check("and stays on Interactions", recorded[0]?.url.includes("/v1beta/interactions"));
}

console.log("\n=== a block that survives the retry fails NON-retryably ===");

{
  // If the relaxed retry is ALSO blocked, the build must fail and must not be
  // marked retryable — re-running would burn quota on a decision that will not
  // change. §4c's retry-storm lesson.
  recorded.length = 0;
  storage.delete("easyfilla.dossier");
  responder = () => BLOCKED;

  let threw = null;
  try {
    await buildDossier([file()]);
  } catch (error) {
    threw = error;
  }
  check("it throws", threw !== null);
  check("the failure names the safety block", /block/i.test(threw?.message ?? ""), threw?.message?.slice(0, 70));
  check("and is NOT retryable", threw?.retryable === false, `retryable=${threw?.retryable}`);
  check("the retry was still attempted (two requests)", recorded.length === 2, `${recorded.length} request(s)`);
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
