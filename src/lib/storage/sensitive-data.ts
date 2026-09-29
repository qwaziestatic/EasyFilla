const LAST_USED_KEY = "easyfilla.sensitiveDataLastUsed";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const EXACT_KEYS = [
  "geminiApiKey",
  "easyfilla.anthropicApiKey",
  "easyfilla.profile",
  "easyfilla.dossier",
  "easyfilla.fileUploads.v1",
  "easyfilla.debugLogging",
] as const;

const PREFIXES = ["easyfilla.ocr."] as const;

export async function touchSensitiveData(): Promise<void> {
  await chrome.storage.local.set({ [LAST_USED_KEY]: Date.now() });
}

export async function purgeExpiredSensitiveData(now = Date.now()): Promise<boolean> {
  const stored = await chrome.storage.local.get(LAST_USED_KEY);
  const lastUsed = stored[LAST_USED_KEY];
  if (typeof lastUsed !== "number" || now - lastUsed <= RETENTION_MS) {
    return false;
  }
  await clearAllSensitiveData();
  return true;
}

export async function clearAllSensitiveData(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (key) => EXACT_KEYS.includes(key as (typeof EXACT_KEYS)[number]) || PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  keys.push(LAST_USED_KEY);
  await chrome.storage.local.remove([...new Set(keys)]);
}
