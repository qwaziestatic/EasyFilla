// ─────────────────────────────────────────────────────────────────────────
// STAGE A — DOSSIER BUILD (ingest once, answer many)
//
// The old pipeline shipped raw document text + the form's questions together on
// every report. That had three compounding faults: it re-paid for the documents
// on every regeneration, it capped how many questions could fit in one request,
// and it could only ever see text a local extractor had already recovered —
// so scanned PDFs and photos contributed nothing.
//
// Here the model reads the ORIGINAL bytes multimodally and returns a compact
// structured dossier. Answering then runs against that dossier alone.
// There is deliberately NO local OCR on this path: the model reads images and
// scanned PDFs natively, and a local OCR pass would only inject its own errors.
// ─────────────────────────────────────────────────────────────────────────

export interface SourcedValue {
  value: string;
  source_filename: string;
  confidence: "high" | "medium" | "low";
}

export interface DossierEducation {
  institution?: SourcedValue;
  program?: SourcedValue;
  level?: SourcedValue;
  dates?: SourcedValue;
  status?: SourcedValue;
  id_number?: SourcedValue;
}

export interface DossierExperience {
  org?: SourcedValue;
  role?: SourcedValue;
  dates?: SourcedValue;
  description?: SourcedValue;
}

export interface DossierEvidence {
  claim: string;
  source_filename: string;
  page_or_region: string;
  verbatim_snippet: string;
}

export interface Dossier {
  identity: Record<string, SourcedValue>;
  contact: Record<string, SourcedValue>;
  education: DossierEducation[];
  experience: DossierExperience[];
  skills: Record<string, SourcedValue>;
  preferences: Record<string, SourcedValue>;
  documents: { filename: string; doc_type: string; summary: string }[];
  evidence: DossierEvidence[];
}

// Every scalar is {value, source_filename, confidence}, so an answer can always
// be traced back to the file it came from.
const SOURCED = {
  type: "object",
  properties: {
    value: { type: "string" },
    source_filename: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["value", "source_filename", "confidence"],
};

const NAMED_SOURCED = {
  type: "array",
  items: {
    type: "object",
    properties: {
      key: { type: "string", description: "snake_case field name, e.g. full_name, email, phone" },
      value: SOURCED.properties.value,
      source_filename: SOURCED.properties.source_filename,
      confidence: SOURCED.properties.confidence,
    },
    required: ["key", "value", "source_filename", "confidence"],
  },
};

// Free-form groups are modelled as key/value ARRAYS rather than open objects:
// proto3 JSON schemas can't express arbitrary additional properties, and a
// fixed property list would silently drop anything unanticipated.
export const DOSSIER_SCHEMA = {
  type: "object",
  properties: {
    identity: NAMED_SOURCED,
    contact: NAMED_SOURCED,
    skills: NAMED_SOURCED,
    preferences: NAMED_SOURCED,
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: SOURCED,
          program: SOURCED,
          level: SOURCED,
          dates: SOURCED,
          status: SOURCED,
          id_number: SOURCED,
        },
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: { org: SOURCED, role: SOURCED, dates: SOURCED, description: SOURCED },
      },
    },
    documents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filename: { type: "string" },
          doc_type: { type: "string" },
          summary: { type: "string" },
        },
        required: ["filename", "doc_type", "summary"],
      },
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          source_filename: { type: "string" },
          page_or_region: { type: "string" },
          verbatim_snippet: { type: "string" },
        },
        required: ["claim", "source_filename", "verbatim_snippet"],
      },
    },
  },
  required: ["identity", "contact", "education", "experience", "skills", "documents", "evidence"],
};

export const DOSSIER_SYSTEM_INSTRUCTION = [
  "You are extracting a factual dossier from a person's own documents so that forms can be filled on their behalf.",
  "",
  "RULES:",
  "1. Extract ONLY what the documents actually contain. Never infer a plausible value. An absent field is simply omitted.",
  // ⚠️ ILLUSTRATIVE VALUES IN THIS PROMPT MUST BE SYNTHETIC. Two reasons, and
  // the second is the one that matters most:
  //   1. This string is compiled into the shipped bundle and transmitted to the
  //      provider on EVERY Stage A request, by every user who installs this.
  //   2. Few-shot examples steer output. A concrete real name sitting beside
  //      "use them verbatim / confidence high" is a fabrication vector aimed at
  //      exactly the field that failed first in this project — "Full name"
  //      answered as a department and stamped answered_from_documents. §3's
  //      machinery exists to prevent that class; a named example reopens a path
  //      to it. Keep every example obviously fictional.
  "2. PREFER LABELLED KEY-VALUE DATA OVER PROSE. If a document is a reference sheet, table, or form with rows like",
  "   'Full Name | Jane Doe', 'Email | ...', 'University | ...', 'Department / Major | ...',",
  "   those rows are the single most reliable source in the entire set. Use them verbatim and mark them confidence 'high'.",
  "   A value read from such a row ALWAYS beats the same field inferred from prose, a letterhead, or a header.",
  "3. Never mistake an institution, department, faculty, or document title for a person's name. A letterhead like",
  "   'School of Engineering and Applied Science' is the issuing body, not the applicant.",
  "4. For scanned or photographed documents, read the image directly. If a passport machine-readable zone (the two",
  "   long <<< lines) is visible, decode it — it is more reliable than the printed fields above it.",
  "5. source_filename must be the exact filename given for the document the value came from.",
  "6. confidence: 'high' = stated explicitly in a label/value pair or machine-readable zone; 'medium' = stated in prose;",
  "   'low' = inferred from layout or context. Prefer omitting a field to guessing it.",
  "7. evidence[] must quote the VERBATIM snippet supporting each important claim, so a human can check it.",
  "8. Use snake_case keys: full_name, preferred_name, date_of_birth, nationality, gender, passport_number,",
  "   national_id, email, phone, address, city, country, linkedin, github, website.",
].join("\n");

// ── FILE SET IDENTITY ─────────────────────────────────────────────────────
// The dossier is cached against the exact set of bytes it was built from, so
// adding or replacing a file rebuilds and an unchanged set never re-spends a
// request. Uses content hashes, not filenames: replacing "cv.pdf" with a
// different "cv.pdf" must invalidate.
export async function fileSetKey(files: File[]): Promise<string> {
  const hashes = await Promise.all(
    files.map(async (file) => {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const hex = Array.from(new Uint8Array(digest))
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return `${file.name.toLowerCase()}:${file.size}:${hex}`;
    }),
  );
  return hashes.sort().join("|");
}

export interface CachedDossier {
  key: string;
  dossier: Dossier;
  fileCount: number;
  factCount: number;
  builtAt: number;
  model: string;
  // TASK E3.5 — which provider produced this dossier. Optional so a dossier
  // cached before providers existed still loads; a missing value is treated as
  // "unknown provider" and forces a rebuild rather than being assumed to match.
  provider?: string;
}

/**
 * TASK E3.5 — the cache key includes PROVIDER and MODEL.
 *
 * A dossier is the model's structured reading of the user's documents. Two
 * providers will not extract identically, and reusing one provider's dossier
 * under another would attribute Anthropic's readings to Gemini in the report's
 * provenance — silently. §3 requires provenance to be derived, not assumed, and
 * that includes which model did the deriving.
 *
 * Content hash stays the primary component so replacing a file still
 * invalidates (§2).
 */
export function dossierCacheKey(fileSetHash: string, provider: string, model: string): string {
  return `${provider}::${model}::${fileSetHash}`;
}

/**
 * Would retargeting a cached dossier at this provider/model alone invalidate it?
 *
 * This is the SETTINGS-PAGE question, and it is deliberately not
 * `dossierReuseVerdict`. That function needs the file-set hash to decide, and
 * the settings page has no access to the uploaded files — passing a placeholder
 * hash there makes the key mismatch and falls through to "the uploaded file set
 * has changed", which is a statement of fact the settings page cannot support
 * and which would be shown to a user who changed nothing.
 *
 * So this answers only what the provider/model choice determines, and stays
 * silent about the file set.
 */
export function dossierRetargetVerdict(
  cached: CachedDossier | null,
  provider: string,
  model: string,
): { rebuild: false } | { rebuild: true; reason: string } {
  if (!cached) {
    return { rebuild: false };
  }
  if (!cached.provider) {
    return {
      rebuild: true,
      reason: "the cached dossier predates per-provider caching, so which provider built it is unknown",
    };
  }
  if (cached.provider !== provider) {
    return {
      rebuild: true,
      reason:
        `it was built by ${cached.provider} and the active provider is now ${provider}. ` +
        "Extraction differs between providers, so reusing it would attribute one provider's reading to the other.",
    };
  }
  if (cached.model !== model) {
    return { rebuild: true, reason: `it was built with ${cached.model} and the model is now ${model}` };
  }
  return { rebuild: false };
}

/**
 * Is a cached dossier reusable for this provider/model?
 *
 * Returns a REASON when it is not, so the caller can tell the user what will be
 * rebuilt and why — a silent rebuild spends a request the user did not expect,
 * and a silent reuse mislabels provenance.
 */
export function dossierReuseVerdict(
  cached: CachedDossier | null,
  fileSetHash: string,
  provider: string,
  model: string,
): { reuse: true } | { reuse: false; reason: string } {
  if (!cached) {
    return { reuse: false, reason: "no dossier has been built yet" };
  }
  const wanted = dossierCacheKey(fileSetHash, provider, model);
  if (cached.key === wanted) {
    return { reuse: true };
  }
  if (cached.provider && cached.provider !== provider) {
    return {
      reuse: false,
      reason:
        `the cached dossier was built by ${cached.provider} and the active provider is now ${provider}. ` +
        "Extraction differs between providers, so reusing it would attribute one provider's reading to the other.",
    };
  }
  if (!cached.provider) {
    return {
      reuse: false,
      reason: "the cached dossier predates per-provider caching, so which provider built it is unknown",
    };
  }
  if (cached.model !== model) {
    return { reuse: false, reason: `the cached dossier was built with ${cached.model} and the model is now ${model}` };
  }
  return { reuse: false, reason: "the uploaded file set has changed" };
}

const DOSSIER_KEY = "easyfilla.dossier";
import { touchSensitiveData } from "../storage/sensitive-data";

export async function loadCachedDossier(): Promise<CachedDossier | null> {
  const result = await chrome.storage.local.get(DOSSIER_KEY);
  const value = result[DOSSIER_KEY] as CachedDossier | undefined;
  const dossier = value && typeof value.key === "string" && value.dossier ? value : null;
  if (dossier) {
    await touchSensitiveData();
  }
  return dossier;
}

export async function saveDossier(entry: CachedDossier): Promise<void> {
  await chrome.storage.local.set({ [DOSSIER_KEY]: entry });
  await touchSensitiveData();
}

export async function clearDossier(): Promise<void> {
  await chrome.storage.local.remove(DOSSIER_KEY);
  await touchSensitiveData();
}

// Counts the scalar facts, for the "Dossier: N files, M facts extracted" line.
export function countFacts(dossier: Dossier): number {
  const groups = [dossier.identity, dossier.contact, dossier.skills, dossier.preferences];
  const scalar = groups.reduce((sum, group) => sum + Object.keys(group ?? {}).length, 0);
  const nested = [...(dossier.education ?? []), ...(dossier.experience ?? [])].reduce(
    (sum, entry) => sum + Object.keys(entry).length,
    0,
  );
  return scalar + nested;
}

// The dossier is small, so it is passed to Stage B as compact JSON rather than
// re-serialized prose — the model relates fields to questions better when the
// structure and the per-field confidence survive.
export function dossierToPromptJson(dossier: Dossier): string {
  return JSON.stringify(dossier, null, 1);
}
