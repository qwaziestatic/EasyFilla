// FIX 6: user-selectable model, persisted and applied to EVERY call path.
// The queue sizes its minimum spacing from the selected model's RPM, so
// switching models automatically re-throttles.
//
// NOTE ON THE RPM NUMBERS: these are conservative *client-side pacing hints*,
// not authoritative quota values. Google changes free-tier limits without
// notice and they differ per project/tier, so the UI never displays them as
// fact — it links to the official pages instead. Pacing conservatively is
// safe: it can only make us slower than allowed, never faster.
export interface ModelOption {
  id: string;
  label: string;
  // Conservative requests-per-minute assumption used only for queue spacing.
  assumedRpm: number;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash (recommended)", assumedRpm: 15 },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", assumedRpm: 15 },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (highest throughput)", assumedRpm: 30 },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", assumedRpm: 15 },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", assumedRpm: 30 },
];

// The ANSWERING stage: relates dossier facts to form questions, so it gets the
// stronger model.
export const DEFAULT_MODEL_ID = "gemini-3.6-flash";

// The INGEST stage (Stage A): reads every uploaded document multimodally and
// emits structured JSON. That is high-volume, high-token, and mechanical, which
// is what Flash-Lite is built for — using the answering model here would burn
// the per-minute budget on the cheapest part of the pipeline.
export const DEFAULT_INGEST_MODEL_ID = "gemini-3.5-flash-lite";

const STORAGE_KEY = "easyfilla.modelId";
const INGEST_STORAGE_KEY = "easyfilla.ingestModelId";

export function modelOptionFor(id: string): ModelOption {
  return MODEL_OPTIONS.find((option) => option.id === id) ?? MODEL_OPTIONS[0]!;
}

export async function loadSelectedModel(): Promise<ModelOption> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const id = typeof result[STORAGE_KEY] === "string" ? (result[STORAGE_KEY] as string) : DEFAULT_MODEL_ID;
  return modelOptionFor(id);
}

export async function saveSelectedModel(id: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: id });
}

export async function loadIngestModel(): Promise<ModelOption> {
  const result = await chrome.storage.local.get(INGEST_STORAGE_KEY);
  const id =
    typeof result[INGEST_STORAGE_KEY] === "string"
      ? (result[INGEST_STORAGE_KEY] as string)
      : DEFAULT_INGEST_MODEL_ID;
  return modelOptionFor(id);
}

export async function saveIngestModel(id: string): Promise<void> {
  await chrome.storage.local.set({ [INGEST_STORAGE_KEY]: id });
}

// ── ListModels (PART 0) ───────────────────────────────────────────────────
// https://ai.google.dev/api/models — GET /v1beta/models
// Called once per session and cached. A configured model that isn't in the
// list is a CONFIGURATION problem, and must be reported as one with the valid
// alternatives — not surfaced later as a generic "AI failure" on a 404.
const MODEL_LIST_CACHE_KEY = "easyfilla.modelList";
const MODEL_LIST_TTL_MS = 24 * 60 * 60_000;

export interface CachedModelList {
  ids: string[];
  fetchedAt: number;
}

export async function loadCachedModelList(): Promise<CachedModelList | null> {
  const result = await chrome.storage.local.get(MODEL_LIST_CACHE_KEY);
  const value = result[MODEL_LIST_CACHE_KEY] as CachedModelList | undefined;
  if (!value || !Array.isArray(value.ids) || Date.now() - value.fetchedAt > MODEL_LIST_TTL_MS) {
    return null;
  }
  return value;
}

export async function saveModelList(ids: string[]): Promise<void> {
  await chrome.storage.local.set({ [MODEL_LIST_CACHE_KEY]: { ids, fetchedAt: Date.now() } });
}

// Official, always-current references — we link rather than hardcode numbers.
export const RATE_LIMIT_DOCS_URL = "https://ai.google.dev/gemini-api/docs/rate-limits";
export const PRICING_DOCS_URL = "https://ai.google.dev/pricing";
export const AI_STUDIO_URL = "https://aistudio.google.com/app/apikey";

// ── ANTHROPIC MODEL SELECTION (TASK E3) ───────────────────────────────────
// Deliberately separate from the Gemini slots above. The two providers' model
// ids share no namespace, and a single "selected model" setting would send a
// Gemini id to Anthropic the moment the user switched provider.
//
// NOTHING IS HARDCODED as an available list — the settings UI populates from
// the live /v1/models response, filtered by capability (§1b). The constant
// below is only the fallback used before the user has chosen, and before any
// list has been fetched.
const ANTHROPIC_MODEL_KEY = "easyfilla.anthropicModelId";

/**
 * Fallback only. The live list is authoritative; this exists so a first run
 * has something to send before the model list has been fetched. If it is not
 * available to the user's account, the 404 → `invalid-model` path names it.
 */
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-5";

export async function loadAnthropicModel(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(ANTHROPIC_MODEL_KEY);
    const value = stored[ANTHROPIC_MODEL_KEY];
    return typeof value === "string" && value.length > 0 ? value : DEFAULT_ANTHROPIC_MODEL_ID;
  } catch {
    return DEFAULT_ANTHROPIC_MODEL_ID;
  }
}

export async function saveAnthropicModel(id: string): Promise<void> {
  await chrome.storage.local.set({ [ANTHROPIC_MODEL_KEY]: id });
}
