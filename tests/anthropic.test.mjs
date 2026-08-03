// TASK E2 — Anthropic provider, schema adapter, error normalization, parity.
//
// ⚠️ NO LIVE REQUEST IS MADE. Every assertion here is about shapes this code
// PRODUCES and error bodies it CLASSIFIES, using bodies transcribed from the
// docs (§1b). That is deliberately not the same as proving the API accepts
// them — Anthropic support stays in §1b as implemented-but-never-executed.
import {
  anthropicHeaders,
  buildAnthropicBody,
  toAnthropicBlocks,
  classifyAnthropicError,
  classifyAnthropicStop,
  extractAnthropicText,
  checkAnthropicRequestSize,
  parseAnthropicModels,
  noteAnthropicRateHeaders,
  anthropicPerMinuteLimit,
  resetAnthropicLearnedLimits,
  BROWSER_ACCESS_HEADER,
  ANTHROPIC_VERSION,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  AnthropicContentError,
} from "./_bundle-anthropic.mjs";
import { adaptSchemaForAnthropic, checkSchemaSupport, SchemaAdaptationError } from "./_bundle-anthropic-schema.mjs";
import { validateStageBOutput, validateStageAOutput, assertShapeParity } from "./_bundle-parity.mjs";
import { DOSSIER_SCHEMA } from "./_bundle-dossier.mjs";
import { ANSWER_SCHEMA } from "./_bundle-agree.mjs";
import { isRetryableClass } from "./_bundle-provider.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

console.log("\n=== E2: headers ===");
{
  const h = anthropicHeaders("KEY");
  check("x-api-key carries the key", h["x-api-key"] === "KEY");
  check(`anthropic-version is pinned to ${ANTHROPIC_VERSION}`, h["anthropic-version"] === "2023-06-01");
  check("content-type is application/json", h["content-type"] === "application/json");
  check(
    "the browser-access header is sent, set to true",
    h[BROWSER_ACCESS_HEADER] === "true",
    `${BROWSER_ACCESS_HEADER}: ${h[BROWSER_ACCESS_HEADER]}`,
  );
}

console.log("\n=== E2: THE 401 TRAP — a valid key must never be reported as invalid ===");
{
  // Transcribed from §1b: omitting the header returns 401 authentication_error
  // whose MESSAGE names the header. This is the single worst failure mode
  // available here, because the naive mapping accuses a working credential.
  const body = {
    type: "error",
    error: {
      type: "authentication_error",
      message:
        "CORS requests are not allowed for this endpoint unless the " +
        "anthropic-dangerous-direct-browser-access header is set to true.",
    },
  };
  const err = classifyAnthropicError(401, body, headers({}));
  check(
    "a 401 naming the browser header maps to browser-access-header-missing",
    err.errorClass === "browser-access-header-missing",
    err.errorClass,
  );
  check("it is NOT classified as auth", err.errorClass !== "auth");
  check(
    "the message tells the user their key is fine",
    /API KEY IS FINE|do not regenerate/i.test(err.message),
    err.message.slice(0, 90) + "…",
  );
  check("it is not retryable (retrying cannot add a header)", err.retryable === false);

  // A genuine auth failure must still classify as auth.
  const real = classifyAnthropicError(
    401,
    { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    headers({}),
  );
  check("a real 401 (invalid key) still maps to auth", real.errorClass === "auth", real.errorClass);
  check("so the two 401s are distinguishable", real.errorClass !== "browser-access-header-missing");

  // ── THE INVERTED TRAP ──
  // A genuine invalid-key 401 that merely MENTIONS a browser must still map to
  // auth. Classifying it as browser-access-header-missing would tell a user
  // whose key is actually broken that "YOUR API KEY IS FINE" — leaving them
  // with no way to recover. That is worse than the original trap.
  const decoys = [
    "Invalid API key provided from browser client.",
    "authentication_error: the key used by this browser extension has been revoked",
    "Your credentials were rejected. Browser requests are logged for security.",
    "invalid x-api-key (request origin: browser)",
  ];
  decoys.forEach((message) => {
    const err = classifyAnthropicError(401, { error: { type: "authentication_error", message } }, headers({}));
    check(
      `a real auth failure mentioning "browser" still maps to auth`,
      err.errorClass === "auth",
      `"${message.slice(0, 46)}…" → ${err.errorClass}`,
    );
  });

  // Bare "cors" with no requirement token is likewise not enough on its own.
  const bareCors = classifyAnthropicError(
    401,
    { error: { type: "authentication_error", message: "Request blocked. See our CORS documentation." } },
    headers({}),
  );
  check("bare 'cors' without a must-set token is NOT the header case", bareCors.errorClass === "auth", bareCors.errorClass);

  // Co-occurrence DOES trigger it, even without the header name spelled out.
  const cooccurrence = classifyAnthropicError(
    401,
    { error: { type: "authentication_error", message: "CORS requests must set the direct browser access header to true." } },
    headers({}),
  );
  check(
    "a CORS token co-occurring with a must-set token IS the header case",
    cooccurrence.errorClass === "browser-access-header-missing",
    cooccurrence.errorClass,
  );
}

console.log("\n=== E2: request-body gotchas ===");
{
  const body = buildAnthropicBody({ model: "claude-sonnet-5", parts: [{ kind: "text", text: "hi" }] });
  check(
    "max_tokens is ALWAYS present (omitting it is a 400; Gemini tolerates absence)",
    typeof body.max_tokens === "number" && body.max_tokens === ANTHROPIC_DEFAULT_MAX_TOKENS,
    `max_tokens=${body.max_tokens}`,
  );
  const explicit = buildAnthropicBody({ model: "m", parts: [{ kind: "text", text: "hi" }], maxTokens: 4096 });
  check("an explicit maxTokens wins", explicit.max_tokens === 4096);
}

{
  const body = buildAnthropicBody({ model: "m", parts: [{ kind: "text", text: "hi" }], system: "SYS" });
  check("the system prompt is a TOP-LEVEL parameter", body.system === "SYS");
  check(
    "there is NO system-role message (Anthropic has no system role in messages[])",
    !body.messages.some((m) => m.role === "system"),
    JSON.stringify(body.messages.map((m) => m.role)),
  );
}

{
  const body = buildAnthropicBody({ model: "m", parts: [{ kind: "text", text: "hi" }] });
  const last = body.messages[body.messages.length - 1];
  check("the conversation does not end on an assistant turn", last.role === "user", `last role = ${last.role}`);
  check("exactly one user turn is sent, so prefill cannot occur", body.messages.length === 1);
}

console.log("\n=== E2: structured output uses output_config, not forced tool use ===");
{
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const body = buildAnthropicBody({ model: "m", parts: [{ kind: "text", text: "x" }], schema });
  check("output_config.format.type is json_schema", body.output_config?.format?.type === "json_schema");
  check("no tools are declared", body.tools === undefined);
  check("no tool_choice is set", body.tool_choice === undefined);
  check(
    "additionalProperties:false was ADDED to the object",
    body.output_config.format.schema.additionalProperties === false,
  );
}

console.log("\n=== E2: schema adapter — transforms what it can ===");
{
  const adapted = adaptSchemaForAnthropic({
    type: "object",
    properties: { list: { type: "array", items: { type: "object", properties: { x: { type: "string" } } } } },
  });
  check("additionalProperties:false is added to every nested object", adapted.properties.list.items.additionalProperties === false);
  check("and to the root", adapted.additionalProperties === false);
  check("enum passes through", adaptSchemaForAnthropic({ type: "string", enum: ["a", "b"] }).enum.length === 2);
  check("minItems:1 is allowed", adaptSchemaForAnthropic({ type: "array", minItems: 1, items: { type: "string" } }).minItems === 1);
}

console.log("\n=== E2: schema adapter — THROWS rather than dropping ===");
{
  const rejects = [
    ["minimum", { type: "integer", minimum: 0 }],
    ["maxLength", { type: "string", maxLength: 10 }],
    ["pattern", { type: "string", pattern: "^a" }],
    ["maxItems", { type: "array", maxItems: 3, items: { type: "string" } }],
    ["uniqueItems", { type: "array", uniqueItems: true, items: { type: "string" } }],
    ["oneOf", { oneOf: [{ type: "string" }] }],
    ["$ref", { $ref: "#/definitions/x" }],
    ["not", { not: { type: "string" } }],
  ];
  rejects.forEach(([keyword, schema]) => {
    const result = checkSchemaSupport(schema);
    check(`"${keyword}" is REJECTED, not silently dropped`, result.ok === false && result.error.keyword === keyword,
      result.ok ? "accepted (WRONG)" : result.error.keyword);
  });

  const bad = checkSchemaSupport({ type: "array", minItems: 5, items: { type: "string" } });
  check("minItems other than 0/1 is rejected", bad.ok === false && bad.error.keyword === "minItems");

  const unknown = checkSchemaSupport({ type: "object", properties: {}, weirdKeyword: true });
  check("an unrecognised keyword is rejected rather than passed through blindly", unknown.ok === false);

  // Recursion would make constrained decoding impossible AND hang the walk.
  const recursive = { type: "object", properties: {} };
  recursive.properties.self = recursive;
  const rec = checkSchemaSupport(recursive);
  check("a recursive schema is detected and rejected", rec.ok === false && rec.error.keyword === "$recursion");
}

console.log("\n=== E2: Gemini's casing split must NOT leak onto this path ===");
{
  // upperCaseSchemaTypes() is a proto3 concern for Gemini's generateContent
  // path ONLY (§1). If it ever reaches Anthropic the schema is invalid, so the
  // adapter fails loudly instead of forwarding it.
  const leaked = checkSchemaSupport({ type: "OBJECT", properties: { a: { type: "STRING" } } });
  check("an uppercase type is rejected", leaked.ok === false && leaked.error.keyword === "type");
  check(
    "and the error explains it is Gemini's spelling leaking",
    /Gemini|proto3|upperCaseSchemaTypes/.test(leaked.error.message),
    leaked.error.message.slice(0, 100) + "…",
  );
}

console.log("\n=== E2: the REAL schemas, not toys ===");
{
  const stageB = checkSchemaSupport(ANSWER_SCHEMA);
  check(
    "the REAL Stage B answer schema survives the adapter",
    stageB.ok === true,
    stageB.ok ? "accepted" : `${stageB.error.keyword} at ${stageB.error.pointer}`,
  );
  const stageA = checkSchemaSupport(DOSSIER_SCHEMA);
  check(
    "the REAL Stage A dossier schema survives the adapter",
    stageA.ok === true,
    stageA.ok ? "accepted" : `${stageA.error.keyword} at ${stageA.error.pointer}`,
  );

  // The evidence array is what §3 derives provenance from — prove it is still
  // expressible after adaptation, and still closed.
  const adaptedB = adaptSchemaForAnthropic(ANSWER_SCHEMA);
  const json = JSON.stringify(adaptedB);
  ["dossier_path", "source_filename", "snippet", "implied_value"].forEach((field) => {
    check(`the adapted Stage B schema still carries evidence.${field}`, json.includes(field));
  });
  check("no uppercase type survived adaptation", !/"type":"[A-Z]/.test(json));
}

console.log("\n=== E2: multimodal blocks ===");
{
  const blocks = toAnthropicBlocks([
    { kind: "text", text: "hi" },
    { kind: "image", mimeType: "image/png", data: "AAAA" },
    { kind: "document", mimeType: "application/pdf", data: "JVBER" },
  ]);
  check("text → {type:text}", blocks[0].type === "text");
  check("image → {type:image, source:{type:base64,media_type,data}}",
    blocks[1].type === "image" && blocks[1].source.type === "base64" && blocks[1].source.media_type === "image/png");
  check(
    "PDF → {type:DOCUMENT}, not an image block",
    blocks[2].type === "document" && blocks[2].source.media_type === "application/pdf",
    blocks[2].type,
  );
}

{
  const reject = (parts) => {
    try { toAnthropicBlocks(parts); return null; } catch (e) { return e; }
  };
  const tiff = reject([{ kind: "image", mimeType: "image/tiff", data: "A" }]);
  check("an unsupported image type is refused", tiff instanceof AnthropicContentError, tiff?.message?.slice(0, 60));
  const foreignUri = reject([{ kind: "document", mimeType: "application/pdf", uri: "https://generativelanguage.googleapis.com/v1beta/files/x" }]);
  check(
    "a GEMINI file URI is refused rather than forwarded to Anthropic",
    foreignUri instanceof AnthropicContentError && /not portable/i.test(foreignUri.message),
  );
}

console.log("\n=== E2: per-provider size guard ===");
{
  const ok = checkAnthropicRequestSize([{ name: "cv.pdf", encodedBytes: 1024 * 1024 }]);
  check("a small set passes", ok.ok === true);
  const over = checkAnthropicRequestSize([
    { name: "small.pdf", encodedBytes: 1 * 1024 * 1024 },
    { name: "huge-scan.pdf", encodedBytes: 40 * 1024 * 1024 },
  ]);
  check("an oversized set fails", over.ok === false);
  check("the offending files are named LARGEST FIRST", over.message.indexOf("huge-scan.pdf") < over.message.indexOf("small.pdf"));
  check("the limit named is Anthropic's 32 MB, not Gemini's 18 MB", /32 MB/.test(over.message) && !/18 MB/.test(over.message));
}

console.log("\n=== E2: error normalization ===");
{
  const cases = [
    [400, "invalid_request_error", "invalid-request"],
    [402, "billing_error", "quota-or-credit-exhausted"],
    [403, "permission_error", "auth"],
    [404, "not_found_error", "invalid-model"],
    [413, "request_too_large", "invalid-request"],
    [429, "rate_limit_error", "rate-limit-per-minute"],
    [500, "api_error", "overloaded"],
    [504, "timeout_error", "timeout"],
    [529, "overloaded_error", "overloaded"],
  ];
  cases.forEach(([status, apiType, expected]) => {
    const err = classifyAnthropicError(status, { type: "error", error: { type: apiType, message: "x" } }, headers({}));
    check(`${status} ${apiType} → ${expected}`, err.errorClass === expected, err.errorClass);
  });
}

{
  const err = classifyAnthropicError(429, { error: { type: "rate_limit_error", message: "slow down" } },
    headers({ "retry-after": "42" }));
  check("retry-after is honoured and converted to ms", err.retryAfterMs === 42000, String(err.retryAfterMs));
  check("a 429 is retryable", err.retryable === true);
}

{
  // The monthly spend cap must NEVER be retried — same lesson as §4c's daily
  // quota, in a different currency.
  const err = classifyAnthropicError(402, { error: { type: "billing_error", message: "spend cap" } }, headers({}));
  check("402 billing is NOT retryable", err.retryable === false);
  check("and both providers agree via the SHARED retryable set", isRetryableClass("quota-or-credit-exhausted") === false);
  check("rate-limit-per-minute is retryable on the shared set", isRetryableClass("rate-limit-per-minute") === true);
  check("browser-access-header-missing is NOT retryable", isRetryableClass("browser-access-header-missing") === false);
}

{
  const refusal = classifyAnthropicStop("refusal", true);
  check("stop_reason refusal → safety-blocked", refusal?.errorClass === "safety-blocked");
  check("and is not retryable", refusal?.retryable === false);
  const truncated = classifyAnthropicStop("max_tokens", false);
  check("max_tokens with no text → empty-response, not retryable", truncated?.errorClass === "empty-response" && truncated.retryable === false);
  check("a normal end_turn with text is not an error", classifyAnthropicStop("end_turn", true) === null);
}

console.log("\n=== E2: response parsing (JSON arrives in a TEXT block) ===");
{
  const payload = { content: [{ type: "text", text: '{"answers":[]}' }], stop_reason: "end_turn" };
  check("text is extracted from text blocks", extractAnthropicText(payload) === '{"answers":[]}');
  check("empty content yields empty string, not a throw", extractAnthropicText({ content: [] }) === "");
  check("a missing content array is handled", extractAnthropicText(null) === "");
  const withTool = { content: [{ type: "tool_use", input: {} }, { type: "text", text: "ok" }] };
  check("non-text blocks are ignored", extractAnthropicText(withTool) === "ok");
}

console.log("\n=== E2: rate limits are LEARNED from headers, never guessed ===");
{
  resetAnthropicLearnedLimits();
  check("before any response, the limit is unknown (null), not a guess", anthropicPerMinuteLimit() === null);
  noteAnthropicRateHeaders(headers({ "anthropic-ratelimit-requests-limit": "1000" }));
  check("after a response it is learned", anthropicPerMinuteLimit() === 1000, String(anthropicPerMinuteLimit()));
  noteAnthropicRateHeaders(headers({}));
  check("a response without the header does not erase what was learned", anthropicPerMinuteLimit() === 1000);
  resetAnthropicLearnedLimits();
}

console.log("\n=== E2: model list is fetched, nothing hardcoded ===");
{
  const models = parseAnthropicModels({
    data: [
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_tokens: 64000,
        capabilities: { structured_outputs: { supported: true }, pdf_input: { supported: true }, image_input: { supported: true } } },
      { id: "legacy-model", display_name: "Legacy", capabilities: { structured_outputs: { supported: false } } },
    ],
  });
  check("models are parsed from the API response", models.length === 2);
  check("structured-output capability is READ, not assumed", models[0].supportsStructuredOutputs === true && models[1].supportsStructuredOutputs === false);
  check("PDF capability is read per model", models[0].supportsPdf === true && models[1].supportsPdf === false);
  check("malformed entries are skipped, not crashed on", parseAnthropicModels({ data: [{}, { id: "ok" }] }).length === 1);
  check("a non-list payload yields an empty list", parseAnthropicModels(null).length === 0);
}

console.log("\n=== E2: PARITY — one validator, both providers ===");
{
  // Same shape, different wording — which is exactly what two providers
  // legitimately produce. §3 must not be able to tell them apart.
  const geminiOut = {
    answers: [
      { question_id: 0, value: "Jane Quinn",
        evidence: [{ dossier_path: "identity.full_name", source_filename: "cv.pdf", snippet: "Name: Jane", implied_value: "Jane Quinn" }] },
      { question_id: 1, value: "", evidence: [] },
    ],
  };
  const anthropicOut = {
    answers: [
      { question_id: 0, value: "Jane Quinn",
        evidence: [{ dossier_path: "identity.full_name", source_filename: "cv.pdf", snippet: "Full name — Jane", implied_value: "Jane Quinn" }] },
      { question_id: 1, value: "", evidence: [] },
    ],
  };

  const g = validateStageBOutput(geminiOut);
  const a = validateStageBOutput(anthropicOut);
  check("Gemini Stage B output satisfies the validator", g.ok === true, JSON.stringify(g.issues));
  check("Anthropic Stage B output satisfies the SAME validator", a.ok === true, JSON.stringify(a.issues));
  check("and the two shapes match", assertShapeParity(geminiOut, anthropicOut).length === 0);
  check("an EMPTY evidence array is valid (§3 derives needs_user_input from it)", validateStageBOutput({ answers: [{ question_id: 2, value: "", evidence: [] }] }).ok === true);
}

{
  // The failures that would silently break provenance.
  const missingImplied = validateStageBOutput({
    answers: [{ question_id: 0, value: "x", evidence: [{ dossier_path: "a", source_filename: "cv.pdf", snippet: "s" }] }],
  });
  check("a missing implied_value is caught", missingImplied.ok === false);
  check(
    "and the reason names why it matters (corroboration vs conflict)",
    /assessEvidenceAgreement|corroboration/.test(JSON.stringify(missingImplied.issues)),
  );

  const nulledEvidence = validateStageBOutput({ answers: [{ question_id: 0, value: "x", evidence: null }] });
  check("evidence:null is caught — absent and empty are NOT the same (§3)", nulledEvidence.ok === false);

  const missingSnippet = validateStageBOutput({
    answers: [{ question_id: 0, value: "x", evidence: [{ dossier_path: "a", source_filename: "cv.pdf", implied_value: "v" }] }],
  });
  check("an ABSENT snippet is caught (empty is allowed, absent is not)", missingSnippet.ok === false);
  check(
    "an EMPTY snippet is accepted (§3 allows it on choice questions)",
    validateStageBOutput({ answers: [{ question_id: 0, value: "x", evidence: [{ dossier_path: "a", source_filename: "cv.pdf", snippet: "", implied_value: "v" }] }] }).ok === true,
  );
}

{
  const dossier = { identity: { full_name: { value: "X", source_filename: "cv.pdf", confidence: "high" } } };
  check("Stage A dossier shape validates", validateStageAOutput(dossier).ok === true);
  const noProvenance = { identity: { full_name: { value: "X" } } };
  check(
    "a dossier scalar without source_filename/confidence is caught",
    validateStageAOutput(noProvenance).ok === false,
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
