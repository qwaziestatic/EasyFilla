// Gemini's key, read by Gemini's own transport.
//
// ── E5: THIS MODULE IS NOW READ-ONLY, AND DELIBERATELY SO ────────────────
// `saveGeminiApiKey`, `clearGeminiApiKey` and `hasGeminiApiKey` were removed
// once the options page and the sidepanel moved onto `provider-keys.ts`. They
// had zero call sites, and leaving them meant two modules could write the same
// storage entry — so an audit of "who can write a key" had two answers.
// Writing and presence-checking now happen in ONE audited place; this file only
// hands Gemini's transport the string it needs.
//
// Stored in chrome.storage.local: persists across browser restarts so the user
// only enters their key once, in plaintext on this device's disk only.
// Deliberately NOT chrome.storage.sync — sync would additionally upload the key
// to Google's Chrome Sync servers and replicate it to every device signed into
// the same Chrome account, which is broader exposure than a single-device
// credential needs.
const STORAGE_KEY = "geminiApiKey";

export async function loadGeminiApiKey(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const value = result[STORAGE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}
