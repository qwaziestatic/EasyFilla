import { RULE_RANK, type ExtractionRule, type ProfileFact, type ProfileFieldKind } from "./types";

// Deterministic, LLM-free extraction. Runs BEFORE any model call.
//
// PRECEDENCE (FIX 1.1), highest first — a lower rule never overrides a higher:
//   labelled   — an explicit "Label: value" / two-column table row
//   typed      — an unambiguous typed pattern (email, phone, passport MRZ)
//   contextual — a sentence that names the field ("certify that <Name>, ID No:")
//   positional — a header-block guess (last resort, low confidence)
//
// This ordering is what fixes the "Full name = Computer Engineering" failure:
// the Reference Sheet's "Full Name | …" row is a `labelled` match and always
// beats a `positional` guess scraped off a letterhead.

let factCounter = 0;
function nextId(): string {
  factCounter += 1;
  return `fact-${Date.now()}-${factCounter}`;
}

export interface Candidate {
  field: ProfileFieldKind;
  label: string;
  value: string;
  source: string;
  rule: ExtractionRule;
}

// ── Vocabulary that can NEVER be a person's name (FIX 1.2) ────────────────
// "engineering"/"computer"/"technology" were the specific omissions that let
// a wrapped letterhead line ("Computer Engineering") become the name.
const ORG_VOCAB_RE =
  /\b(universit|college|institute|polytechnic|academy|school|faculty|department|dept|engineering|technology|science|sciences|studies|program|programme|ministry|office|registrar|bureau|agency|authority|company|ltd|inc|plc|corporation|foundation|centre|center|hospital|clinic|bank|environment|built|federal|republic|democratic|immigration|nationality affairs)\b/i;

const DOC_VOCAB_RE =
  /\b(letter|certificate|statement|transcript|curriculum|vitae|resume|purpose|application|form|report|reference|sheet|subject|status|concern|regards|sincerely|dear|passport|observation|page)\b/i;

// MORPHOLOGY ONLY — "could this string be a person's name at all?" It must
// NOT reject on organizational vocabulary: that's now a demotion signal
// inside scoreNameCandidate, not a gate. A blocklist is unbounded (we only
// learned "engineering" by being burned by it), so the decision is made by
// POSITIVE evidence instead (FIX B.1).
function hasPersonNameShape(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 60 || /[@\d]/.test(v)) {
    return false;
  }
  const words = v.split(/\s+/);
  if (words.length < 2 || words.length > 4) {
    return false;
  }
  return words.every((w) => /^[A-ZÀ-Þ][a-zà-ÿ'’.-]*$/.test(w) || /^[A-ZÀ-Þ]+$/.test(w));
}

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// Score thresholds. Calibrated so that: an email-handle match alone (+50) or a
// labelled table row (+50) clears "confident"; an org fragment (-70) never can,
// even if it appears in a labelled row.
const NAME_SCORE_CONFIDENT = 50;
const NAME_SCORE_PLAUSIBLE = 25;

export interface NameSignals {
  emails: string[];
  urls: string[];
  mrzName: string | null;
}

// FIX B.1 — score on POSITIVE evidence. The two strongest signals are
// language-independent and don't rely on any vocabulary list:
//   • agreement with the passport MRZ (effectively ground truth)
//   • agreement with the email local-part / LinkedIn slug — a person's own
//     handle almost always contains their name, an institution's does not.
export function scoreNameCandidate(
  candidate: Candidate,
  signals: NameSignals,
  corroboration: number,
): { score: number; why: string[] } {
  const why: string[] = [];
  const tokens = nameTokens(candidate.value);
  if (tokens.length === 0) {
    return { score: -100, why: ["no usable tokens"] };
  }

  let score = { labelled: 50, typed: 45, contextual: 25, positional: 5 }[candidate.rule];
  why.push(`${candidate.rule}(+${score})`);

  if (signals.mrzName) {
    const mrz = new Set(nameTokens(signals.mrzName));
    const overlap = tokens.filter((t) => mrz.has(t)).length;
    if (overlap >= 2) {
      score += 60;
      why.push("matches passport MRZ(+60)");
    } else if (overlap === 1) {
      score += 25;
      why.push("partial MRZ match(+25)");
    }
  }

  // Email local-part + profile URL slugs, letters only.
  const identity = [...signals.emails.map((e) => e.split("@")[0] ?? ""), ...signals.urls]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (identity) {
    const matched = tokens.filter((t) => identity.includes(t)).length;
    if (matched >= 2) {
      score += 50;
      why.push("matches email/profile handle(+50)");
    } else if (matched === 1) {
      score += 20;
      why.push("partial handle match(+20)");
    }
  }

  if (corroboration > 1) {
    const bonus = Math.min(corroboration - 1, 3) * 12;
    score += bonus;
    why.push(`seen in ${corroboration} documents(+${bonus})`);
  }

  // Demotion, never a hard gate (FIX B.2).
  if (ORG_VOCAB_RE.test(candidate.value)) {
    score -= 70;
    why.push("organizational vocabulary(-70)");
  }
  if (DOC_VOCAB_RE.test(candidate.value)) {
    score -= 40;
    why.push("document-boilerplate vocabulary(-40)");
  }

  return { score, why };
}

// ── (a) LABELLED KEY-VALUE PAIRS — highest precedence ─────────────────────
// Handles "Label: value", "Label<2+ spaces>value" (two-column table rows as
// pdf.js flattens them), and a label line immediately followed by its value.
const LABEL_MAP: { re: RegExp; field: ProfileFieldKind; label: string }[] = [
  { re: /^(full\s*name|name in full)$/i, field: "name", label: "Full name" },
  { re: /^(preferred\s*name|nickname)$/i, field: "preferred_name", label: "Preferred name" },
  { re: /^(e-?mail|email address)$/i, field: "email", label: "Email" },
  { re: /^(phone|mobile|telephone|phone number|contact number)$/i, field: "phone", label: "Phone" },
  { re: /^(linkedin|github|portfolio|website|profile url)$/i, field: "url", label: "Link" },
  { re: /^(current location|location|address|city)$/i, field: "address", label: "Location" },
  { re: /^(universit(y|ies)|school|institution)$/i, field: "education", label: "University" },
  { re: /^(department\s*\/?\s*major|department|major|field of study)$/i, field: "department", label: "Department" },
  { re: /^(class\s*\/?\s*year standing|year standing|academic year|class)$/i, field: "year_standing", label: "Year standing" },
  { re: /^(expected graduation|graduation)$/i, field: "graduation", label: "Expected graduation" },
  { re: /^(degree level|degree)$/i, field: "degree", label: "Degree" },
  { re: /^(technical skills|skills|technologies)$/i, field: "skills", label: "Skills" },
  { re: /^(languages?)$/i, field: "language", label: "Languages" },
  { re: /^(nationality|citizenship)$/i, field: "nationality", label: "Nationality" },
  { re: /^(date of birth|dob|birth date)$/i, field: "dob", label: "Date of birth" },
  { re: /^(sex|gender)$/i, field: "gender", label: "Gender" },
  { re: /^(place of birth)$/i, field: "place_of_birth", label: "Place of birth" },
  { re: /^(passport(\s*(no|number))?)$/i, field: "passport", label: "Passport number" },
  { re: /^(student\s*id|employee\s*id|id\s*(no|number)|national id)$/i, field: "id", label: "ID number" },
  { re: /^(career goal|objective|career objective)$/i, field: "other", label: "Career objective" },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Normalizes a visually-printed date to ISO so it can corroborate the MRZ,
// which is the same date in a different notation. Without this, "18 AUG 04"
// and "2004-08-18" look like two competing values instead of one confirmed one.
function normalizeDate(raw: string): string | null {
  const text = raw.trim();
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }

  const expandYear = (y: string): string => {
    if (y.length === 4) {
      return y;
    }
    const n = Number(y);
    // A 2-digit birth year in the future must belong to the previous century.
    return n > Number(String(new Date().getFullYear()).slice(2)) ? `19${y}` : `20${y}`;
  };

  // "18 AUG 04" / "18 August 2004" / "Aug 18, 2004"
  const named = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})\b/) ??
    text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})\b/);
  if (named) {
    const dayFirst = /^\d/.test(named[1] ?? "");
    const day = dayFirst ? named[1] : named[2];
    const monthName = (dayFirst ? named[2] : named[1])?.slice(0, 3).toLowerCase() ?? "";
    const month = MONTHS.indexOf(monthName) + 1;
    if (month > 0 && day) {
      return `${expandYear(named[3] ?? "")}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }

  // "18/08/2004" — day-first, the dominant convention outside the US. Left
  // unnormalized when ambiguous would be safer, but the MRZ overrides anyway.
  const numeric = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    return `${expandYear(numeric[3])}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
  }
  return null;
}

function fieldForLabel(rawLabel: string): { field: ProfileFieldKind; label: string } | null {
  const cleaned = rawLabel.replace(/[:\-–—]+$/, "").trim();
  for (const entry of LABEL_MAP) {
    if (entry.re.test(cleaned)) {
      return { field: entry.field, label: entry.label };
    }
  }
  return null;
}

// Splits "Full Name   Jane Quinn Doe" into label + value by testing
// progressively longer word prefixes against LABEL_MAP and keeping the LONGEST
// match ("Class / Year Standing" must beat "Class").
//
// FIX A.2 — a regex on `:` or 2+ spaces missed the most common real shape:
// pdf.js routinely flattens a two-column table row to a SINGLE space, so
// "Full Name Jane Quinn Doe" arrived unparsed and the whole labelled
// tier silently fell through to the positional guess.
const MAX_LABEL_WORDS = 6;

interface LabelledPair {
  field: ProfileFieldKind;
  label: string;
  value: string;
  // Trailing columns of a multi-pair row ("… Place of Birth LAKESIDE"), left
  // for the caller to parse as pairs in their own right.
  rest: string;
}

function splitLabelValue(line: string): LabelledPair | null {
  // Dot/underscore leaders ("Full Name ....... Jane") and column pipes.
  const cleaned = line.replace(/[.…_]{3,}/g, " ").replace(/\s*\|\s*/g, "  ");
  const words = cleaned.split(/\s+/).filter(Boolean);
  let best: { field: ProfileFieldKind; label: string; value: string; separated: boolean } | null = null;

  for (let take = 1; take <= Math.min(MAX_LABEL_WORDS, words.length - 1); take += 1) {
    const head = words.slice(0, take).join(" ");
    const mapped = fieldForLabel(head.replace(/[:|]+$/, ""));
    if (!mapped) {
      continue;
    }
    // Was there a real separator between label and value in the ORIGINAL line?
    const consumed = cleaned.indexOf(head) + head.length;
    const gap = cleaned.slice(consumed).match(/^\s*[:|]\s*|^\s{2,}/);
    const value = cleaned.slice(consumed).replace(/^\s*[:|]\s*/, "").trim();
    if (value && value.length <= 300) {
      best = { ...mapped, value, separated: Boolean(gap) };
    }
  }

  if (!best) {
    return null;
  }

  // A table row often carries TWO pairs: "Date of Birth 01 JAN 00   Place of
  // Birth LAKESIDE". Cut the value at the next column that begins with a known
  // label, or the second pair gets swallowed into the first value. Only 2+
  // space gaps count as a column boundary — scanning word-by-word would
  // truncate legitimate values ("Riverton University — …" at "University").
  let rest = "";
  const columns = best.value.split(/\s{2,}/);
  if (columns.length > 1) {
    const cut = columns.findIndex((col, i) => i > 0 && Boolean(splitLabelValue(col) ?? fieldForLabel(col)));
    if (cut > 0) {
      best.value = columns.slice(0, cut).join(" ").trim();
      rest = columns.slice(cut).join("  ").trim();
    }
  }
  // A colon or a column gap is proof of a table row. A single space is not, so
  // require the line to look tabular rather than prose: short, and a value that
  // doesn't continue a sentence ("Languages spoken include…" must not parse).
  if (!best.separated) {
    const words = best.value.split(/\s+/);
    if (words.length > 12 || /^[a-z]/.test(best.value)) {
      return null;
    }
  }
  const { field, label, value } = best;
  return { field, label, value, rest };
}

// Only open-ended descriptive values may absorb a wrapped continuation line.
// Bounded fields — above all `name`, the one that has burned us — never do, so
// a stray line after "Full Name  X" can't corrupt the name.
const JOINABLE_FIELDS: ReadonlySet<ProfileFieldKind> = new Set([
  "department",
  "education",
  "skills",
  "address",
  "degree",
  "language",
  "other",
]);

// True when `line` reads as the continuation of a wrapped table value rather
// than a new row. Covers "Electrical and Computer" / "Engineering (Comm…)",
// which a narrow PDF column splits mid-phrase on an uppercase word.
function isWrapContinuation(line: string | undefined): boolean {
  if (!line || line.length > 120) {
    return false;
  }
  if (splitLabelValue(line) ?? fieldForLabel(line)) {
    return false;
  }
  // An ALL-CAPS line is a section heading ("EXPERIENCE"), not a wrap.
  return !/^[A-Z\s]{4,}$/.test(line);
}

function parseLabelledPairs(text: string, source: string): Candidate[] {
  const out: Candidate[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  lines.forEach((line, index) => {
    if (!line) {
      return;
    }

    // A row may carry several pairs; walk across its columns.
    let pair = splitLabelValue(line);
    if (pair) {
      let first = true;
      while (pair) {
        let value = pair.value;
        // Re-join a value the PDF wrapped onto the following line. Only the
        // last pair on a row can be the one that wrapped.
        if (first && !pair.rest && JOINABLE_FIELDS.has(pair.field) && isWrapContinuation(lines[index + 1])) {
          value = `${value} ${lines[index + 1]}`.trim();
        }
        if (pair.field === "dob") {
          value = normalizeDate(value) ?? value;
        }
        out.push({ field: pair.field, label: pair.label, value, source, rule: "labelled" });
        first = false;
        pair = pair.rest ? splitLabelValue(pair.rest) : null;
      }
      return;
    }

    // Label alone on its line, value on the next.
    const mapped = fieldForLabel(line);
    const next = lines[index + 1]?.trim();
    if (mapped && next && !fieldForLabel(next) && !splitLabelValue(next) && next.length <= 300) {
      out.push({ ...mapped, value: next, source, rule: "labelled" });
    }
  });

  return out;
}

// ── (b) STRONGLY-TYPED PATTERNS ───────────────────────────────────────────
function contactNormalize(text: string): string {
  return text.replace(/\s*([@.])\s*/g, "$1");
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.|linkedin\.com\/in\/|github\.com\/)[^\s)<>"']+/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

// Passport MRZ (FIX 2.3) — a fixed-format, checksum-backed encoding that is
// far more reliable than OCR'ing the visual fields.
//   L1: P<ISO3SURNAME<<GIVEN<NAMES<<<
//   L2: DOCNUM<C>ISO3>YYMMDD<C>SEX>YYMMDD<C>...
function parseMrz(text: string, source: string): Candidate[] {
  const out: Candidate[] = [];
  const compact = text.replace(/\s+/g, "");
  const l1 = compact.match(/P.?([A-Z]{3})([A-Z]+)<<([A-Z<]+?)<<</);
  const l2 = compact.match(/([A-Z0-9<]{9})\d([A-Z]{3})(\d{6})\d([MFX<])(\d{6})/);

  if (l1?.[2] && l1[3]) {
    const surname = titleCase(l1[2]);
    const given = titleCase(l1[3].replace(/</g, " ").trim());
    if (surname && given) {
      out.push({ field: "name", label: "Full name", value: `${given} ${surname}`, source, rule: "typed" });
      out.push({ field: "last_name" as ProfileFieldKind, label: "Surname", value: surname, source, rule: "typed" });
    }
  }
  if (l2) {
    const [, docNum, nat, dobRaw, sex] = l2;
    if (docNum) {
      out.push({ field: "passport", label: "Passport number", value: docNum.replace(/</g, ""), source, rule: "typed" });
    }
    if (nat) {
      out.push({ field: "nationality", label: "Nationality", value: nat, source, rule: "typed" });
    }
    if (dobRaw) {
      const yy = Number(dobRaw.slice(0, 2));
      const year = yy > 40 ? 1900 + yy : 2000 + yy;
      out.push({
        field: "dob",
        label: "Date of birth",
        value: `${year}-${dobRaw.slice(2, 4)}-${dobRaw.slice(4, 6)}`,
        source,
        rule: "typed",
      });
    }
    if (sex && sex !== "<") {
      out.push({ field: "gender", label: "Gender", value: sex === "M" ? "Male" : "Female", source, rule: "typed" });
    }
  }
  return out;
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }
  return trimmed.replace(/\s{2,}/g, " ");
}

function parseTyped(text: string, source: string): Candidate[] {
  const out: Candidate[] = [];
  const normalized = contactNormalize(text);

  for (const email of new Set(normalized.match(EMAIL_RE) ?? [])) {
    out.push({ field: "email", label: "Email", value: email, source, rule: "typed" });
  }
  for (const url of new Set(normalized.match(URL_RE) ?? [])) {
    if (!url.includes("@")) {
      out.push({ field: "url", label: "Link", value: url, source, rule: "typed" });
    }
  }
  for (const raw of new Set(text.match(PHONE_RE) ?? [])) {
    const phone = normalizePhone(raw);
    if (phone) {
      out.push({ field: "phone", label: "Phone", value: phone, source, rule: "typed" });
    }
  }
  return out;
}

// ── (c) CONTEXTUAL SENTENCES ──────────────────────────────────────────────
function parseContextual(text: string, source: string): Candidate[] {
  const out: Candidate[] = [];

  // "…certify that <Name>, ID No: <ID> is an active 4th Year…"
  const certify = text.match(
    /certify\s+that\s+([A-ZÀ-Þ][\p{L}'’.-]*(?:\s+[A-ZÀ-Þ][\p{L}'’.-]*){1,3})\s*,?\s*(?:ID\s*No\.?\s*[:.]?\s*([A-Z0-9/\-]+))?/iu,
  );
  if (certify?.[1] && hasPersonNameShape(certify[1])) {
    out.push({ field: "name", label: "Full name", value: certify[1].trim(), source, rule: "contextual" });
  }
  if (certify?.[2]) {
    out.push({ field: "id", label: "ID number", value: certify[2].trim(), source, rule: "contextual" });
  }

  // A standalone "ID No: X" anywhere.
  const idMatch = text.match(/\bID\s*No\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9/\-]{3,})/i);
  if (idMatch?.[1]) {
    out.push({ field: "id", label: "ID number", value: idMatch[1].trim(), source, rule: "contextual" });
  }

  // Year standing: "4th Year", "Fourth Year".
  const yearStanding = text.match(/\b((?:\d(?:st|nd|rd|th)|first|second|third|fourth|fifth)\s+year)\b/i);
  if (yearStanding?.[1]) {
    out.push({ field: "year_standing", label: "Year standing", value: titleCase(yearStanding[1]), source, rule: "contextual" });
  }

  // University / school named in prose.
  const uni = text.match(/\b([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,4}\s+(?:University|Institute of Technology))\b/);
  if (uni?.[1]) {
    out.push({ field: "education", label: "University", value: uni[1].trim(), source, rule: "contextual" });
  }

  return out;
}

// ── (d) POSITIONAL HEADER — last resort, low confidence ───────────────────
function parsePositional(text: string, source: string): Candidate[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);
  // Emit EVERY shape-plausible header line, not just the first. On a prose-only
  // CV the real name and an institution fragment often both appear in the first
  // few lines; picking the topmost one is what produced "Computer Engineering".
  // Scoring decides between them later (FIX B.1).
  return lines
    .filter(hasPersonNameShape)
    .map((line) => ({ field: "name" as const, label: "Full name", value: line, source, rule: "positional" as const }));
}

// MRZ lines are long uppercase/digit/filler runs. They're parsed structurally
// by parseMrz, but left in the raw text they poison other extractors — their
// digit groups were being harvested as phone numbers, and the visual passport
// header line was being read as a "Passport number" label-value pair.
const MRZ_LINE_RE = /^[A-Z0-9<]{20,}$/;

function stripMrzLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !MRZ_LINE_RE.test(line.replace(/\s+/g, "")))
    .join("\n");
}

export function extractCandidates(text: string, source: string): Candidate[] {
  if (!text.trim()) {
    return [];
  }
  // MRZ gets the full text (it needs those lines); everything else gets a
  // copy with them removed.
  const clean = stripMrzLines(text);
  return [
    ...parseLabelledPairs(clean, source),
    ...parseTyped(clean, source),
    ...parseMrz(text, source),
    ...parseContextual(clean, source),
    ...parsePositional(clean, source),
  ];
}

// ── RECONCILIATION ACROSS DOCUMENTS (FIX 1.3) ─────────────────────────────
// Precedence first, then how many separate documents corroborate the value.
function confidenceFor(rule: ExtractionRule, corroboration: number): ProfileFact["confidence"] {
  if (rule === "labelled" || rule === "typed") {
    return "high";
  }
  if (rule === "contextual") {
    return corroboration > 1 ? "high" : "medium";
  }
  return corroboration > 1 ? "medium" : "low";
}

export function extractProfileFromDocuments(documents: { fileName: string; text: string }[]): ProfileFact[] {
  const all: Candidate[] = [];
  documents.forEach((doc) => {
    const found = extractCandidates(doc.text, doc.fileName);
    console.log(
      `EasyFilla(profile): ${doc.fileName} — ${doc.text.length} chars, ${found.length} candidate(s):`,
      found.map((c) => `${c.field}="${c.value}" [${c.rule}]`),
    );
    all.push(...found);
  });

  // Group identical values per field to count cross-document corroboration.
  const groups = new Map<string, { candidate: Candidate; sources: Set<string> }>();
  for (const candidate of all) {
    if (!candidate.value.trim()) {
      continue;
    }
    const key = `${candidate.field}:${candidate.value.trim().toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.sources.add(candidate.source);
      if (RULE_RANK[candidate.rule] > RULE_RANK[existing.candidate.rule]) {
        existing.candidate = candidate;
      }
    } else {
      groups.set(key, { candidate, sources: new Set([candidate.source]) });
    }
  }

  // Signals for name scoring, gathered across ALL documents before any name is
  // chosen — the passport's MRZ and the CV's email can vindicate a name that
  // appears in a third file with no local evidence at all.
  const nameSignals: NameSignals = {
    emails: all.filter((c) => c.field === "email").map((c) => c.value),
    urls: all.filter((c) => c.field === "url").map((c) => c.value),
    mrzName: all.find((c) => c.field === "name" && c.rule === "typed")?.value ?? null,
  };

  // Per field, keep the winner by (precedence, corroboration). Multi-value
  // fields (email/url/phone/skills) keep every distinct value.
  const MULTI: ReadonlySet<ProfileFieldKind> = new Set(["email", "url", "phone", "skills", "language"]);
  const bestPerField = new Map<ProfileFieldKind, { candidate: Candidate; corroboration: number }>();
  const facts: ProfileFact[] = [];
  let bestName: { candidate: Candidate; corroboration: number; score: number; why: string[] } | null = null;

  for (const { candidate, sources } of groups.values()) {
    const corroboration = sources.size;

    // FIX B — names are decided by positive evidence, not precedence rank. A
    // labelled "Name: Computer Engineering" must lose to a positional header
    // that matches the passport MRZ and the email handle.
    if (candidate.field === "name") {
      const { score, why } = scoreNameCandidate(candidate, nameSignals, corroboration);
      console.log(
        `EasyFilla(profile): name candidate "${candidate.value}" [${candidate.rule}, ${candidate.source}] score=${score} — ${why.join(", ")}`,
      );
      if (!bestName || score > bestName.score) {
        bestName = { candidate, corroboration, score, why };
      }
      continue;
    }

    if (MULTI.has(candidate.field)) {
      facts.push({
        id: nextId(),
        field: candidate.field,
        label: candidate.label,
        value: candidate.value.trim(),
        source: candidate.source,
        confidence: confidenceFor(candidate.rule, corroboration),
        rule: candidate.rule,
        corroboration,
      });
      continue;
    }
    const current = bestPerField.get(candidate.field);
    const better =
      !current ||
      RULE_RANK[candidate.rule] > RULE_RANK[current.candidate.rule] ||
      (RULE_RANK[candidate.rule] === RULE_RANK[current.candidate.rule] && corroboration > current.corroboration);
    if (better) {
      bestPerField.set(candidate.field, { candidate, corroboration });
    }
  }

  // A name only counts as document-sourced when positive evidence backs it.
  // Below the threshold it is still surfaced — but as "low", which downstream
  // renders as needing user confirmation rather than as an answer (FIX B.3).
  if (bestName) {
    const confidence: ProfileFact["confidence"] =
      bestName.score >= NAME_SCORE_CONFIDENT ? "high" : bestName.score >= NAME_SCORE_PLAUSIBLE ? "medium" : "low";
    console.log(
      `EasyFilla(profile): name winner "${bestName.candidate.value}" score=${bestName.score} → ${confidence}`,
    );
    facts.push({
      id: nextId(),
      field: "name",
      label: "Full name",
      value: bestName.candidate.value.trim(),
      source: bestName.candidate.source,
      confidence,
      rule: bestName.candidate.rule,
      corroboration: bestName.corroboration,
    });
  }

  for (const { candidate, corroboration } of bestPerField.values()) {
    facts.push({
      id: nextId(),
      field: candidate.field,
      label: candidate.label,
      value: candidate.value.trim(),
      source: candidate.source,
      confidence: confidenceFor(candidate.rule, corroboration),
      rule: candidate.rule,
      corroboration,
    });
  }

  console.log(
    "EasyFilla(profile): reconciled —",
    facts.map((f) => `${f.field}="${f.value}" [${f.rule}, ${f.confidence}, ${f.corroboration}x, ${f.source}]`),
  );
  return facts;
}

// Kept for callers that extract from a single document.
export function extractProfileFacts(rawText: string, source: string): ProfileFact[] {
  return extractProfileFromDocuments([{ fileName: source, text: rawText }]);
}
