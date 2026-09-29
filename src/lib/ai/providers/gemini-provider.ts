// ─────────────────────────────────────────────────────────────────────────
// GEMINI PROVIDER (TASK E1) — a MOVE, not a rewrite.
//
// This adapts the EXISTING Gemini machinery to the shared ProviderClient
// interface. It deliberately adds no wire-format logic of its own: every byte
// that goes on the network is still produced by `transport.ts`
// (`buildWireRequest` / `headersFor`), untouched.
//
// ⚠️ THE ACCEPTANCE GATE FOR THIS FILE IS BYTE-EQUALITY.
// `tests/gemini-wire.test.mjs` compares 20 request shapes against a golden
// file captured BEFORE this wrapper existed. §1 records four separate
// occasions on which the Gemini wire format was "corrected" from memory and
// broken; a wrapper is exactly the change that looks safe and isn't. If that
// test fails, fix this file — never regenerate the golden.
//
// ── WHAT STAYS GEMINI-INTERNAL (do not hoist into provider.ts) ───────────
// The daily quota counter, the Pacific-midnight reset, the request spacing,
// the Interactions→generateContent 404 fallback, and the Files API path are
// all Gemini's own. Anthropic has no daily quota and no Pacific reset (§1b),
// so generalising these now would bake in a shape that is wrong for the very
// next provider. E2 decides what is genuinely shared.
// ─────────────────────────────────────────────────────────────────────────

import {
  registerProvider,
  ProviderError,
  diagnoseAssumedCapability,
  type CapabilitySource,
  type CompleteRequest,
  type CompleteResult,
  type ProviderClient,
  type ProviderErrorClass,
  type ProviderPart,
} from "../provider";
import {
  callGeminiRaw,
  readGeminiJson,
  readGeminiJsonWithSafetyRetry,
  activeGeminiModel,
  geminiPerMinuteLimit,
  verifyConfiguredModels as listGeminiModels,
  GeminiRequestError,
  type GeminiErrorKind,
} from "../gemini-client";
import { saveSelectedModel as saveGeminiModel } from "../model-config";
// NOTE: deliberately NOT from ../transport. gemini-client.ts is the single
// importer of the wire format; see the E3 boundary grep in HANDOFF §6b.2.
import type { GeminiPart } from "../gemini-client";

// ── Error normalization ──────────────────────────────────────────────────
// The Gemini classifier is unchanged and still authoritative (§4c contains a
// re-verified per-day/per-minute fix that must not be re-litigated). This maps
// its verdicts onto the shared taxonomy — a translation, not a re-decision.
const CLASS_BY_KIND: Record<GeminiErrorKind, ProviderErrorClass> = {
  invalid_key: "auth",
  rate_limit_minute: "rate-limit-per-minute",
  daily_quota: "quota-or-credit-exhausted",
  overloaded: "overloaded",
  server: "overloaded",
  bad_request: "invalid-request",
  network: "network",
  timeout: "timeout",
  blocked: "safety-blocked",
  empty: "empty-response",
  // A malformed body is not a transport failure; it is an unusable response.
  parse: "empty-response",
};

// `bad_request` covers both a malformed request and an unusable model name.
// The distinction matters to the user — one is our bug, the other is their
// setting — and §4f/B3 already teaches the message to say which.
function refineClass(error: GeminiRequestError): ProviderErrorClass {
  const base = CLASS_BY_KIND[error.kind] ?? "invalid-request";
  if (base === "invalid-request" && /not found|is not supported|unsupported model/i.test(error.message)) {
    return "invalid-model";
  }
  return base;
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (error instanceof GeminiRequestError) {
    return new ProviderError({
      provider: "gemini",
      errorClass: refineClass(error),
      message: error.message,
      retryable: error.retryable,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.metric !== undefined ? { metric: error.metric } : {}),
    });
  }
  return new ProviderError({
    provider: "gemini",
    errorClass: "network",
    message: error instanceof Error ? error.message : "Unknown provider failure.",
    retryable: true,
  });
}

/**
 * ⚠️ Gemini reports NO per-model capability flags, so every flag this provider
 * publishes is an assumption. Declared once: listModels() and the error path in
 * complete() must never disagree about whether a capability was verified.
 */
export const GEMINI_CAPABILITY_SOURCE: CapabilitySource = "assumed";

// ── Part translation ─────────────────────────────────────────────────────
// Structurally identical by design: `ProviderPart` was defined to match the
// shape `transport.ts` already consumes, so this cannot alter a request.
function toGeminiParts(parts: ProviderPart[]): GeminiPart[] {
  return parts.map((part) => ({
    kind: part.kind,
    ...(part.text !== undefined ? { text: part.text } : {}),
    ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
    ...(part.data !== undefined ? { data: part.data } : {}),
    ...(part.uri !== undefined ? { uri: part.uri } : {}),
  }));
}

/**
 * Gemini's 18 MB ENCODED budget (§2). Kept here, not in `provider.ts`: it is a
 * Gemini constant chosen for headroom under its ~20 MB inline ceiling, not a
 * shared truth. Anthropic's equivalent is 32 MB and unrelated.
 */
const GEMINI_MAX_INLINE_ENCODED_BYTES = 18 * 1024 * 1024;

export const geminiProvider: ProviderClient = {
  id: "gemini",
  displayName: "Google Gemini",
  dataDestination: "generativelanguage.googleapis.com (Google)",

  capabilities: {
    // §4d — implemented, though never executed (§1b).
    supportsFilesApi: true,
    maxInlineRequestBytes: GEMINI_MAX_INLINE_ENCODED_BYTES,
    // No per-file cap on the inline path; the Files API path has its own
    // (2 GB, 50 MB for PDFs) enforced inside `files-api.ts`.
    maxPerFileBytes: null,
    // Gemini reads scans and photos natively and is permissive about types;
    // the set below is what Stage A actually sends.
    supportedFileMimeTypes: new Set([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/heic",
      "image/heif",
      "application/pdf",
      "text/plain",
      "audio/mpeg",
      "audio/wav",
      "audio/mp4",
      "audio/ogg",
      "audio/webm",
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-msvideo",
      "video/x-matroska",
    ]),
    // §4c — daily requests, resetting at midnight Pacific.
    hasDailyQuota: true,
    // Gemini's RPM is an assumption in model-config.ts, not something the API
    // told us. §4c's refusal to invent a denominator follows from this.
    learnsLimitsFromResponseHeaders: false,
    hasMonthlySpendCap: false,
  },

  activeModel: activeGeminiModel,
  perMinuteRequestLimit: geminiPerMinuteLimit,

  async listModels() {
    const availability = await listGeminiModels();
    if (!availability.ok) {
      throw new ProviderError({
        provider: "gemini",
        errorClass: "auth",
        message: availability.message,
        retryable: false,
      });
    }
    // ⚠️ Gemini's ListModels response carries NO capability flags, unlike
    // Anthropic's. These two are `true` because THIS APP ASSUMES the models it
    // offers support them — NOT because the API said so.
    //
    // 0c: that assumption is now recorded in the DATA as `capabilitySource:
    // "assumed"`, so the selector can label it and a failure can name it as the
    // likely cause. Previously it was only a comment, which means the UI could
    // not warn and the error could not explain.
    return availability.available.map((id) => ({
      id,
      displayName: id,
      supportsStructuredOutputs: true,
      supportsPdf: true,
      capabilitySource: GEMINI_CAPABILITY_SOURCE,
    }));
  },

  async saveModel(modelId: string) {
    await saveGeminiModel(modelId);
  },

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const model = request.model ?? (await activeGeminiModel());
    try {
      const { payload, text } = await readGeminiJsonWithSafetyRetry({
        parts: toGeminiParts(request.parts),
        label: request.label ?? "complete",
        ...(request.system !== undefined ? { systemInstruction: request.system } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
        // Gemini's `thinking_level` takes the same four values as the neutral
        // field, so this is a rename rather than a translation. Omitted when
        // the caller omits it — Gemini tolerates absence and adding a default
        // here would change every existing request (see the orchestration
        // golden, and the max_tokens trap it pins).
        ...(request.reasoningEffort !== undefined ? { thinkingLevel: request.reasoningEffort } : {}),
        ...(request.model !== undefined ? { modelOverride: request.model } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      }, request.onProgress);

      // Structured output is parsed only when a schema was asked for. A caller
      // that did not request structure gets `null`, never a speculative parse.
      let structured: unknown | null = null;
      if (request.schema !== undefined && text.trim()) {
        try {
          structured = JSON.parse(text) as unknown;
        } catch {
          structured = null;
        }
      }

      const usageRaw = (payload as { usage?: Record<string, unknown> } | null)?.usage ?? {};
      const inputTokens = Number(usageRaw.input_tokens ?? usageRaw.promptTokenCount);
      const outputTokens = Number(usageRaw.output_tokens ?? usageRaw.candidatesTokenCount);

      return {
        text,
        structured,
        usage: {
          ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
          ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
        },
        finishReason:
          (payload as { candidates?: { finishReason?: string }[]; status?: string } | null)?.candidates?.[0]
            ?.finishReason ??
          (payload as { status?: string } | null)?.status ??
          null,
        provider: "gemini",
        model,
      };
    } catch (error) {
      // 0c — Gemini's capability flags are ASSUMED, so a model rejection here
      // may be our guess failing rather than a bad model name. Say so, instead
      // of letting the user read "not supported" as their own misconfiguration.
      const normalized = toProviderError(error);
      const diagnosis = diagnoseAssumedCapability({
        errorClass: normalized.errorClass,
        hadSchema: request.schema !== undefined,
        hadFileParts: request.parts.some((part) => part.kind !== "text"),
        capabilitySource: GEMINI_CAPABILITY_SOURCE,
        model,
        providerName: geminiProvider.displayName,
      });
      if (diagnosis === null) throw normalized;
      throw new ProviderError({
        provider: "gemini",
        errorClass: normalized.errorClass,
        message: `${normalized.message} ${diagnosis}`,
        retryable: normalized.retryable,
        ...(normalized.status !== undefined ? { status: normalized.status } : {}),
      });
    }
  },
};

registerProvider(geminiProvider);

// Re-exported so nothing outside this directory needs `transport.ts`.
export { callGeminiRaw, readGeminiJson };
