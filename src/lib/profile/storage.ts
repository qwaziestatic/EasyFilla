import { PROFILE_PIPELINE_VERSION, type ProfileFact, type StructuredProfile } from "./types";
import { extractProfileFromDocuments } from "./extract";

// One profile persisted per browser, keyed to the current document set. Kept
// in chrome.storage.local (same device-only policy as the API key). Manual
// edits survive re-processing of the SAME document set — a corrected ID
// number is never silently re-derived wrongly.
const STORAGE_KEY = "easyfilla.profile";

// A cheap, synchronous content fingerprint (FNV-1a). Not cryptographic — its
// only job is to notice that the bytes behind a filename changed.
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// A stable key for a set of uploaded documents (order-independent). Keyed on
// name AND content: replacing "resume.pdf" with a different resume.pdf must
// invalidate the profile, which a name-only key silently failed to do.
export function documentSetKey(documents: { fileName: string; text: string }[]): string {
  return documents
    .map((d) => `${d.fileName.toLowerCase()}#${d.text.length}:${fingerprint(d.text)}`)
    .sort()
    .join("|");
}

export async function loadProfile(): Promise<StructuredProfile | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const value = result[STORAGE_KEY];
  return value && typeof value === "object" && Array.isArray((value as StructuredProfile).facts)
    ? (value as StructuredProfile)
    : null;
}

export async function saveProfile(profile: StructuredProfile): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...profile, updatedAt: Date.now() } });
}

export async function clearProfile(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// Returns the profile for the given documents: reuses the stored one (with
// the user's manual edits intact) when the document set is unchanged, else
// deterministically re-extracts and persists.
export async function buildOrReuseProfile(
  documents: { fileName: string; text: string }[],
): Promise<StructuredProfile> {
  const key = documentSetKey(documents);
  const stored = await loadProfile();

  if (stored && stored.documentSetKey === key) {
    if (stored.pipelineVersion === PROFILE_PIPELINE_VERSION) {
      console.log(`EasyFilla(profile): reusing stored profile for document set (${stored.facts.length} facts).`);
      return stored;
    }
    console.log(
      `EasyFilla(profile): stored profile was built by extractor v${stored.pipelineVersion ?? "0"}, ` +
        `current is v${PROFILE_PIPELINE_VERSION} — re-deriving from documents.`,
    );
  } else if (stored) {
    console.log("EasyFilla(profile): document set changed — re-deriving profile.");
  }

  const derived = extractProfileFromDocuments(documents);

  // A user's manual correction outranks every extraction rule and must survive
  // re-derivation, including across a pipeline upgrade (FIX D.2).
  const manual = (stored?.facts ?? []).filter((f) => f.source === "manual");
  const overridden = new Set(manual.map((f) => f.field));
  const facts = [...manual, ...derived.filter((f) => !overridden.has(f.field))];
  if (manual.length > 0) {
    console.log(
      `EasyFilla(profile): kept ${manual.length} manual correction(s):`,
      manual.map((f) => `${f.field}="${f.value}"`),
    );
  }

  const profile: StructuredProfile = {
    documentSetKey: key,
    pipelineVersion: PROFILE_PIPELINE_VERSION,
    facts,
    updatedAt: Date.now(),
  };
  await saveProfile(profile);
  console.log(
    `EasyFilla(profile): extracted ${facts.length} deterministic fact(s):`,
    facts.map((f) => `${f.field}=${f.value} [${f.confidence}, ${f.source}]`),
  );
  return profile;
}

// Applies an edited fact list (from the options editor) to the stored
// profile, marking touched facts source="manual" so they persist.
export async function updateProfileFacts(facts: ProfileFact[]): Promise<void> {
  const stored = await loadProfile();
  const profile: StructuredProfile = {
    documentSetKey: stored?.documentSetKey ?? "manual",
    facts,
    updatedAt: Date.now(),
  };
  await saveProfile(profile);
}
