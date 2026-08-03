// ─────────────────────────────────────────────────────────────────────────
// GEMINI TRANSPORT — the ONLY place that knows the wire format.
//
// VERIFIED AGAINST THE DOCS ON 2026-07-28. Do not rewrite this from memory.
// Two sessions have now changed it in opposite directions on belief alone:
// one invented an endpoint, the next "corrected" a CORRECT endpoint back to
// the legacy one. Both were wrong. Cite the doc before you touch it.
//
//   Interactions API (GA, recommended for new projects):
//     https://ai.google.dev/api/interactions-api
//     https://ai.google.dev/gemini-api/docs/migrate-to-interactions
//     POST https://generativelanguage.googleapis.com/v1beta/interactions
//     Header: x-goog-api-key
//     Body: { model, input, system_instruction?, generation_config?,
//             response_format? }
//     `input` is a STRING or an ARRAY of typed content objects:
//        [{ type: "text",  text: "..." },
//         { type: "image", mime_type: "image/png", data: "<base64>" }]
//     It is NOT { parts: [...] } — that is the generateContent shape.
//     Response: { id, status, steps: [{ type: "model_output",
//                 content: [{ type: "text", text }] }], usage }
//     SDKs also surface a convenience `output_text`.
//
//   generateContent (legacy, still supported):
//     https://ai.google.dev/api/generate-content
//     POST /v1beta/models/{model}:generateContent
//     Body: { contents: [{ role, parts: [{ text } | { inline_data:
//             { mime_type, data } }] }], systemInstruction?,
//             generationConfig? }
//     Response: { candidates: [{ content: { parts: [{ text }] } }] }
//
// Sampling knobs (temperature / top_p / top_k / candidate_count) are
// deliberately absent: they are deprecated, ignored by current models, and
// slated to 400. Reasoning depth is `thinking_level`, NOT `thinking_budget`.
// ─────────────────────────────────────────────────────────────────────────

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type TransportName = "interactions" | "generateContent";

// Pin the Interactions request contract. There is a documented set of breaking
// changes from May 2026; an unpinned revision lets the contract move underneath
// us between sessions, which is precisely the class of bug this file has
// already suffered twice. Only sent on the Interactions path — generateContent
// is versioned by its URL.
//
// NOTE: this header is not described on the reference page I could reach; it is
// applied per an explicit instruction. If the first live run 400s with an
// unknown-header complaint, drop it here and nowhere else.
export const INTERACTIONS_API_REVISION = "2026-05-20";

export function headersFor(transport: TransportName, apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
    ...(transport === "interactions" ? { "Api-Revision": INTERACTIONS_API_REVISION } : {}),
  };
}

// "low" exists too, per the generation_config reference.
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

// A provider-neutral description of one request. Callers build this; the
// transport translates it. Nothing above this layer knows the wire format.
export interface GeminiPart {
  kind: "text" | "image" | "document";
  text?: string;
  mimeType?: string;
  // Base64, no data: prefix.
  data?: string;
  // STAGE 4 — ADDITIVE ONLY. A Files API URI to reference INSTEAD of inline
  // bytes, for uploads over the inline budget. When present, `data` is unused.
  // Nothing about the existing text/inline shapes changes; this adds a third
  // variant that the docs specify for uploaded files.
  //   https://ai.google.dev/gemini-api/docs/files   (fetched 2026-07-28)
  uri?: string;
}

export interface GeminiRequest {
  model: string;
  parts: GeminiPart[];
  systemInstruction?: string;
  // JSON Schema for structured output. Types are uppercased by the transport.
  responseSchema?: unknown;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  // generateContent ONLY. The Interactions API does not accept custom safety
  // settings, which is why a safety-blocked dossier falls back to this path.
  relaxedSafety?: boolean;
}

// BLOCK_ONLY_HIGH is the loosest threshold the API exposes; it does not disable
// filtering. Used solely to give an ID photo or a personal letter a second
// chance after a plausible false positive.
const RELAXED_SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

// ITEM 4 — THE ONE LINE TO FLIP.
// The Interactions structured-output docs show standard JSON Schema, whose type
// names are lowercase ("object", "array"). generateContent uses proto3 Schema,
// whose type enum is uppercase. If Stage B ever 400s complaining about schema
// types on the Interactions path, set this to true. Nothing else needs changing.
// Doc: https://ai.google.dev/gemini-api/docs/structured-output
export const UPPERCASE_SCHEMA_TYPES_ON_INTERACTIONS = false;

// Gemini's schema is proto3 JSON, whose enum parsing is case-SENSITIVE:
// "type": "array" is rejected as INVALID_ARGUMENT where "ARRAY" is accepted.
// Schemas are authored lowercase for readability and normalized here.
export function upperCaseSchemaTypes(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(upperCaseSchemaTypes);
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = key === "type" && typeof value === "string" ? value.toUpperCase() : upperCaseSchemaTypes(value);
  }
  return out;
}

export interface WireRequest {
  url: string;
  body: unknown;
}

function interactionsBody(request: GeminiRequest): unknown {
  const input = request.parts.map((part) => {
    if (part.kind === "text") {
      return { type: "text", text: part.text ?? "" };
    }
    // STAGE 4 — a Files API reference. Documented shape is the typed content
    // object with `uri` + `mime_type` in place of `data`:
    //   { "type": "<kind>", "uri": myfile.uri, "mime_type": myfile.mime_type }
    //   https://ai.google.dev/gemini-api/docs/files   (fetched 2026-07-28)
    // ADDITIVE: the inline branch below is byte-for-byte what it always was.
    if (part.uri) {
      return { type: part.kind, uri: part.uri, mime_type: part.mimeType };
    }
    return { type: part.kind, mime_type: part.mimeType, data: part.data };
  });

  const generationConfig: Record<string, unknown> = {};
  if (request.thinkingLevel) {
    generationConfig.thinking_level = request.thinkingLevel;
  }
  if (request.maxOutputTokens) {
    generationConfig.max_output_tokens = request.maxOutputTokens;
  }

  return {
    model: request.model,
    input,
    ...(request.systemInstruction ? { system_instruction: request.systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
    // https://ai.google.dev/gemini-api/docs/structured-output
    // "configure response_format with an object of type `text` and set its
    //  mime_type to application/json". It is NOT {type:"json_schema",...} —
    // that is the OpenAI spelling and produces a 400 here.
    //
    // SCHEMA CASE: Interactions takes standard JSON Schema, whose type names
    // are LOWERCASE ("object", "array"). Only the generateContent path uses
    // proto3 Schema, whose type enum is uppercase. Schemas are therefore passed
    // through untouched here and uppercased only on that path.
    ...(request.responseSchema
      ? {
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: UPPERCASE_SCHEMA_TYPES_ON_INTERACTIONS
              ? upperCaseSchemaTypes(request.responseSchema)
              : request.responseSchema,
          },
        }
      : {}),
    // Stateless: this extension has no use for server-side conversation state,
    // and storing users' document contents server-side would be a privacy
    // regression they never asked for.
    store: false,
  };
}

function generateContentBody(request: GeminiRequest): unknown {
  const parts = request.parts.map((part) => {
    if (part.kind === "text") {
      return { text: part.text ?? "" };
    }
    // STAGE 4 — the generateContent spelling of a Files API reference is
    // `file_data`, not `inline_data`. Two different fields, same as the
    // response_format / generationConfig split (§1). ADDITIVE: the inline
    // branch is unchanged.
    if (part.uri) {
      return { file_data: { mime_type: part.mimeType, file_uri: part.uri } };
    }
    return { inline_data: { mime_type: part.mimeType, data: part.data } };
  });

  const generationConfig: Record<string, unknown> = {};
  if (request.responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = upperCaseSchemaTypes(request.responseSchema);
  }
  if (request.thinkingLevel) {
    generationConfig.thinkingLevel = request.thinkingLevel;
  }
  if (request.maxOutputTokens) {
    generationConfig.maxOutputTokens = request.maxOutputTokens;
  }

  return {
    contents: [{ role: "user", parts }],
    ...(request.relaxedSafety ? { safetySettings: RELAXED_SAFETY_SETTINGS } : {}),
    ...(request.systemInstruction
      ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } }
      : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

export function buildWireRequest(transport: TransportName, request: GeminiRequest): WireRequest {
  return transport === "interactions"
    ? { url: INTERACTIONS_URL, body: interactionsBody(request) }
    : {
        url: `${MODELS_BASE}/${encodeURIComponent(request.model)}:generateContent`,
        body: generateContentBody(request),
      };
}

export function listModelsUrl(): string {
  return `${MODELS_BASE}?pageSize=200`;
}

// Reads the output text out of EITHER response shape. Tries the documented
// paths in order rather than trusting one — if a shape shifts, this degrades
// to an explicit "empty response" error instead of crashing on undefined.
export function extractOutputText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const obj = payload as Record<string, unknown>;

  // Interactions: SDK convenience field.
  if (typeof obj.output_text === "string" && obj.output_text) {
    return obj.output_text;
  }

  // Interactions: steps[] → model_output → content[] → text.
  if (Array.isArray(obj.steps)) {
    const chunks: string[] = [];
    for (const step of obj.steps) {
      if (typeof step !== "object" || step === null) {
        continue;
      }
      const s = step as { type?: unknown; content?: unknown };
      if (s.type !== "model_output" || !Array.isArray(s.content)) {
        continue;
      }
      for (const item of s.content) {
        const text = (item as { text?: unknown })?.text;
        if (typeof text === "string") {
          chunks.push(text);
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join("");
    }
  }

  // generateContent: candidates[0].content.parts[].text.
  if (Array.isArray(obj.candidates)) {
    const candidate = obj.candidates[0] as { content?: { parts?: { text?: string }[] } } | undefined;
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (text) {
      return text;
    }
  }

  return "";
}

// Interactions reports terminal trouble in `status`; generateContent uses
// finishReason / promptFeedback. Normalized so one caller handles both.
export function describeEmptyResponse(payload: unknown): string {
  const obj = (payload ?? {}) as {
    status?: string;
    candidates?: { finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (obj.promptFeedback?.blockReason) {
    return "blocked by safety filters";
  }
  const finish = obj.candidates?.[0]?.finishReason;
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST") {
    return "blocked by safety filters";
  }
  if (finish === "MAX_TOKENS" || obj.status === "incomplete") {
    return "hit the output token limit — reduce the batch size";
  }
  if (finish === "RECITATION") {
    return "stopped for recitation";
  }
  if (obj.status === "budget_exceeded") {
    return "the model's thinking budget was exceeded";
  }
  if (obj.status === "failed") {
    return "the interaction failed server-side";
  }
  return finish ?? obj.status ?? "no output returned";
}
