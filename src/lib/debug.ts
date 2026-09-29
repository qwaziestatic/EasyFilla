// ─────────────────────────────────────────────────────────────────────────
// DEBUG LOGGING GATE (B4)
//
// The tagged diagnostic blocks in this codebase have earned their place: the
// coverage report, the tier distribution, the fill-timing `console.table`, the
// transport request summary. Each exists because a specific silent failure was
// only diagnosable once it printed. Those stay ON.
//
// What is gated here is the PER-FIELD chatter — one line per question, per
// frame, per harvested widget. On a 59-field form across four frames that is
// hundreds of lines that bury the summaries, and it is only useful when
// actively debugging.
//
// ── WHAT MUST NEVER BE LOGGED, AT ANY LEVEL ─────────────────────────────
//   · the API key, or any substring of it
//   · document contents — extracted text, dossier values, OCR output
//   · answer VALUES derived from documents (a field label is fine; the
//     passport number that went into it is not)
// `debugLog` does not make these safe. It is a volume control, not a
// confidentiality boundary: a user pasting a debug console into a bug report
// must not be pasting their passport number.
// ─────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "easyfilla.debugLogging";

// Read synchronously from a cached value so logging never has to await. The
// default is OFF: a fresh install is quiet.
let enabled = false;
let loaded = false;

// Call once at startup in each context (sidepanel, options, content script).
// Failure to read storage leaves logging off, which is the safe default.
export async function initDebugLogging(): Promise<boolean> {
  if (loaded) {
    return enabled;
  }
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    enabled = stored[STORAGE_KEY] === true;
  } catch {
    enabled = false;
  }
  loaded = true;
  if (enabled) {
    console.log(
      "EasyFilla: verbose debug logging is ON (Options → Diagnostics). Per-field detail will be printed. " +
        "Document contents and the API key are never logged at any level.",
    );
  }
  return enabled;
}

export async function setDebugLogging(on: boolean): Promise<void> {
  enabled = on;
  loaded = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: on });
  } catch {
    // Non-fatal: the setting just won't persist to the next session.
  }
}

// Verbose, per-item logging. Silent unless the user turned it on.
export function debugLog(...args: unknown[]): void {
  if (enabled) {
    console.log(...args);
  }
}

export function safeUrl(value: string | null | undefined): string {
  if (!value) {
    return "(unknown URL)";
  }
  try {
    return new URL(value).origin;
  } catch {
    return "(invalid URL)";
  }
}
