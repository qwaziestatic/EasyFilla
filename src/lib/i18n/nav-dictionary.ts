// Multilingual navigation-label dictionary. Used only as a SECONDARY signal
// behind structural detection (see the adapters) — never the primary
// mechanism. Trivially extensible: add a language row and it's picked up
// everywhere. All comparisons go through `normalizeNavLabel` so accents,
// case, and Unicode composition don't cause misses.
export interface NavLabelSet {
  next: string[];
  back: string[];
  submit: string[];
}

export const NAV_LABELS: Record<string, NavLabelSet> = {
  en: { next: ["next", "continue", "next step", "proceed"], back: ["back", "previous", "prev"], submit: ["submit", "send", "finish", "done"] },
  it: { next: ["avanti", "continua", "prosegui"], back: ["indietro", "precedente"], submit: ["invia", "inoltra", "fine"] },
  es: { next: ["siguiente", "continuar", "adelante"], back: ["atras", "atrás", "anterior"], submit: ["enviar", "finalizar"] },
  fr: { next: ["suivant", "continuer", "suite"], back: ["precedent", "précédent", "retour"], submit: ["envoyer", "soumettre", "terminer"] },
  de: { next: ["weiter", "nachste", "nächste", "fortfahren"], back: ["zuruck", "zurück", "vorherige"], submit: ["absenden", "senden", "abschicken"] },
  pt: { next: ["proximo", "próximo", "seguinte", "continuar", "avancar", "avançar"], back: ["voltar", "anterior"], submit: ["enviar", "concluir", "finalizar"] },
  ar: { next: ["التالي", "متابعة", "التالى"], back: ["السابق", "رجوع", "عودة"], submit: ["إرسال", "ارسال", "إنهاء"] },
  am: { next: ["ቀጣይ", "ቀጥል", "ይቀጥሉ"], back: ["ተመለስ", "ኋላ", "የቀድሞ"], submit: ["አስገባ", "ላክ", "ጨርስ"] },
  zh: { next: ["下一步", "下一页", "继续", "繼續"], back: ["上一步", "上一页", "返回"], submit: ["提交", "发送", "發送", "完成"] },
  hi: { next: ["आगे", "अगला", "जारी रखें"], back: ["पीछे", "पिछला", "वापस"], submit: ["जमा करें", "भेजें", "पूर्ण"] },
  ru: { next: ["далее", "продолжить", "вперед", "вперёд"], back: ["назад", "предыдущий"], submit: ["отправить", "готово", "завершить"] },
  sw: { next: ["endelea", "ifuatayo", "mbele"], back: ["nyuma", "rudi", "iliyotangulia"], submit: ["wasilisha", "tuma", "maliza"] },
} as const;

// NFKD + strip combining marks + lowercase, so "Précédent", "PRECEDENTE",
// and "precedent" all compare equal. Non-Latin scripts (Arabic, Ethiopic,
// CJK, Devanagari, Cyrillic) have no combining-mark issue here and pass
// through lowercased/trimmed.
export function normalizeNavLabel(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type NavKind = "next" | "back" | "submit";

export interface DictionaryMatch {
  kind: NavKind;
  language: string;
  matchedLabel: string;
}

// Returns which nav kind a label matches, and in which language, or null.
// Checked longest-label-first within a kind so "next step" wins over "next"
// when both would match, giving the more specific classification.
export function classifyNavLabel(rawLabel: string): DictionaryMatch | null {
  const normalized = normalizeNavLabel(rawLabel);
  if (!normalized) {
    return null;
  }

  let best: DictionaryMatch | null = null;
  for (const [language, set] of Object.entries(NAV_LABELS)) {
    (["submit", "next", "back"] as NavKind[]).forEach((kind) => {
      set[kind].forEach((label) => {
        const normalizedLabel = normalizeNavLabel(label);
        if (normalized === normalizedLabel || normalized.startsWith(`${normalizedLabel} `)) {
          if (!best || normalizedLabel.length > normalizeNavLabel(best.matchedLabel).length) {
            best = { kind, language, matchedLabel: label };
          }
        }
      });
    });
  }
  return best;
}
