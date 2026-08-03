// Tier 1 (FIX 1): standard application-portal compliance declarations. These
// yes/no attestations (misconduct, disciplinary action, investigations,
// relatives employed, conflict of interest, reference-check consent,
// willingness to accept assignments, certification statements) are NEVER
// answerable from a CV and must NEVER consume an API call. We detect them by
// intent and route them to a dedicated Declarations group, pre-filled from
// reusable defaults the user sets once in Options and reuses across portals.

export type DeclarationKind =
  | "disciplinary"
  | "investigation_criminal"
  | "relatives_employed"
  | "conflict_of_interest"
  | "reference_consent"
  | "willing_assignment"
  | "certification";

const PATTERNS: { kind: DeclarationKind; re: RegExp }[] = [
  { kind: "disciplinary", re: /disciplinar|misconduct|dismissed for|terminated for cause|separated from service/i },
  {
    kind: "investigation_criminal",
    re: /investigat|charged with|convicted|criminal (record|offen[cs]e|charge)|arrested|pending (charge|case)/i,
  },
  {
    kind: "relatives_employed",
    re: /relative[s]?\b.*(employ|work)|family member[s]?\b.*(employ|work)|related to.*(staff|employee|personnel)/i,
  },
  { kind: "conflict_of_interest", re: /conflict of interest/i },
  { kind: "reference_consent", re: /reference check|contact.*referee|object.*(reference|referee)|verify.*reference/i },
  {
    kind: "willing_assignment",
    re: /willing to (accept|be assigned|relocate|travel|serve)|accept.*(assignment|duty station)|available to travel/i,
  },
  {
    kind: "certification",
    re: /i (hereby )?(certify|declare|confirm|attest)|certif(y|ication) that the (above|information|statements)|declaration of|i understand that any (misrepresentation|false)/i,
  },
];

export function detectDeclaration(label: string): DeclarationKind | null {
  for (const { kind, re } of PATTERNS) {
    if (re.test(label)) {
      return kind;
    }
  }
  return null;
}

export const DECLARATION_LABELS: Record<DeclarationKind, string> = {
  disciplinary: "Ever subject to disciplinary action / dismissed for misconduct?",
  investigation_criminal: "Ever investigated / charged / convicted of an offence?",
  relatives_employed: "Any relatives employed by this organization?",
  conflict_of_interest: "Any conflict of interest to declare?",
  reference_consent: "Consent to reference checks?",
  willing_assignment: "Willing to accept assignments / relocate / travel?",
  certification: "Certify the information provided is true and accurate?",
};

// Reusable declaration defaults — set once in Options, applied on every form.
export type DeclarationDefaults = Partial<Record<DeclarationKind, string>>;

const STORAGE_KEY = "easyfilla.declarationDefaults";

export async function loadDeclarationDefaults(): Promise<DeclarationDefaults> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const value = result[STORAGE_KEY];
  return value && typeof value === "object" ? (value as DeclarationDefaults) : {};
}

export async function saveDeclarationDefaults(defaults: DeclarationDefaults): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: defaults });
}
