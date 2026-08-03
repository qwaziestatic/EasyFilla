// ─────────────────────────────────────────────────────────────────────────
// PROVIDER INTERFACE (TASK E1)
//
// One interface, provider-agnostic. Gemini implements it today; Anthropic is
// E2 and must be addable WITHOUT touching a single call site.
//
// ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────
// It is not a place to generalise Gemini's quota model, its request spacing,
// its Files API path, or its daily counter. Those stay inside the Gemini
// implementation as internals. Anthropic has **no daily quota and no
// Pacific-midnight reset** (§1b) — it has per-minute token buckets and a
// MONTHLY spend cap — so hoisting Gemini's daily-counter shape into a shared
// abstraction would be wrong in a specific, discoverable way. E2 will show
// which parts genuinely need to be provider-shaped. Wait for it.
//
// ── §3 INVARIANT ─────────────────────────────────────────────────────────
// `perMinuteRequestLimit` exists to drive SPACING between sequential
// requests. It is NOT a concurrency budget. Request concurrency is 1, settled,
// and no provider may raise it. See §3 and §6b.4.
// ─────────────────────────────────────────────────────────────────────────

export const PROVIDER_IDS = ["gemini", "anthropic"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Type guard for deserialising a persisted provider id. Validation, not
 *  behavioural branching — call sites still branch on CAPABILITY only. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

// ── Content ──────────────────────────────────────────────────────────────
// Deliberately the same three shapes the Gemini transport already speaks, so
// the move is a rename rather than a re-encoding. Each provider translates
// these into its own wire format and nothing above this layer knows either.
export interface ProviderPart {
  kind: "text" | "image" | "document";
  text?: string;
  mimeType?: string;
  /** Base64, no `data:` prefix. Mutually exclusive with `uri`. */
  data?: string;
  /**
   * A provider-hosted file reference (Gemini Files API today).
   *
   * ⚠️ These are NOT portable. A Gemini file URI is meaningless to Anthropic
   * and vice versa (§1b, E8). Whoever creates one owns it; a provider that
   * receives a foreign reference must refuse rather than forward it.
   */
  uri?: string;
}

// ── Request ──────────────────────────────────────────────────────────────
export interface CompleteRequest {
  /** System instruction, if any. */
  system?: string;
  parts: ProviderPart[];
  /**
   * JSON Schema for structured output.
   *
   * Each provider applies its OWN dialect rules and neither leaks here:
   *   · Gemini — uppercase proto3 enums on generateContent, lowercase standard
   *     JSON Schema on Interactions (the SETTLED casing split, §1).
   *   · Anthropic — `output_config.format`, which requires
   *     `additionalProperties:false` everywhere and rejects several
   *     constraints Gemini accepts (§1b). That adapter is E2's problem.
   */
  schema?: unknown;
  maxTokens?: number;
  /**
   * How much reasoning effort to spend.
   *
   * ⚠️ THIS FIELD EXISTS BECAUSE THE ORCHESTRATION GOLDEN CAUGHT ITS ABSENCE.
   * All three stages send `thinking_level: "medium"` today. Moving them onto
   * `complete()` without a provider-neutral reasoning field would have DROPPED
   * that `generation_config` block from every real Gemini request — a change
   * the TRANSPORT golden cannot see, because the transport faithfully emits
   * whatever it is handed. Only the orchestration golden catches it.
   *
   * Provider-neutral by design. Gemini maps it to `thinking_level` (identical
   * value set). Anthropic's reasoning configuration is model-dependent and
   * rejecting the wrong shape is a 400 (§1b lists three distinct
   * thinking-related 400s), so its provider currently IGNORES this rather than
   * guessing — documented there, not silently dropped here.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /**
   * How many alternative drafts to request (TASK D2). Providers satisfy this
   * inside ONE request — N variants must never become N requests, or the
   * budget accounting in §4c silently under-counts by a factor of N.
   */
  variants?: number;
  /**
   * Caller cancellation. The interface owns this because TASK C's Cancel
   * affordance flows through it: a cancelled compose must abort the in-flight
   * request without consuming a retry (§6b.3).
   *
   * Distinct from a provider's own internal timeout, which is not a caller
   * cancellation and must not be reported as one.
   */
  signal?: AbortSignal;
  /** Overrides the configured model for this one call. */
  model?: string;
  /** Opaque label for logs and queue instrumentation. */
  label?: string;
  /**
   * Provider-neutral progress channel. A provider reports long internal steps
   * through it — Gemini uses it for the safety-block retry, which the caller
   * would otherwise experience as an unexplained pause.
   */
  onProgress?: (stage: string) => void;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompleteResult {
  /** Raw output text, whatever the provider's response shape. */
  text: string;
  /**
   * Parsed JSON when `schema` was supplied and the output parsed. `null` when
   * no schema was requested or parsing failed — a caller that needs structure
   * must check, never assume.
   */
  structured: unknown | null;
  usage: ProviderUsage;
  /** Provider-native finish reason, passed through unnormalized for logs. */
  finishReason: string | null;
  provider: ProviderId;
  model: string;
}

// ── Errors ───────────────────────────────────────────────────────────────
// One taxonomy for every provider. Call sites branch on these and must never
// need to know which vendor produced the failure.
export type ProviderErrorClass =
  | "network"
  | "timeout"
  | "auth"
  /**
   * ⚠️ ITS OWN CLASS, DELIBERATELY — and the reason is a real trap.
   *
   * Anthropic returns **HTTP 401 `authentication_error`** when a browser-origin
   * request omits `anthropic-dangerous-direct-browser-access: true`, with a
   * message saying CORS requests must set that header (§1b).
   *
   * A naive 401 → `auth` mapping tells a user with a PERFECTLY VALID KEY that
   * their key is invalid, sending them to regenerate a working credential to
   * fix a missing request header. The classifier MUST special-case that
   * message to this class and must never surface it as an auth failure.
   */
  | "browser-access-header-missing"
  | "invalid-request"
  | "invalid-model"
  | "rate-limit-per-minute"
  | "quota-or-credit-exhausted"
  | "overloaded"
  | "safety-blocked"
  | "empty-response";

export interface ProviderErrorInit {
  provider: ProviderId;
  errorClass: ProviderErrorClass;
  message: string;
  retryable: boolean;
  status?: number;
  /** Server-supplied delay, honoured by the queue in place of its own backoff. */
  retryAfterMs?: number;
  /** Provider-native quota metric name, for diagnostics only. */
  metric?: string;
}

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly errorClass: ProviderErrorClass;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly metric: string | undefined;

  constructor(init: ProviderErrorInit) {
    super(init.message);
    this.name = "ProviderError";
    this.provider = init.provider;
    this.errorClass = init.errorClass;
    this.retryable = init.retryable;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.metric = init.metric;
  }
}

/**
 * Which classes are worth retrying, in one place so two providers cannot
 * disagree about it.
 *
 * `quota-or-credit-exhausted` is NOT retryable: that is the daily-quota retry
 * storm §4c exists to prevent. `browser-access-header-missing` is NOT
 * retryable either — the request will fail identically until the header is
 * added, and retrying only burns the per-minute window.
 */
export const RETRYABLE_ERROR_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  "network",
  "timeout",
  "rate-limit-per-minute",
  "overloaded",
]);

export function isRetryableClass(errorClass: ProviderErrorClass): boolean {
  return RETRYABLE_ERROR_CLASSES.has(errorClass);
}

// ── Capabilities ─────────────────────────────────────────────────────────
// Call sites branch on CAPABILITY, never on provider identity.
//
// `if (provider === "gemini")` rots the moment a third provider exists, and it
// scatters vendor knowledge across every site that touches uploads, quota or
// fallbacks. Worse, it is invisible to the type system: adding a provider
// compiles fine and silently takes the wrong branch everywhere.
//
// A capability flag makes the question the code actually cares about explicit
// — "can this provider host files?" rather than "is this Google?" — and a new
// provider must answer it to compile.
export interface ProviderCapabilities {
  /**
   * Can oversized document sets be uploaded and referenced by URI instead of
   * inlined? Gemini: yes (§4d). Anthropic: it HAS a Files API but ours is not
   * implemented (§1b), so this is FALSE and inline limits are enforced.
   */
  supportsFilesApi: boolean;

  /**
   * Ceiling for one request's encoded payload. Gemini's 18 MB is a Gemini
   * constant with headroom under its ~20 MB inline limit; Anthropic's is the
   * documented 32 MB. Neither is a shared truth.
   */
  maxInlineRequestBytes: number;

  /** Per-file ceiling where one exists, else null. */
  maxPerFileBytes: number | null;

  /**
   * Mime types this provider accepts as non-text content. A file outside this
   * set must be rejected by name BEFORE a request is spent on it.
   */
  supportedFileMimeTypes: ReadonlySet<string>;

  /**
   * Does the provider enforce a DAILY request quota?
   *
   * Gemini: yes — resets at midnight Pacific (§4c). Anthropic: NO — per-minute
   * token buckets plus a MONTHLY spend cap surfacing as 402 (§1b). Rendering a
   * daily counter for a provider that has none would be inventing a number,
   * which §4c forbids.
   */
  hasDailyQuota: boolean;

  /**
   * Are rate limits returned in response headers, so they can be LEARNED?
   * Anthropic: yes (`anthropic-ratelimit-*`). Gemini: no — its RPM figure is
   * an assumption in `model-config.ts`, never something the API stated.
   */
  learnsLimitsFromResponseHeaders: boolean;

  /**
   * Does a MONTHLY spend cap apply, surfacing as a hard stop rather than a
   * per-request throttle? Anthropic: yes (402, §1b). Gemini free tier: no.
   *
   * This is its OWN capability and must never be inferred from
   * `!hasDailyQuota`. "Has no daily quota" does not imply "has a monthly cap" —
   * deriving one from the other is the same class of error as inventing a
   * denominator, one level up.
   */
  hasMonthlySpendCap: boolean;
}

// ── The interface ────────────────────────────────────────────────────────
export interface ProviderClient {
  readonly capabilities: ProviderCapabilities;
  readonly id: ProviderId;
  /** Human-readable, for the "documents will be sent to X" disclosure (E4). */
  readonly displayName: string;
  /** The origin documents are transmitted to. Surfaced at provider selection. */
  readonly dataDestination: string;

  /** The model this provider will use for the next call. */
  activeModel(): Promise<string>;

  /**
   * The selected model's per-minute REQUEST limit, or null when unknown.
   *
   * §3: this drives SPACING between sequential requests. It is not a
   * concurrency count and must not be used as one. `null` means "not learned
   * yet" and callers must not substitute a guess — §4c's refusal to invent a
   * denominator applies here too.
   */
  perMinuteRequestLimit(): Promise<number | null>;

  /**
   * Models available to the user's key for THIS provider, with the two
   * capabilities EasyFilla requires read per model where the API reports them.
   *
   * On the interface rather than behind an `if (provider === …)` in the
   * registry: adding a provider must not require editing a switch somewhere
   * else. Nothing outside `providers/` names a provider.
   */
  listModels(): Promise<ProviderModelOption[]>;

  /** Persists the user's model choice in this provider's own namespace. */
  saveModel(modelId: string): Promise<void>;

  complete(request: CompleteRequest): Promise<CompleteResult>;
}

/**
 * Where a model's capability flags came from.
 *
 * ⚠️ 0c — THIS DISTINCTION IS LOAD-BEARING, NOT METADATA.
 *
 * Anthropic's `/v1/models` returns a `capabilities` object per model, so
 * `structured_outputs.supported` and `pdf_input.supported` are FACTS the API
 * stated. Gemini's ListModels returns no such flags, so the same two booleans
 * come back `true` because THIS APP ASSUMES the models it offers support them.
 *
 * Collapsing the two into a bare boolean makes an assumption indistinguishable
 * from a fact — the same error class as inventing a rate-limit denominator
 * (§4c) or inferring one capability from another's absence (E3d.2). A UI cannot
 * warn about a risk it cannot see, and a failure cannot be explained by a cause
 * nobody recorded.
 */
export type CapabilitySource =
  /** The provider's model API stated it. */
  | "reported"
  /** We assume it; the API is silent. A wrong assumption surfaces at request time. */
  | "assumed";

export interface ProviderModelOption {
  id: string;
  displayName: string;
  /** §3 derives provenance from the schema, so this is REQUIRED to run. */
  supportsStructuredOutputs: boolean;
  /** Stage A exists to read scanned PDFs (§2), so this is REQUIRED to run. */
  supportsPdf: boolean;
  /**
   * Provenance of the two flags above. Both share one source because no provider
   * so far reports one and assumes the other; split it if that changes.
   */
  capabilitySource: CapabilitySource;
}

/**
 * Turns a bare model-rejection into one that names the ASSUMPTION that probably
 * caused it (0c).
 *
 * The problem this solves: when capability flags are assumed rather than
 * reported, the app offers a model it cannot actually verify is usable. If that
 * assumption is wrong the request fails with "model not found / not supported",
 * which tells the user their model name is bad. It isn't — the model exists, it
 * just cannot do structured output or PDF input, which is the one thing we
 * guessed. Without this, the guess is invisible in the failure and the user
 * retries the same model or edits a working setting.
 *
 * Returns `null` when the assumption is not a plausible explanation, so a real
 * typo'd model name still gets the plain message.
 */
export function diagnoseAssumedCapability(input: {
  errorClass: ProviderErrorClass;
  hadSchema: boolean;
  hadFileParts: boolean;
  capabilitySource: CapabilitySource;
  model: string;
  providerName: string;
}): string | null {
  const { errorClass, hadSchema, hadFileParts, capabilitySource, model, providerName } = input;

  // A REPORTED capability that fails is a provider bug or a stale model list —
  // not our guess — and must not be explained away as one.
  if (capabilitySource !== "assumed") return null;
  if (errorClass !== "invalid-model" && errorClass !== "invalid-request") return null;
  // If the request asked for neither structured output nor file input, no
  // assumed capability was exercised and this cannot be the cause.
  if (!hadSchema && !hadFileParts) return null;

  const suspects: string[] = [];
  if (hadSchema) suspects.push("structured output (a JSON schema)");
  if (hadFileParts) suspects.push("file input (PDF or image)");

  return (
    `${model} rejected this request, and it may simply not support ${suspects.join(" or ")}. ` +
    `${providerName} does not report per-model capabilities, so EasyFilla ASSUMED this model could do ` +
    `${suspects.length > 1 ? "both" : "that"} — the assumption may be wrong for this model rather than your ` +
    "settings being wrong. Try another model in Settings before changing anything else."
  );
}

// ── Registry ─────────────────────────────────────────────────────────────
// E2 adds Anthropic by registering it here. No call site changes.
const providers = new Map<ProviderId, ProviderClient>();

export function registerProvider(client: ProviderClient): void {
  providers.set(client.id, client);
}

export function getProvider(id: ProviderId): ProviderClient {
  const client = providers.get(id);
  if (!client) {
    throw new Error(`No provider registered for "${id}".`);
  }
  return client;
}

export function registeredProviders(): ProviderId[] {
  return [...providers.keys()];
}
