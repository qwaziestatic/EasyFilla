import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker, OEM } from "tesseract.js";
import type { Worker as TesseractWorker } from "tesseract.js";
import { unzipSync } from "fflate";

// Bundled locally (see scripts/copy-tesseract-assets.mjs) rather than fetched
// from a CDN — required under MV3's default CSP and the project's
// local-processing-only requirement for user-uploaded documents.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Pages with less selectable text than this are assumed to be scans and are
// routed through OCR instead of being trusted as-is.
const MIN_SELECTABLE_TEXT_LENGTH = 20;
const PDF_RENDER_SCALE = 2;

export interface ExtractionProgress {
  stage: string;
  progress: number;
}

type ProgressCallback = (update: ExtractionProgress) => void;

function isPdfFileType(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isImageFileType(file: File): boolean {
  // MIME first, then extension — some formats (notably .heic on Windows)
  // arrive with an empty file.type and would otherwise be rejected as
  // "unsupported" instead of being OCR'd.
  if (file.type.startsWith("image/")) {
    return true;
  }
  return /\.(png|jpe?g|webp|tiff?|bmp|heic|heif)$/i.test(file.name);
}

function isPlainTextFileType(file: File): boolean {
  return file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");
}

const OFFICE_EXTENSIONS = /\.(docx|xlsx|pptx|odt|ods|odp|rtf|csv)$/i;
const LEGACY_OFFICE_EXTENSIONS = /\.(doc|xls|ppt)$/i;

function isOfficeFileType(file: File): boolean {
  return OFFICE_EXTENSIONS.test(file.name);
}

function isArchiveFileType(file: File): boolean {
  return file.type === "application/zip" || file.name.toLowerCase().endsWith(".zip");
}

function isMediaFileType(file: File): boolean {
  return file.type.startsWith("audio/") || file.type.startsWith("video/") || /\.(mp3|wav|m4a|ogg|mp4|mov|webm|avi|mkv)$/i.test(file.name);
}

export type SupportedDocumentKind = "pdf" | "image" | "text" | "office" | "archive" | "media" | "unsupported";

export function supportedDocumentKind(file: Pick<File, "name" | "type">): SupportedDocumentKind {
  if (isPdfFileType(file as File)) return "pdf";
  if (isImageFileType(file as File)) return "image";
  if (isPlainTextFileType(file as File)) return "text";
  if (isOfficeFileType(file as File)) return "office";
  if (isArchiveFileType(file as File)) return "archive";
  if (isMediaFileType(file as File)) return "media";
  return "unsupported";
}

async function extractOfficeText(file: File, onProgress?: ProgressCallback): Promise<string> {
  onProgress?.({ stage: "Reading office document", progress: 0.2 });
  const { OfficeParser } = await import("officeparser");
  const ast = await OfficeParser.parseOffice(file, { extractAttachments: false });
  const result = await ast.to("text");
  onProgress?.({ stage: "Done", progress: 1 });
  return result.value.trim();
}

async function extractPlainText(file: File, onProgress?: ProgressCallback): Promise<string> {
  onProgress?.({ stage: "Reading text file", progress: 1 });
  return (await file.text()).trim();
}

async function extractZipText(file: File, onProgress?: ProgressCallback): Promise<string> {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const entries = Object.entries(archive).filter(([name]) => !name.endsWith("/") && !/^(__MACOSX|\.git)\//i.test(name));
  const supported = entries.find(([name]) => OFFICE_EXTENSIONS.test(name) || /\.txt$/i.test(name));
  if (!supported) {
    throw new Error("ZIP archives must contain a supported text or office document.");
  }
  const [name, bytes] = supported;
  onProgress?.({ stage: `Reading ${name} from archive`, progress: 0.5 });
  const nested = new File([bytes], name, { type: "" });
  return /\.txt$/i.test(name)
    ? extractPlainText(nested, onProgress)
    : extractOfficeText(nested, onProgress);
}

async function createLocalTesseractWorker(onProgress?: ProgressCallback): Promise<TesseractWorker> {
  return withTimeout(
    createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("tesseract/tesseract-core-simd-lstm.wasm.js"),
    langPath: chrome.runtime.getURL("tesseract/lang-data"),
    // THE OCR FIX. tesseract.js defaults to workerBlobURL:true, which spawns
    // the worker via `new Worker(URL.createObjectURL(blob))`. MV3's content
    // security policy (script-src 'self') BLOCKS blob: workers, so the worker
    // died immediately, onerror fired, and tesseract rejected with a bare
    // string — which surfaced as the generic "Extraction failed."
    // Setting this false spawns the worker straight from the chrome-extension://
    // URL, which is 'self' and therefore allowed.
      workerBlobURL: false,
      gzip: true,
      logger: (data) => {
        onProgress?.({ stage: data.status, progress: data.progress });
      },
    }),
    OCR_INIT_TIMEOUT_MS,
    "Tesseract initialization",
  );
}

// A hung OCR stage must never strand the whole upload queue (previously one
// stuck document left every later file on "Pending" forever). Every OCR stage
// is bounded; on timeout we fail THAT document with a clear message and move
// on to the next.
const OCR_INIT_TIMEOUT_MS = 90_000;
const OCR_PAGE_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function ocrImage(image: File | HTMLCanvasElement, worker: TesseractWorker): Promise<string> {
  const {
    data: { text },
  } = await withTimeout(worker.recognize(image), OCR_PAGE_TIMEOUT_MS, "OCR");
  return text.trim();
}

async function getSelectableText(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const textContent = await page.getTextContent();
  return textContent.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function renderPageToCanvas(page: pdfjsLib.PDFPageProxy): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvas, viewport }).promise;
  return canvas;
}

// ── EXTRACTION DIAGNOSTICS (FIX A.1) ──────────────────────────────────────
// Records, per document, exactly what the reader produced and by which path.
// Every extraction bug so far was invisible in the same way: the profile came
// out wrong, but the text it was derived from was never observable. This makes
// it observable, and exportable so it can be sent back for analysis.
export interface PageDiagnostic {
  page: number;
  path: "native-text" | "ocr";
  chars: number;
}

export interface DocumentDiagnostic {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  kind: SupportedDocumentKind;
  source: "fresh" | "cache";
  pages: PageDiagnostic[];
  totalChars: number;
  // Verbatim, unmodified reader output — NOT normalized or trimmed for display.
  rawText: string;
  error?: string;
  extractedAt: number;
}

const diagnostics = new Map<string, DocumentDiagnostic>();

export function getExtractionDiagnostics(): DocumentDiagnostic[] {
  return [...diagnostics.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export function clearExtractionDiagnostics(): void {
  diagnostics.clear();
}

async function extractPdfText(
  file: File,
  onProgress?: ProgressCallback,
  pageLog?: PageDiagnostic[],
): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // Created lazily, and only once, so a fully-selectable-text PDF never pays
  // the cost of loading the OCR worker/core/language data at all.
  let ocrWorker: TesseractWorker | null = null;
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress?.({
        stage: `Reading page ${pageNumber} of ${pdf.numPages}`,
        progress: (pageNumber - 1) / pdf.numPages,
      });

      const page = await pdf.getPage(pageNumber);
      const selectableText = await getSelectableText(page);

      if (selectableText.length >= MIN_SELECTABLE_TEXT_LENGTH) {
        pageTexts.push(selectableText);
        pageLog?.push({ page: pageNumber, path: "native-text", chars: selectableText.length });
        continue;
      }

      onProgress?.({
        stage: `Running OCR on page ${pageNumber} of ${pdf.numPages}`,
        progress: (pageNumber - 1) / pdf.numPages,
      });

      const canvas = await renderPageToCanvas(page);
      ocrWorker ??= await createLocalTesseractWorker(onProgress);
      const ocrText = await ocrImage(canvas, ocrWorker);
      pageTexts.push(ocrText);
      pageLog?.push({ page: pageNumber, path: "ocr", chars: ocrText.length });
    }
  } finally {
    if (ocrWorker) {
      await ocrWorker.terminate();
    }
    await pdf.cleanup();
  }

  onProgress?.({ stage: "Done", progress: 1 });
  return pageTexts.join("\n\n").trim();
}

async function extractImageText(file: File, onProgress?: ProgressCallback): Promise<string> {
  const worker = await createLocalTesseractWorker(onProgress);
  try {
    return await ocrImage(file, worker);
  } finally {
    await worker.terminate();
  }
}

// tesseract.js rejects with a bare STRING in its worker-error path (see
// createWorker.js: `workerResReject(event.message)`), so `instanceof Error`
// is false and the real cause was being swallowed as a generic failure.
// Everything thrown from here is normalized to a real Error with a usable
// message.
export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

// FIX 5.3: OCR is expensive, so its result is cached per DOCUMENT keyed by a
// content hash — OCR runs once per uploaded file, never again per form, per
// field, or per report regeneration.
const OCR_CACHE_PREFIX = "easyfilla.ocr.";

async function contentHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readOcrCache(hash: string): Promise<string | null> {
  const key = OCR_CACHE_PREFIX + hash;
  const result = await chrome.storage.local.get(key);
  const value = result[key];
  return typeof value === "string" ? value : null;
}

async function writeOcrCache(hash: string, text: string): Promise<void> {
  await chrome.storage.local.set({ [OCR_CACHE_PREFIX + hash]: text });
}

function documentKind(file: File): DocumentDiagnostic["kind"] {
  return supportedDocumentKind(file);
}

function recordDiagnostic(
  file: File,
  fields: Pick<DocumentDiagnostic, "source" | "pages" | "rawText"> & { error?: string },
): void {
  diagnostics.set(`${file.name}:${file.size}`, {
    fileName: file.name,
    sizeBytes: file.size,
    mimeType: file.type || "(none)",
    kind: documentKind(file),
    totalChars: fields.rawText.length,
    extractedAt: Date.now(),
    ...fields,
  });
}

export async function extractText(file: File, onProgress?: ProgressCallback): Promise<string> {
  // Cache lookup first — a re-uploaded/reprocessed document never re-OCRs.
  let hash: string | null = null;
  try {
    hash = await contentHash(file);
    const cached = await readOcrCache(hash);
    if (cached !== null) {
      console.log(`EasyFilla(extract): cache hit (${cached.length} chars), no re-processing.`);
      onProgress?.({ stage: "Loaded from cache", progress: 1 });
      recordDiagnostic(file, { source: "cache", pages: [], rawText: cached });
      return cached;
    }
  } catch (error) {
    console.log("EasyFilla(extract): cache unavailable, processing directly —", describeThrown(error));
  }

  const pageLog: PageDiagnostic[] = [];
  let text: string;
  try {
    if (isPdfFileType(file)) {
      text = await extractPdfText(file, onProgress, pageLog);
    } else if (isImageFileType(file)) {
      text = await extractImageText(file, onProgress);
      pageLog.push({ page: 1, path: "ocr", chars: text.length });
    } else if (isPlainTextFileType(file)) {
      text = await extractPlainText(file, onProgress);
      pageLog.push({ page: 1, path: "native-text", chars: text.length });
    } else if (isOfficeFileType(file)) {
      text = await extractOfficeText(file, onProgress);
      pageLog.push({ page: 1, path: "native-text", chars: text.length });
    } else if (isArchiveFileType(file)) {
      text = await extractZipText(file, onProgress);
      pageLog.push({ page: 1, path: "native-text", chars: text.length });
    } else if (isMediaFileType(file)) {
      throw new Error(
        "Audio and video files are detected but cannot be transcribed locally yet. Upload a transcript or convert the media to a supported document.",
      );
    } else {
      if (LEGACY_OFFICE_EXTENSIONS.test(file.name)) {
        throw new Error("Legacy DOC/XLS/PPT files are not supported. Save them as DOCX/XLSX/PPTX and upload again.");
      }
      throw new Error(`Unsupported file type: ${file.type || file.name}`);
    }
  } catch (error) {
    // Surface the ACTUAL cause (including string rejections from tesseract)
    // instead of a generic "Extraction failed."
    const detail = describeThrown(error);
    console.error(`EasyFilla(extract): failed — ${detail}`);
    recordDiagnostic(file, { source: "fresh", pages: pageLog, rawText: "", error: detail });
    throw new Error(`Couldn't read "${file.name}": ${detail}`);
  }

  if (hash) {
    await writeOcrCache(hash, text).catch(() => undefined);
  }
  recordDiagnostic(file, { source: "fresh", pages: pageLog, rawText: text });
  const ocrPages = pageLog.filter((p) => p.path === "ocr").length;
  console.log(
    `EasyFilla(extract): extracted ${text.length} chars ` +
      `(${pageLog.length} page(s): ${pageLog.length - ocrPages} native-text, ${ocrPages} OCR).`,
  );
  return text;
}
