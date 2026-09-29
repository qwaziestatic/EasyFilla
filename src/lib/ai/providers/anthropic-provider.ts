// ─────────────────────────────────────────────────────────────────────────
// ANTHROPIC PROVIDER (TASK E2)
//
// The provider is wired through active-provider.ts, which registers it only
// after the application has selected the Anthropic provider. Keeping
// registration out of this module preserves its isolated, testable client
// implementation while the active-provider seam controls reachability.
//
// ── DOCS (fetched 2026-07-28/29; see §1b) ────────────────────────────────
//   Messages API      https://platform.claude.com/docs/en/api/messages
//   Errors            https://platform.claude.com/docs/en/api/errors
//   Rate limits       https://platform.claude.com/docs/en/api/rate-limits
//   Structured output https://platform.claude.com/docs/en/build-with-claude/structured-outputs
//   Vision            https://platform.claude.com/docs/en/build-with-claude/vision
//   PDF support       https://platform.claude.com/docs/en/build-with-claude/pdf-support
//   Models list       https://platform.claude.com/docs/en/api/models-list
//   NOTE: docs.anthropic.com 301s to platform.claude.com. Use the new host.
// ─────────────────────────────────────────────────────────────────────────

import {
  ProviderError,
  isRetryableClass,
  type CompleteRequest,
  type CompleteResult,
  type ProviderClient,
  type ProviderErrorClass,
  type ProviderPart,
} from "../provider";
import { adaptSchemaForAnthropic } from "./anthropic-schema";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models";

/** Pinned per the docs. Not a guess — see §1b. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * ⚠️ REQUIRED FOR BROWSER-ORIGIN REQUESTS.
 *
 * Originates from `anthropic-sdk-typescript` PR #504 and was undocumented at
 * launch, which is why it is absent from the client-SDKs page (§1b).
 *
 * Omitting it does NOT produce a CORS/network failure. It returns **HTTP 401
 * `authentication_error`** with a message naming this header — which a naive
 * 401→auth mapping would report as "your API key is invalid" to a user whose
 * key is perfectly fine. See `classifyAnthropicError`.
 */
export const BROWSER_ACCESS_HEADER = "anthropic-dangerous-direct-browser-access";

/**
 * Messages API request cap, per the errors doc. This is a PER-PROVIDER value:
 * Gemini's 18 MB encoded budget is a Gemini constant and does not apply here.
 */
export const ANTHROPIC_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Vision doc: per-image base64 cap on the direct API. */
export const ANTHROPIC_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Vision doc: animations unsupported; only the first frame is read. */
export const ANTHROPIC_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * PDF doc: document blocks accept application/pdf. **All active models support
 * PDF processing on the Claude API and no beta header is required.** That
 * matters — Stage A exists to read scanned PDFs natively (§2), so if this were
 * unsupported Stage A could not run on Anthropic at all. It is supported.
 */
export const ANTHROPIC_DOCUMENT_MIME_TYPES = new Set(["application/pdf"]);

/**
 * PDF doc: 600 pages per request, 100 when the context window is under 1M
 * tokens. Recorded for the size guard's message; not enforceable client-side
 * without parsing the PDF, so it is surfaced as guidance, never as a silent cap.
 */
export const ANTHROPIC_MAX_PDF_PAGES = 600;

// ── Headers ──────────────────────────────────────────────────────────────
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    [BROWSER_ACCESS_HEADER]: "true",
  };
}

// ── Content translation ──────────────────────────────────────────────────
export class AnthropicContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicContentError";
  }
}

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * Provider-neutral parts → Anthropic content blocks.
 *
 * Images and PDFs use DIFFERENT block types — `image` vs `document` — which is
 * not interchangeable with Gemini, where both are inline data with a mime
 * type. Getting this wrong silently sends a PDF as an image block and 400s.
 */
export function toAnthropicBlocks(parts: ProviderPart[]): AnthropicBlock[] {
  return parts.map((part) => {
    if (part.kind === "text") {
      return { type: "text", text: part.text ?? "" };
    }

    // A Gemini Files API URI must never be forwarded here — different vendor,
    // different namespace (§1b, E8). Refuse loudly.
    if (part.uri) {
      throw new AnthropicContentError(
        "A provider-hosted file reference was passed to Anthropic. File URIs are not portable between " +
          "providers — a Gemini Files API URI is meaningless to Anthropic. Send inline bytes, or upload via " +
          "Anthropic's own Files API (not implemented — see §1b).",
      );
    }

    const mimeType = part.mimeType ?? "";
    const data = part.data ?? "";

    if (part.kind === "document" || mimeType === "application/pdf") {
      if (!ANTHROPIC_DOCUMENT_MIME_TYPES.has(mimeType)) {
        throw new AnthropicContentError(
          `Anthropic document blocks accept application/pdf only; got "${mimeType || "(none)"}".`,
        );
      }
      // https://platform.claude.com/docs/en/build-with-claude/pdf-support
      return { type: "document", source: { type: "base64", media_type: mimeType, data } };
    }

    if (!ANTHROPIC_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new AnthropicContentError(
        `Anthropic supports JPEG, PNG, GIF and WebP images only; got "${mimeType || "(none)"}". ` +
          "Convert the file, or send it as a PDF document block.",
      );
    }
    if (data.length > ANTHROPIC_MAX_IMAGE_BYTES) {
      throw new AnthropicContentError(
        `An image encodes to ${(data.length / 1024 / 1024).toFixed(1)} MB, over Anthropic's ` +
          `${ANTHROPIC_MAX_IMAGE_BYTES / 1024 / 1024} MB per-image limit.`,
      );
    }
    // https://platform.claude.com/docs/en/build-with-claude/vision
    return { type: "image", source: { type: "base64", media_type: mimeType, data } };
  });
}

/**
 * Per-provider size guard. Fails with the offending files named LARGEST FIRST,
 * matching Gemini's behaviour (§2) — "too big" alone is not actionable.
 */
export function checkAnthropicRequestSize(
  files: { name: string; encodedBytes: number }[],
): { ok: true } | { ok: false; message: string } {
  const total = files.reduce((sum, file) => sum + file.encodedBytes, 0);
  if (total <= ANTHROPIC_MAX_REQUEST_BYTES) {
    return { ok: true };
  }
  const ranked = [...files]
    .sort((a, b) => b.encodedBytes - a.encodedBytes)
    .map((file) => `${file.name} (${(file.encodedBytes / 1024 / 1024).toFixed(1)} MB)`);
  const overBy = (total - ANTHROPIC_MAX_REQUEST_BYTES) / 1024 / 1024;
  return {
    ok: false,
    message:
      `Your files encode to ~${(total / 1024 / 1024).toFixed(1)} MB, which is ${overBy.toFixed(1)} MB over ` +
      `Anthropic's ${ANTHROPIC_MAX_REQUEST_BYTES / 1024 / 1024} MB request limit. ` +
      `Largest first: ${ranked.slice(0, 5).join(", ")}. ` +
      "Remove or downscale the largest files, then rebuild the dossier. " +
      "(Anthropic's Files API would raise this ceiling but is not implemented — see HANDOFF §1b.)",
  };
}

// ── Request body ─────────────────────────────────────────────────────────
export interface AnthropicBodyInput {
  model: string;
  parts: ProviderPart[];
  system?: string;
  schema?: unknown;
  maxTokens?: number;
}

/**
 * ⚠️ `max_tokens` is REQUIRED by the Messages API — omitting it is a 400.
 * Gemini tolerates its absence, so a caller written against Gemini will not
 * supply one. A default is applied here rather than letting the request fail.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

export function buildAnthropicBody(input: AnthropicBodyInput): Record<string, unknown> {
  const content = toAnthropicBlocks(input.parts);

  const body: Record<string, unknown> = {
    model: input.model,
    // REQUIRED. See above.
    max_tokens: input.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    // ⚠️ The conversation must NOT end on an assistant turn, and prefill is
    // rejected outright on recent models. Exactly one user turn is sent, so
    // this cannot drift into that state.
    messages: [{ role: "user", content }],
  };

  // ⚠️ The system prompt is a TOP-LEVEL parameter, not a message with
  // role:"system". Anthropic has no system role in `messages[]`; sending one
  // is a 400.
  if (input.system) {
    body.system = input.system;
  }

  // ⚠️ `reasoningEffort` is DELIBERATELY IGNORED here, not silently dropped.
  //
  // Anthropic's reasoning configuration is model-dependent in a way that 400s
  // when wrong, and §1b records THREE distinct thinking-related 400s: 4.7+
  // rejects `thinking.type:"enabled"` and wants adaptive + `output_config.effort`;
  // 4.5-and-earlier rejects `adaptive`; Fable/Mythos reject `disabled` and also
  // reject the spelling their own error message suggests.
  //
  // Sending a guess would be a 400 on some models and silently wrong on others.
  // Omitting it runs with the model's default, which is correct behaviour.
  // Implement this only against a fetched capability check
  // (`capabilities.thinking.types` from /v1/models) — never from memory.

  // Structured output via output_config.format — NOT forced tool use (§1b).
  // The JSON arrives in a normal text block, which keeps parsing symmetric
  // with Gemini and means the provenance path downstream is identical.
  if (input.schema !== undefined) {
    body.output_config = { format: { type: "json_schema", schema: adaptSchemaForAnthropic(input.schema) } };
  }

  return body;
}

// ── Errors ───────────────────────────────────────────────────────────────
export interface AnthropicErrorBody {
  type?: string;
  error?: { type?: string; message?: string };
  request_id?: string;
}

/**
 * ⚠️ THE 401 TRAP. A missing browser-access header returns 401
 * `authentication_error` whose MESSAGE names the header. Mapping that to
 * `auth` would tell a user with a valid key that their key is invalid, and
 * send them to regenerate a working credential to fix a missing header.
 */
// ── THE DISCRIMINATOR, AND WHY IT IS NARROW ──────────────────────────────
//
// An earlier version matched `cors|browser|<header name>` as a disjunction.
// Bare "browser" was far too loose, and the consequence is the ORIGINAL TRAP
// INVERTED — and worse:
//
//   · Too loose  → a genuine invalid-key 401 whose message merely mentions a
//                  browser is reported as "YOUR API KEY IS FINE — do not
//                  regenerate it." The user's key really IS broken, and we
//                  have told them nothing is wrong. They cannot recover.
//   · Too strict → a missing-header 401 is reported as an auth failure. Bad,
//                  but the user is at least looking at a real failure.
//
// Being wrong in the "everything is fine" direction is strictly worse than
// being wrong in the "something is wrong" direction, so this errs narrow.
//
// Accepted ONLY when:
//   1. the message names the header explicitly — unambiguous on its own; or
//   2. a CORS/cross-origin token CO-OCCURS with a must-set/required token.
//
// Bare "cors" alone is NOT sufficient. Bare "browser" is not a trigger at all.
function looksLikeBrowserAccessRefusal(message: string): boolean {
  const text = message.toLowerCase();

  // (1) The header name is self-identifying.
  if (text.includes(BROWSER_ACCESS_HEADER)) {
    return true;
  }

  // (2) Both halves required. "cors" in isolation can appear in a genuine
  // auth message; "cors ... must be set to true" cannot plausibly be one.
  const corsToken = /\bcors\b|cross[- ]origin/.test(text);
  const requirementToken = /must (?:be )?(?:set|include|pass|send)|must set|required|not allowed unless|set .{0,40}\bto true\b|enable/.test(
    text,
  );
  return corsToken && requirementToken;
}

export function classifyAnthropicError(
  status: number,
  body: AnthropicErrorBody | null,
  headers?: { get(name: string): string | null },
): ProviderError {
  const apiType = body?.error?.type ?? "";
  const message = body?.error?.message ?? "";

  const retryAfterRaw = headers?.get("retry-after");
  const retryAfterSeconds = retryAfterRaw ? Number.parseFloat(retryAfterRaw) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.ceil(retryAfterSeconds * 1000) : undefined;

  let errorClass: ProviderErrorClass;
  let detail = message;

  if (status === 401 && looksLikeBrowserAccessRefusal(message)) {
    errorClass = "browser-access-header-missing";
    detail =
      `Anthropic rejected a browser-origin request because the "${BROWSER_ACCESS_HEADER}" header was missing. ` +
      "YOUR API KEY IS FINE — do not regenerate it. This is a request-header problem in EasyFilla, not a " +
      `credential problem. (Server said: ${message})`;
  } else {
    switch (status) {
      case 401:
      case 403:
        errorClass = "auth";
        break;
      case 402:
        // Monthly SPEND CAP, not a per-minute limit. Never retryable — the
        // §4c retry-storm lesson applies here in a different currency.
        errorClass = "quota-or-credit-exhausted";
        detail = message || "Anthropic reports a billing problem or an exhausted monthly spend cap.";
        break;
      case 404:
        errorClass = "invalid-model";
        break;
      case 429:
        errorClass = "rate-limit-per-minute";
        break;
      case 413:
        errorClass = "invalid-request";
        detail = message || "The request exceeded Anthropic's 32 MB limit.";
        break;
      case 500:
      case 529:
        errorClass = "overloaded";
        break;
      case 504:
        errorClass = "timeout";
        break;
      default:
        errorClass = apiType === "rate_limit_error" ? "rate-limit-per-minute" : "invalid-request";
        break;
    }
  }

  return new ProviderError({
    provider: "anthropic",
    errorClass,
    message: detail || `Anthropic returned ${status}.`,
    // Retryability comes from the SHARED set so the two providers cannot
    // disagree about what is worth retrying.
    retryable: isRetryableClass(errorClass),
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(apiType ? { metric: apiType } : {}),
  });
}

/** `stop_reason` → normalized class, for a 200 that produced nothing usable. */
export function classifyAnthropicStop(stopReason: string | null, hasText: boolean): ProviderError | null {
  if (stopReason === "refusal") {
    return new ProviderError({
      provider: "anthropic",
      errorClass: "safety-blocked",
      message: "Anthropic declined this request on policy grounds.",
      retryable: false,
    });
  }
  if (!hasText) {
    return new ProviderError({
      provider: "anthropic",
      errorClass: "empty-response",
      message:
        stopReason === "max_tokens"
          ? "Anthropic hit the output token limit before producing usable text — reduce the batch size."
          : `Anthropic returned no usable text (stop_reason: ${stopReason ?? "unknown"}).`,
      retryable: stopReason !== "max_tokens",
    });
  }
  return null;
}

// ── Response parsing ─────────────────────────────────────────────────────
export interface AnthropicResponse {
  content?: { type?: string; text?: string }[];
  stop_reason?: string | null;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Concatenates text blocks. Structured output arrives as a normal text block
 * (§1b), so this is the same extraction path a plain completion uses — which
 * is exactly why `output_config` was chosen over forced tool use.
 */
export function extractAnthropicText(payload: AnthropicResponse | null): string {
  if (!payload?.content || !Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

// ── Rate limits ──────────────────────────────────────────────────────────
/**
 * Anthropic RETURNS its limits in response headers, so unlike Gemini this can
 * be LEARNED rather than guessed (§1b). Until a real response has been seen it
 * stays null — §4c's refusal to invent a denominator applies here too.
 *
 * §3: this drives SPACING between sequential requests, never a concurrency
 * count. Concurrency is 1 and settled.
 */
let learnedRequestsPerMinute: number | null = null;

export function noteAnthropicRateHeaders(headers: { get(name: string): string | null }): void {
  const limit = headers.get("anthropic-ratelimit-requests-limit");
  const parsed = limit ? Number.parseInt(limit, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    learnedRequestsPerMinute = parsed;
  }
}

export function anthropicPerMinuteLimit(): number | null {
  return learnedRequestsPerMinute;
}

/** Test-only reset. */
export function resetAnthropicLearnedLimits(): void {
  learnedRequestsPerMinute = null;
}

// ── Models ───────────────────────────────────────────────────────────────
export interface AnthropicModelInfo {
  id: string;
  displayName: string;
  supportsStructuredOutputs: boolean;
  supportsPdf: boolean;
  supportsImages: boolean;
  maxTokens: number | null;
}

/**
 * Fetched from the API — NOTHING is hardcoded. The response carries a
 * `capabilities` object per model, so structured-output and PDF support are
 * read rather than assumed, and a model that cannot do what Stage A/B needs
 * can be excluded instead of failing at request time.
 * https://platform.claude.com/docs/en/api/models-list
 */
export function parseAnthropicModels(payload: unknown): AnthropicModelInfo[] {
  const data = (payload as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((raw) => {
    const model = raw as {
      id?: string;
      display_name?: string;
      max_tokens?: number;
      capabilities?: {
        structured_outputs?: { supported?: boolean };
        pdf_input?: { supported?: boolean };
        image_input?: { supported?: boolean };
      };
    };
    if (typeof model.id !== "string") {
      return [];
    }
    return [
      {
        id: model.id,
        displayName: model.display_name ?? model.id,
        supportsStructuredOutputs: model.capabilities?.structured_outputs?.supported === true,
        supportsPdf: model.capabilities?.pdf_input?.supported === true,
        supportsImages: model.capabilities?.image_input?.supported === true,
        maxTokens: typeof model.max_tokens === "number" && model.max_tokens > 0 ? model.max_tokens : null,
      },
    ];
  });
}

export async function listAnthropicModels(apiKey: string, signal?: AbortSignal): Promise<AnthropicModelInfo[]> {
  const response = await fetch(`${MODELS_URL}?limit=100`, {
    headers: anthropicHeaders(apiKey),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as AnthropicErrorBody | null;
    throw classifyAnthropicError(response.status, body, response.headers);
  }
  noteAnthropicRateHeaders(response.headers);
  return parseAnthropicModels(await response.json());
}

// ── The client ───────────────────────────────────────────────────────────
/**
 * ⚠️ Long requests: the docs warn that non-streaming requests are validated
 * against a **10-minute** ceiling and recommend streaming (or the Batches API)
 * beyond that, chiefly for large `max_tokens`. EasyFilla's requests are far
 * below that, so streaming is NOT implemented here. If a future change raises
 * `max_tokens` substantially, revisit this before assuming it still holds.
 * https://platform.claude.com/docs/en/api/errors  (§ Long requests)
 */
const REQUEST_TIMEOUT_MS = 60_000;

export interface AnthropicClientDeps {
  loadApiKey: () => Promise<string | null>;
  resolveModel: () => Promise<string>;
  saveModel: (modelId: string) => Promise<void>;
}

export function createAnthropicProvider(deps: AnthropicClientDeps): ProviderClient {
  return {
    id: "anthropic",
    displayName: "Anthropic Claude",
    dataDestination: "api.anthropic.com (Anthropic)",

    capabilities: {
      // Anthropic HAS a Files API (§1b) but ours is NOT implemented. This is
      // false deliberately: the flag describes what THIS CODE can do, not what
      // the vendor offers. Claiming otherwise would route oversized sets down
      // a path that does not exist.
      supportsFilesApi: false,
      maxInlineRequestBytes: ANTHROPIC_MAX_REQUEST_BYTES,
      maxPerFileBytes: ANTHROPIC_MAX_IMAGE_BYTES,
      supportedFileMimeTypes: new Set([...ANTHROPIC_IMAGE_MIME_TYPES, ...ANTHROPIC_DOCUMENT_MIME_TYPES]),
      // NO daily quota — per-minute token buckets plus a MONTHLY spend cap
      // surfacing as 402 (§1b). A daily counter must not be rendered for this
      // provider; there is no such number to show.
      hasDailyQuota: false,
      // anthropic-ratelimit-* headers mean the limit can be learned rather
      // than guessed.
      learnsLimitsFromResponseHeaders: true,
      hasMonthlySpendCap: true,
    },

    activeModel: deps.resolveModel,

    async listModels() {
      const key = await deps.loadApiKey();
      if (!key) {
        throw new ProviderError({
          provider: "anthropic",
          errorClass: "auth",
          message: "No Anthropic API key set — add one in Settings to list models.",
          retryable: false,
        });
      }
      // The API reports capabilities per model, so both requirements are READ
      // rather than assumed (§1b).
      return (await listAnthropicModels(key)).map((model) => ({
        id: model.id,
        displayName: model.displayName,
        supportsStructuredOutputs: model.supportsStructuredOutputs,
        supportsPdf: model.supportsPdf,
        // 0c: READ from the per-model `capabilities` object (§1b), not assumed.
        capabilitySource: "reported" as const,
      }));
    },

    async saveModel(modelId: string) {
      await deps.saveModel(modelId);
    },

    async perMinuteRequestLimit(): Promise<number | null> {
      return anthropicPerMinuteLimit();
    },

    async complete(request: CompleteRequest): Promise<CompleteResult> {
      const apiKey = await deps.loadApiKey();
      if (!apiKey) {
        throw new ProviderError({
          provider: "anthropic",
          errorClass: "auth",
          message: "No Anthropic API key set — add one in Settings.",
          retryable: false,
        });
      }
      const model = request.model ?? (await deps.resolveModel());

      const body = buildAnthropicBody({
        model,
        parts: request.parts,
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      });

      // The caller's signal (TASK C cancellation) and our own timeout are
      // distinct concerns; a timeout must never be reported as a user cancel.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const onAbort = (): void => controller.abort();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      let response: Response;
      try {
        response = await fetch(MESSAGES_URL, {
          method: "POST",
          headers: anthropicHeaders(apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new ProviderError({
          provider: "anthropic",
          errorClass: request.signal?.aborted ? "network" : "timeout",
          message: request.signal?.aborted
            ? "Cancelled."
            : `Anthropic didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s.`,
          retryable: !request.signal?.aborted,
        });
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }

      noteAnthropicRateHeaders(response.headers);

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as AnthropicErrorBody | null;
        throw classifyAnthropicError(response.status, errorBody, response.headers);
      }

      const payload = (await response.json()) as AnthropicResponse;
      const text = extractAnthropicText(payload);
      const stopError = classifyAnthropicStop(payload.stop_reason ?? null, Boolean(text.trim()));
      if (stopError) {
        throw stopError;
      }

      let structured: unknown | null = null;
      if (request.schema !== undefined && text.trim()) {
        try {
          structured = JSON.parse(text) as unknown;
        } catch {
          structured = null;
        }
      }

      return {
        text,
        structured,
        usage: {
          ...(typeof payload.usage?.input_tokens === "number" ? { inputTokens: payload.usage.input_tokens } : {}),
          ...(typeof payload.usage?.output_tokens === "number" ? { outputTokens: payload.usage.output_tokens } : {}),
        },
        finishReason: payload.stop_reason ?? null,
        provider: "anthropic",
        model: payload.model ?? model,
      };
    },
  };
}

// ⚠️ DELIBERATELY NOT REGISTERED AT MODULE SCOPE.
//
// E2 is additive only: nothing here may be reachable from an existing call
// site. Registering the provider would make it selectable the moment this
// module is imported. E3 owns wiring — settings UI, key storage, per-provider
// accounting and cache keys — and will call `registerProvider` there once
// those exist. Until then this module is inert by construction.
