// ─────────────────────────────────────────────────────────────────────────
// ACTIVE PROVIDER RESOLUTION (TASK E3.2)
//
// The single place that decides which provider a request goes to, and the only
// module that imports both implementations. Importing it registers both.
//
// Call sites ask for `activeProvider()` and then talk to the INTERFACE. They
// must never branch on `provider.id` — see `ProviderCapabilities` in
// provider.ts for why, and the E3 grep proof in HANDOFF §6b.
// ─────────────────────────────────────────────────────────────────────────

import { getProvider, type ProviderClient, type ProviderId } from "./provider";
import { geminiProvider } from "./providers/gemini-provider";
import { createAnthropicProvider } from "./providers/anthropic-provider";
import { registerProvider } from "./provider";
import { loadApiKey, loadActiveProvider, hasApiKey, MissingProviderKeyError } from "../storage/provider-keys";
import { loadAnthropicModel, saveAnthropicModel } from "./model-config";

// Gemini self-registers on import (it predates the registry and its own module
// owns that). Anthropic is registered HERE rather than at its module scope, so
// that importing the Anthropic implementation for tests does not make it
// selectable — E2 required it to be inert, and this is the seam where it stops
// being so.
registerProvider(
  createAnthropicProvider({
    loadApiKey: () => loadApiKey("anthropic"),
    resolveModel: loadAnthropicModel,
    saveModel: saveAnthropicModel,
  }),
);
void geminiProvider; // referenced so the self-registering import is not elided

export async function activeProviderId(): Promise<ProviderId> {
  return loadActiveProvider();
}

export async function activeProvider(): Promise<ProviderClient> {
  return getProvider(await loadActiveProvider());
}

/**
 * Resolves the active provider AND asserts it is usable.
 *
 * The misconfigured state — provider selected, no key for it — is caught here
 * and named. Letting it fall through produces a generic auth error that does
 * not say WHICH of two keys is missing, which is exactly the kind of
 * unactionable failure §4f/B3 exists to eliminate.
 */
export async function requireActiveProvider(): Promise<ProviderClient> {
  const provider = await activeProvider();
  if (!(await hasApiKey(provider.id))) {
    throw new MissingProviderKeyError(provider.id, provider.displayName);
  }
  return provider;
}

/**
 * Where the active provider will transmit documents. Rendered in the sidepanel
 * at all times and at the point of selection — this is a privacy-relevant
 * choice and must never be silent (E3.3).
 */
export async function activeProviderDisclosure(): Promise<{ name: string; destination: string }> {
  const provider = await activeProvider();
  return { name: provider.displayName, destination: provider.dataDestination };
}

// ── E3d.1: model listing, delegated to the provider ───────────────────────
// No provider-name branching: each implementation answers for itself.
export type { ProviderModelOption } from "./provider";

export async function listModelsForProvider(provider: ProviderId): Promise<import("./provider").ProviderModelOption[]> {
  return getProvider(provider).listModels();
}

export async function saveModelForProvider(provider: ProviderId, modelId: string): Promise<void> {
  return getProvider(provider).saveModel(modelId);
}
