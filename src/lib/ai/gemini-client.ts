import { loadGeminiApiKey } from "../storage/gemini-api-key";
import { resolveToOption } from "../profile/match";
import { enqueueGeminiRequest } from "./request-queue";
import { applyActiveProviderPacing } from "./pacing";
import { classifyQuotaWindow, extractObservedLimit } from "./request-budget";
import { ensureUploaded, checkUploadable, FileUploadError } from "./files-api";
import { debugLog } from "../debug";
// E3 — capability lookups only. Call sites never branch on provider identity.
import { activeProvider } from "./active-provider";
import { hasApiKey } from "../storage/provider-keys";
import { ProviderError } from "./provider";
// Re-exported so a test can register a provider into the SAME module graph the
// orchestration resolves through. Separate esbuild bundles each get their own
// copy of the registry, so importing it from elsewhere would register into a
// different Map and the swap would silently not take effect.
export { registerProvider, getProvider } from "./provider";
import {
  lengthTargetFor,
  TONE_INSTRUCTIONS,
  type ComposeLengthChoice,
  type ComposeToneChoice,
} from "../ui-prefs";
import { noteObservedDailyLimit, noteDailyQuotaExhausted } from "./quota-store";
import {
  loadSelectedModel,
  loadIngestModel,
  loadCachedModelList,
  saveModelList,
  DEFAULT_MODEL_ID,
} from "./model-config";
import {
  buildWireRequest,
  describeEmptyResponse,
  extractOutputText,
  type GeminiPart,
  type GeminiRequest,
  type ThinkingLevel,
  listModelsUrl,
  headersFor,
  INTERACTIONS_API_REVISION,
  type TransportName,
} from "./transport";
import {
  DOSSIER_SCHEMA,
  DOSSIER_SYSTEM_INSTRUCTION,
  countFacts,
  fileSetKey,
  loadCachedDossier,
  saveDossier,
  dossierCacheKey,
  dossierReuseVerdict,
  type Dossier,
  dossierToPromptJson,
  type SourcedValue,
} from "./dossier";

// The wire format lives in transport.ts, verified against the docs. Default is
// the Interactions API (GA, Google's recommended path); a 404 falls back to
// generateContent ONCE and sticks, so a project without Interactions access
// still works without re-probing on every call.
let activeTransport: TransportName = "interactions";
let transportLocked = false;

export function currentTransport(): TransportName {
  return activeTransport;
}

function endpointFor(model: string): string {
  return buildWireRequest(activeTransport, { model, parts: [] }).url;
}

// Preview/experimental models are rate-limited far more aggressively than the
// stable ones and are the usual source of a persistent 429/503.
function isPreviewModel(model: string): boolean {
  return /-(exp|preview|experimental)\b|-exp-|preview-\d/i.test(model);
}
// Fallback only — the ACTIVE model is whatever the user selected in Options.
// activeModel() resolves it and re-sizes the queue's spacing to that model's
// RPM, so switching models automatically re-throttles (FIX 6.2/6.4).
export const GEMINI_MODEL = DEFAULT_MODEL_ID;

async function activeModel(): Promise<string> {
  // ⚠️ 0b — THIS NO LONGER SETS THE GLOBAL PACE.
  //
  // It used to call setQueueRpm/setChunkSpacingMs from the selected GEMINI
  // model's assumedRpm. Because this is the only place that did, a user on
  // Anthropic was paced by a Gemini constant, and Anthropic's own limits — which
  // it returns in response headers — never took effect.
  //
  // Pacing now comes from the ACTIVE provider in `pacing.ts`. Resolving Gemini's
  // model must not decide how fast a different provider is allowed to go.
  const option = await loadSelectedModel();
  return option.id;
}

// Distinguished from a generic Error so callers (the sidepanel) can offer a
// direct "open Settings" action instead of just showing an error string.
export class MissingApiKeyError extends Error {
  constructor() {
    super("No Gemini API key found. Open the extension's Options page to add one.");
    this.name = "MissingApiKeyError";
  }
}

// The precise failure kind, so the UI can say exactly what's wrong (FIX 4)
// rather than a generic "AI error".
export type GeminiErrorKind =
  | "invalid_key"
  | "rate_limit_minute"
  | "daily_quota"
  | "overloaded"
  | "server"
  | "bad_request"
  | "network"
  | "timeout"
  | "blocked"
  | "empty"
  | "parse";

// How the attempt failed, kept separate from WHY. The three are genuinely
// different bugs and were previously all reported as "couldn't reach AI":
//   fetch-throw   — never got an HTTP response (DNS, offline, CORS, abort)
//   http-error    — got a response, status was not 2xx
//   empty-200     — status 200, but no usable text (safety block, MAX_TOKENS)
export type GeminiFailureMode = "fetch-throw" | "http-error" | "empty-200";

// A quota / network / parse failure. Carries `retryable` so the sidepanel can
// mark affected questions ERROR_RETRY (Problem 2) — NEVER "not found in
// documents", which would falsely imply the documents lacked the answer.
export class GeminiRequestError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly kind: GeminiErrorKind;
  readonly metric: string | undefined;
  // Server-supplied retry delay in ms (the live 429 supplied 46.657s). The
  // queue honors this instead of its own backoff when present.
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    retryable: boolean,
    kind: GeminiErrorKind,
    status?: number,
    metric?: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GeminiRequestError";
    this.retryable = retryable;
    this.status = status;
    this.kind = kind;
    this.metric = metric;
    this.retryAfterMs = retryAfterMs;
  }
}

// Google quotas reset at 00:00 Pacific. Returns that instant in the user's
// own local time, so the message is actionable wherever they are.
function nextPacificMidnightLocal(): string {
  const now = new Date();
  const pacNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const utcNow = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = utcNow.getTime() - pacNow.getTime();
  const pacMidnight = new Date(pacNow);
  pacMidnight.setHours(24, 0, 0, 0);
  const instant = new Date(pacMidnight.getTime() + offsetMs);
  return instant.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── PART 1: MAKE THE REAL FAILURE OBSERVABLE ──────────────────────────────
// One tagged line per failed attempt carrying everything needed to tell the
// classes apart without guessing. Never swallows the body: when JSON parsing
// fails, the raw text is logged verbatim.
interface FailureLogInput {
  mode: GeminiFailureMode;
  model: string;
  label: string;
  attemptNote?: string;
  status?: number;
  bodyText?: string;
  thrown?: unknown;
  payload?: unknown;
}

function logGeminiFailure(input: FailureLogInput): void {
  const { mode, model, label, status, bodyText } = input;
  const detail: Record<string, unknown> = {
    failureMode: mode,
    operation: label,
    model,
    // The key travels in a header and is never part of this URL.
    endpoint: endpointFor(model),
    modelIsPreview: isPreviewModel(model),
  };

  if (input.attemptNote) {
    detail.attempt = input.attemptNote;
  }
  if (status !== undefined) {
    detail.httpStatus = status;
  }

  if (mode === "fetch-throw") {
    const thrown = input.thrown;
    detail.thrownName = thrown instanceof Error ? thrown.name : typeof thrown;
    detail.thrownMessage = thrown instanceof Error ? thrown.message : String(thrown);
  }

  if (bodyText !== undefined) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: Record<string, unknown> };
      if (parsed.error) {
        detail.errorCode = parsed.error.code;
        detail.errorStatus = parsed.error.status;
        detail.errorMessage = parsed.error.message;
        detail.errorDetails = parsed.error.details;
      } else {
        detail.rawBody = bodyText.slice(0, 2000);
      }
    } catch {
      // Body wasn't JSON — an HTML error page from a proxy, or a truncated
      // stream. Log it raw rather than reporting "unknown error".
      detail.bodyWasNotJson = true;
      detail.rawBody = bodyText.slice(0, 2000);
    }
  }

  // A 200 that yields nothing is almost always a safety block or a token cap;
  // both look like success and return no text.
  if (mode === "empty-200") {
    const obj = (input.payload ?? {}) as {
      candidates?: { finishReason?: unknown; safetyRatings?: unknown }[];
      promptFeedback?: { blockReason?: unknown; safetyRatings?: unknown };
    };
    detail.finishReason = obj.candidates?.[0]?.finishReason ?? "(absent)";
    detail.blockReason = obj.promptFeedback?.blockReason ?? "(absent)";
    detail.safetyRatings = obj.candidates?.[0]?.safetyRatings ?? obj.promptFeedback?.safetyRatings ?? "(absent)";
    detail.rawPayload = input.payload;
  }

  console.error("[EasyFilla][Gemini] request failed —", detail);
}

// Turns a content-free 200 into a human cause.

// Classifies a non-OK response body into a precise GeminiRequestError.
// FIX 4.2: a requests-per-DAY quota is NOT retryable — it must stop and state
// the reset time, never spin a retry loop.
function classifyError(status: number, bodyText: string): GeminiRequestError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  const err = (parsed as { error?: Record<string, unknown> } | null)?.error;
  const message = typeof err?.message === "string" ? err.message : bodyText.slice(0, 200);
  const details = Array.isArray(err?.details) ? (err.details as Record<string, unknown>[]) : [];

  const statusText = typeof err?.status === "string" ? err.status : "";

  // AUTH — never retryable. Retrying an invalid key just burns the budget.
  if (status === 401 || status === 403 || /api[_ ]?key not valid|api_key_invalid|permission[_ ]denied|unauthenticated/i.test(`${message}${statusText}`)) {
    const notEnabled = /has not been used|is disabled|not enabled|SERVICE_DISABLED/i.test(message);
    return new GeminiRequestError(
      notEnabled
        ? `AI auth error — the Generative Language API isn't enabled for this key's project. ${message}`
        : `AI auth error — check your API key, and that the Generative Language API is enabled. ${message}`,
      false,
      "invalid_key",
      status,
    );
  }

  // 400 INVALID_ARGUMENT — a malformed request. Retrying re-sends the same
  // malformed request, so it can only fail identically. Common causes are a
  // bad model name, an oversized prompt, or an unsupported schema.
  if (status === 400 || status === 404) {
    // B3 — a raw relay of Google's message names what happened but not what to
    // DO about it. The three causes that actually occur are distinguishable
    // from the message text, and each has a different remedy.
    const badModel = /not found|is not supported|unsupported model|models\/[^\s]+ (?:is|was)/i.test(message);
    const tooBig = /too large|exceeds the maximum|payload size|request entity/i.test(message);
    const remedy = badModel
      ? " → The model name looks wrong or isn't available to this key. Pick a different model in Options; " +
        "model availability differs per key and changes over time."
      : tooBig
        ? " → The request was too large. Remove or downscale the biggest documents and rebuild the dossier."
        : " → This request can't succeed as sent, so it is not retried. If it persists after changing the model " +
          "in Options, it is a bug in EasyFilla's request shape — please report it with this message.";
    return new GeminiRequestError(
      `AI rejected the request (${status}${statusText ? ` ${statusText}` : ""}): ${message}${remedy}`,
      false,
      "bad_request",
      status,
    );
  }

  if (status === 429) {
    // Find the quota metric across QuotaFailure violations, and the
    // server-provided RetryInfo delay (e.g. "46.657000191s").
    let metric: string | undefined;
    let retryAfterMs: number | undefined;
    for (const detail of details) {
      const violations = (detail as { violations?: Record<string, unknown>[] }).violations;
      if (Array.isArray(violations)) {
        for (const v of violations) {
          const m = (v.quotaMetric ?? v.quotaId ?? v.subject) as string | undefined;
          if (typeof m === "string" && !metric) {
            metric = m;
          }
        }
      }
      const delay = (detail as { retryDelay?: unknown }).retryDelay;
      if (typeof delay === "string") {
        const seconds = Number.parseFloat(delay.replace(/s$/, ""));
        if (Number.isFinite(seconds)) {
          retryAfterMs = Math.ceil(seconds * 1000);
        }
      }
    }
    // Fallback: pull the delay out of the human-readable message.
    if (retryAfterMs === undefined) {
      const inline = message.match(/retry in ([\d.]+)s/i);
      if (inline?.[1]) {
        retryAfterMs = Math.ceil(Number.parseFloat(inline[1]) * 1000);
      }
    }

    // Daily quota won't clear inside four attempts — retrying is pure waste and
    // produced the observed "retry 4× then fail" loop.
    //
    // STAGE 3 — RE-VERIFIED, AND CORRECTED. The previous test was
    //   /per[_ -]?day|perday|daily|free[_ -]?tier/
    // which treats ANY free-tier violation as daily. But `free_tier` appears in
    // Google's PER-MINUTE metrics too:
    //   generativelanguage.googleapis.com/generate_content_free_tier_requests
    //   GenerateRequestsPerMinutePerProjectPerModel-FreeTier   ← per minute
    //   GenerateRequestsPerDayPerProjectPerModel-FreeTier      ← per day
    // so a per-minute free-tier 429 was being classified non-retryable and the
    // run stopped dead on something that would have cleared in 60 seconds.
    // Window tokens are now checked BEFORE the bare free-tier wording, and a
    // short server-supplied retryDelay is treated as proof of a per-minute
    // window. See `classifyQuotaWindow` in request-budget.ts.
    const haystack = `${metric ?? ""} ${message}`;
    const observedLimit = extractObservedLimit(details);
    if (observedLimit !== null) {
      void noteObservedDailyLimit(observedLimit, haystack, retryAfterMs);
    }
    if (classifyQuotaWindow(haystack, retryAfterMs) === "daily") {
      // The exhaustion point IS the allowance. Recording it makes the next
      // run's pre-flight estimate accurate instead of "limit unknown".
      void noteDailyQuotaExhausted();
      return new GeminiRequestError(
        `Gemini quota limit hit — ${message || metric || "daily quota exhausted"}. ` +
          `A daily quota won't clear by retrying: it resets around ${nextPacificMidnightLocal()} (00:00 Pacific). ` +
          "Everything completed so far has been kept. Switch model or key to continue now.",
        false, // NOT retryable — stop, don't loop
        "daily_quota",
        status,
        metric,
      );
    }
    return new GeminiRequestError(
      `Gemini rate limit hit (${metric ?? "requests per minute"}) — ${message || "too many requests"}. ` +
        (retryAfterMs
          ? `Waiting ${(retryAfterMs / 1000).toFixed(0)}s as the server instructed.`
          : "Wait a minute, or switch model/key."),
      true,
      "rate_limit_minute",
      status,
      metric,
      retryAfterMs,
    );
  }

  // 503 UNAVAILABLE / "model is overloaded" — transient and capacity-driven.
  // Deliberately does NOT carry retryAfterMs: a fixed server delay makes every
  // client retry in lockstep, so this one backs off exponentially instead.
  if (status === 503 || /overloaded|UNAVAILABLE/i.test(`${message}${statusText}`)) {
    return new GeminiRequestError(
      `Gemini is overloaded — ${message || "the model is temporarily unavailable"}. ` +
        "Retry shortly, or switch to a stable model.",
      true,
      "overloaded",
      status,
    );
  }

  return new GeminiRequestError(`Gemini server error (${status}): ${message}`, status >= 500, "server", status);
}

// Resolves the model, builds the wire request via the transport, and issues it.
// Every caller goes through here so the model in the URL, the model in the body
// and the model in the logs can never disagree.
export interface CallOptions {
  schema?: unknown;
  systemInstruction?: string;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  relaxedSafety?: boolean;
  // Overrides the user's chosen model — used by the ingest stage, which runs a
  // cheaper high-volume extraction model than the answering stage.
  modelOverride?: string;
}

async function callGemini(
  apiKey: string,
  parts: GeminiPart[],
  label: string,
  options: CallOptions = {},
): Promise<Response> {
  const model = options.modelOverride ?? (await activeModel());
  const request: GeminiRequest = {
    model,
    parts,
    ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
    ...(options.schema ? { responseSchema: options.schema } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.relaxedSafety ? { relaxedSafety: true } : {}),
  };

  console.log(
    `[EasyFilla][Gemini] ${label} → ${activeTransport} / ${model}` +
      (isPreviewModel(model) ? " (preview model — rate-limited harder than stable ones)" : ""),
  );

  const response = await geminiFetch(apiKey, request, label);

  // ONE probe: if Interactions isn't available to this project, fall back to
  // generateContent permanently for the session rather than re-probing (and
  // re-spending quota) on every subsequent call.
  if (response.status === 404 && activeTransport === "interactions" && !transportLocked) {
    transportLocked = true;
    activeTransport = "generateContent";
    console.warn(
      "[EasyFilla][Gemini] Interactions API returned 404 for this key/project — " +
        "falling back to the legacy generateContent endpoint for the rest of this session.",
    );
    return geminiFetch(apiKey, request, `${label} (generateContent fallback)`);
  }
  if (response.ok) {
    transportLocked = true;
  }
  return response;
}

// (textPart removed in E3d.0 — every text-only call site now builds its part
// inline for the provider interface, so no Gemini-shaped helper is needed.)

// ── TASK E1: the seam the provider interface sits on ──────────────────────
// This file IS the Gemini implementation — it is the only module that imports
// `transport.ts`, and it stays that way. `providers/gemini-provider.ts` adapts
// the three functions below to the shared `ProviderClient` interface without
// re-implementing any of them.
//
// Nothing here changes what goes on the wire. The acceptance gate
// (`tests/gemini-wire.test.mjs`) asserts that byte-for-byte.

/** Raw request → raw `Response`, including the 404 Interactions fallback. */
export async function callGeminiRaw(
  apiKey: string,
  parts: GeminiPart[],
  label: string,
  options: CallOptions = {},
): Promise<Response> {
  return callGemini(apiKey, parts, label, options);
}

/**
 * E3c — THE SAFETY-BLOCK RETRY, now Gemini-internal.
 *
 * Interactions does not accept custom safety settings, so a false positive
 * there is unappealable. Stage A's inputs are ID photos and personal letters —
 * exactly the shape of a spurious block. generateContent DOES accept
 * safetySettings, so a blocked build is retried there ONCE with
 * BLOCK_ONLY_HIGH (the loosest threshold available; it does not disable
 * filtering) rather than failing the whole dossier on one filter decision.
 *
 * ⚠️ THIS IS TRANSPORT BEHAVIOUR AND MUST NOT TRAVEL WITH THE ORCHESTRATOR.
 * It is two Gemini endpoints with different capabilities. Anthropic has no
 * equivalent — a `refusal` stop_reason is terminal there — and §3 requires the
 * orchestrator to be unable to tell which provider ran.
 *
 * Pinned by `tests/safety-retry.test.mjs`, which was written BEFORE this moved
 * because neither golden covers the blocked path.
 */
export async function readGeminiJsonWithSafetyRetry(
  call: GeminiJsonCall,
  onProgress?: (stage: string) => void,
): Promise<{ payload: unknown; text: string }> {
  try {
    return await readGeminiJson(call);
  } catch (error) {
    const blocked =
      error instanceof GeminiRequestError && error.kind === "blocked" && activeTransport === "interactions";
    if (!blocked) {
      throw error;
    }
    console.warn(
      "[EasyFilla][Dossier] Stage A was safety-blocked on the Interactions API, which doesn't accept custom " +
        "safety settings. Retrying once via generateContent with relaxed thresholds — ID photos and personal " +
        "letters are plausible false positives.",
    );
    onProgress?.("Safety filter tripped — retrying via the legacy endpoint…");
    const previous = activeTransport;
    activeTransport = "generateContent";
    try {
      return await readGeminiJson({ ...call, label: `${call.label} (safety fallback)`, relaxedSafety: true });
    } finally {
      activeTransport = previous;
    }
  }
}

/** The configured answering model. */
export async function activeGeminiModel(): Promise<string> {
  return activeModel();
}

/**
 * The selected model's assumed requests-per-minute.
 *
 * §3: this drives SPACING between sequential requests — it is NOT a
 * concurrency count. Gemini's figure is an ASSUMPTION baked into
 * `model-config.ts`, not something the API told us, which is why §4c still
 * refuses to invent a daily denominator from it.
 */
export async function geminiPerMinuteLimit(): Promise<number | null> {
  const option = await loadSelectedModel();
  return Number.isFinite(option.assumedRpm) ? option.assumedRpm : null;
}

// Re-exported so the provider adapter never needs transport.ts directly,
// leaving this file as the SINGLE importer of the wire format.
export type { GeminiPart };

export interface GeminiJsonCall extends CallOptions {
  parts: GeminiPart[];
  label: string;
  signal?: AbortSignal;
}

/**
 * One request → `{ payload, text }`, applying the SAME status and empty-200
 * handling every existing call site already applies.
 *
 * The empty-200 case matters: a safety block returns HTTP 200 with no usable
 * text and looks like success. `describeEmptyResponse` is the only way to
 * tell, and it must keep producing `blocked` (non-retryable) rather than
 * `empty` (retryable) for that case.
 */
export async function readGeminiJson(call: GeminiJsonCall): Promise<{ payload: unknown; text: string }> {
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) {
    throw new MissingApiKeyError();
  }
  const { parts, label, signal, ...options } = call;

  // A caller cancellation (TASK C) is not a provider failure — surface it as
  // an abort before spending anything further on it.
  if (signal?.aborted) {
    throw new GeminiRequestError("Cancelled before the request was sent.", false, "network");
  }

  const response = await callGemini(apiKey, parts, label, options);

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.error(`EasyFilla: Gemini API request failed (${response.status})`, bodyText);
    assertOkOrThrow(response.status, bodyText);
  }

  const payload: unknown = await response.json();
  const text = extractOutputText(payload);

  if (!text.trim()) {
    logGeminiFailure({ mode: "empty-200", model: await activeModel(), label, status: 200, payload });
    const reason = describeEmptyResponse(payload);
    throw new GeminiRequestError(
      `AI returned an empty response (${reason}).`,
      reason !== "blocked by safety filters",
      reason === "blocked by safety filters" ? "blocked" : "empty",
      200,
    );
  }

  return { payload, text };
}

// ── ListModels (PART 0) ───────────────────────────────────────────────────
// https://ai.google.dev/api/models. One GET per session, cached for a day.
// Deliberately NOT routed through the generate queue: it's a cheap metadata
// read on a different quota, and it must be able to run while generation is
// blocked precisely so it can explain WHY.
export interface ModelAvailability {
  ok: boolean;
  available: string[];
  message: string;
}

export async function verifyConfiguredModels(): Promise<ModelAvailability> {
  const apiKey = await loadGeminiApiKey();
  if (!apiKey) {
    return { ok: false, available: [], message: "No API key set — add one in Settings." };
  }

  let ids: string[];
  const cached = await loadCachedModelList();
  if (cached) {
    ids = cached.ids;
  } else {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(listModelsUrl(), {
        headers: { "x-goog-api-key": apiKey },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        logGeminiFailure({ mode: "http-error", model: "(ListModels)", label: "list-models", status: response.status, bodyText });
        const error = classifyError(response.status, bodyText);
        return { ok: false, available: [], message: error.message };
      }
      const payload = (await response.json()) as { models?: { name?: string }[] };
      // Names arrive as "models/gemini-3.6-flash".
      ids = (payload.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
      await saveModelList(ids);
    } catch (error) {
      logGeminiFailure({ mode: "fetch-throw", model: "(ListModels)", label: "list-models", thrown: error });
      return { ok: false, available: [], message: `Couldn't list models: ${describeThrownMessage(error)}` };
    }
  }

  const answering = (await loadSelectedModel()).id;
  const ingest = (await loadIngestModel()).id;
  const missing = [answering, ingest].filter((id, i, arr) => arr.indexOf(id) === i && !ids.includes(id));

  if (missing.length === 0) {
    console.log(`[EasyFilla][Gemini] models verified — answering=${answering}, ingest=${ingest} (${ids.length} available).`);
    return { ok: true, available: ids, message: `Models OK (${answering} / ${ingest}).` };
  }

  // Surface the closest valid alternatives rather than the full list of ~50.
  const suggestions = ids.filter((id) => /flash|pro/.test(id)).slice(0, 6);
  const message =
    `Model not available to this key: ${missing.join(", ")}. ` +
    (suggestions.length > 0 ? `Valid alternatives include: ${suggestions.join(", ")}.` : "");
  console.error(`[EasyFilla][Gemini] ${message}`);
  return { ok: false, available: ids, message };
}

// ── STAGE A: BUILD THE DOSSIER (PART 1) ───────────────────────────────────
// Files go to the model as raw bytes. No local OCR runs on this path — the
// model reads scans and photos natively, and a local pass would only add its
// own errors on top.
//
// The inline request-body ceiling is ~20 MB. base64 inflates by 4/3, so the
// budget is measured on ENCODED size and kept under the ceiling with headroom
// for the prompt text and JSON framing.
//
// The Files API is the documented route above this limit and is NOT implemented:
// rather than silently truncating or emitting a generic AI error, oversized sets
// fail with a message naming the specific files to shrink.
const MAX_INLINE_ENCODED_BYTES = 18 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Chunked to avoid blowing the argument limit on large files.
  for (let i = 0; i < buffer.length; i += 8192) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function mimeKindFor(file: File): GeminiPart["kind"] {
  return file.type.startsWith("image/") ? "image" : "document";
}

export interface DossierBuildResult {
  dossier: Dossier;
  model: string;
  fromCache: boolean;
}

export async function buildDossier(files: File[], onProgress?: (stage: string) => void): Promise<DossierBuildResult> {
  // 0b — pace from the ACTIVE provider before the first request of this run.
  // A provider switch re-paces here rather than waiting for Settings to be
  // reopened, and Anthropic learned limits apply from the response onward.
  await applyActiveProviderPacing();

  // E3c — NO PROVIDER-SPECIFIC KEY GATE HERE. Gating on a GEMINI key would
  // reject a Stage A run on any other provider. The active provider raises its
  // own key error from complete(); for Gemini that is still MissingApiKeyError,
  // thrown by readGeminiJson, so the message the UI catches is unchanged.
  //
  // The Files API path DOES need a Gemini key — it is a Gemini endpoint — so
  // that load moved into the branch that uses it, below.
  if (files.length === 0) {
    throw new GeminiRequestError("No documents uploaded — nothing to build a dossier from.", false, "bad_request");
  }

  // TASK E3.5 — the cache key includes PROVIDER and MODEL, so a dossier built
  // by one provider is never silently reused by another. The verdict carries a
  // REASON so the caller can say what is being rebuilt and why.
  const provider = await activeProvider();
  const cacheModel = await provider.activeModel();
  const fileHash = await fileSetKey(files);
  const key = dossierCacheKey(fileHash, provider.id, cacheModel);
  const cached = await loadCachedDossier();
  const verdict = dossierReuseVerdict(cached, fileHash, provider.id, cacheModel);

  if (verdict.reuse && cached) {
    console.log(
      `[EasyFilla][Dossier] cache HIT for this file set (${cached.fileCount} files, ${cached.factCount} facts, ` +
        `built ${new Date(cached.builtAt).toLocaleString()} by ${cached.provider ?? "unknown"}) — 0 Stage-A requests.`,
    );
    return { dossier: cached.dossier, model: cached.model, fromCache: true };
  }
  console.log(
    `[EasyFilla][Dossier] cache MISS — building from ${files.length} file(s). ` +
      `Reason: ${verdict.reuse ? "n/a" : verdict.reason}`,
  );

  // Size is measured as ENCODED bytes, not raw. base64 inflates by 4/3, so a
  // 16 MB set of phone photos becomes a ~21 MB request body and 400s against
  // the ~20 MB inline ceiling — measuring raw size would have let that through.
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const encodedBytes = Math.ceil(totalBytes * 4 / 3);

  // ── STAGE 4: FILES API ────────────────────────────────────────────────
  // Over the inline budget this used to hard-fail with "shrink these files".
  // Phone photos of documents cross that line routinely — a normal case, not an
  // edge case — so oversized sets now upload instead. Files are kept inline
  // BELOW the threshold: an upload is two extra round trips and a 48-hour
  // server-side copy, neither of which is worth paying for a 200 KB PDF.
  // ── TASK E3.6: CAPABILITY-GATED, NOT PROVIDER-GATED ───────────────────
  // The decision is "can this provider host files?" — never "is this Gemini?".
  // A provider without a Files API (Anthropic, whose own is not implemented —
  // §1b) must NOT reach the upload path; it enforces its inline ceiling and
  // fails with the offending files named instead.
  const capabilities = (await activeProvider()).capabilities;
  const inlineCeiling = capabilities.maxInlineRequestBytes;
  const overBudget = encodedBytes > inlineCeiling;

  if (overBudget && !capabilities.supportsFilesApi) {
    const ranked = [...files]
      .sort((a, b) => b.size - a.size)
      .map((file) => `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    const overBy = (encodedBytes - inlineCeiling) / 1024 / 1024;
    // E3d.3 — the error NAMES THE PROVIDER AND ITS LIMIT. These ceilings are
    // transcribed from docs and have never been tested against a real upload
    // (§7), so if a constant is wrong the failure has to be diagnosable rather
    // than mysterious: the message states which provider rejected it and at
    // what number, so a mismatch between our constant and reality is obvious.
    throw new GeminiRequestError(
      `Your ${files.length} file(s) encode to ~${(encodedBytes / 1024 / 1024).toFixed(1)} MB, which is ` +
        `${overBy.toFixed(1)} MB over ${provider.displayName}'s ` +
        `${(inlineCeiling / 1024 / 1024).toFixed(0)} MB request limit. ` +
        `Largest first: ${ranked.slice(0, 5).join(", ")}. ` +
        "Remove or downscale the largest files, then rebuild the dossier. " +
        `(${provider.displayName} has no file-upload path in EasyFilla, so oversized sets cannot be split out — ` +
        "see HANDOFF §1b.)",
      false,
      "bad_request",
    );
  }

  const useFilesApi = overBudget && capabilities.supportsFilesApi;
  if (useFilesApi) {
    console.log(
      `[EasyFilla][Dossier] ${files.length} file(s) encode to ~${(encodedBytes / 1024 / 1024).toFixed(1)} MB, ` +
        `over ${provider.displayName}'s ${(inlineCeiling / 1024 / 1024).toFixed(0)} MB inline budget — ` +
        "routing through the Files API.",
    );
    // Pre-validate every file BEFORE uploading any, so a set containing one
    // 60 MB PDF fails naming that file rather than after three slow uploads.
    const violations = files
      .map((file) => ({ file, reason: checkUploadable(file) }))
      .filter((entry): entry is { file: File; reason: string } => entry.reason !== null);
    if (violations.length > 0) {
      throw new GeminiRequestError(
        `${violations.length} file(s) can't be uploaded: ` +
          violations.map((v) => `"${v.file.name}" — ${v.reason}`).join("; "),
        false,
        "bad_request",
      );
    }
  }

  const parts: GeminiPart[] = [];
  for (const file of files) {
    onProgress?.(`Preparing ${file.name}…`);
    // The filename is announced as text immediately before its bytes so the
    // model can attribute source_filename correctly.
    parts.push({ kind: "text", text: `=== DOCUMENT: ${file.name} (${file.type || "unknown type"}) ===` });

    if (useFilesApi) {
      try {
        // The Files API is a GEMINI endpoint, so it needs a Gemini key — loaded
        // here, in the only branch that uses one, rather than gating the whole
        // provider-agnostic function on it.
        const filesApiKey = await loadGeminiApiKey();
        if (!filesApiKey) {
          throw new MissingApiKeyError();
        }
        const uploaded = await ensureUploaded(file, filesApiKey, onProgress);
        parts.push({
          kind: mimeKindFor(file),
          mimeType: uploaded.mimeType || file.type || "application/pdf",
          uri: uploaded.uri,
        });
      } catch (error) {
        // NEVER a generic AI error: the user cannot tell which of six documents
        // to fix from "upload failed".
        if (error instanceof FileUploadError) {
          throw new GeminiRequestError(error.message, error.retryable, "bad_request");
        }
        throw new GeminiRequestError(
          `Couldn't upload "${file.name}" — ${error instanceof Error ? error.message : "unknown error"}`,
          false,
          "bad_request",
        );
      }
    } else {
      parts.push({
        kind: mimeKindFor(file),
        mimeType: file.type || "application/pdf",
        data: await fileToBase64(file),
      });
    }
  }
  parts.push({
    kind: "text",
    text:
      "Build the dossier from the documents above. Attribute every value to the exact filename it came from. " +
      "Prefer labelled key-value rows over prose inference. Omit anything the documents do not state.",
  });

  const model = (await loadIngestModel()).id;
  onProgress?.(`Reading ${files.length} document(s) with ${model}…`);

  // Item 5 — the full request summary, so the dossier can be judged against
  // what was actually sent.
  console.log("[EasyFilla][Dossier] Stage A request", {
    fileCount: files.length,
    files: files.map((f) => ({ name: f.name, type: f.type || "(none)", bytes: f.size })),
    totalBytesRaw: totalBytes,
    totalBytesEncoded: encodedBytes,
    encodedHuman: `${(encodedBytes / 1024 / 1024).toFixed(2)} MB of ${MAX_INLINE_ENCODED_BYTES / 1024 / 1024} MB inline budget`,
    // STAGE 4 — which path each file took, so a slow or failed run can be
    // diagnosed without guessing.
    uploadMethod: useFilesApi ? "Files API (uri reference)" : "inline_data (base64)",
    filesApiUsed: useFilesApi,
    model,
    transport: activeTransport,
    apiRevision: INTERACTIONS_API_REVISION,
    partCount: parts.length,
  });


  // ── E3c: THROUGH THE PROVIDER INTERFACE ────────────────────────────────
  // The safety-block retry is no longer here. It is Gemini transport behaviour
  // (two endpoints, different capabilities) and now lives inside the Gemini
  // provider — Anthropic has no equivalent, and §3 requires the orchestrator to
  // be unable to tell which provider ran.
  let outputText: string;
  try {
    const completion = await provider.complete({
      parts,
      label: "dossier-build",
      schema: DOSSIER_SCHEMA,
      system: DOSSIER_SYSTEM_INSTRUCTION,
      // Carried over from the CallOptions this replaced. Dropping either would
      // change Stage A's real request — the orchestration golden asserts both.
      reasoningEffort: "medium",
      model,
      ...(onProgress ? { onProgress } : {}),
    });
    outputText = completion.text;
  } catch (error: unknown) {
    // A block that survives the provider's own retry is terminal and NOT
    // retryable: re-running burns quota on a decision that will not change.
    if (error instanceof ProviderError && error.errorClass === "safety-blocked") {
      throw new GeminiRequestError(
        "Dossier build returned nothing (blocked by safety filters).",
        false,
        "empty",
        200,
      );
    }
    throw error;
  }

  // B4 — builds are rare (once per file-set change) but the payload is the
  // model's reading of the user's identity documents. The LENGTH is the useful
  // diagnostic; the content is not logged.
  debugLog(`[EasyFilla][Dossier] Stage A returned ${outputText.length} chars of JSON.`);

  let raw: unknown;
  try {
    raw = JSON.parse(outputText);
  } catch {
    throw new GeminiRequestError("The dossier response wasn't valid JSON.", true, "parse");
  }

  const dossier = normalizeDossier(raw);
  const factCount = countFacts(dossier);
  // E3.5 — record WHICH PROVIDER produced this dossier. Without it a later
  // session cannot tell whether the cache is reusable, and would either
  // rebuild needlessly or reuse across providers silently.
  await saveDossier({
    key,
    dossier,
    fileCount: files.length,
    factCount,
    builtAt: Date.now(),
    model,
    provider: provider.id,
  });
  console.log(
    `[EasyFilla][Dossier] built — ${files.length} file(s), ${factCount} facts, ` +
      `provider ${provider.id}, model ${model}.`,
  );
  return { dossier, model, fromCache: false };
}

// The schema returns identity/contact/skills/preferences as {key,...} ARRAYS
// (proto3 JSON can't express open-ended objects); collapse them to records.
function normalizeDossier(raw: unknown): Dossier {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const toRecord = (value: unknown): Record<string, SourcedValue> => {
    const out: Record<string, SourcedValue> = {};
    if (Array.isArray(value)) {
      for (const entry of value) {
        const e = entry as { key?: string; value?: string; source_filename?: string; confidence?: string };
        if (e?.key && typeof e.value === "string" && e.value.trim()) {
          out[e.key] = {
            value: e.value.trim(),
            source_filename: e.source_filename ?? "(unattributed)",
            confidence: (e.confidence as SourcedValue["confidence"]) ?? "low",
          };
        }
      }
    } else if (value && typeof value === "object") {
      // Tolerate a model that returned a plain object anyway.
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const e = v as SourcedValue;
        if (e && typeof e.value === "string" && e.value.trim()) {
          out[k] = { ...e, value: e.value.trim() };
        }
      }
    }
    return out;
  };

  return {
    identity: toRecord(obj.identity),
    contact: toRecord(obj.contact),
    skills: toRecord(obj.skills),
    preferences: toRecord(obj.preferences),
    education: Array.isArray(obj.education) ? (obj.education as Dossier["education"]) : [],
    experience: Array.isArray(obj.experience) ? (obj.experience as Dossier["experience"]) : [],
    documents: Array.isArray(obj.documents) ? (obj.documents as Dossier["documents"]) : [],
    evidence: Array.isArray(obj.evidence) ? (obj.evidence as Dossier["evidence"]) : [],
  };
}

// ── STAGE B: ANSWER FROM THE DOSSIER (PART 1) ─────────────────────────────
// Raw documents never appear here. The dossier is small, so batches can be
// large and cheap, and the model spends its attention relating facts to
// questions instead of re-reading PDFs it already read in Stage A.
export const DEFAULT_QUESTION_CHUNK = 12;

// Exported for the E2 schema-adapter tests. THIS is the Stage B schema that
// carries the evidence array (dossier_path / source_filename / snippet /
// implied_value) the provenance state machine derives from (§3) — the adapter
// must be proven against it, not against a toy schema.
export const ANSWER_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      question_id: { type: "integer" },
      status: {
        type: "string",
        enum: ["answered_from_documents", "drafted", "needs_user_input", "manual_only"],
      },
      value: { type: "string", description: "The literal text to type. For multi-select, a JSON array of exact option strings." },
      source: { type: "string", description: "Filename the fact came from, or empty when not document-sourced." },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reasoning_brief: { type: "string", description: "One short clause. For needs_user_input, the specific question to ask the user." },
      evidence: {
        type: "array",
        description:
          "The dossier support for this answer. EMPTY ARRAY when the dossier does not support it — that is a " +
          "correct and expected outcome, never a failure.",
        items: {
          type: "object",
          properties: {
            dossier_path: { type: "string", description: "Dotted path into the dossier, e.g. identity.full_name" },
            source_filename: { type: "string", description: "The exact filename the dossier attributed this to" },
            implied_value: {
              type: "string",
              description:
                "The value THIS entry alone supports, normalized to how it would be typed into the field. Two " +
                "entries supporting the same fact must carry the same implied_value. If two documents genuinely " +
                "disagree, give each its own differing implied_value — do not silently pick one.",
            },
            snippet: {
              type: "string",
              description:
                "The supporting text. May be empty for CHOICE questions, where the justification is a dossier " +
                "field rather than a quotable sentence — but dossier_path and source_filename are still required.",
            },
          },
          required: ["dossier_path", "source_filename", "implied_value"],
        },
      },
    },
    required: ["question_id", "status", "value", "confidence", "reasoning_brief", "evidence"],
  },
};

const ANSWER_SYSTEM_INSTRUCTION = [
  "You fill forms on a person's behalf using ONLY the structured dossier provided. The dossier was extracted from",
  "their own uploaded documents. You never see the raw documents and must not invent facts beyond the dossier.",
  "",
  "STATUS RULES:",
  "- answered_from_documents: the dossier directly supports this value. Set `source` to the dossier's source_filename.",
  "- drafted: an open-ended question the dossier supports well enough to write a genuine answer for. Say so honestly.",
  "- needs_user_input: the dossier does NOT contain what's needed. `value` MUST be empty, and `reasoning_brief` MUST be",
  "  a specific one-line question asking the user for exactly the missing detail. Never fabricate, never stay silent.",
  "- manual_only: passwords, payment details, signatures, CAPTCHAs, or anything a person must supply in person.",
  "",
  "CHOICE QUESTIONS ARE NOT EXEMPT FROM EVIDENCE. Picking one of the form's own options does not make the choice",
  "grounded. You must still cite the dossier field and filename that justify choosing THAT option; only `snippet`",
  "may be empty for them. If the dossier says nothing about which option applies — e.g. which operating system or",
  "version control system the person uses — return needs_user_input with evidence: []. Do NOT guess an option.",
  "",
  "CHOICE QUESTIONS: when a question lists options, `value` MUST be one of those option strings copied VERBATIM,",
  "character for character. Do not paraphrase, re-case, or abbreviate. If none genuinely fits, use needs_user_input.",
  "For multi-select questions, `value` is a JSON array of verbatim option strings.",
  "",
  "EVIDENCE — every answer carries an `evidence` array naming the dossier field, the source filename, the value",
  "that entry implies, and the supporting snippet. When several documents support the SAME value, list them all:",
  "corroboration is the strongest grounding available. When two documents genuinely disagree (two different phone",
  "numbers, two spellings of a name), list BOTH with their differing implied_value — do not silently pick one.",
  "The supporting snippet. Returning `evidence: []` is CORRECT and EXPECTED whenever the dossier does not support an",
  "answer. It is not a failure and you are not being graded on filling it. An empty evidence array with a",
  "needs_user_input status is a perfect response.",
  "",
  "ANTI-FABRICATION — this is the most important rule here:",
  "You must NEVER invent a claim about the user's current state, opinions, or circumstances in order to avoid",
  "returning an empty answer. Sentences like 'I am not currently facing any technical hurdles', 'I have no",
  "suggestions at this time', or 'everything appears to be clear' are FABRICATIONS unless the dossier actually",
  "says so. You do not know whether the user has hurdles or suggestions. Returning needs_user_input with a",
  "specific question is ALWAYS the correct answer there — it is not a failure, it is the honest result.",
  "",
  "A blank field is always better than a wrong one. This is a real application form.",
].join("\n");

export interface DossierAnswer {
  status: "answered_from_documents" | "drafted" | "needs_user_input" | "manual_only" | "conflicting_sources";
  value: string;
  values?: string[];
  source: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  // Structural grounding: the dossier fields and filenames the model cited.
  // Empty means "unsupported", which is a legitimate, expected outcome.
  evidence: AnswerEvidence[];
}

export interface AnswerEvidence {
  dossier_path: string;
  source_filename: string;
  // The value this single entry supports. Comparing these is how corroboration
  // is told apart from disagreement WITHIN the dossier.
  implied_value: string;
  snippet: string;
}

// STAGE 1 — value-level agreement. FIX 2 removed plurality-as-conflict but left
// no detector for two dossier entries implying DIFFERENT values (resume says one
// phone number, reference sheet says another). This is that detector.
export interface EvidenceAgreement {
  agree: boolean;
  // One group per distinct value, each with the files asserting it.
  groups: { value: string; files: string[] }[];
}

function normalizeImplied(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

// "ECE" and "Electrical and Computer Engineering" are one fact, not two. Plain
// containment misses this — the acronym's letters are not contiguous in the
// expansion — and treating it as disagreement would flag the single strongest
// piece of corroboration in the user's document set for review.
const JOIN_WORDS = new Set(["and", "of", "the", "for", "in", "on", "with", "a", "an", "or", "to"]);

function acronymOf(text: string): string {
  return normalizeImplied(text.replace(/\([^)]*\)/g, " "))
    .split(" ")
    .filter((word) => word && !JOIN_WORDS.has(word))
    .map((word) => word[0] ?? "")
    .join("");
}

// STAGE 0a — acronym agreement must not suppress a REAL conflict.
//
// Initials alone are not identity: "ECE" expands to both "Electrical and
// Computer Engineering" and "Electronics and Communication Engineering", which
// are different programs. Merging them would stamp a genuine disagreement as
// answered_from_documents with confidence HIGH — failure in the dangerous
// direction. So an acronym/expansion pair coming from DIFFERENT files is only
// treated as one value when the dossier itself links them (writes them
// together, e.g. "Electrical and Computer Engineering (ECE)").
const ACRONYM_LINK_WINDOW = 80;

function dossierLinksAcronym(corpus: string, acronym: string, expansion: string): boolean {
  if (!corpus) {
    return false;
  }
  const haystack = corpus.toLowerCase();
  const needleExp = expansion.toLowerCase();
  const needleAcr = acronym.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needleExp, from);
    if (at === -1) {
      return false;
    }
    const window = haystack.slice(
      Math.max(0, at - ACRONYM_LINK_WINDOW),
      at + needleExp.length + ACRONYM_LINK_WINDOW,
    );
    // Word-boundary match so "ece" doesn't hit inside "piece".
    const escaped = needleAcr.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    if (new RegExp(String.raw`\b` + escaped + String.raw`\b`).test(window)) {
      return true;
    }
    from = at + needleExp.length;
  }
}

function looksLikeAcronym(value: string): boolean {
  return !value.includes(" ") && value.length <= 6;
}

function impliesSameValue(a: string, b: string, sameFile: boolean, corpus: string): boolean {
  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }

  const aIsAcronym = looksLikeAcronym(a);
  const bIsAcronym = looksLikeAcronym(b);
  const pair = aIsAcronym && acronymOf(b) === a ? { acronym: a, expansion: b } :
               bIsAcronym && acronymOf(a) === b ? { acronym: b, expansion: a } : null;
  if (!pair) {
    return false;
  }

  // Within one file the model is describing a single fact two ways; across
  // files it may be two different facts that share initials.
  if (sameFile) {
    return true;
  }
  return dossierLinksAcronym(corpus, pair.acronym, pair.expansion);
}

export function assessEvidenceAgreement(evidence: AnswerEvidence[], dossierCorpus = ""): EvidenceAgreement {
  const usable = evidence.filter((ev) => normalizeImplied(ev.implied_value || ev.snippet));
  if (usable.length === 0) {
    return { agree: true, groups: [] };
  }

  const groups: { value: string; norm: string; files: string[] }[] = [];
  for (const entry of usable) {
    const raw = entry.implied_value || entry.snippet;
    const norm = normalizeImplied(raw);
    // Containment counts as agreement, so "Riverton University" and
    // "Riverton University — RIT" are one fact. Acronyms are handled more
    // carefully — see impliesSameValue.
    const existing = groups.find((g) =>
      impliesSameValue(g.norm, norm, g.files.length === 1 && g.files[0] === entry.source_filename, dossierCorpus),
    );
    if (existing) {
      if (!existing.files.includes(entry.source_filename)) {
        existing.files.push(entry.source_filename);
      }
      // Keep the longer spelling as the group's label.
      if (norm.length > existing.norm.length) {
        existing.value = raw;
        existing.norm = norm;
      }
    } else {
      groups.push({ value: raw, norm, files: [entry.source_filename] });
    }
  }

  return {
    agree: groups.length <= 1,
    groups: groups.map((g) => ({ value: g.value, files: g.files })),
  };
}

const FILENAME_RE = /\.[A-Za-z0-9]{2,5}$/;

function isFilename(value: unknown): boolean {
  return typeof value === "string" && FILENAME_RE.test(value.trim());
}

function parseEvidence(raw: unknown): AnswerEvidence[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      dossier_path: String(entry.dossier_path ?? ""),
      source_filename: String(entry.source_filename ?? ""),
      implied_value: String(entry.implied_value ?? ""),
      snippet: String(entry.snippet ?? ""),
    }))
    .filter((entry) => entry.source_filename || entry.snippet);
}

export interface StageBOutcome {
  answers: Map<number, DossierAnswer>;
  // Question ids no chunk returned — the caller retries ONLY these.
  failedIds: number[];
  requestsUsed: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// Repairs a model answer that didn't match an option verbatim, BEFORE it can
// reach the PDF. Exact match first, then the local resolver (canonical forms,
// whole-word containment, acronyms). A value that still can't be resolved is
// downgraded to needs_user_input rather than filled wrong.
function repairChoiceValue(raw: string, options: string[]): { value: string; repaired: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (options.includes(trimmed)) {
    return { value: trimmed, repaired: false };
  }
  const resolved = resolveToOption(trimmed, options);
  return resolved ? { value: resolved, repaired: true } : null;
}

export async function answerFromDossier(
  dossier: Dossier,
  questions: QuestionForAi[],
  options: { chunkSize?: number; maxRequests?: number; language?: AnswerLanguage } = {},
): Promise<StageBOutcome> {
  // 0b — pace from the ACTIVE provider before the first request of this run.
  // A provider switch re-paces here rather than waiting for Settings to be
  // reopened, and Anthropic learned limits apply from the response onward.
  await applyActiveProviderPacing();

  // E3c — NO PROVIDER-SPECIFIC KEY GATE HERE.
  // The orchestrator is provider-agnostic: gating on a GEMINI key would
  // reject a run on any other provider. The active provider raises its own
  // key error from complete() — for Gemini that is still MissingApiKeyError,
  // thrown by readGeminiJson, so the message the UI catches is unchanged.

  const chunkSize = options.chunkSize ?? DEFAULT_QUESTION_CHUNK;
  const batches = chunk(questions, chunkSize);
  const maxRequests = options.maxRequests ?? batches.length;
  const answers = new Map<number, DossierAnswer>();
  const failedIds: number[] = [];
  let requestsUsed = 0;

  const dossierJson = dossierToPromptJson(dossier);

  for (const batch of batches) {
    if (requestsUsed >= maxRequests) {
      // Budget exhausted — everything left is reported as unattempted, not as
      // failed and not as "not in documents".
      batch.forEach((q) => failedIds.push(q.index));
      continue;
    }

    const questionBlock = batch
      .map((q) => {
        const opts =
          q.options.length > 0
            ? `\n   OPTIONS (copy one VERBATIM): ${q.options.map((o) => JSON.stringify(o)).join(" | ")}`
            : "";
        return `${q.index}. [${q.type}] ${q.questionText}${opts}`;
      })
      .join("\n");

    const prompt = [
      "=== DOSSIER (the only facts you may use) ===",
      dossierJson,
      "",
      options.language ? `Answer in ${options.language.name}.` : "Answer in the language of the questions.",
      "",
      "=== QUESTIONS ===",
      questionBlock,
      "",
      `Return exactly ${batch.length} entries, one per question_id above.`,
    ].join("\n");

    try {
      // ── E3c: THROUGH THE PROVIDER INTERFACE ──────────────────────────
      // ONE system instruction, identical on every provider — §3 requires the
      // provenance layer to be unable to tell which provider ran, and the
      // instruction is what carries the grounding rules it depends on.
      const provider = await activeProvider();
      const completion = await provider.complete({
        parts: [{ kind: "text", text: prompt }],
        label: `answer-batch-${requestsUsed + 1}`,
        schema: ANSWER_SCHEMA,
        system: ANSWER_SYSTEM_INSTRUCTION,
        reasoningEffort: "medium",
      });
      requestsUsed += 1;

      // Partial success is mandatory (§2): a batch that returns nothing usable
      // marks only ITS ids failed and lets the rest of the run continue.
      const parsed = completion.structured;
      if (!Array.isArray(parsed)) {
        batch.forEach((q) => failedIds.push(q.index));
        continue;
      }

      for (const entry of parsed) {
        const e = entry as Partial<Record<string, unknown>>;
        const id = typeof e.question_id === "number" ? e.question_id : NaN;
        const question = batch.find((q) => q.index === id);
        if (!question) {
          continue;
        }

        let status = (e.status as DossierAnswer["status"]) ?? "needs_user_input";
        let value = typeof e.value === "string" ? e.value.trim() : "";
        let values: string[] | undefined;

        // VERBATIM ENFORCEMENT — repaired locally before it can reach the PDF.
        if (question.options.length > 0 && value) {
          const multi = value.startsWith("[");
          const candidates: string[] = multi ? (safeJsonArray(value) ?? [value]) : [value];
          const resolvedAll = candidates
            .map((c) => repairChoiceValue(c, question.options))
            .filter((r): r is { value: string; repaired: boolean } => r !== null);

          if (resolvedAll.length === 0) {
            console.warn(
              `[EasyFilla][StageB] Q${id}: "${value}" matched none of [${question.options.join(" | ")}] — ` +
                "downgraded to needs_user_input rather than filling a non-option.",
            );
            status = "needs_user_input";
            value = "";
          } else {
            if (resolvedAll.some((r) => r.repaired)) {
              // B4 — option labels come from the FORM (not the user's
              // documents) so they are safe, but this is per-field chatter.
              debugLog(`[EasyFilla][StageB] Q${id}: repaired "${value}" → "${resolvedAll.map((r) => r.value).join(", ")}"`);
            }
            if (multi) {
              values = resolvedAll.map((r) => r.value);
              value = values.join(", ");
            } else {
              value = resolvedAll[0]!.value;
            }
          }
        }

        // A non-empty value with needs_user_input, or an empty value claiming an
        // answer, are both incoherent — normalize rather than trust.
        if (status === "needs_user_input") {
          value = "";
        } else if (!value) {
          status = "needs_user_input";
        }

        // STRUCTURAL GROUNDING (B-FIX 1). No text inspection: provenance is
        // decided by whether the model cited evidence, not by how the sentence
        // is phrased. The old first-person regex both downgraded genuinely
        // grounded answers that opened with "I am" and missed fabrications
        // phrased without those tokens.
        const evidence = parseEvidence(e.evidence);
        const cited = evidence.filter((ev) => isFilename(ev.source_filename));

        // FIX 1: choice questions are NOT exempt. Picking one of the form's own
        // option strings does not make the SELECTION grounded — that exemption
        // whitelisted exactly the questions that fabricated (OS, VCS, preferred
        // channel). Only the SNIPPET requirement is relaxed for them, because
        // the justification is a dossier field, not a quotable sentence.
        if (value && cited.length === 0) {
          console.warn(
            `[EasyFilla][StageB] Q${id}: answered with evidence: [] and no cited file — ` +
              "downgraded to needs_user_input (structural grounding).",
          );
          status = "needs_user_input";
          value = "";
        }

        // FIX 2: several files citing the SAME value is corroboration — the
        // strongest grounding available — not a conflict. The previous rule
        // (>=2 entries, different files, different snippets) flagged the resume
        // and the reference sheet agreeing on ECE as something to review.
        // Genuine value disagreement is detected against local extraction in
        // the sidepanel's reconcileWithDossier; here, plurality means confidence.
        const agreement = assessEvidenceAgreement(cited, dossierJson);
        if (!agreement.agree) {
          console.warn(
            `[EasyFilla][StageB] Q${id}: evidence implies DIFFERENT values — conflicting_sources.`,
            agreement.groups.map((g) => `"${g.value}" (${g.files.join(", ")})`),
          );
          status = "conflicting_sources";
        } else if (cited.length > 1) {
          const files = [...new Set(cited.map((ev) => ev.source_filename))];
          if (files.length > 1) {
            console.log(`[EasyFilla][StageB] Q${id}: corroborated by ${files.join(", ")} — confidence raised.`);
          }
        }

        answers.set(id, {
          status,
          value,
          evidence: cited,
          ...(values ? { values } : {}),
          source: typeof e.source === "string" ? e.source : "",
          // Corroboration across distinct files raises confidence.
          confidence:
            agreement.agree && new Set(cited.map((ev) => ev.source_filename)).size > 1
              ? "high"
              : ((e.confidence as DossierAnswer["confidence"]) ?? "low"),
          reasoning: typeof e.reasoning_brief === "string" ? e.reasoning_brief : "",
        });
      }

      // PARTIAL SUCCESS: only the ids this batch didn't return are failures.
      // A good answer is never discarded because a sibling was missing.
      batch.filter((q) => !answers.has(q.index)).forEach((q) => failedIds.push(q.index));
    } catch (error) {
      requestsUsed += 1;
      const quotaStop = error instanceof GeminiRequestError && error.kind === "daily_quota";
      console.warn(
        `[EasyFilla][StageB] batch failed (${describeGeminiError(error)}) — ` +
          `${answers.size} answer(s) already collected are KEPT.`,
      );
      batch.forEach((q) => failedIds.push(q.index));
      if (quotaStop) {
        // Every remaining batch would fail identically. Stop, keep the work.
        batches.slice(batches.indexOf(batch) + 1).forEach((rest) => rest.forEach((q) => failedIds.push(q.index)));
        break;
      }
    }
  }

  console.log(
    `[EasyFilla][StageB] ${answers.size}/${questions.length} answered in ${requestsUsed} request(s); ` +
      `${failedIds.length} unresolved.`,
  );
  return { answers, failedIds, requestsUsed };
}

function safeJsonArray(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function describeThrownMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "timed out";
  }
  return error instanceof Error ? error.message : String(error);
}

// FIX 1.3 / 3.1: THE single chokepoint. Every Gemini request in the entire
// extension goes through here, and here goes through the global queue —
// concurrency 1, rolling-window pacing, retries counted against the budget.
// No other module may construct its own fetch to the API.
//
// The queue retries by re-invoking this task, so a 429 with a server
// retryDelay is honored centrally rather than per-feature.
// A stalled request must never hang the extension. `fetch` has NO default
// timeout: if the connection is opened but the response never arrives, the
// promise never settles, the concurrency-1 queue stays blocked behind it, and
// the UI sits on "Analyzing…" forever with no error and no PDF. That is
// exactly the failure this bounds.
const REQUEST_TIMEOUT_MS = 60_000;

async function geminiFetch(apiKey: string, request: GeminiRequest, label = "gemini"): Promise<Response> {
  const model = request.model;
  const wire = buildWireRequest(activeTransport, request);
  return enqueueGeminiRequest(
    async () => {
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(wire.url, {
          method: "POST",
          headers: headersFor(activeTransport, apiKey),
          body: JSON.stringify(wire.body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        logGeminiFailure({ mode: "fetch-throw", model, label, thrown: error });
        // An abort is our own timeout firing, not a caller cancellation. It's
        // reported as its own class so a hung request is never confused with
        // an unreachable network.
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new GeminiRequestError(
            `AI timed out — Gemini didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s.`,
            true,
            "timeout",
          );
        }
        throw new GeminiRequestError(
          `Couldn't reach AI (network): ${error instanceof Error ? error.message : "unknown"}`,
          true,
          "network",
        );
      }

      // `fetch` resolves as soon as HEADERS arrive — a body that never finishes
      // streaming would still hang forever. Drain it here, inside the timeout,
      // then hand callers an in-memory Response that cannot stall.
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (error) {
        logGeminiFailure({ mode: "fetch-throw", model, label, status: response.status, thrown: error });
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new GeminiRequestError(
            `AI timed out — Gemini stopped sending its response after ${REQUEST_TIMEOUT_MS / 1000}s.`,
            true,
            "timeout",
          );
        }
        throw new GeminiRequestError(
          `Couldn't reach AI (network) — failed reading the response: ${error instanceof Error ? error.message : "unknown"}`,
          true,
          "network",
        );
      } finally {
        clearTimeout(timer);
      }

      // Every non-OK response is logged with its real status and Gemini's own
      // error message, whether or not it will be retried.
      if (!response.ok) {
        logGeminiFailure({ mode: "http-error", model, label, status: response.status, bodyText });
        // Throw retryable failures INSIDE the task so the queue can retry them
        // while counting each attempt against the rolling window.
        const error = classifyError(response.status, bodyText);
        if (error.retryable) {
          throw error;
        }
      }
      // The Response constructor rejects a body on null-body statuses, which a
      // proxy in front of the API can legitimately return.
      const nullBody = [101, 204, 205, 304].includes(response.status);
      return new Response(nullBody ? null : bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
      });
    },
    {
      label,
      classify: (error) =>
        error instanceof GeminiRequestError
          ? { retryable: error.retryable, retryAfterMs: error.retryAfterMs }
          : { retryable: false },
    },
  );
}

function assertOkOrThrow(status: number, bodyText: string): void {
  const error = classifyError(status, bodyText);
  console.warn(`EasyFilla(gemini): request failed — kind=${error.kind}, retryable=${error.retryable}`, error.message);
  throw error;
}

// Human-readable one-liner for any error thrown by this module.
export function describeGeminiError(error: unknown): string {
  if (error instanceof MissingApiKeyError) {
    return "No Gemini API key set — add one in Settings.";
  }
  if (error instanceof GeminiRequestError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Unknown error.";
}

export interface ConnectionTestResult {
  ok: boolean;
  kind: GeminiErrorKind | "ok" | "no_key";
  message: string;
}

// FIX 4.1: one minimal request that reports exactly what's wrong.
/**
 * E3d.0 — the connection test is now PER PROVIDER.
 *
 * A connection test is legitimately provider-specific: it exists to tell the
 * user whether *their key for the selected provider* works. What it must not
 * do is test Gemini while the user has selected something else — that reports
 * a healthy connection to a vendor they are not using, and would report a
 * FAILURE for a user whose selected provider is fine but who has no Gemini key.
 *
 * It sends the single word "ping" — no user content — which is why it is safe
 * to run on demand from Settings.
 */
export async function testProviderConnection(): Promise<ConnectionTestResult> {
  const provider = await activeProvider();
  if (!(await hasApiKey(provider.id))) {
    return {
      ok: false,
      kind: "no_key",
      message: `No ${provider.displayName} API key saved. Paste one above and Save first.`,
    };
  }
  try {
    await provider.complete({ parts: [{ kind: "text", text: "ping" }], label: "connection-test" });
    return {
      ok: true,
      kind: "ok",
      message: `Connection OK — your ${provider.displayName} key works and quota is available.`,
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      // The browser-access header case must NOT read as an auth failure —
      // telling a user with a valid key that it is invalid is the worst
      // outcome available here (§1b).
      const kind: GeminiErrorKind =
        error.errorClass === "browser-access-header-missing"
          ? "bad_request"
          : PROVIDER_CLASS_TO_KIND[error.errorClass] ?? "network";
      return { ok: false, kind, message: error.message };
    }
    if (error instanceof GeminiRequestError) {
      return { ok: false, kind: error.kind, message: error.message };
    }
    return { ok: false, kind: "network", message: describeGeminiError(error) };
  }
}

/** Back-compat alias; the Settings page calls the provider-aware name. */
export const testGeminiConnection = testProviderConnection;

// Maps the shared taxonomy back onto the legacy `kind` the Settings UI renders.
const PROVIDER_CLASS_TO_KIND: Record<string, GeminiErrorKind> = {
  network: "network",
  timeout: "timeout",
  auth: "invalid_key",
  "browser-access-header-missing": "bad_request",
  "invalid-request": "bad_request",
  "invalid-model": "bad_request",
  "rate-limit-per-minute": "rate_limit_minute",
  "quota-or-credit-exhausted": "daily_quota",
  overloaded: "overloaded",
  "safety-blocked": "blocked",
  "empty-response": "empty",
};

export interface QuestionForAi {
  index: number;
  questionText: string;
  type: string;
  options: string[];
}

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      questionIndex: { type: "integer" },
      answer: {
        type: "string",
        description:
          "ONLY the literal text a person would type into the form field. Empty string if nothing could be " +
          "determined. Never a description, explanation, apology, or instruction.",
      },
      sourced: {
        type: "boolean",
        description:
          "true if the answer is directly stated (or a plain factual restatement of something stated) in the " +
          "documents. false if it's an inference/best-effort suggestion for a personal or subjective question, " +
          "or if answer is empty.",
      },
      category: {
        type: "string",
        enum: ["answerable", "not_in_documents", "personal"],
        description:
          "answerable = the documents contain (or strongly support) an answer. " +
          "not_in_documents = a FACTUAL question (e.g. ID number, a specific date, an address) whose answer is " +
          "simply not present in the documents — the user must supply it. " +
          "personal = an inherently subjective/personal question only the user can truly answer (opinions, " +
          "motivations, preferences), whether or not you offered a draft.",
      },
    },
    required: ["questionIndex", "answer", "sourced", "category"],
  },
};

export type AnswerCategory = "answerable" | "not_in_documents" | "personal";

export type GeminiMode = "match" | "defaults";

// Passed through from the detected form language. `code` is ISO 639-1 (or
// "und"); `name` is a human name for the prompt. When undetermined we tell
// the model to answer in the questions' own language.
export interface AnswerLanguage {
  code: string;
  name: string;
}

function languageInstruction(language: AnswerLanguage | undefined): string {
  if (!language || language.code === "und") {
    return "- Write every answer in the SAME LANGUAGE the form questions are written in, regardless of what language the uploaded documents use.";
  }
  return (
    `- Write every free-text answer in ${language.name} (ISO 639-1 "${language.code}"), regardless of what ` +
    `language the uploaded documents use. Translate/compose as needed. ` +
    `EXCEPTION: for choice questions, return the option text EXACTLY as listed (it is already in the form's language) — do not translate the option.`
  );
}

function buildPrompt(
  documentContext: string,
  questions: QuestionForAi[],
  mode: GeminiMode,
  language: AnswerLanguage | undefined,
  profileContext: string,
): string {
  const questionsBlock = questions
    .map((question) => {
      const optionsText = question.options.length > 0 ? ` Options: ${question.options.join(" | ")}.` : "";
      return `${question.index}. [${question.type}] ${question.questionText}${optionsText}`;
    })
    .join("\n");

  const modeInstructions =
    mode === "match"
      ? [
          "For each question, decide whether the documents contain a direct, relevant answer, and set `sourced` accordingly:",
          "- FACTUAL questions (name, contact info, dates, employers, objective details): only answer if directly stated in the documents, and set sourced=true. Never invent a fact that isn't there — if it's not in the documents, answer=\"\" and sourced=false.",
          "- PERSONAL or SUBJECTIVE questions (opinions, motivations, self-assessments, \"why do you want this role\", preferences, essay-style prompts): if nothing in the documents bears on it, answer=\"\" and sourced=false. Only offer an inferred answer if you can point to something SPECIFIC and CONCRETE in the documents that supports it (a named skill, project, role, or achievement) — and even then, keep it brief and set sourced=false. If you can't point to something concrete, leave answer=\"\" — do not write generic filler.",
        ]
      : [
          "The user asked you to try harder on questions that had no direct answer. You may look for INDIRECT evidence in the documents/profile, but you may NOT invent.",
          "- EVERY answer must be derivable from something actually present in the documents or profile. You may combine, restate, or infer from concrete evidence there.",
          "- If nothing in the documents or profile supports an answer, return answer=\"\" — do NOT supply a plausible-sounding default. A blank the user fills in is REQUIRED and is better than an invented value.",
          "- Never invent names, employers, dates, institutions, ID numbers, addresses, qualifications, metrics, or achievements. If it isn't in the documents, it doesn't exist.",
          "- For choice-based questions, pick a listed option ONLY if the documents/profile support that choice; otherwise answer=\"\".",
          "- Set sourced=true only if the answer is explicitly stated in the documents; if it's an inference from them, set sourced=false so the user verifies it.",
        ];

  return [
    "You are helping a user fill out a form by finding answers in documents they uploaded (e.g. a resume or CV).",
    "You are given (1) a structured profile of facts already extracted from their documents, (2) the raw document text, and (3) a numbered list of form questions.",
    "Prefer the structured profile for contact/identity facts; fall back to the document text for everything else.",
    ...modeInstructions,
    "- If the question is multiple choice, checkboxes, dropdown, or a linear scale, answer using the EXACT wording of one of the listed options (comma-separated if more than one applies for checkboxes). Never invent an option that isn't listed.",
    languageInstruction(language),
    "- Never set sourced=true unless the answer is genuinely stated or directly implied in the documents or profile.",
    "CRITICAL: `answer` must contain ONLY the literal text a person would type into the field — never a description of your reasoning, never placeholder/instructional text, never phrases like \"based on the documents\" or \"I cannot determine this\" or \"write something here\". If you cannot determine an answer, the correct value is exactly an empty string \"\", not an explanation of why.",
    "Respond with one entry per question, in the given schema, using the question's index number.",
    "",
    "=== Structured profile (high-confidence extracted facts) ===",
    profileContext,
    "",
    "=== Uploaded document text ===",
    documentContext.trim() || "(no documents were uploaded)",
    "",
    "=== Form questions ===",
    questionsBlock,
  ].join("\n");
}


// Defends against exactly the failure observed in testing: the model (or a
// broken structured-output path) echoing meta-commentary/instruction text
// back as if it were the answer. Any match is treated as "no answer" rather
// than surfaced to the user as if it were real content.
const SUSPICIOUS_ANSWER_PATTERNS: RegExp[] = [
  /\bas an ai\b/i,
  /\bas a language model\b/i,
  /\bi cannot\b/i,
  /\bi can't\b/i,
  /\bi'm unable to\b/i,
  /\bi am unable to\b/i,
  /\bi don't have access\b/i,
  /\bi do not have access\b/i,
  /\bplease provide\b/i,
  /\bwrite something\b/i,
  /\bbased on the uploaded\b/i,
  /\bas a placeholder\b/i,
];

function looksLikeLeakedInstruction(answer: string): boolean {
  return SUSPICIOUS_ANSWER_PATTERNS.some((pattern) => pattern.test(answer));
}

export interface GeminiAnswer {
  answer: string;
  sourced: boolean;
  category: AnswerCategory;
}

export async function matchAnswersWithGemini(
  documentContext: string,
  questions: QuestionForAi[],
  mode: GeminiMode = "match",
  language?: AnswerLanguage,
  profileContext = "(no structured profile extracted)",
): Promise<Map<number, GeminiAnswer>> {
  // E3d.0 — NO GEMINI KEY GATE. These paths carry the FORM'S OWN TEXT, so
  // they must follow the user's provider selection. Gating on a Gemini key
  // made them fail (or silently no-op) for a user on another provider whose
  // configuration was perfectly correct. The active provider raises its own
  // key error from complete().

  const prompt = buildPrompt(documentContext, questions, mode, language, profileContext);

  console.log("[EasyFilla][Gemini] classify request", {
    documentContextLength: documentContext.length,
    questionCount: questions.length,
    promptChars: prompt.length,
  });

  // ── E3d.0: THROUGH THE PROVIDER INTERFACE ──────────────────────────────
  // This prompt carries the FORM'S QUESTION TEXT. Sending it to Gemini while
  // the user has selected Anthropic would make the privacy disclosure false —
  // it promises content goes to the provider they chose. The empty-200 and
  // safety-block handling now lives in the provider, which raises the shared
  // `safety-blocked` / `empty-response` classes.
  const provider = await activeProvider();
  const completion = await provider.complete({
    parts: [{ kind: "text", text: prompt }],
    label: "classify",
    schema: RESPONSE_SCHEMA,
    reasoningEffort: "medium",
  });

  const parsed = completion.structured;
  if (parsed === null) {
    throw new GeminiRequestError("The AI returned a response that wasn't valid JSON.", true, "parse");
  }
  if (!Array.isArray(parsed)) {
    throw new GeminiRequestError("The AI's structured response wasn't an array as expected.", true, "parse");
  }

  const answers = new Map<number, GeminiAnswer>();
  parsed.forEach((entry) => {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { questionIndex?: unknown }).questionIndex === "number" &&
      typeof (entry as { answer?: unknown }).answer === "string"
    ) {
      const { questionIndex, answer } = entry as { questionIndex: number; answer: string };
      const sourced = (entry as { sourced?: unknown }).sourced === true;
      const rawCategory = (entry as { category?: unknown }).category;
      const category: AnswerCategory =
        rawCategory === "not_in_documents" || rawCategory === "personal" ? rawCategory : "answerable";

      if (answer && looksLikeLeakedInstruction(answer)) {
        console.warn(
          `EasyFilla: discarding suspicious answer for question ${questionIndex} (looks like leaked instruction/meta-commentary rather than a real answer):`,
          answer,
        );
        answers.set(questionIndex, { answer: "", sourced: false, category });
        return;
      }

      answers.set(questionIndex, { answer, sourced, category });
    } else {
      console.warn("EasyFilla: skipping malformed Gemini response entry", entry);
    }
  });

  console.log(
    `EasyFilla: Gemini matching complete — ${Array.from(answers.values()).filter((a) => a.sourced).length} sourced, ` +
      `${Array.from(answers.values()).filter((a) => !a.sourced && a.answer).length} unsourced suggestions, ` +
      `${questions.length - answers.size} question(s) with no valid entry at all.`,
  );

  return answers;
}

// ── Composition mode (Feature 3) ─────────────────────────────────────────

// TASK B — length and tone are SEPARATE axes. They used to be entangled
// ("shorter" also read as terser/less formal), which made a short FORMAL
// answer inexpressible. They are now independent, and length is stated as an
// explicit WORD RANGE rather than an adjective: "make it shorter" produced
// answers of wildly different size between runs, because it told the model
// nothing reproducible.
export type ComposeLength = ComposeLengthChoice;
export type ComposeTone = ComposeToneChoice;

export interface ComposeRequestItem {
  index: number;
  questionText: string;
  isEssay: boolean; // essays get a wider word band than a one-line field
  guidance?: string; // optional per-question steering from the user
  seed?: string; // the user's rough, unpolished seed to expand (Problem 3)
  // TASK B — PER QUESTION, not per batch. A batch may legitimately mix a long
  // formal essay with a short conversational one; the previous code took the
  // first item's settings and silently applied them to every question in the
  // request.
  length?: ComposeLength;
  tone?: ComposeTone;
  // TASK D2 — how many alternative drafts to return for this question. The
  // variants come back in ONE request (an array), so N drafts cost ONE unit of
  // budget rather than N.
  variants?: number;
}

export interface ComposeResult {
  draft: string;
  // The hard-fail signal (3.4): true when the seed is empty AND the documents
  // contain nothing relevant, so no draft could be responsibly written. A
  // first-class return value, never an error — the UI blocks Continue-and-Fill.
  notFound: boolean;
  sourced: boolean;
  // Whether the user's seed was actually used to ground the draft.
  seedUsed: boolean;
  // Which uploaded documents (by name) grounded the draft.
  groundedDocuments: string[];
  // What the model would need from the user to strengthen a thin answer —
  // surfaced instead of padding with invention.
  gaps: string[];
  /**
   * TASK D2 — alternative PROSE over the SAME evidence.
   *
   * `draft` is always the first variant, so every existing caller is unaffected.
   * Empty when only one draft was requested.
   *
   * ⚠️ PROVENANCE INVARIANT (§3, §6b.5). Variants share ONE evidence set. They
   * do not carry their own `groundedDocuments`, `sourced` or `notFound`, and
   * they must not: picking a variant is choosing wording, never choosing a
   * different claim about what the documents say. An evidence-empty compose is
   * `notFound` no matter how many variants came back — three fluent drafts of an
   * ungrounded answer are three fabrications, not a choice.
   */
  variants: string[];
}

const COMPOSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      questionIndex: { type: "integer" },
      draft: {
        type: "string",
        description: "The composed answer text ONLY, in the form's language. Empty string if notFound is true.",
      },
      notFound: {
        type: "boolean",
        description:
          "true ONLY if the user's seed is empty AND the documents/profile contain nothing relevant, so no " +
          "grounded answer is possible. When true, draft MUST be empty — never fabricate.",
      },
      sourced: {
        type: "boolean",
        description: "true if the draft is grounded in specific facts from the documents/profile.",
      },
      seedUsed: {
        type: "boolean",
        description: "true if the user's seed text was used to ground the draft.",
      },
      groundedDocuments: {
        type: "array",
        items: { type: "string" },
        description: "Names of the uploaded documents whose content grounded this draft. Empty if notFound.",
      },
      gaps: {
        type: "array",
        items: { type: "string" },
        description:
          "Short notes on what specific information the user would need to add to strengthen a thin answer. " +
          "Never invent facts to fill these — report them instead.",
      },
    },
    required: ["questionIndex", "draft", "notFound", "sourced", "seedUsed", "groundedDocuments", "gaps"],
  },
};

/**
 * TASK D2 — the schema used ONLY when a question asks for more than one draft.
 *
 * ⚠️ WHY THIS IS A SEPARATE SCHEMA RATHER THAN AN EXTRA OPTIONAL FIELD.
 * The orchestration golden pins the exact bytes of every compose request. Adding
 * `drafts` to `COMPOSE_SCHEMA` would change the wire for EVERY compose,
 * including the overwhelmingly common single-draft case, and would break that
 * golden — which exists precisely because the request contract has been altered
 * by accident before (§1). Sending the variant schema only when variants were
 * actually requested keeps the single-draft wire byte-for-byte unchanged.
 *
 * The evidence fields are deliberately NOT duplicated per draft. §3 decides
 * provenance from ONE evidence set; per-variant evidence would let a picked
 * variant carry a different claim about the documents than the one that was
 * verified.
 */
const COMPOSE_SCHEMA_WITH_VARIANTS = {
  ...COMPOSE_SCHEMA,
  items: {
    ...COMPOSE_SCHEMA.items,
    properties: {
      ...COMPOSE_SCHEMA.items.properties,
      drafts: {
        type: "array",
        items: { type: "string" },
        description:
          "The requested number of DISTINCT alternative drafts of the SAME answer — different wording, " +
          "structure or emphasis, all grounded in the SAME facts. Never introduce a claim in one draft that " +
          "is absent from the others. Empty if notFound is true.",
      },
    },
    required: [...COMPOSE_SCHEMA.items.required, "drafts"],
  },
};

// A specific, question-tailored elicitation prompt per question index.
const ELICIT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      questionIndex: { type: "integer" },
      prompt: {
        type: "string",
        description:
          "A short, specific request telling the user exactly what rough details to jot down for THIS question " +
          "(e.g. what/when/outcome). Never generic 'write something'.",
      },
    },
    required: ["questionIndex", "prompt"],
  },
};

// Offline/failure fallback: a template elicitation prompt keyed to question
// intent, so the guided flow still works with no API/quota.
export function templateElicitation(questionText: string): string {
  const lower = questionText.toLowerCase();
  if (/challeng|difficult|problem|obstacle/.test(lower)) {
    return "Briefly — what was the challenge, what did you try, and how did it end? A few words or bullet points is enough.";
  }
  if (/why|motivat|interest|reason/.test(lower)) {
    return "In a few words: what draws you to this, and what makes you a fit? Rough notes are fine.";
  }
  if (/experience|describe|tell us|about/.test(lower)) {
    return "Jot down the key facts: what you did, where, when, and the result. Bullet points are perfect.";
  }
  if (/goal|objective|plan|future/.test(lower)) {
    return "A couple of bullets: what you want to achieve and why. Rough is fine.";
  }
  return "Jot down a few rough notes or bullet points — the key facts you'd want this answer to include.";
}

// Generates a tailored elicitation prompt for every eligible question in ONE
// batched call (Problem 3.2a / 3.5). Falls back to templates on any failure
// so the guided flow never blocks on the network.
export async function generateElicitationPrompts(
  items: { index: number; questionText: string }[],
  language?: AnswerLanguage,
): Promise<Map<number, string>> {
  const fallback = new Map(items.map((item) => [item.index, templateElicitation(item.questionText)]));
  // E3d.0 — NO GEMINI KEY GATE. These paths carry the FORM'S OWN TEXT, so
  // they must follow the user's provider selection. Gating on a Gemini key
  // made them fail (or silently no-op) for a user on another provider whose
  // configuration was perfectly correct. The active provider raises its own
  // key error from complete().
  if (items.length === 0) {
    return fallback;
  }

  const prompt = [
    "For each open-ended form question below, write a SHORT, SPECIFIC request that tells the user exactly which rough details to jot down to answer it (e.g. what happened / what they did / the outcome).",
    "Never write a generic 'write something'. Tailor each to the question.",
    languageInstruction(language),
    "Respond with one entry per question index, in the given schema.",
    "",
    ...items.map((item) => `${item.index}. ${item.questionText}`),
  ].join("\n");

  try {
    // E3d.0 — through the provider interface. This prompt carries the form's
    // question text; routing it to Gemini while another provider is selected
    // would send user content to a vendor the user did not choose.
    const provider = await activeProvider();
    const completion = await provider.complete({
      parts: [{ kind: "text", text: prompt }],
      label: "elicitation",
      schema: ELICIT_SCHEMA,
      reasoningEffort: "minimal",
    });
    // B4 — the raw payload is not logged; it echoes form question text.
    debugLog(`EasyFilla: elicitation returned ${completion.text.length} chars.`);
    const parsed = completion.structured;
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    const result = new Map(fallback);
    parsed.forEach((entry) => {
      const record = entry as Record<string, unknown>;
      if (typeof record.questionIndex === "number" && typeof record.prompt === "string" && record.prompt.trim()) {
        result.set(record.questionIndex, record.prompt.trim());
      }
    });
    return result;
  } catch (error) {
    console.warn("EasyFilla: elicitation generation failed, using templates", error);
    return fallback;
  }
}

// TASK B — the batch-level half of the instruction. The word target itself is
// stated PER QUESTION (see questionsBlock below) because it depends on both
// that question's length choice and whether it is an essay.
//
// LENGTH IS A BUDGET, NOT A LICENCE. Every phrasing here has to survive the
// grounding rule: a model told "write 400 words" with a two-line seed will pad,
// and padding on an application form is fabrication. So the length line
// explicitly subordinates itself to the evidence.
function composeInstructions(): string[] {
  return [
    "- Each question below carries its own TARGET LENGTH in words and its own TONE. Apply them per question; " +
      "do not average them across the batch.",
    "- The word target is a CEILING GOVERNED BY EVIDENCE, not a quota to fill. If the seed and documents do not " +
      "support the target, write the shorter honest answer and record the shortfall in `gaps`. NEVER pad to reach " +
      "a word count — inventing a sentence to hit a number is the exact failure this tool exists to prevent.",
    "- Tone changes register only. It never changes which facts are used, and never adds a claim.",
  ];
}

// The per-question directive: explicit range + tone, both resolved from the
// shared table in ui-prefs.ts so the UI label and the model instruction can
// never disagree.
function itemDirective(item: ComposeRequestItem): string {
  const length = item.length ?? "medium";
  const tone = item.tone ?? "neutral";
  const target = lengthTargetFor(length, item.isEssay);
  const variants = item.variants && item.variants > 1 ? ` [Produce ${item.variants} DISTINCT drafts]` : "";
  return `[Target: ${target.minWords}–${target.maxWords} words] [${TONE_INSTRUCTIONS[tone]}]${variants}`;
}

// Drafts grounded prose for open-ended questions. The hard-fail rule is the
// core invariant: if the documents don't support an answer, the model must
// return notFound=true with an empty draft rather than inventing one.
export async function composeAnswers(
  documentContext: string,
  documentNames: string[],
  items: ComposeRequestItem[],
  options: {
    language?: AnswerLanguage;
    length?: ComposeLength;
    tone?: ComposeTone;
    profileContext?: string;
    /**
     * TASK C/D1 cancellation. Threaded to complete() so cancelling a running
     * compose actually aborts the REQUEST. Without this the queue could only
     * stop listening, which spends the quota and merely hides the result.
     */
    signal?: AbortSignal;
  } = {},
): Promise<Map<number, ComposeResult>> {
  // 0b — pace from the ACTIVE provider before the first request of this run.
  // A provider switch re-paces here rather than waiting for Settings to be
  // reopened, and Anthropic learned limits apply from the response onward.
  await applyActiveProviderPacing();

  // E3c — NO PROVIDER-SPECIFIC KEY GATE HERE.
  // The orchestrator is provider-agnostic: gating on a GEMINI key would
  // reject a run on any other provider. The active provider raises its own
  // key error from complete() — for Gemini that is still MissingApiKeyError,
  // thrown by readGeminiJson, so the message the UI catches is unchanged.

  const { language, length = "auto", tone = "default", profileContext = "(no structured profile extracted)", signal } = options;

  const questionsBlock = items
    .map((item) => {
      const guidance = item.guidance?.trim() ? ` [User guidance: ${item.guidance.trim()}]` : "";
      const seed = item.seed?.trim() ? `\n   [User's seed notes: ${item.seed.trim()}]` : "\n   [User's seed notes: (none)]";
      const kind = item.isEssay ? "essay" : "short open-ended";
      // TASK B — the length/tone directive rides on the QUESTION, so a batch
      // can legitimately mix a long formal essay with a short conversational
      // one instead of the first item's settings winning for everybody.
      return `${item.index}. (${kind}) ${item.questionText}${guidance}\n   ${itemDirective(item)}${seed}`;
    })
    .join("\n");

  const prompt = [
    "You are expanding a user's ROUGH SEED NOTES into a polished answer for each open-ended form question.",
    "STRICT GROUNDING RULE: the answer may ONLY use facts from (1) the user's seed notes, (2) the structured profile, and (3) the uploaded document text. You may organize, connect, and polish, but you must NOT add any employer, date, technology, outcome, metric, or achievement that appears in none of these.",
    "Where the seed is thin, write around what you have and record what's missing in `gaps` — NEVER pad with invention.",
    "HARD-FAIL RULE: if a question's seed notes are empty AND nothing in the profile/documents is relevant, set notFound=true and draft=\"\". An empty seed must never produce a generic essay.",
    "Follow any per-question [User guidance] to steer emphasis and style.",
    ...composeInstructions(),
    languageInstruction(language),
    "List in groundedDocuments the exact names of the uploaded documents you drew facts from (from this list): " +
      (documentNames.length > 0 ? documentNames.join(" | ") : "(none)"),
    "Respond with one entry per question index, in the given schema.",
    "",
    "=== Structured profile ===",
    profileContext,
    "",
    "=== Uploaded document text ===",
    documentContext.trim() || "(no documents were uploaded)",
    "",
    "=== Questions (with the user's seed notes) ===",
    questionsBlock,
  ].join("\n");

  console.log("[EasyFilla][Gemini] compose request", { itemCount: items.length, length, tone, promptChars: prompt.length });

  // ── E3c: THROUGH THE PROVIDER INTERFACE ────────────────────────────────
  // No transport knowledge here any more. `reasoningEffort` is the neutral
  // spelling of what was `thinkingLevel` — Gemini renames it, Anthropic
  // deliberately ignores it (§1b). maxTokens is deliberately NOT sent: adding
  // one to satisfy Anthropic would change every real Gemini request, and the
  // orchestration golden asserts its absence.
  // D2 — N variants come back in ONE request, so N drafts cost ONE unit of
  // budget rather than N. §4c's binding constraint is the daily request ceiling,
  // which is exactly why this must never become N requests.
  const wantsVariants = items.some((item) => (item.variants ?? 1) > 1);

  const provider = await activeProvider();
  const completion = await provider.complete({
    parts: [{ kind: "text", text: prompt }],
    label: "compose",
    // D2 — the variant schema is used ONLY when a question actually asked for
    // more than one draft, so the single-draft wire stays byte-identical to the
    // orchestration golden.
    schema: wantsVariants ? COMPOSE_SCHEMA_WITH_VARIANTS : COMPOSE_SCHEMA,
    reasoningEffort: "medium",
    ...(signal !== undefined ? { signal } : {}),
  });

  // B4 — the raw payload is NOT logged. It contains draft prose derived from
  // the user's documents and seeds.
  debugLog(`EasyFilla: compose response — ${completion.text.length} chars via ${completion.provider}.`);

  const parsed = completion.structured;
  if (parsed === null) {
    throw new GeminiRequestError("The compose response wasn't valid JSON.", true, "parse");
  }
  if (!Array.isArray(parsed)) {
    throw new GeminiRequestError("The compose response wasn't an array as expected.", true, "parse");
  }

  const seedByIndex = new Map(items.map((item) => [item.index, item.seed?.trim() ?? ""]));

  const results = new Map<number, ComposeResult>();
  parsed.forEach((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.questionIndex !== "number" || typeof record.draft !== "string") {
      return;
    }
    const notFound = record.notFound === true;
    const draft = record.draft.trim();
    // Guard the hard-fail even if the model contradicts itself: no draft, an
    // empty draft, or a leaked instruction all collapse to not-found.
    const invalid = notFound || draft.length === 0 || looksLikeLeakedInstruction(draft);

    // ── D2 PROVENANCE INVARIANT (§3, §6b.5) ────────────────────────────────
    // Variants are alternative PROSE over one evidence set, so they are subject
    // to exactly the same hard-fail as the single draft. When the compose is
    // invalid, `variants` is emptied — returning three fluent drafts of an
    // ungrounded answer would present a fabrication as a choice, and the number
    // of variants must never influence whether the result is usable.
    // The same leak guard applies per variant: a leaked instruction is not
    // rescued by arriving in position 2.
    const rawVariants = Array.isArray(record.drafts)
      ? record.drafts
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && !looksLikeLeakedInstruction(value))
      : [];
    // `draft` is always the first variant, so single-draft callers see no change.
    const variants = invalid ? [] : rawVariants.length > 1 ? [draft, ...rawVariants.filter((v) => v !== draft)] : [];

    results.set(record.questionIndex, {
      draft: invalid ? "" : draft,
      notFound: invalid,
      variants,
      sourced: !invalid && record.sourced === true,
      seedUsed: !invalid && record.seedUsed === true && (seedByIndex.get(record.questionIndex)?.length ?? 0) > 0,
      groundedDocuments:
        !invalid && Array.isArray(record.groundedDocuments)
          ? record.groundedDocuments.filter((name): name is string => typeof name === "string")
          : [],
      gaps: Array.isArray(record.gaps) ? record.gaps.filter((g): g is string => typeof g === "string") : [],
    });
  });

  console.log(
    `EasyFilla: compose complete — ${Array.from(results.values()).filter((r) => !r.notFound).length} drafted, ` +
      `${Array.from(results.values()).filter((r) => r.notFound).length} not-found (hard-fail).`,
  );
  return results;
}

// Last-resort language detection: when <html lang>, hl=, and script
// heuristics all fail to name a specific language (e.g. a Latin-script form
// that could be Italian, Spanish, or Portuguese), ask the model for an ISO
// 639-1 code only. Returns null on any failure so callers fall back to
// "answer in the questions' language" rather than blocking.
export async function detectLanguageWithGemini(sampleLabels: string[]): Promise<string | null> {
  // E3d.0 — NO GEMINI KEY GATE. These paths carry the FORM'S OWN TEXT, so
  // they must follow the user's provider selection. Gating on a Gemini key
  // made them fail (or silently no-op) for a user on another provider whose
  // configuration was perfectly correct. The active provider raises its own
  // key error from complete().

  const prompt = [
    "Identify the language of the following form field labels.",
    'Respond with ONLY a JSON object: {"code":"<ISO 639-1 code>"}. No prose.',
    "",
    ...sampleLabels.slice(0, 10),
  ].join("\n");

  try {
    // Was a RAW fetch that bypassed the queue entirely — a direct contributor
    // to the observed 429. Now routed through the single gated chokepoint.
    // E3d.0 — through the provider interface. The sample labels are the
    // FORM'S OWN TEXT, so this is user content and must follow the selection.
    const provider = await activeProvider();
    const completion = await provider.complete({
      parts: [{ kind: "text", text: prompt }],
      label: "language-detect",
      schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      reasoningEffort: "minimal",
    });
    // B4 — length only. On a malformed response the text can echo prompt
    // content, which is the form's own wording.
    debugLog(`EasyFilla: language-detect returned ${completion.text.length} chars.`);
    const parsed = completion.structured as { code?: unknown } | null;
    const code = typeof parsed?.code === "string" ? parsed.code.trim().toLowerCase().split(/[-_]/)[0] : null;
    return code && /^[a-z]{2,3}$/.test(code) ? code : null;
  } catch (error) {
    // Language detection is best-effort: a failure means "undetermined", never
    // a broken run. Unchanged behaviour, now provider-agnostic.
    console.warn("EasyFilla: language detection failed", error);
    return null;
  }
}
