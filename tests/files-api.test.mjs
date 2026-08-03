// STAGE 4 — Files API cache expiry and per-file size validation.
//
// The pure parts only. The network half (resumable upload, x-goog-upload-url
// header, PROCESSING→ACTIVE polling) is NOT faked here: a fake would validate
// the fake, and this codebase's transport has been broken four times by exactly
// that kind of confidence. Those shapes were read off the live docs on
// 2026-07-28 and are cited in src/lib/ai/files-api.ts.
import {
  pruneUploadCache,
  isCacheEntryFresh,
  computeExpiry,
  checkUploadable,
  FILE_TTL_MS,
  FILE_CACHE_MARGIN_MS,
  MAX_PDF_BYTES,
} from "./_bundle-files.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const HOUR = 3600_000;
const entry = (key, expiresAt) => ({ key, uri: `files/${key}`, name: `files/${key}`, mimeType: "application/pdf", uploadedAt: 0, expiresAt });

console.log("\n=== STAGE 4: the 48-hour TTL is respected with a safety margin ===");

{
  const uploadedAt = Date.parse("2026-07-28T00:00:00Z");
  const expiry = computeExpiry(uploadedAt);
  check(
    "with no server expiry, the documented 48h TTL is used",
    expiry === uploadedAt + FILE_TTL_MS - FILE_CACHE_MARGIN_MS,
    new Date(expiry).toISOString(),
  );
  check("and it expires EARLY, never at the exact server deadline", expiry < uploadedAt + FILE_TTL_MS);
  check("48h is what the docs say", FILE_TTL_MS === 48 * 3600_000, `${FILE_TTL_MS / 3600_000}h`);
}

{
  // The server's own expirationTime wins when supplied — it knows better than
  // our constant, and Google may shorten the window without notice.
  const uploadedAt = Date.parse("2026-07-28T00:00:00Z");
  const serverExpiry = "2026-07-28T06:00:00Z"; // deliberately much shorter than 48h
  const expiry = computeExpiry(uploadedAt, serverExpiry);
  check(
    "a server-supplied expirationTime overrides the 48h default",
    expiry === Date.parse(serverExpiry) - FILE_CACHE_MARGIN_MS,
    new Date(expiry).toISOString(),
  );
  check("and is still pulled back by the margin", expiry < Date.parse(serverExpiry));
}

{
  const uploadedAt = Date.parse("2026-07-28T00:00:00Z");
  check(
    "a garbage server expirationTime falls back to the documented TTL rather than NaN",
    computeExpiry(uploadedAt, "not-a-date") === uploadedAt + FILE_TTL_MS - FILE_CACHE_MARGIN_MS,
  );
}

console.log("\n=== STAGE 4: cache pruning ===");

{
  const now = 100 * HOUR;
  const cache = {
    fresh: entry("fresh", now + 10 * HOUR),
    stale: entry("stale", now - 1),
    exactlyNow: entry("exactlyNow", now),
  };
  const { kept, dropped } = pruneUploadCache(cache, now);
  check("a fresh entry is kept", Boolean(kept.fresh));
  check("an expired entry is dropped", dropped.includes("stale") && !kept.stale);
  check(
    "an entry expiring exactly now is treated as expired, not reused",
    dropped.includes("exactlyNow"),
    "reusing a URI at the instant it lapses is the race this margin exists to avoid",
  );
  check("what was dropped is reported", dropped.length === 2, `dropped=${JSON.stringify(dropped)}`);
}

{
  const now = 100 * HOUR;
  check("isCacheEntryFresh agrees with pruning", isCacheEntryFresh(entry("a", now + 1), now) === true);
  check("and rejects a lapsed entry", isCacheEntryFresh(entry("a", now - 1), now) === false);
  const empty = pruneUploadCache({}, now);
  check("an empty cache prunes to empty without throwing", Object.keys(empty.kept).length === 0 && empty.dropped.length === 0);
}

console.log("\n=== STAGE 4: per-file size validation happens BEFORE any upload ===");

{
  const ok = checkUploadable({ name: "cv.pdf", size: 2 * 1024 * 1024, type: "application/pdf" });
  check("a normal PDF is uploadable", ok === null, String(ok));

  const bigPdf = checkUploadable({ name: "scan.pdf", size: 60 * 1024 * 1024, type: "application/pdf" });
  check("a PDF over the documented 50 MB PDF cap is rejected", bigPdf !== null);
  check("and the reason names the actual limit", /50 MB/.test(bigPdf ?? ""), bigPdf);
  check("the cap matches the docs", MAX_PDF_BYTES === 50 * 1024 * 1024, `${MAX_PDF_BYTES / 1024 / 1024} MB`);

  // The PDF cap must apply by extension too — a phone-exported PDF often
  // arrives with an empty or wrong MIME type.
  const byExtension = checkUploadable({ name: "scan.PDF", size: 60 * 1024 * 1024, type: "" });
  check("a PDF with no MIME type is still held to the PDF cap", byExtension !== null, String(byExtension));

  const bigImage = checkUploadable({ name: "photo.jpg", size: 60 * 1024 * 1024, type: "image/jpeg" });
  check("a 60 MB IMAGE is fine — the 50 MB cap is PDF-specific", bigImage === null, String(bigImage));

  const empty = checkUploadable({ name: "broken.pdf", size: 0, type: "application/pdf" });
  check("an empty file is rejected before wasting an upload", empty !== null && /empty/.test(empty), String(empty));
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
