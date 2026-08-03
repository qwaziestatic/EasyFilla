import { getExtractionDiagnostics, type DocumentDiagnostic } from "./pdf/extractor";
import { PROFILE_PIPELINE_VERSION, type StructuredProfile } from "./profile/types";

// FIX A.1 — a plain-text dump pairing each document's VERBATIM reader output
// with the facts derived from it. When a field comes out wrong, this is the
// only artifact that shows whether the fault was the reader or the parser.
//
// PRIVACY: this file contains the full text of the user's documents, including
// ID and passport numbers. It is generated locally, saved locally via a
// download, and never transmitted anywhere by the extension — sharing it is
// entirely the user's decision.

function pageSummary(doc: DocumentDiagnostic): string {
  if (doc.source === "cache") {
    return "loaded from cache (page breakdown not re-computed)";
  }
  if (doc.pages.length === 0) {
    return "no pages processed";
  }
  const native = doc.pages.filter((p) => p.path === "native-text");
  const ocr = doc.pages.filter((p) => p.path === "ocr");
  const parts = [
    `${doc.pages.length} page(s)`,
    `${native.length} via pdf.js native text`,
    `${ocr.length} via Tesseract OCR`,
  ];
  return parts.join(", ");
}

function qualityNotes(doc: DocumentDiagnostic): string[] {
  const notes: string[] = [];
  if (doc.error) {
    notes.push(`EXTRACTION FAILED: ${doc.error}`);
    return notes;
  }
  if (doc.totalChars === 0) {
    notes.push("Produced NO text at all — nothing can be derived from this file.");
  } else if (doc.totalChars < 200) {
    notes.push(`Only ${doc.totalChars} characters — likely an incomplete read.`);
  }
  const ocrPages = doc.pages.filter((p) => p.path === "ocr");
  if (ocrPages.length > 0) {
    notes.push(
      `${ocrPages.length} page(s) went through OCR, so character-level errors are expected ` +
        "(0/O, 1/l/I, rn/m). Labels may not match exactly.",
    );
  }
  // A high ratio of non-alphanumeric characters is the signature of bad OCR.
  const noise = (doc.rawText.match(/[^\p{L}\p{N}\s.,:/@+()'’-]/gu) ?? []).length;
  if (doc.totalChars > 0 && noise / doc.totalChars > 0.08) {
    notes.push(`High noise ratio (${((noise / doc.totalChars) * 100).toFixed(1)}% odd characters) — poor OCR quality.`);
  }
  return notes;
}

export function buildDiagnosticsReport(profile: StructuredProfile | null): string {
  const docs = getExtractionDiagnostics();
  const lines: string[] = [];

  lines.push("EasyFilla — extraction diagnostics");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Extractor pipeline version: v${PROFILE_PIPELINE_VERSION}`);
  lines.push(`Documents processed this session: ${docs.length}`);
  lines.push("");
  lines.push("This file contains the FULL TEXT of your documents. It was created on your");
  lines.push("device and is not sent anywhere by EasyFilla. Review it before sharing.");
  lines.push("");

  lines.push("=".repeat(78));
  lines.push("PART 1 — PER-DOCUMENT READ QUALITY");
  lines.push("=".repeat(78));
  if (docs.length === 0) {
    lines.push("(no documents processed — upload files, then export again)");
  }
  for (const doc of docs) {
    lines.push("");
    lines.push(`FILE: ${doc.fileName}`);
    lines.push(`  size        : ${doc.sizeBytes} bytes`);
    lines.push(`  mime type   : ${doc.mimeType}`);
    lines.push(`  detected as : ${doc.kind}`);
    lines.push(`  read path   : ${pageSummary(doc)}`);
    lines.push(`  characters  : ${doc.totalChars}`);
    for (const page of doc.pages) {
      lines.push(`    page ${page.page}: ${page.path}, ${page.chars} chars`);
    }
    for (const note of qualityNotes(doc)) {
      lines.push(`  NOTE: ${note}`);
    }
  }

  lines.push("");
  lines.push("=".repeat(78));
  lines.push("PART 2 — FACTS DERIVED FROM THAT TEXT");
  lines.push("=".repeat(78));
  if (!profile || profile.facts.length === 0) {
    lines.push("(no profile derived)");
  } else {
    lines.push(`Profile built by extractor v${profile.pipelineVersion ?? "unknown"}`);
    lines.push(`Document set key: ${profile.documentSetKey}`);
    lines.push("");
    lines.push("field            | value | rule | confidence | corroboration | source file");
    lines.push("-".repeat(78));
    for (const fact of profile.facts) {
      lines.push(
        `${fact.field.padEnd(16)} | ${fact.value} | ${fact.rule ?? "manual"} | ` +
          `${fact.confidence} | ${fact.corroboration ?? 1}x | ${fact.source}`,
      );
    }
    lines.push("");
    lines.push("How to read this: 'rule' is how the value was found — labelled (a table");
    lines.push("row or 'Label: value'), typed (an unambiguous pattern like an email or a");
    lines.push("passport MRZ), contextual (a sentence naming the field), or positional (a");
    lines.push("header-line guess). A 'low' confidence value is NEVER auto-filled.");
  }

  lines.push("");
  lines.push("=".repeat(78));
  lines.push("PART 3 — VERBATIM READER OUTPUT");
  lines.push("=".repeat(78));
  lines.push("Exactly what pdf.js or Tesseract returned, before any parsing.");
  for (const doc of docs) {
    lines.push("");
    lines.push("-".repeat(78));
    lines.push(`--- BEGIN ${doc.fileName} (${doc.totalChars} chars, ${doc.source}) ---`);
    lines.push("-".repeat(78));
    lines.push(doc.error ? `(extraction failed: ${doc.error})` : doc.rawText);
    lines.push(`--- END ${doc.fileName} ---`);
  }

  return lines.join("\n");
}

// Saves the report through the download path rather than any network call.
export function downloadDiagnosticsReport(report: string): void {
  const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `easyfilla-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
