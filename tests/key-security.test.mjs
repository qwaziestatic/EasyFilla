// ─────────────────────────────────────────────────────────────────────────
// E5 — KEY SECURITY BOUNDARIES, ASSERTED STRUCTURALLY
//
// B1 (§4f) was verified by grep, and its guarantees are structural claims about
// which files can even SEE a key. A runtime test cannot express "no content
// script can reach the key" — that is a property of the import graph and the
// text of the files. So this suite greps, exactly as the original audit did,
// and fails if a future edit reintroduces a boundary crossing.
//
// This exists because the audit was true when written and then quietly stopped
// being true: a second key was added and nothing re-checked the boundaries.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|js|mjs)$/.test(full)) out.push(full);
  }
  return out;
}

const read = (file) => readFileSync(file, "utf8");

/**
 * Source with comments removed.
 *
 * Every assertion below is a claim about CODE. Matching raw text made three of
 * them fail on prose that documents the very rule being checked —
 * `gemini-api-key.ts` explains it is "deliberately NOT chrome.storage.sync",
 * and the options page explains that it no longer calls `loadGeminiApiKey`.
 * A comment stating the invariant must not be evidence of breaking it. This is
 * not a relaxed assertion: it is the same assertion, applied to code only.
 */
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const KEY_TOKENS = /geminiApiKey|anthropicApiKey|loadApiKey|loadGeminiApiKey|x-api-key|x-goog-api-key/;

console.log("\n=== E5: the key is unreachable from the untrusted boundaries ===");
{
  // 1. Content scripts run in the page's tab. Anything they can read is one
  //    compromised page away from exfiltration.
  const contentScripts = walk(join("src", "content-scripts"));
  check("content-scripts/ exist to audit (guard against a vacuous pass)", contentScripts.length > 0, `${contentScripts.length} files`);
  const leakyContent = contentScripts.filter((file) => KEY_TOKENS.test(code(file)));
  check("no file under content-scripts/ references either key", leakyContent.length === 0, leakyContent.join(", "));

  // 2. A key on a message payload crosses into the worker and is visible to
  //    anything that can send/receive that message type.
  const messageFiles = [...walk(join("src", "lib", "messaging")), ...walk(join("src", "types"))];
  const leakyMessages = messageFiles.filter((file) => KEY_TOKENS.test(code(file)));
  check("no key on any message type", leakyMessages.length === 0, leakyMessages.join(", "));

  // 3. The service worker deliberately does not import the AI client.
  const background = walk(join("src", "background"));
  const leakyBackground = background.filter((file) => KEY_TOKENS.test(code(file)));
  check("the service worker never handles a key", leakyBackground.length === 0, leakyBackground.join(", "));

  // 4. MAIN-world injection would put our code in the page's JS context, where
  //    page script can read our closures.
  const allSource = walk("src");
  const mainWorld = allSource.filter((file) => /world:\s*["']MAIN["']/.test(code(file)));
  check("no MAIN-world injection anywhere", mainWorld.length === 0, mainWorld.join(", "));
}

console.log("\n=== E5: nothing logs a key, or any prefix of one ===");
{
  const allSource = walk("src");
  // A prefix is not a safe redaction: the first characters of an API key are
  // enough to confirm which key a leaked credential is, and `sk-ant-` style
  // prefixes plus a few chars materially narrow a brute force.
  const offenders = [];
  for (const file of allSource) {
    const text = code(file);
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!/console\.(log|warn|error|info|table|debug)|debugLog\(/.test(line)) return;
      // Flags a log statement that interpolates a key-ish identifier, or slices one.
      if (/\bapiKey\b|geminiApiKey|anthropicApiKey|\bkey\.slice|\bapiKey\.slice|\bapiKey\.substring/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }
  check("no log statement references a key or a slice of one", offenders.length === 0, offenders.join(", "));
}

console.log("\n=== E5: presence checks never materialise the string ===");
{
  const providerKeys = read(join("src", "lib", "storage", "provider-keys.ts"));
  const providerKeysCode = code(join("src", "lib", "storage", "provider-keys.ts"));
  // The signature is the guarantee: a boolean cannot carry the key out.
  check(
    "hasApiKey returns Promise<boolean>, so no caller can receive the string",
    /export async function hasApiKey\(provider: ProviderId\): Promise<boolean>/.test(providerKeys),
  );
  check(
    "loadApiKey is the ONLY function returning the string",
    (providerKeys.match(/Promise<string \| null>/g) ?? []).length === 1,
  );

  // The options page must never write a stored key back into the DOM. This was
  // a real E5 finding: it did, on every open, for the INACTIVE provider too.
  const options = code(join("src", "options", "options.ts"));
  check(
    "the options page never assigns a loaded key to an input value",
    !/apiKeyInput\.value\s*=\s*(apiKey|await|key\b)/.test(options),
    "it may only CLEAR the field, never populate it",
  );
  check(
    "the options page does not import a key-materialising loader",
    !/loadGeminiApiKey|loadApiKey/.test(options),
  );
}

console.log("\n=== E5: the INACTIVE provider's key is never read ===");
{
  // The only way a provider's key is read is through the closure handed to its
  // own implementation, so a key read implies that provider ran. Assert that no
  // module reads a key for a HARDCODED provider outside the registration seam
  // and Gemini's own transport.
  const allSource = walk("src");
  const hardcodedReads = [];
  for (const file of allSource) {
    code(file)
      .split("\n")
      .forEach((line, index) => {
        if (/loadApiKey\(\s*["'](gemini|anthropic)["']\s*\)/.test(line)) {
          hardcodedReads.push(`${file}:${index + 1}`);
        }
      });
  }
  // active-provider.ts is the registration seam: it builds the Anthropic client
  // with a closure that reads Anthropic's key, invoked only if that client runs.
  const unexpected = hardcodedReads.filter((loc) => !loc.includes(join("src", "lib", "ai", "active-provider.ts")));
  check(
    "no module reads a specific provider's key outside the registration seam",
    unexpected.length === 0,
    unexpected.join(", ") || `only ${hardcodedReads.length} (the seam)`,
  );

  // Gemini's transport reads its own key directly, which is legitimate — but it
  // must be the Gemini implementation, not orchestration shared with Anthropic.
  const geminiDirect = allSource.filter((file) => /loadGeminiApiKey\(/.test(code(file)));
  const allowed = [
    join("src", "lib", "ai", "gemini-client.ts"),
    join("src", "lib", "storage", "gemini-api-key.ts"),
  ];
  const unexpectedGemini = geminiDirect.filter((file) => !allowed.includes(file));
  check(
    "loadGeminiApiKey is confined to Gemini's own modules",
    unexpectedGemini.length === 0,
    unexpectedGemini.join(", "),
  );
}

console.log("\n=== E5: keys go to storage.local, never storage.sync ===");
{
  const storage = walk(join("src", "lib", "storage"));
  const synced = storage.filter((file) => /storage\.sync/.test(code(file)));
  check(
    "no key module touches chrome.storage.sync",
    synced.length === 0,
    synced.join(", ") || "sync would replicate credentials to every device on the account",
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
