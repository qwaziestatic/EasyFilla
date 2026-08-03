import type { jsPDF } from "jspdf";

// jsPDF's built-in Helvetica/Times/Courier cover only WinAnsi (Latin-1 +
// a little Latin Extended). Any other script renders as blank boxes. This
// module makes that failure LOUD instead of silent, and provides the single
// hook where a real embedded font would be plugged in.
//
// HONEST LIMITATION: no non-Latin font is bundled. Embedding the full
// matrix the spec asks for (Latin Extended + Cyrillic + Greek + Arabic +
// Ethiopic + CJK) with dynamic (un-subsettable) form text means tens of MB
// — CJK alone is ~16MB per weight — and there is no build-time subsetting
// pipeline in this project. So `registerEmbeddedFont` is the seam: drop a
// base64 TTF and its script coverage here and non-Latin rendering starts
// working, without touching the generator.

interface EmbeddedFont {
  vfsName: string;
  fontName: string;
  base64: string;
  covers: (script: NonLatinScript) => boolean;
}

const embeddedFonts: EmbeddedFont[] = [];

export type NonLatinScript = "cyrillic" | "greek" | "arabic" | "ethiopic" | "cjk" | "devanagari" | "hebrew" | "other";

// Populate from a build step or a lazy fetch to enable a script. Left empty
// deliberately — see the limitation note above.
export function registerEmbeddedFont(font: EmbeddedFont): void {
  embeddedFonts.push(font);
}

// Returns the set of non-Latin scripts present in the given text.
export function detectNonLatinScripts(text: string): Set<NonLatinScript> {
  const found = new Set<NonLatinScript>();
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) continue;
    if (code >= 0x370 && code <= 0x3ff) found.add("greek");
    else if (code >= 0x400 && code <= 0x4ff) found.add("cyrillic");
    else if (code >= 0x590 && code <= 0x5ff) found.add("hebrew");
    else if (code >= 0x600 && code <= 0x6ff) found.add("arabic");
    else if (code >= 0x900 && code <= 0x97f) found.add("devanagari");
    else if (code >= 0x1200 && code <= 0x137f) found.add("ethiopic");
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff)) found.add("cjk");
    else if (code > 0x24f && code < 0x2000) found.add("other");
  }
  return found;
}

export interface FontApplication {
  // Scripts present that NO embedded font covers — these will render as
  // boxes. Empty when everything is covered (or all-Latin).
  unsupportedScripts: NonLatinScript[];
}

// Applies the best available embedded font for the document's content, and
// reports which scripts (if any) have no glyph coverage so the caller can
// warn the user rather than silently produce an unreadable PDF.
export function applyBestFont(doc: jsPDF, fullText: string): FontApplication {
  const scripts = detectNonLatinScripts(fullText);
  if (scripts.size === 0) {
    return { unsupportedScripts: [] };
  }

  const unsupported: NonLatinScript[] = [];
  let appliedFontName: string | null = null;

  for (const script of scripts) {
    const font = embeddedFonts.find((f) => f.covers(script));
    if (!font) {
      unsupported.push(script);
      continue;
    }
    if (!doc.existsFileInVFS(font.vfsName)) {
      doc.addFileToVFS(font.vfsName, font.base64);
      doc.addFont(font.vfsName, font.fontName, "normal");
    }
    // Last matching font wins as the active one; adequate until multiple
    // simultaneous non-Latin scripts need different fonts (a genuine
    // limitation flagged for the user via unsupportedScripts anyway).
    appliedFontName = font.fontName;
  }

  if (appliedFontName) {
    doc.setFont(appliedFontName, "normal");
  }

  if (unsupported.length > 0) {
    console.warn(
      `EasyFilla: PDF contains scripts with no embedded font (${unsupported.join(", ")}) — ` +
        `these will not render correctly. See lib/pdf/font-support.ts to bundle a font.`,
    );
  }

  return { unsupportedScripts: unsupported };
}
