import type { ExtractionRule, ProfileFact, ProfileFieldKind, StructuredProfile } from "./types";
import { textSimilarity } from "../text/fuzzy-match";

// A "semantic key" is what a question label is asking for. It's broader than
// ProfileFieldKind: it includes SUB-COMPONENTS (first/last name, DOB
// day/month/year, dial code) that are DERIVED from a stored base fact rather
// than stored separately. This lets a "Surname" or "Year of Birth" dropdown
// resolve at Tier 0 with zero API calls.
export type SemanticKey =
  | ProfileFieldKind
  | "first_name"
  | "middle_name"
  | "last_name"
  | "dial_code"
  | "dob_day"
  | "dob_month"
  | "dob_year"
  | "city"
  | "state"
  | "postal_code"
  | "country"
  | "gender"
  | "years_experience";

// Longest matching keyword wins, so "family name" beats "name" and
// "year of birth" beats "birth". Diacritic-insensitive.
const KEYWORDS: Record<SemanticKey, string[]> = {
  first_name: ["first name", "given name", "forename", "prenom", "nombre de pila", "primer nombre", "vorname", "nome proprio", "الاسم الاول", "ስም"],
  middle_name: ["middle name", "second name", "segundo nombre", "deuxieme prenom"],
  last_name: ["last name", "family name", "surname", "cognome", "apellido", "apellidos", "nom de famille", "nachname", "اسم العائلة", "የአባት ስም", "姓"],
  name: ["full name", "your name", "name in full", "first and last", "nome completo", "nombre completo", "nom complet", "vollstandiger name", "الاسم الكامل", "全名", "姓名", "name"],
  email: ["email", "e-mail", "e mail", "correo electronico", "correo", "courriel", "posta elettronica", "e-post", "بريد", "ايميل", "ኢሜይል", "邮箱", "电子邮件", "mail"],
  dial_code: ["country code", "dial code", "dialing code", "phone code", "area code", "prefisso", "prefijo", "indicatif", "vorwahl", "رمز الدولة", "区号"],
  phone: ["mobile number", "phone number", "telephone", "phone", "mobile", "cellphone", "cell", "contact number", "telefono", "movil", "portable", "handy", "telefon", "هاتف", "جوال", "ስልክ", "电话", "手机"],
  dob_year: ["year of birth", "birth year", "dob year", "anno di nascita", "ano de nacimiento", "annee de naissance", "geburtsjahr", "出生年"],
  dob_month: ["month of birth", "birth month", "dob month", "mese di nascita", "mes de nacimiento", "mois de naissance", "geburtsmonat", "出生月"],
  dob_day: ["day of birth", "birth day", "dob day", "giorno di nascita", "dia de nacimiento", "jour de naissance", "geburtstag", "出生日"],
  dob: ["date of birth", "birth date", "dob", "born", "data di nascita", "fecha de nacimiento", "date de naissance", "geburtsdatum", "تاريخ الميلاد", "የልደት ቀን", "出生日期"],
  city: ["city", "town", "city of residence", "citta", "ciudad", "ville", "stadt", "المدينة", "ከተማ", "城市"],
  state: ["state", "province", "region", "state/province", "provincia", "regione", "estado", "provincia o estado", "region", "bundesland", "المحافظة", "省"],
  postal_code: ["postal code", "post code", "postcode", "zip", "zip code", "cap", "codigo postal", "code postal", "postleitzahl", "الرمز البريدي", "邮编"],
  country: ["country", "country of residence", "nation", "paese", "pais", "pays", "land", "البلد", "ሀገር", "国家"],
  address: ["address", "postal address", "residential address", "home address", "street address", "indirizzo", "direccion", "adresse", "anschrift", "عنوان", "አድራሻ", "地址"],
  nationality: ["nationality", "citizenship", "nazionalita", "nacionalidad", "nationalite", "staatsangehorigkeit", "الجنسية", "ዜግነት", "国籍"],
  gender: ["gender", "sex", "genere", "sesso", "genero", "sexo", "genre", "geschlecht", "الجنس", "ጾታ", "性别"],
  id: ["passport number", "passport", "national id", "student id", "employee id", "id number", "identification number", "identification", "matricola", "numero de identificacion", "ausweis", "رقم الهوية", "መታወቂያ", "证件号"],
  url: ["linkedin", "github", "portfolio", "personal website", "website", "profile url", "sito web", "sitio web", "site web", "webseite", "رابط", "ድረ ገፅ", "网址"],
  education: ["institution attended", "name of institution", "university", "college", "school attended", "alma mater", "which institution", "institution", "universita", "universidad", "universite", "المؤسسة", "الجامعة", "ተቋም", "大学", "毕业院校"],
  language: ["languages spoken", "language spoken", "languages", "lingue", "idiomas", "langues", "sprachen", "اللغات", "ቋንቋዎች", "语言"],
  years_experience: ["years of experience", "total experience", "work experience years", "anni di esperienza", "anos de experiencia", "annees d'experience", "berufserfahrung", "سنوات الخبرة", "工作年限"],
  job_title: ["job title", "current title", "position title", "titolo", "cargo", "poste", "berufsbezeichnung", "المسمى الوظيفي", "职位"],
  employer: ["employer", "current employer", "company", "organization", "datore di lavoro", "empleador", "employeur", "arbeitgeber", "صاحب العمل", "雇主"],
  // Fields that map directly onto the choice controls application forms use.
  department: ["field of study", "department", "major", "discipline", "programme of study", "program of study", "dipartimento", "departamento", "spécialité", "fachbereich", "القسم", "የትምህርት ክፍል", "专业"],
  year_standing: ["academic year", "year standing", "year of study", "current year", "tenure", "class standing", "level of study", "anno accademico", "año académico", "année d'étude", "studienjahr", "السنة الدراسية", "የትምህርት ዓመት", "年级"],
  skills: ["programming languages", "languages are you proficient", "technical skills", "skills", "technologies", "proficient in", "competenze", "habilidades", "compétences", "kenntnisse", "المهارات", "ክህሎቶች", "技能"],
  passport: ["passport number", "passport no", "passport", "numero di passaporto", "numero de pasaporte", "numéro de passeport", "reisepass", "رقم جواز السفر", "护照号"],
  place_of_birth: ["place of birth", "birth place", "born in", "luogo di nascita", "lugar de nacimiento", "lieu de naissance", "geburtsort", "مكان الميلاد", "የትውልድ ቦታ", "出生地"],
  preferred_name: ["preferred name", "nickname", "known as", "goes by", "soprannome", "apodo", "surnom"],
  graduation: ["expected graduation", "graduation date", "graduation year", "completion date", "laurea prevista", "graduación", "diplôme prévu", "毕业时间"],
  degree: ["degree level", "degree", "qualification level", "titolo di studio", "nivel de titulación", "niveau de diplôme", "abschluss", "学历"],
  other: [],
};

// Keys whose control is EXPECTED to be a constrained choice (dropdown/radio),
// so a free-text profile value that isn't an option must NOT be stuffed in
// (E4). We still try to derive a matching component (e.g. dial code) but fall
// back to needs-input rather than emitting a non-option value.
export const CONSTRAINED_EXPECTED: ReadonlySet<SemanticKey> = new Set([
  "country",
  "nationality",
  "gender",
  "dob_day",
  "dob_month",
  "dob_year",
  "dial_code",
  "state",
]);

// Sensitive keys resolved at Tier 0 must never be sent to the API (privacy).
export const SENSITIVE_KEYS: ReadonlySet<SemanticKey> = new Set([
  "id",
  "dob",
  "dob_day",
  "dob_month",
  "dob_year",
  "phone",
  "dial_code",
  "email",
]);

function stripDiacritics(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function normalizeLabel(label: string): string {
  return stripDiacritics(label.toLowerCase()).replace(/\s+/g, " ").trim();
}

export function semanticKeyForQuestion(label: string): SemanticKey | null {
  const normalized = normalizeLabel(label);
  let best: { key: SemanticKey; length: number } | null = null;
  for (const [key, keywords] of Object.entries(KEYWORDS) as [SemanticKey, string[]][]) {
    for (const keyword of keywords) {
      if (keyword && normalized.includes(keyword) && (!best || keyword.length > best.length)) {
        best = { key, length: keyword.length };
      }
    }
  }
  return best?.key ?? null;
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

function bestFact(profile: StructuredProfile, field: ProfileFieldKind): ProfileFact | null {
  const candidates = profile.facts.filter((fact) => fact.field === field);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((a, b) => (CONFIDENCE_RANK[b.confidence] > CONFIDENCE_RANK[a.confidence] ? b : a));
}

function splitName(fullName: string): { first: string; middle: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { first: parts[0] ?? "", middle: "", last: "" };
  }
  return {
    first: parts[0] ?? "",
    last: parts[parts.length - 1] ?? "",
    middle: parts.slice(1, -1).join(" "),
  };
}

function dobComponents(dob: string): { day: string; month: string; year: string } | null {
  // Accept dd/mm/yyyy, yyyy-mm-dd, dd.mm.yyyy, etc.
  const iso = dob.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    return { year: iso[1] ?? "", month: iso[2] ?? "", day: iso[3] ?? "" };
  }
  const dmy = dob.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (dmy) {
    return { day: dmy[1] ?? "", month: dmy[2] ?? "", year: dmy[3] ?? "" };
  }
  const yearOnly = dob.match(/\b(19|20)\d{2}\b/);
  return yearOnly ? { day: "", month: "", year: yearOnly[0] } : null;
}

function dialCodeFromPhone(phone: string): string | null {
  const match = phone.replace(/[^\d+]/g, "").match(/^\+(\d{1,3})/);
  return match ? `+${match[1]}` : null;
}

// A value must LOOK like the thing the field is asking for before we put it
// on a real application. Without this, a mis-parsed profile value (e.g. a
// department name stored as "name") silently lands in the wrong field.
// A rejected value resolves to needs-input instead — a blank the user can
// fill is always better than a confidently wrong answer.
const ORG_OR_LABEL_RE =
  /\b(universit|college|institute|polytechnic|academy|school|faculty|department|dept|ministry|office|registrar|company|ltd|inc|plc|corporation|foundation|hospital|bank|letter|certificate|statement|transcript|curriculum|vitae|resume|application|form)\b/i;

export function isPlausibleFor(key: SemanticKey, value: string): boolean {
  const v = value.trim();
  if (!v) {
    return false;
  }
  const words = v.split(/\s+/);

  switch (key) {
    case "name":
    case "first_name":
    case "middle_name":
    case "last_name":
      // A person's name: no digits, not an organization/heading, sane length.
      return !/\d/.test(v) && !ORG_OR_LABEL_RE.test(v) && v.length <= 60 && words.length <= 5;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
    case "phone": {
      const digits = v.replace(/\D/g, "");
      return digits.length >= 7 && digits.length <= 15;
    }
    case "dial_code":
      return /^\+\d{1,4}$/.test(v);
    case "dob_year":
      return /^(19|20)\d{2}$/.test(v);
    case "dob_month":
      return /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 12;
    case "dob_day":
      return /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 31;
    case "dob":
      return /\d/.test(v) && v.length <= 40;
    case "id":
      // An identifier contains at least one digit and isn't prose.
      return /\d/.test(v) && v.length <= 40 && words.length <= 4;
    case "url":
      return /\./.test(v) && !/\s/.test(v);
    case "postal_code":
      return /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(v);
    case "country":
    case "nationality":
    case "city":
    case "state":
    case "gender":
      return !/\d/.test(v) && !ORG_OR_LABEL_RE.test(v) && v.length <= 56;
    case "years_experience":
      return /\d/.test(v) && v.length <= 24;
    case "education":
    case "employer":
    case "job_title":
    case "language":
    case "address":
      return v.length <= 200;
    default:
      return true;
  }
}

// FIX 3 / acceptance (e): a constrained control must receive one of ITS OWN
// option strings, never raw profile text. "Electrical and Computer
// Engineering" has to become "ECE"; "4th Year" has to become "4+ Years".
// Plain similarity can't do that, so we also match abbreviations/acronyms.
function normLoose(text: string): string {
  return stripDiacritics(text.toLowerCase()).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const JOIN_WORDS = new Set(["and", "of", "the", "for", "in", "on", "with", "a", "an", "or", "to"]);

// Comparison form: drop parentheticals, normalise ordinals and plurals, so
// "4th Year" and "4+ Years" become the same string.
function canonical(text: string): string {
  return normLoose(text.replace(/\([^)]*\)/g, " "))
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\bfirst\b/g, "1")
    .replace(/\bsecond\b/g, "2")
    .replace(/\bthird\b/g, "3")
    .replace(/\bfourth\b/g, "4")
    .replace(/\bfifth\b/g, "5")
    .replace(/(\w)s\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function acronymOf(text: string): string {
  // camelCase counts as a word boundary, so "JavaScript" → "Java Script" → JS
  // and "TypeScript" → TS. General rule, not a hardcoded abbreviation list.
  const split = text.replace(/\([^)]*\)/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return normLoose(split)
    .split(" ")
    .filter((w) => w && !JOIN_WORDS.has(w))
    .map((w) => w[0] ?? "")
    .join("");
}

// Whole-word containment only. Plain substring matching is unsafe here:
// it selected the option "Java" for the skill "JavaScript".
function containsWord(haystack: string, needle: string): boolean {
  if (!needle) {
    return false;
  }
  return new RegExp(`(^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(haystack);
}

// Returns the option that best represents `value`, or null if none is a
// defensible match (in which case the caller must NOT fill the control).
export function resolveToOption(value: string, options: string[]): string | null {
  if (options.length === 0) {
    return null;
  }
  const v = normLoose(value);
  if (!v) {
    return null;
  }

  const vc = canonical(value);

  // 1. Exact / canonical-equal ("4th Year" ≡ "4+ Years").
  const exact = options.find((option) => normLoose(option) === v || canonical(option) === vc);
  if (exact) {
    return exact;
  }
  // 2. Whole-word containment (never substring — "Java" must not match
  //    "JavaScript").
  const contained = options.find((option) => {
    const oc = canonical(option);
    return oc.length >= 3 && (containsWord(vc, oc) || containsWord(oc, vc));
  });
  if (contained) {
    return contained;
  }
  // 3. Acronym: the option is the initials of the value — "ECE" ← "Electrical
  //    and Computer Engineering".
  const valueAcronym = acronymOf(value);
  const acronym = options.find((option) => {
    const o = normLoose(option).replace(/\s+/g, "");
    return o.length >= 2 && o === valueAcronym;
  });
  if (acronym) {
    return acronym;
  }
  // 4. High-confidence fuzzy, as a last resort. Deliberately strict: a miss
  //    (user picks it themselves) is far safer than a wrong pick on a real
  //    application form.
  let best: { option: string; score: number } | null = null;
  options.forEach((option) => {
    const score = textSimilarity(canonical(option), vc);
    if (score >= 0.8 && (!best || score > best.score)) {
      best = { option, score };
    }
  });
  return best ? (best as { option: string }).option : null;
}

// For multi-select controls: every option the value list supports.
export function resolveToOptions(value: string, options: string[]): string[] {
  const parts = value
    .split(/[,;/]|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const picked = new Set<string>();
  parts.forEach((part) => {
    const option = resolveToOption(part, options);
    if (option) {
      picked.add(option);
    }
  });
  return [...picked];
}

export interface ProfileMatch {
  key: SemanticKey;
  value: string;
  source: string;
  // Which extraction rule produced the underlying fact. The caller uses this to
  // decide whether a Tier 0 value is strong enough to outrank the dossier: a
  // verbatim "labelled" table row is, a "positional" header guess is not.
  rule?: ExtractionRule;
  // The label maps to a profile value, but this control is a constrained
  // choice and no exact component could be produced — resolve to needs-input
  // instead of emitting a non-option value (E4).
  constrainedNoValue?: boolean;
}

// Tier 0: resolve a question from the profile with ZERO API calls. `isChoice`
// is true when the live control is a dropdown/radio/checkbox — used for the
// composite/constrained-control rule.
export function matchQuestionToProfile(
  label: string,
  profile: StructuredProfile | null,
  isChoice = false,
  options: string[] = [],
  multiSelect = false,
): ProfileMatch | null {
  if (!profile) {
    return null;
  }
  const key = semanticKeyForQuestion(label);
  if (!key) {
    return null;
  }

  // FIX B.3 — a name that scored below the evidence threshold is kept in the
  // profile (so the editor can show and correct it) but is NEVER auto-filled.
  // On a document set with no handle, no MRZ and no labelled row, the honest
  // outcome is an empty field the user completes, not a header-line guess.
  const nameFact = bestFact(profile, "name");
  const name = nameFact && nameFact.confidence === "low" ? null : nameFact;
  if (nameFact && !name) {
    console.log(
      `EasyFilla(tier): name "${nameFact.value}" has low extraction confidence — ` +
        "leaving name fields for you to confirm rather than filling a guess.",
    );
  }
  const phone = bestFact(profile, "phone");
  const dob = bestFact(profile, "dob");

  let value: string | null = null;
  let source = "";
  let rule: ExtractionRule | undefined;

  switch (key) {
    case "first_name":
    case "middle_name":
    case "last_name": {
      if (name) {
        const split = splitName(name.value);
        value = key === "first_name" ? split.first : key === "last_name" ? split.last : split.middle;
        source = name.source;
        rule = name.rule;
      }
      break;
    }
    case "dial_code": {
      if (phone) {
        value = dialCodeFromPhone(phone.value);
        source = phone.source;
      }
      break;
    }
    case "dob_day":
    case "dob_month":
    case "dob_year": {
      if (dob) {
        const comp = dobComponents(dob.value);
        if (comp) {
          value = key === "dob_day" ? comp.day : key === "dob_month" ? comp.month : comp.year;
        }
        source = dob.source;
      }
      break;
    }
    default: {
      // Direct field kinds (name, email, phone, address, dob, id, url,
      // nationality, education, language, gender, country, city, state,
      // postal_code, years_experience, job_title, employer).
      // `name` routes through the confidence-gated `name` binding above, not a
      // fresh bestFact lookup — otherwise a low-confidence name would leak
      // straight into a "Full name" question through this branch.
      const fact = key === "name" ? name : bestFact(profile, key as ProfileFieldKind);
      if (fact) {
        value = fact.value;
        source = fact.source;
        rule = fact.rule;
      }
      break;
    }
  }

  const trimmed = value?.trim() ?? "";

  // Composite/constrained-control rule (E4): a phone number can't go into a
  // dropdown; a country dropdown can't take a full address. If the control is
  // a choice and we have no confident option-shaped value, decline with a
  // needs-input signal rather than emitting a non-option string.
  if (isChoice && CONSTRAINED_EXPECTED.has(key) && !trimmed) {
    return { key, value: "", source, constrainedNoValue: true };
  }
  // A phone labeled on a CHOICE control: never stuff the full number in.
  if (isChoice && key === "phone") {
    const dial = phone ? dialCodeFromPhone(phone.value) : null;
    return dial
      ? { key: "dial_code", value: dial, source: phone?.source ?? "" }
      : { key, value: "", source, constrainedNoValue: true };
  }

  if (!trimmed) {
    return null;
  }

  // THE SEMANTIC GATE: never emit a value whose shape doesn't fit the field.
  // (This is what stopped a mis-parsed department name from being filled into
  // "Full Name".) A rejected value becomes needs-input, never a wrong answer.
  if (!isPlausibleFor(key, trimmed)) {
    console.log(
      `EasyFilla(tier): rejected profile value for "${label}" — "${trimmed}" doesn't look like a valid ${key}. ` +
        "Marking needs-input instead of filling something wrong.",
    );
    return { key, value: "", source, constrainedNoValue: true };
  }

  // A constrained control must receive one of its own options, never raw text.
  if (isChoice && options.length > 0) {
    const resolved = multiSelect ? resolveToOptions(trimmed, options).join(", ") : resolveToOption(trimmed, options);
    if (!resolved) {
      console.log(
        `EasyFilla(tier): "${label}" — profile ${key}="${trimmed}" matched none of ` +
          `[${options.join(" | ")}]; leaving for you rather than filling free text.`,
      );
      return { key, value: "", source, constrainedNoValue: true };
    }
    console.log(`EasyFilla(tier): "${label}" — profile ${key}="${trimmed}" → option "${resolved}"`);
    return { key, value: resolved, source };
  }

  return { key, value: trimmed, source, ...(rule ? { rule } : {}) };
}
