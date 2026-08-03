// ─────────────────────────────────────────────────────────────────────────
// GEMINI FILES API (STAGE 4)
//
// Uploads that exceed the inline base64 budget used to hard-fail with a
// "shrink these files" message. Phone photos of documents cross that line
// routinely — an ordinary case, not an edge case — so this is the documented
// route for them.
//
// ── FETCHED FROM LIVE DOCS ON 2026-07-28. DO NOT REWRITE FROM MEMORY. ────
// This codebase's transport has been broken four separate times by sessions
// "correcting" it on recall (see HANDOFF.md §1). Every shape below was read
// off these pages on the date above. If you believe one is wrong, RE-FETCH
// the URL and update this header — do not change the code from memory.
//
//   Files API guide (upload protocol, 48h TTL, size limits):
//     https://ai.google.dev/gemini-api/docs/files
//   File resource reference (field names, state enum, files.get):
//     https://ai.google.dev/api/files
//
// VERIFIED SHAPES
//   Upload (resumable, two requests):
//     1) POST https://generativelanguage.googleapis.com/upload/v1beta/files
//        X-Goog-Upload-Protocol: resumable
//        X-Goog-Upload-Command: start
//        X-Goog-Upload-Header-Content-Length: <bytes>
//        X-Goog-Upload-Header-Content-Type: <mime>
//        Content-Type: application/json
//        body: {"file": {"display_name": "<name>"}}
//        → the upload URL comes back in the `x-goog-upload-url` RESPONSE HEADER
//     2) POST <that url>
//        X-Goog-Upload-Offset: 0
//        X-Goog-Upload-Command: upload, finalize
//        body: the raw bytes
//        → {"file": {"name","uri","mimeType","state","expirationTime", …}}
//
//   Poll:  GET https://generativelanguage.googleapis.com/v1beta/{name=files/*}
//   State: STATE_UNSPECIFIED | PROCESSING | ACTIVE | FAILED
//          Large PDFs sit in PROCESSING; referencing one before it is ACTIVE
//          fails, which is why `waitForActive` exists.
//   TTL:   "Files are stored for 48 hours."
//   Size:  2 GB per file, 20 GB per project, PDFs limited to 50 MB.
//          "Always use the Files API when the total request size … is larger
//           than 100 MB."
//
//   Reference in an Interactions `input` block (§1 — input is an array of
//   typed content objects):
//     { "type": "<kind>", "uri": file.uri, "mime_type": file.mimeType }
// ─────────────────────────────────────────────────────────────────────────

const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const FILES_BASE = "https://generativelanguage.googleapis.com/v1beta";

// "Files are stored for 48 hours" — https://ai.google.dev/gemini-api/docs/files
export const FILE_TTL_MS = 48 * 60 * 60 * 1000;
// Expire our cache early so a dossier rebuild never references a URI that
// lapses mid-request. One hour of margin against a 48-hour window.
export const FILE_CACHE_MARGIN_MS = 60 * 60 * 1000;

// PDFs have their own documented ceiling, well below the 2 GB per-file limit.
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export type FileState = "STATE_UNSPECIFIED" | "PROCESSING" | "ACTIVE" | "FAILED";

export interface UploadedFile {
  // "files/abc-123" — the resource name used for polling.
  name: string;
  uri: string;
  mimeType: string;
  state: FileState;
  // RFC3339 from the server. We also store our own computed expiry.
  expirationTime?: string;
  sizeBytes?: string;
}

// Thrown with the FILE NAMED. A generic "AI error" for a failed upload is
// useless: the user cannot tell which of six documents to fix.
export class FileUploadError extends Error {
  constructor(
    readonly fileName: string,
    reason: string,
    readonly retryable = false,
  ) {
    super(`Couldn't upload "${fileName}" — ${reason}`);
    this.name = "FileUploadError";
  }
}

function describeHttp(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 300);
  return `the server replied ${status}${trimmed ? `: ${trimmed}` : ""}`;
}

// Per-file size validation BEFORE spending an upload. Both ceilings are
// documented values, not guesses.
export function checkUploadable(file: { name: string; size: number; type: string }): string | null {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf && file.size > MAX_PDF_BYTES) {
    return (
      `it is ${(file.size / 1024 / 1024).toFixed(1)} MB and the Files API caps PDFs at ` +
      `${MAX_PDF_BYTES / 1024 / 1024} MB. Split it or export a smaller copy.`
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return `it is ${(file.size / 1024 / 1024 / 1024).toFixed(2)} GB and the per-file limit is 2 GB.`;
  }
  if (file.size === 0) {
    return "it is empty (0 bytes).";
  }
  return null;
}

// ── Step 1 + 2: resumable upload ─────────────────────────────────────────

export async function uploadFile(
  file: File,
  apiKey: string,
  onProgress?: (stage: string) => void,
): Promise<UploadedFile> {
  const violation = checkUploadable(file);
  if (violation) {
    throw new FileUploadError(file.name, violation, false);
  }

  onProgress?.(`Starting upload of ${file.name}…`);

  let startResponse: Response;
  try {
    startResponse = await fetch(UPLOAD_BASE, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(file.size),
        "X-Goog-Upload-Header-Content-Type": file.type || "application/octet-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: file.name } }),
    });
  } catch (error) {
    throw new FileUploadError(
      file.name,
      `the upload couldn't be started (${error instanceof Error ? error.message : "network error"})`,
      true,
    );
  }

  if (!startResponse.ok) {
    throw new FileUploadError(
      file.name,
      describeHttp(startResponse.status, await startResponse.text().catch(() => "")),
      startResponse.status >= 500,
    );
  }

  // The upload URL arrives as a RESPONSE HEADER, not in the body. Extension
  // pages holding host_permissions for this origin read cross-origin response
  // headers without CORS restriction; a content script could not.
  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new FileUploadError(
      file.name,
      "the server accepted the upload request but returned no 'x-goog-upload-url' header, so there is nowhere " +
        "to send the bytes. This usually means the request was made from a context that can't read cross-origin " +
        "response headers.",
      false,
    );
  }

  onProgress?.(`Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`);

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(file.size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: file,
    });
  } catch (error) {
    throw new FileUploadError(
      file.name,
      `the bytes couldn't be sent (${error instanceof Error ? error.message : "network error"})`,
      true,
    );
  }

  if (!uploadResponse.ok) {
    throw new FileUploadError(
      file.name,
      describeHttp(uploadResponse.status, await uploadResponse.text().catch(() => "")),
      uploadResponse.status >= 500,
    );
  }

  const payload = (await uploadResponse.json().catch(() => null)) as { file?: UploadedFile } | null;
  const uploaded = payload?.file;
  if (!uploaded?.uri || !uploaded.name) {
    throw new FileUploadError(file.name, "the upload finished but the server returned no file URI", false);
  }
  return {
    name: uploaded.name,
    uri: uploaded.uri,
    mimeType: uploaded.mimeType || file.type || "application/octet-stream",
    state: uploaded.state ?? "PROCESSING",
    ...(uploaded.expirationTime ? { expirationTime: uploaded.expirationTime } : {}),
    ...(uploaded.sizeBytes ? { sizeBytes: uploaded.sizeBytes } : {}),
  };
}

// ── Step 3: wait for ACTIVE ──────────────────────────────────────────────
// Large PDFs sit in PROCESSING after the bytes land. Referencing one before it
// is ACTIVE fails the generation request — so this is not optional politeness,
// it is the difference between working and a confusing 400.

export interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function getFile(name: string, apiKey: string): Promise<UploadedFile> {
  const response = await fetch(`${FILES_BASE}/${name}`, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) {
    throw new FileUploadError(name, describeHttp(response.status, await response.text().catch(() => "")), response.status >= 500);
  }
  return (await response.json()) as UploadedFile;
}

export async function waitForActive(
  file: UploadedFile,
  apiKey: string,
  options: WaitOptions = {},
  onProgress?: (stage: string) => void,
): Promise<UploadedFile> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const started = Date.now();
  let current = file;

  while (current.state === "PROCESSING" || current.state === "STATE_UNSPECIFIED") {
    if (Date.now() - started > timeoutMs) {
      throw new FileUploadError(
        file.name,
        `it was still PROCESSING after ${Math.round(timeoutMs / 1000)}s. Large scans can take longer — try again, ` +
          "or use a smaller copy.",
        true,
      );
    }
    onProgress?.(`Waiting for the server to finish processing ${file.name}…`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    current = await getFile(file.name, apiKey);
  }

  if (current.state === "FAILED") {
    throw new FileUploadError(file.name, "the server reported it FAILED to process (it may be corrupt or unsupported)", false);
  }
  return current;
}

// ── Cache ────────────────────────────────────────────────────────────────
// Keyed on the SAME content hash the dossier cache uses, so a rebuild inside
// the 48-hour window reuses the uploaded URI instead of re-uploading megabytes.

export interface CachedUpload {
  key: string; // content hash of this one file
  uri: string;
  name: string;
  mimeType: string;
  uploadedAt: number;
  // Our own conservative expiry: server TTL minus a margin.
  expiresAt: number;
}

const UPLOAD_CACHE_KEY = "easyfilla.fileUploads.v1";

// Same per-file digest shape the dossier's `fileSetKey` builds its set key from
// (name:size:sha256-prefix), so the two caches invalidate on the same events.
export async function fileContentKey(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${file.name.toLowerCase()}:${file.size}:${hex}`;
}

export function isCacheEntryFresh(entry: CachedUpload, now = Date.now()): boolean {
  return entry.expiresAt > now;
}

export function computeExpiry(uploadedAt: number, serverExpirationTime?: string): number {
  const serverExpiry = serverExpirationTime ? Date.parse(serverExpirationTime) : NaN;
  // Trust the server's own expiry when it gives one; fall back to the
  // documented 48 hours. Either way, subtract the margin.
  const base = Number.isFinite(serverExpiry) ? serverExpiry : uploadedAt + FILE_TTL_MS;
  return base - FILE_CACHE_MARGIN_MS;
}

export async function loadUploadCache(): Promise<Record<string, CachedUpload>> {
  try {
    const stored = await chrome.storage.local.get(UPLOAD_CACHE_KEY);
    const raw = stored[UPLOAD_CACHE_KEY];
    return typeof raw === "object" && raw !== null ? (raw as Record<string, CachedUpload>) : {};
  } catch {
    return {};
  }
}

export async function saveUploadCache(cache: Record<string, CachedUpload>): Promise<void> {
  try {
    await chrome.storage.local.set({ [UPLOAD_CACHE_KEY]: cache });
  } catch (error) {
    console.warn("[EasyFilla][Files] couldn't persist the upload cache; the next rebuild will re-upload.", error);
  }
}

// Drops entries past their (margin-adjusted) expiry. Pure so it is testable.
export function pruneUploadCache(
  cache: Record<string, CachedUpload>,
  now = Date.now(),
): { kept: Record<string, CachedUpload>; dropped: string[] } {
  const kept: Record<string, CachedUpload> = {};
  const dropped: string[] = [];
  for (const [key, entry] of Object.entries(cache)) {
    if (isCacheEntryFresh(entry, now)) {
      kept[key] = entry;
    } else {
      dropped.push(key);
    }
  }
  return { kept, dropped };
}

// Upload-or-reuse. Returns the URI to reference plus which path was taken, so
// the caller can log it per file (§ "log which path was taken per file").
export interface EnsureUploadResult {
  uri: string;
  mimeType: string;
  fromCache: boolean;
  name: string;
}

export async function ensureUploaded(
  file: File,
  apiKey: string,
  onProgress?: (stage: string) => void,
): Promise<EnsureUploadResult> {
  const key = await fileContentKey(file);
  const cache = await loadUploadCache();
  const { kept, dropped } = pruneUploadCache(cache);
  if (dropped.length > 0) {
    console.log(`[EasyFilla][Files] dropped ${dropped.length} expired upload(s) from the cache.`);
    await saveUploadCache(kept);
  }

  const hit = kept[key];
  if (hit) {
    console.log(
      `[EasyFilla][Files] "${file.name}" → CACHED upload ${hit.uri} ` +
        `(expires ${new Date(hit.expiresAt).toLocaleString()}) — 0 bytes re-sent.`,
    );
    return { uri: hit.uri, mimeType: hit.mimeType, fromCache: true, name: hit.name };
  }

  const uploaded = await uploadFile(file, apiKey, onProgress);
  const active = await waitForActive(uploaded, apiKey, {}, onProgress);
  const uploadedAt = Date.now();
  const entry: CachedUpload = {
    key,
    uri: active.uri,
    name: active.name,
    mimeType: active.mimeType,
    uploadedAt,
    expiresAt: computeExpiry(uploadedAt, active.expirationTime),
  };
  kept[key] = entry;
  await saveUploadCache(kept);

  console.log(
    `[EasyFilla][Files] "${file.name}" → UPLOADED ${active.uri} (state ${active.state}, ` +
      `cached until ${new Date(entry.expiresAt).toLocaleString()}).`,
  );
  return { uri: active.uri, mimeType: active.mimeType, fromCache: false, name: active.name };
}
