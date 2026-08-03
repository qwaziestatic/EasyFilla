// ═══════════════════════════════════════════════════════════════════════
// TASK E3b STEP 0 — THE ORCHESTRATION GOLDEN
//
// The transport golden pins what the TRANSPORT emits for fixed inputs. It says
// nothing about what Stage A / Stage B / compose PASS IN. Extraction can change
// a system instruction, swap a schema, reorder parts or add maxTokens while the
// transport golden stays perfectly green.
//
// That matters because the system instructions CARRY §3 INVARIANTS:
//   · the evidence-ceiling rule (length is a ceiling, never a quota to fill)
//   · the anti-fabrication / strict-grounding rules
//   · "evidence: [] is correct and expected" → needs_user_input
// Dropping a clause there is a PROVENANCE failure that no transport test can
// see. This file is the only thing that would catch it.
//
// ── WHY THIS CAPTURE IS SEAM-AGNOSTIC ────────────────────────────────────
// It records the REQUEST BODIES the orchestration ultimately produces, by
// stubbing `fetch`. Today those come from callGemini; after extraction they
// come from complete() → the Gemini provider. Same bodies either way, so the
// golden survives the refactor it exists to police.
//
// ⚠️ CAPTURED PRE-EXTRACTION. It is evidence only because of that ordering and
// cannot be recreated afterwards.
//
// Regenerate ONLY with a deliberate, reviewed reason:
//     UPDATE_ORCHESTRATION_GOLDEN=1 node tests/orchestration-golden.test.mjs
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const GOLDEN_PATH = "tests/golden/orchestration.golden.json";

// ── Environment stubs ────────────────────────────────────────────────────
// The orchestration reaches for chrome.storage and fetch. Both are replaced
// with deterministic doubles; nothing else about the code under test changes.
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
      set: async (items) => {
        Object.entries(items).forEach(([k, v]) => storage.set(k, v));
      },
      remove: async (key) => {
        (Array.isArray(key) ? key : [key]).forEach((k) => storage.delete(k));
      },
    },
    session: { get: async () => ({}), set: async () => {} },
  },
};
// A key must exist or every entry point short-circuits on MissingApiKeyError.
storage.set("geminiApiKey", "TEST-KEY-NOT-A-REAL-SECRET");

const recorded = [];
let respondWith = () => ({ steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }] });

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  recorded.push({ url: String(url), body });
  const payload = respondWith(recorded.length - 1, body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const { buildDossier, answerFromDossier, composeAnswers } = await import("./_bundle-orchestration.mjs");

// ── Deterministic fixtures ───────────────────────────────────────────────
// Fixed bytes, fixed names, fixed questions. Nothing random, nothing dated.
function fixtureFile(name, type, byte) {
  const bytes = new Uint8Array(64).fill(byte);
  return new File([bytes], name, { type });
}

const FILES = [
  fixtureFile("cv.pdf", "application/pdf", 1),
  fixtureFile("id-photo.png", "image/png", 2),
];

const QUESTIONS = [
  { index: 0, questionText: "Full name", type: "short_answer", options: [] },
  { index: 1, questionText: "Why do you want this role?", type: "paragraph", options: [] },
];

const DOSSIER = {
  identity: { full_name: { value: "Test Person", source_filename: "cv.pdf", confidence: "high" } },
  contact: {},
  skills: {},
  preferences: {},
  education: [],
  experience: [],
};

const COMPOSE_ITEMS = [
  {
    index: 1,
    questionText: "Why do you want this role?",
    isEssay: true,
    seed: "worked on distributed systems; want more impact",
    guidance: "",
    length: "medium",
    tone: "neutral",
    variants: 1,
  },
];

// Canned responses, shaped so each entry point parses and completes.
const DOSSIER_RESPONSE = {
  steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({
    identity: [{ key: "full_name", value: "Test Person", source_filename: "cv.pdf", confidence: "high" }],
    contact: [], skills: [], preferences: [], education: [], experience: [],
  }) }] }],
};
const ANSWER_RESPONSE = {
  steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({
    answers: [{ question_id: 0, value: "Test Person", evidence: [
      { dossier_path: "identity.full_name", source_filename: "cv.pdf", snippet: "Name: Test Person", implied_value: "Test Person" },
    ] }],
  }) }] }],
};
const COMPOSE_RESPONSE = {
  steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify([
    { questionIndex: 1, draft: "A grounded answer.", notFound: false, groundedDocuments: ["cv.pdf"], gaps: [] },
  ]) }] }],
};

// ── Normalisation ────────────────────────────────────────────────────────
// Base64 payloads are replaced by a stable digest: the golden must pin that a
// part is PRESENT, in ORDER, with the right mime type — not carry 64 KB of
// fixture bytes. Ordering is preserved because ordering is under test.
function normalizeBody(body) {
  const clone = JSON.parse(JSON.stringify(body));
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        if (key === "data" && typeof value === "string") {
          out[key] = `base64:sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    }
    return node;
  };
  return walk(clone);
}

// ── Drive the three entry points ─────────────────────────────────────────
async function capture() {
  const snapshot = { _note: "Orchestration inputs (HANDOFF §6b / E3b). Any diff is a failure.", stages: {} };

  recorded.length = 0;
  respondWith = () => DOSSIER_RESPONSE;
  await buildDossier(FILES);
  snapshot.stages.stageA_buildDossier = recorded.map((r) => normalizeBody(r.body));

  recorded.length = 0;
  respondWith = () => ANSWER_RESPONSE;
  await answerFromDossier(DOSSIER, QUESTIONS, { chunkSize: 12 });
  snapshot.stages.stageB_answerFromDossier = recorded.map((r) => normalizeBody(r.body));

  recorded.length = 0;
  respondWith = () => COMPOSE_RESPONSE;
  await composeAnswers("cv.pdf contents here", ["cv.pdf"], COMPOSE_ITEMS, {});
  snapshot.stages.compose = recorded.map((r) => normalizeBody(r.body));

  return snapshot;
}

const actual = await capture();
const serialized = `${JSON.stringify(actual, null, 2)}\n`;

if (process.env.UPDATE_ORCHESTRATION_GOLDEN === "1") {
  mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
  writeFileSync(GOLDEN_PATH, serialized, "utf8");
  const counts = Object.entries(actual.stages).map(([k, v]) => `${k}=${v.length}`).join(", ");
  console.log(`\n  orchestration golden WRITTEN → ${GOLDEN_PATH}`);
  console.log(`  requests captured: ${counts}\n`);
  process.exit(0);
}

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n=== E3b GATE: orchestration inputs are unchanged ===");

if (!existsSync(GOLDEN_PATH)) {
  console.log(`  FAIL ❌  golden missing at ${GOLDEN_PATH}`);
  console.log("          Run: UPDATE_ORCHESTRATION_GOLDEN=1 node tests/orchestration-golden.test.mjs");
  process.exit(1);
}

const expected = readFileSync(GOLDEN_PATH, "utf8");
check("every orchestration request body matches the golden byte-for-byte", serialized === expected);

if (serialized !== expected) {
  const a = serialized.split("\n");
  const b = expected.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      console.log(`\n  FIRST DIFFERENCE at line ${i + 1}:`);
      console.log(`    golden : ${b[i] ?? "(end)"}`);
      console.log(`    actual : ${a[i] ?? "(end)"}`);
      break;
    }
  }
  console.log(
    "\n  ⚠️  Orchestration INPUTS changed. The transport golden cannot see this.\n" +
      "      If a system instruction lost a §3 clause, that is a PROVENANCE bug.\n",
  );
}

// ── §3 INVARIANTS, ASSERTED BY NAME ──────────────────────────────────────
// So a dropped anti-fabrication clause identifies itself instead of appearing
// as one anonymous line in a large diff.
console.log("\n=== §3 invariants present in the system instructions ===");
const allText = JSON.stringify(actual);

const INVARIANTS = [
  ["Stage A extracts only what documents state", /Omit anything the documents do not state/i],
  ["Stage B strict grounding", /ONLY use facts from|STRICT GROUNDING/i],
  ["compose hard-fail on empty seed", /HARD-FAIL RULE/i],
  ["compose never pads with invention", /NEVER pad with invention/i],
  ["evidence-ceiling: length is a ceiling, not a quota", /CEILING GOVERNED BY EVIDENCE/i],
  ["evidence-ceiling: never pad to hit a word count", /NEVER pad to reach/i],
  ["tone changes register only, never adds a claim", /Tone changes register only/i],
  ["shortfall goes in gaps rather than invention", /record the shortfall in `gaps`|gaps/i],
];

INVARIANTS.forEach(([name, pattern]) => {
  check(`§3 — ${name}`, pattern.test(allText));
});

console.log("\n=== structural facts the transport golden cannot see ===");
{
  const stageA = actual.stages.stageA_buildDossier[0];
  const stageB = actual.stages.stageB_answerFromDossier[0];

  check("Stage A sends a system instruction", typeof stageA?.system_instruction === "string" && stageA.system_instruction.length > 0);
  check("Stage A sends a response schema", Boolean(stageA?.response_format?.schema));
  check(
    "Stage A announces each filename immediately BEFORE its bytes (source attribution depends on order)",
    stageA.input[0]?.text?.includes("cv.pdf") && stageA.input[1]?.data !== undefined,
    `input[0]=${stageA.input[0]?.type}, input[1]=${stageA.input[1]?.type}`,
  );
  check("Stage A sends both fixture files", JSON.stringify(stageA.input).includes("id-photo.png"));
  check("Stage B sends a response schema", Boolean(stageB?.response_format?.schema));
  check(
    "Stage B's schema carries the evidence fields §3 derives from",
    ["dossier_path", "source_filename", "snippet", "implied_value"].every((f) => JSON.stringify(stageB.response_format.schema).includes(f)),
  );

  // THE TRAP, pinned: Gemini must NOT gain a maxTokens it never had. Anthropic
  // needs max_tokens; supplying it from the orchestrator would silently change
  // every real Gemini request while the transport golden stayed green.
  const anyMaxTokens = Object.values(actual.stages).flat().some((b) => b?.generation_config?.max_output_tokens !== undefined);
  check(
    "no orchestration stage sends max_output_tokens to Gemini (the Anthropic trap)",
    anyMaxTokens === false,
    "Anthropic supplies its own default INSIDE its provider; the orchestrator must not",
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
