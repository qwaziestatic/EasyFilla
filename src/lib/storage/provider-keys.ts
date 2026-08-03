// ─────────────────────────────────────────────────────────────────────────
// PER-PROVIDER API KEYS (TASK E3.7)
//
// One key per provider, stored and validated INDEPENDENTLY. Only the ACTIVE
// provider's key is ever read for a request, so selecting Gemini cannot cause
// an Anthropic key to be transmitted, or the reverse.
//
// ── THE B1 RULES STILL APPLY, NOW TO BOTH KEYS ──────────────────────────
// Neither key may be reachable from any content script, message payload, page
// context, or log line. This module is imported ONLY by extension pages
// (sidepanel, options) and the provider implementations — never by anything
// under `src/content-scripts/` or `src/background/`.
//
// `hasApiKey()` exists so callers that only need "is one configured?" never
// materialise the string. The fewer scopes that hold it, the smaller the
// surface for it to be logged, serialised into a message, or captured in an
// error report.
//
// chrome.storage.LOCAL, never SYNC: sync would replicate credentials to every
// device on the user's Chrome account.
// ─────────────────────────────────────────────────────────────────────────

import { isProviderId, type ProviderId } from "../ai/provider";

// Gemini's key keeps its original storage key so existing installs do not lose
// it on upgrade. Anthropic gets a namespaced one.
const STORAGE_KEYS: Record<ProviderId, string> = {
  gemini: "geminiApiKey",
  anthropic: "easyfilla.anthropicApiKey",
};

const ACTIVE_PROVIDER_KEY = "easyfilla.activeProvider";
export const DEFAULT_PROVIDER: ProviderId = "gemini";

export async function saveApiKey(provider: ProviderId, apiKey: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS[provider]]: apiKey });
}

export async function loadApiKey(provider: ProviderId): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS[provider]);
  const value = result[STORAGE_KEYS[provider]];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function clearApiKey(provider: ProviderId): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS[provider]);
}

/**
 * "Is a key configured?" WITHOUT materialising it. Used by the first-run hint
 * and the misconfigured-provider check — neither needs the string itself.
 */
export async function hasApiKey(provider: ProviderId): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEYS[provider]);
  const value = result[STORAGE_KEYS[provider]];
  return typeof value === "string" && value.length > 0;
}

export async function loadActiveProvider(): Promise<ProviderId> {
  try {
    const stored = await chrome.storage.local.get(ACTIVE_PROVIDER_KEY);
    const value = stored[ACTIVE_PROVIDER_KEY];
    // Validation of a persisted enum, not behavioural branching.
    return isProviderId(value) ? value : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

export async function saveActiveProvider(provider: ProviderId): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_PROVIDER_KEY]: provider });
}

/**
 * The misconfigured state, handled EXPLICITLY (E3.3): a provider is selected
 * but has no key. Callers must surface this by name rather than letting the
 * request fail as a generic AI error — "no API key" is actionable, "AI request
 * failed" is not, and the user cannot tell WHICH key is missing when two exist.
 */
export class MissingProviderKeyError extends Error {
  readonly provider: ProviderId;

  constructor(provider: ProviderId, displayName: string) {
    super(
      `No ${displayName} API key is set, but ${displayName} is the selected provider. ` +
        `Open Settings and add your ${displayName} key — or switch to a provider you have a key for. ` +
        "Keys are stored per provider, so a key for the other one will not be used.",
    );
    this.name = "MissingProviderKeyError";
    this.provider = provider;
  }
}
