// ═══════════════════════════════════════════════════════════════════════
// TASK E ACCEPTANCE GATE — Gemini request bodies must be BYTE-IDENTICAL
//
// §1 of HANDOFF.md is a table of four separate occasions on which the Gemini
// wire format was "corrected" from memory and broken. Moving that transport
// behind a provider interface is exactly the kind of change that looks safe
// and isn't: nothing about it is supposed to alter a single byte of the
// request, and nothing but a byte-level comparison can prove that.
//
// This file captures every request shape the transport can emit and compares
// it against a committed golden file. ANY difference is a FAILURE, not a
// detail to rationalise.
//
// The matrix deliberately covers, per §6b.2:
//   · both transports        — interactions AND generateContent
//   · all three part variants — text, inline base64 bytes, Files-API `uri`
//   · schema present/absent   — the casing split lives here
//   · system instruction, thinking level, max tokens, relaxed safety
//   · the headers, because `Api-Revision: 2026-05-20` is part of the contract
//
// To regenerate INTENTIONALLY (only when a change to the wire format is
// deliberate and doc-backed, per §1):
//     UPDATE_GEMINI_GOLDEN=1 node tests/gemini-wire.test.mjs
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildWireRequest, headersFor, INTERACTIONS_API_REVISION } from "./_bundle-transport.mjs";

const GOLDEN_PATH = "tests/golden/gemini-wire.golden.json";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── The matrix ───────────────────────────────────────────────────────────
// Fixed, boring inputs. Nothing random, nothing time-dependent — the whole
// point is that the same input produces the same bytes forever.

const SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_id: { type: "integer" },
          value: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dossier_path: { type: "string" },
                source_filename: { type: "string" },
                snippet: { type: "string" },
                implied_value: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const TEXT_PART = { kind: "text", text: "Extract the applicant's full name." };
const INLINE_IMAGE_PART = { kind: "image", mimeType: "image/png", data: "aGVsbG8td29ybGQ=" };
const INLINE_DOC_PART = { kind: "document", mimeType: "application/pdf", data: "JVBERi0xLjQK" };
// STAGE 4 variant: uri set, data deliberately absent.
const URI_DOC_PART = { kind: "document", mimeType: "application/pdf", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123" };
const URI_IMAGE_PART = { kind: "image", mimeType: "image/jpeg", uri: "https://generativelanguage.googleapis.com/v1beta/files/def-456" };

const CASES = [
  {
    name: "text only, no schema",
    request: { model: "gemini-3.6-flash", parts: [TEXT_PART] },
  },
  {
    name: "text only, with schema (schema casing split)",
    request: { model: "gemini-3.6-flash", parts: [TEXT_PART], responseSchema: SCHEMA },
  },
  {
    name: "text + system instruction + thinking + maxTokens",
    request: {
      model: "gemini-3.6-flash",
      parts: [TEXT_PART],
      systemInstruction: "You are a careful extractor. Cite every value.",
      thinkingLevel: "medium",
      maxOutputTokens: 4096,
    },
  },
  {
    name: "PART VARIANT 1 — inline image bytes",
    request: { model: "gemini-3.5-flash-lite", parts: [TEXT_PART, INLINE_IMAGE_PART] },
  },
  {
    name: "PART VARIANT 2 — inline document bytes",
    request: { model: "gemini-3.5-flash-lite", parts: [TEXT_PART, INLINE_DOC_PART] },
  },
  {
    name: "PART VARIANT 3 — Files API uri (document)",
    request: { model: "gemini-3.5-flash-lite", parts: [TEXT_PART, URI_DOC_PART] },
  },
  {
    name: "PART VARIANT 3 — Files API uri (image)",
    request: { model: "gemini-3.5-flash-lite", parts: [TEXT_PART, URI_IMAGE_PART] },
  },
  {
    name: "mixed: text + inline + uri in one request",
    request: {
      model: "gemini-3.5-flash-lite",
      parts: [TEXT_PART, INLINE_IMAGE_PART, URI_DOC_PART],
      responseSchema: SCHEMA,
      systemInstruction: "Dossier build.",
    },
  },
  {
    name: "relaxed safety (generateContent-only field)",
    request: { model: "gemini-3.5-flash-lite", parts: [TEXT_PART, INLINE_IMAGE_PART], relaxedSafety: true },
  },
  {
    name: "full house — every field set at once",
    request: {
      model: "gemini-3.6-flash",
      parts: [TEXT_PART, INLINE_DOC_PART, URI_IMAGE_PART],
      systemInstruction: "Answer strictly from the dossier.",
      responseSchema: SCHEMA,
      thinkingLevel: "high",
      maxOutputTokens: 8192,
      relaxedSafety: true,
    },
  },
];

const TRANSPORTS = ["interactions", "generateContent"];

function capture() {
  const snapshot = {
    // Recorded so a future reader can see WHAT contract this golden pins.
    _note:
      "Byte-identical gate for the Gemini wire format (HANDOFF.md §1, §6b.2). " +
      "Any diff is a failure. Regenerate only with a doc-backed reason.",
    interactionsApiRevision: INTERACTIONS_API_REVISION,
    headers: {},
    requests: {},
  };

  for (const transport of TRANSPORTS) {
    // The API key is a fixed placeholder: we are pinning the header SHAPE,
    // never a real secret. No key is written to disk by this test.
    snapshot.headers[transport] = headersFor(transport, "TEST-KEY-NOT-A-REAL-SECRET");
    for (const testCase of CASES) {
      snapshot.requests[`${transport} :: ${testCase.name}`] = buildWireRequest(transport, testCase.request);
    }
  }
  return snapshot;
}

const actual = capture();
const serialized = `${JSON.stringify(actual, null, 2)}\n`;

if (process.env.UPDATE_GEMINI_GOLDEN === "1") {
  mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
  writeFileSync(GOLDEN_PATH, serialized, "utf8");
  console.log(`\n  golden file WRITTEN → ${GOLDEN_PATH}`);
  console.log(`  ${Object.keys(actual.requests).length} request shapes captured across ${TRANSPORTS.length} transports.\n`);
  process.exit(0);
}

console.log("\n=== TASK E GATE: Gemini wire format is byte-identical ===");

if (!existsSync(GOLDEN_PATH)) {
  console.log(`  FAIL ❌  golden file missing at ${GOLDEN_PATH}`);
  console.log("          Run: UPDATE_GEMINI_GOLDEN=1 node tests/gemini-wire.test.mjs");
  process.exit(1);
}

const expected = readFileSync(GOLDEN_PATH, "utf8");

check(
  `all ${Object.keys(actual.requests).length} request shapes match the golden file byte-for-byte`,
  serialized === expected,
  serialized === expected ? undefined : "SEE DIFF BELOW",
);

if (serialized !== expected) {
  // Point at the first differing line — a 400-line JSON diff is unreadable.
  const a = serialized.split("\n");
  const b = expected.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      console.log(`\n  FIRST DIFFERENCE at line ${i + 1}:`);
      console.log(`    golden : ${b[i] ?? "(end of file)"}`);
      console.log(`    actual : ${a[i] ?? "(end of file)"}`);
      break;
    }
  }
  console.log(
    "\n  ⚠️  The Gemini wire format CHANGED. Per HANDOFF.md §1 this is a failure\n" +
      "      unless you have a freshly fetched doc URL justifying it. Four past\n" +
      "      sessions broke this exact contract on belief alone.\n",
  );
}

// Spot-checks that assert the SETTLED facts by name, so a future reader sees
// them fail individually rather than only as an opaque golden mismatch.
console.log("\n=== SETTLED facts, asserted individually ===");

{
  const h = headersFor("interactions", "K");
  check("Api-Revision is sent on the Interactions path", h["Api-Revision"] === "2026-05-20", h["Api-Revision"]);
  check("the pinned revision is still 2026-05-20", INTERACTIONS_API_REVISION === "2026-05-20");
  const g = headersFor("generateContent", "K");
  check("Api-Revision is NOT sent on generateContent", g["Api-Revision"] === undefined);
  check("both paths send x-goog-api-key", h["x-goog-api-key"] === "K" && g["x-goog-api-key"] === "K");
}

{
  const body = buildWireRequest("interactions", { model: "m", parts: [TEXT_PART], responseSchema: SCHEMA }).body;
  check(
    "Interactions uses response_format {type:text, mime_type:application/json, schema}",
    body.response_format?.type === "text" && body.response_format?.mime_type === "application/json" && Boolean(body.response_format?.schema),
    JSON.stringify(body.response_format?.type) + "/" + JSON.stringify(body.response_format?.mime_type),
  );
  check(
    "Interactions schema types stay LOWERCASE (standard JSON Schema)",
    body.response_format.schema.type === "object",
    body.response_format.schema.type,
  );
  check("Interactions input is an ARRAY of typed objects, not {parts:[…]}", Array.isArray(body.input));
  check("Interactions sends store:false", body.store === false);
}

{
  const body = buildWireRequest("generateContent", { model: "m", parts: [TEXT_PART], responseSchema: SCHEMA }).body;
  check(
    "generateContent schema types are UPPERCASED (proto3 enum)",
    body.generationConfig.responseSchema.type === "OBJECT",
    body.generationConfig.responseSchema.type,
  );
  check(
    "generateContent uses responseMimeType, NOT response_format",
    body.generationConfig.responseMimeType === "application/json" && body.response_format === undefined,
  );
  check("generateContent wraps parts in contents[]", Array.isArray(body.contents));
}

{
  const inter = buildWireRequest("interactions", { model: "m", parts: [URI_DOC_PART] }).body;
  check(
    "Interactions uri variant → {type, uri, mime_type} with no data field",
    inter.input[0].uri === URI_DOC_PART.uri && !("data" in inter.input[0]),
    JSON.stringify(inter.input[0]),
  );
  const gen = buildWireRequest("generateContent", { model: "m", parts: [URI_DOC_PART] }).body;
  check(
    "generateContent uri variant → file_data{mime_type,file_uri}, NOT inline_data",
    gen.contents[0].parts[0].file_data?.file_uri === URI_DOC_PART.uri && gen.contents[0].parts[0].inline_data === undefined,
    JSON.stringify(gen.contents[0].parts[0]),
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
