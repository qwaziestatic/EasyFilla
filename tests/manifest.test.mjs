// ─────────────────────────────────────────────────────────────────────────
// MANIFEST STRUCTURAL VALIDATION — against the BUILT manifest
//
// ⚠️ WHY THIS EXISTS. Nine sessions of green tests never caught a manifest that
// Chrome refuses to load:
//
//     "The path component for scripts with 'match_origin_as_fallback' must be '*'."
//
// `match_origin_as_fallback: true` was added in STAGE 2a to reach
// about:blank/srcdoc frames. The narrow `https://docs.google.com/forms/*` path
// predates it. Each was correct alone; together they are invalid, and nothing
// ever loaded them together. Every test asserted what our code PRODUCES —
// nothing asserted that Chrome would accept the result.
//
// ── IT VALIDATES dist/, NOT THE SOURCE ───────────────────────────────────
// crxjs REWRITES the manifest: it replaces `js` paths with hashed loaders,
// swaps the service worker for a loader shim, and has been observed ADDING a
// `web_accessible_resources` entry that does not appear in the source. Chrome
// loads the built file, so the built file is what must be valid. The source is
// checked too, so a bad edit fails even before a build.
//
// ── ADD TO THIS FILE ─────────────────────────────────────────────────────
// This is the first live-load failure. There will be more. Each one should
// become an assertion here rather than a note in a handoff.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const SRC_MANIFEST = "manifest.json";
const BUILT_MANIFEST = join("dist", "manifest.json");

// ── Chrome match-pattern grammar ─────────────────────────────────────────
// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
// <scheme>://<host><path>, or the literal <all_urls>. The PATH IS MANDATORY —
// "https://example.com" is not a valid pattern, which is a real and easy typo.
const CONTENT_SCRIPT_SCHEMES = new Set(["*", "http", "https", "file", "ftp", "urn"]);

/** Returns {ok:true, scheme, host, path} or {ok:false, reason}. */
function parseMatchPattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, reason: "not a non-empty string" };
  }
  if (pattern === "<all_urls>") {
    return { ok: true, scheme: "*", host: "*", path: "/*", allUrls: true };
  }
  const split = /^([a-zA-Z*][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(pattern);
  if (!split) return { ok: false, reason: "missing '<scheme>://'" };

  const scheme = split[1];
  const rest = split[2] ?? "";
  if (!CONTENT_SCRIPT_SCHEMES.has(scheme)) {
    return { ok: false, reason: `scheme "${scheme}" is not one Chrome accepts here` };
  }

  const slash = rest.indexOf("/");
  if (slash === -1) {
    // The single most common malformed pattern: no path at all.
    return { ok: false, reason: "no path component (a pattern must end with a path, e.g. '/*')" };
  }
  const host = rest.slice(0, slash);
  const path = rest.slice(slash);

  if (scheme === "file") {
    if (host !== "") return { ok: false, reason: "file:// patterns take an empty host" };
  } else {
    if (host === "") return { ok: false, reason: "empty host" };
    // '*' alone, or a '*.' prefix, are the only wildcards allowed in a host.
    if (host !== "*") {
      const wildcardBody = host.startsWith("*.") ? host.slice(2) : host;
      if (wildcardBody.includes("*")) {
        return { ok: false, reason: `'*' may only appear as the whole host or a leading '*.' — got "${host}"` };
      }
      if (wildcardBody.length === 0) return { ok: false, reason: "'*.' with no domain" };
    }
  }
  if (!path.startsWith("/")) return { ok: false, reason: "path must start with '/'" };
  return { ok: true, scheme, host, path };
}

/**
 * Chrome: "any content scripts specified with 'match_origin_as_fallback' set to
 * true [must] also specify a path of *". An opaque-origin frame (about:, data:,
 * blob:, filesystem:) has no meaningful path, so a path-restricted pattern could
 * never match one — Chrome rejects the manifest rather than silently never
 * injecting.
 */
function pathIsWildcardOnly(path) {
  return path === "/*";
}

/** The rule under test, applied to any manifest-shaped object. */
function violationsFor(manifest) {
  const out = [];
  (manifest.content_scripts ?? []).forEach((entry, index) => {
    if (entry.match_origin_as_fallback !== true) return;
    (entry.matches ?? []).forEach((pattern) => {
      const parsed = parseMatchPattern(pattern);
      if (!parsed.ok || !pathIsWildcardOnly(parsed.path)) {
        out.push(`content_scripts[${index}] "${pattern}"`);
      }
    });
  });
  return out;
}

// ── Ensure a fresh built manifest ────────────────────────────────────────
// Rebuilds only when dist/ is missing or older than the source, so the common
// case costs nothing. A guard that silently skipped would reproduce the exact
// failure it exists to prevent.
{
  const needsBuild =
    !existsSync(BUILT_MANIFEST) ||
    statSync(SRC_MANIFEST).mtimeMs > statSync(BUILT_MANIFEST).mtimeMs;
  if (needsBuild) {
    console.log("\n  (dist/manifest.json missing or stale — running npm run build)");
    execSync("npm run build", { stdio: "ignore" });
  }
}

console.log("\n=== MANIFEST: the rule Chrome rejected the extension over ===");
{
  check("dist/manifest.json exists (nothing below is meaningful without it)", existsSync(BUILT_MANIFEST));
  const built = JSON.parse(readFileSync(BUILT_MANIFEST, "utf8"));
  const source = JSON.parse(readFileSync(SRC_MANIFEST, "utf8"));

  const builtViolations = violationsFor(built);
  check(
    "BUILT: every match_origin_as_fallback entry has a path of exactly '/*'",
    builtViolations.length === 0,
    builtViolations.join(", ") || "no entry carries the flag, so the rule is trivially satisfied",
  );
  const sourceViolations = violationsFor(source);
  check(
    "SOURCE: same rule, so a bad edit fails before a build",
    sourceViolations.length === 0,
    sourceViolations.join(", "),
  );

  // ⚠️ GUARD AGAINST A VACUOUS PASS. The real manifest no longer carries the
  // flag, so the two assertions above would pass even if the rule were broken.
  // These synthetic fixtures prove the rule actually catches the failure — the
  // first is the exact shape Chrome rejected.
  const theRejectedShape = {
    content_scripts: [
      { matches: ["https://docs.google.com/forms/*"], match_origin_as_fallback: true },
    ],
  };
  check(
    "the rule REPRODUCES the live failure (narrow path + flag is rejected)",
    violationsFor(theRejectedShape).length === 1,
    "if this ever passes, the guard has stopped guarding",
  );
  check(
    "and accepts the legal form (path '/*' + flag)",
    violationsFor({
      content_scripts: [{ matches: ["https://docs.google.com/*"], match_origin_as_fallback: true }],
    }).length === 0,
  );
  check(
    "a missing path is caught too",
    violationsFor({
      content_scripts: [{ matches: ["https://docs.google.com"], match_origin_as_fallback: true }],
    }).length === 1,
  );
}

console.log("\n=== MANIFEST: every match pattern is syntactically valid ===");
{
  const built = JSON.parse(readFileSync(BUILT_MANIFEST, "utf8"));
  const patternSets = [
    ["host_permissions", built.host_permissions ?? []],
    ["optional_host_permissions", built.optional_host_permissions ?? []],
    ...(built.content_scripts ?? []).map((entry, i) => [`content_scripts[${i}].matches`, entry.matches ?? []]),
    ...(built.web_accessible_resources ?? []).map((entry, i) => [
      `web_accessible_resources[${i}].matches`,
      entry.matches ?? [],
    ]),
  ];

  let total = 0;
  patternSets.forEach(([label, patterns]) => {
    const bad = patterns
      .map((p) => ({ p, parsed: parseMatchPattern(p) }))
      .filter((entry) => !entry.parsed.ok)
      .map((entry) => `${entry.p} (${entry.parsed.reason})`);
    total += patterns.length;
    check(`${label}: ${patterns.length} valid pattern(s)`, bad.length === 0, bad.join("; "));
  });
  check("patterns were actually found, so this is not a vacuous pass", total > 0, `${total} checked`);

  // Self-check on the parser: malformed patterns that must be rejected.
  const mustReject = [
    "docs.google.com/*",
    "https://docs.google.com",
    "https://*google.com/*",
    "https://",
    "javascript://*/*",
    "",
  ];
  const wronglyAccepted = mustReject.filter((p) => parseMatchPattern(p).ok);
  check("the parser rejects malformed patterns", wronglyAccepted.length === 0, wronglyAccepted.join(", "));
  const mustAccept = ["<all_urls>", "https://*/*", "http://*/*", "https://*.example.com/*", "file:///*"];
  const wronglyRejected = mustAccept.filter((p) => !parseMatchPattern(p).ok);
  check("and accepts well-formed ones", wronglyRejected.length === 0, wronglyRejected.join(", "));
}

console.log("\n=== MANIFEST: the API origins the app needs are declared ===");
{
  const built = JSON.parse(readFileSync(BUILT_MANIFEST, "utf8"));
  const hosts = built.host_permissions ?? [];
  // Both providers must be reachable. A missing origin here means the provider
  // silently fails or works only by depending on that vendor's CORS behaviour,
  // which is what happened to api.anthropic.com before F.
  check(
    "the Gemini API origin is present",
    hosts.some((h) => h.includes("generativelanguage.googleapis.com")),
    hosts.join(", "),
  );
  check("the Anthropic API origin is present", hosts.some((h) => h.includes("api.anthropic.com")));
  check(
    "both are https",
    hosts.filter((h) => /googleapis|anthropic/.test(h)).every((h) => h.startsWith("https://")),
  );
}

console.log("\n=== MANIFEST: permission hygiene (§4e) must not silently widen ===");
{
  const built = JSON.parse(readFileSync(BUILT_MANIFEST, "utf8"));

  // The Google Forms content script must stay on the NARROW path. Broadening it
  // to https://docs.google.com/* would inject into Docs, Sheets, Slides and
  // Drive — and is the tempting "fix" for the match_origin_as_fallback error.
  const formsEntries = (built.content_scripts ?? []).filter((entry) =>
    (entry.matches ?? []).some((m) => m.includes("docs.google.com")),
  );
  check("a Google Forms content script exists", formsEntries.length > 0);
  const broadened = formsEntries.flatMap((entry) =>
    (entry.matches ?? []).filter((m) => /^https:\/\/docs\.google\.com\/\*$/.test(m)),
  );
  check(
    "⚠️ it is NOT broadened to all of docs.google.com",
    broadened.length === 0,
    broadened.join(", ") || "stays on /forms/*, so Docs/Sheets/Slides/Drive are untouched",
  );

  // The all-sites patterns must stay OPTIONAL. Declarative content_scripts
  // matches count toward the install-time prompt, so an all-sites pattern there
  // would read "Read and change all your data on all websites" at install.
  const declaredBroad = (built.content_scripts ?? []).flatMap((entry) =>
    (entry.matches ?? []).filter((m) => m === "<all_urls>" || /^\*?https?:\/\/\*\/\*$/.test(m)),
  );
  check(
    "⚠️ no content script declares an all-sites pattern",
    declaredBroad.length === 0,
    declaredBroad.join(", ") || "all-sites access stays in optional_host_permissions, requested per origin",
  );
  check(
    "the all-sites patterns are in optional_host_permissions",
    (built.optional_host_permissions ?? []).includes("https://*/*"),
  );
  check(
    "and NOT in host_permissions",
    !(built.host_permissions ?? []).some((h) => h === "https://*/*" || h === "<all_urls>"),
  );
}

console.log("\n=== MANIFEST: every referenced file actually exists in dist/ ===");
{
  // A manifest pointing at a file the build did not emit is another load
  // failure that no logic test would catch.
  const built = JSON.parse(readFileSync(BUILT_MANIFEST, "utf8"));
  const missing = [];
  const want = (relative, label) => {
    if (typeof relative !== "string") return;
    if (!existsSync(join("dist", relative))) missing.push(`${label}: ${relative}`);
  };

  want(built.background?.service_worker, "background.service_worker");
  want(built.side_panel?.default_path, "side_panel.default_path");
  want(built.options_ui?.page, "options_ui.page");
  Object.entries(built.icons ?? {}).forEach(([size, path]) => want(path, `icons[${size}]`));
  Object.entries(built.action?.default_icon ?? {}).forEach(([size, path]) => want(path, `action.default_icon[${size}]`));
  (built.content_scripts ?? []).forEach((entry, i) =>
    (entry.js ?? []).forEach((path) => want(path, `content_scripts[${i}].js`)),
  );

  check("no referenced file is missing from the build output", missing.length === 0, missing.join("; "));

  // Resource globs must match at least one emitted file, or the entry is dead.
  const emptyGlobs = [];
  (built.web_accessible_resources ?? []).forEach((entry, i) => {
    (entry.resources ?? []).forEach((pattern) => {
      const dir = join("dist", dirname(pattern));
      const base = pattern.split("/").pop() ?? "";
      const rx = new RegExp(`^${base.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      const hit = existsSync(dir) && readdirSync(dir).some((file) => rx.test(file));
      if (!hit) emptyGlobs.push(`web_accessible_resources[${i}]: ${pattern}`);
    });
  });
  check("every web_accessible_resources pattern matches an emitted file", emptyGlobs.length === 0, emptyGlobs.join("; "));
}

console.log("\n=== MANIFEST: assorted rules Chrome enforces at load ===");
{
  const built = JSON.parse(readFileSync(BUILT_MANIFEST, "utf8"));

  check("manifest_version is 3", built.manifest_version === 3);
  check("version is present and dotted-numeric", /^\d+(\.\d+){0,3}$/.test(built.version ?? ""), built.version);
  check("name is non-empty and within Chrome's 75-char limit", (built.name ?? "").length > 0 && built.name.length <= 75);
  check(
    "description is non-empty and within Chrome's 132-char limit",
    (built.description ?? "").length > 0 && built.description.length <= 132,
    `${(built.description ?? "").length} chars`,
  );

  // §5: this CSP is required or the PDF/OCR WASM will not run. 'unsafe-eval'
  // would be rejected outright by the Web Store.
  const csp = built.content_security_policy?.extension_pages ?? "";
  check("extension_pages CSP keeps 'wasm-unsafe-eval' (§5 — required for the WASM)", csp.includes("wasm-unsafe-eval"));
  check("and does NOT contain bare 'unsafe-eval'", !/'unsafe-eval'/.test(csp), csp);

  // Every content script needs at least one match and one file, or it is inert.
  const inert = (built.content_scripts ?? [])
    .map((entry, i) => ({ i, entry }))
    .filter(({ entry }) => (entry.matches ?? []).length === 0 || (entry.js ?? []).length === 0)
    .map(({ i }) => `content_scripts[${i}]`);
  check("no content script is inert (empty matches or js)", inert.length === 0, inert.join(", "));

  const runAtValues = new Set(["document_start", "document_end", "document_idle"]);
  const badRunAt = (built.content_scripts ?? [])
    .filter((entry) => entry.run_at !== undefined && !runAtValues.has(entry.run_at))
    .map((entry) => entry.run_at);
  check("every run_at is a value Chrome accepts", badRunAt.length === 0, badRunAt.join(", "));

  // Declared permissions must be real API permissions; a typo is silently
  // ignored by some Chrome versions and rejected by others.
  const KNOWN_PERMISSIONS = new Set([
    "activeTab", "alarms", "bookmarks", "browsingData", "certificateProvider", "clipboardRead",
    "clipboardWrite", "contentSettings", "contextMenus", "cookies", "debugger", "declarativeContent",
    "declarativeNetRequest", "declarativeNetRequestFeedback", "declarativeNetRequestWithHostAccess",
    "desktopCapture", "documentScan", "downloads", "downloads.open", "downloads.ui", "enterprise.deviceAttributes",
    "enterprise.hardwarePlatform", "enterprise.networkingAttributes", "enterprise.platformKeys", "favicon",
    "fileBrowserHandler", "fileSystemProvider", "fontSettings", "gcm", "geolocation", "history", "identity",
    "identity.email", "idle", "loginState", "management", "nativeMessaging", "notifications", "offscreen",
    "pageCapture", "platformKeys", "power", "printerProvider", "printing", "printingMetrics", "privacy",
    "processes", "proxy", "readingList", "runtime", "scripting", "search", "sessions", "sidePanel",
    "storage", "system.cpu", "system.display", "system.memory", "system.storage", "tabCapture", "tabGroups",
    "tabs", "topSites", "tts", "ttsEngine", "unlimitedStorage", "userScripts", "vpnProvider", "wallpaper",
    "webAuthenticationProxy", "webNavigation", "webRequest", "webRequestBlocking",
  ]);
  const unknown = (built.permissions ?? []).filter((p) => !KNOWN_PERMISSIONS.has(p));
  check("every declared permission is a real Chrome permission", unknown.length === 0, unknown.join(", "));

  // A permission listed twice, or in both permissions and optional_permissions,
  // is a sign of a bad merge.
  const perms = built.permissions ?? [];
  check("no duplicate permissions", new Set(perms).size === perms.length, perms.join(", "));
  const hostPerms = built.host_permissions ?? [];
  check("no duplicate host_permissions", new Set(hostPerms).size === hostPerms.length, hostPerms.join(", "));
  const overlap = hostPerms.filter((h) => (built.optional_host_permissions ?? []).includes(h));
  check(
    "no host is both required and optional",
    overlap.length === 0,
    overlap.join(", ") || "an origin granted at install cannot also be requested later",
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
