// ISO 639-1 codes we can name from Unicode script alone; anything else falls
// back to "und" (undetermined) and, ultimately, the Gemini language probe.
export interface DetectedLanguage {
  code: string; // ISO 639-1, or "und"
  direction: "ltr" | "rtl";
  source: "html-lang" | "hl-param" | "script-heuristic" | "llm" | "manual" | "default";
}

const RTL_CODES = new Set(["ar", "he", "fa", "ur", "ps", "sd"]);

export function directionForCode(code: string): "ltr" | "rtl" {
  return RTL_CODES.has(code) ? "rtl" : "ltr";
}

// Counts characters by Unicode block. Deliberately coarse — enough to
// distinguish the major script families the nav dictionary covers, not a
// full language identifier.
interface ScriptTally {
  latin: number;
  cyrillic: number;
  arabic: number;
  ethiopic: number;
  cjk: number;
  devanagari: number;
  hebrew: number;
  greek: number;
  total: number;
}

function tallyScripts(text: string): ScriptTally {
  const t: ScriptTally = { latin: 0, cyrillic: 0, arabic: 0, ethiopic: 0, cjk: 0, devanagari: 0, hebrew: 0, greek: 0, total: 0 };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x0041) continue;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) t.latin += 1;
    else if (code >= 0x370 && code <= 0x3ff) t.greek += 1;
    else if (code >= 0x400 && code <= 0x4ff) t.cyrillic += 1;
    else if (code >= 0x590 && code <= 0x5ff) t.hebrew += 1;
    else if (code >= 0x600 && code <= 0x6ff) t.arabic += 1;
    else if (code >= 0x900 && code <= 0x97f) t.devanagari += 1;
    else if (code >= 0x1200 && code <= 0x137f) t.ethiopic += 1;
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff)) t.cjk += 1;
    else continue;
    t.total += 1;
  }
  return t;
}

// Maps the dominant script to a representative ISO 639-1 code. For scripts
// that host many languages (Latin, Arabic, Cyrillic, CJK) this returns a
// best-guess default the user can override — script alone can't tell Italian
// from French. Callers should prefer html-lang/hl-param when available.
export function detectLanguageFromText(samples: string[]): DetectedLanguage | null {
  const tally = tallyScripts(samples.join(" "));
  if (tally.total < 3) {
    return null;
  }

  const entries: [keyof ScriptTally, string][] = [
    ["ethiopic", "am"],
    ["arabic", "ar"],
    ["hebrew", "he"],
    ["devanagari", "hi"],
    ["cyrillic", "ru"],
    ["cjk", "zh"],
    ["greek", "el"],
    ["latin", "und"], // Latin is ambiguous — don't guess a specific language
  ];

  let bestKey: keyof ScriptTally = "latin";
  let bestCount = -1;
  for (const [key] of entries) {
    const count = tally[key];
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }

  const code = entries.find(([key]) => key === bestKey)?.[1] ?? "und";
  return { code, direction: directionForCode(code), source: "script-heuristic" };
}

// Normalizes whatever a <html lang> / hl= param gives us to a bare ISO
// 639-1 code ("en-GB" -> "en", "zh-Hans" -> "zh").
export function normalizeLangCode(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const code = raw.trim().toLowerCase().split(/[-_]/)[0];
  return code && /^[a-z]{2,3}$/.test(code) ? code : null;
}

export function displayNameForCode(code: string): string {
  const names: Record<string, string> = {
    en: "English", it: "Italian", es: "Spanish", fr: "French", de: "German",
    pt: "Portuguese", ar: "Arabic", am: "Amharic", zh: "Chinese", hi: "Hindi",
    ru: "Russian", sw: "Swahili", he: "Hebrew", el: "Greek", und: "Undetermined",
  };
  return names[code] ?? code.toUpperCase();
}
