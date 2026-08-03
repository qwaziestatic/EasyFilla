// ─────────────────────────────────────────────────────────────────────────
// DATE NORMALIZATION (PART 3)
//
// Date fields were skipped outright with "date fields can't be auto-filled".
// They ARE fillable, and the dossier already holds a date of birth — so a form
// asking for one was being left blank for no reason.
//
// ⚠️ THE INVARIANT THAT SHAPES THIS FILE.
// **A WRONG DATE OF BIRTH ON AN APPLICATION IS WORSE THAN A BLANK ONE.**
// "03/04/2001" is 3 April in most of the world and 4 March in the US. Guessing
// silently produces a confidently wrong answer of exactly the kind §3 exists to
// prevent — it just arrives through a date parser instead of a language model.
//
// So: every function here REFUSES on ambiguity and names the reason. It never
// picks a "probably right" reading. Pure and dependency-free so the refusals can
// be tested exhaustively.
// ─────────────────────────────────────────────────────────────────────────

/** Day/month/year, already validated as a real calendar date. */
export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export type DateParseResult =
  | { ok: true; date: CalendarDate; interpretation: string }
  | { ok: false; reason: string };

/** Field ordering a form has told us about, when it has. */
export type DateOrder = "DMY" | "MDY" | "YMD" | "unknown";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  // Day count for the month, leap years included.
  const lengths = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] ?? 0);
}

/**
 * Parses a dossier/profile date string into a calendar date, or REFUSES.
 *
 * Accepted without ambiguity:
 *   - ISO `YYYY-MM-DD` (and `YYYY/MM/DD`) — unambiguous by construction
 *   - any form naming the month in words ("4 March 2001", "March 4, 2001")
 *   - numeric forms where one component is > 12, which fixes the day
 *
 * REFUSED:
 *   - numeric forms where both candidates are ≤ 12 and no order is known
 *   - impossible dates (31 February)
 *   - anything unrecognised
 */
export function parseKnownDate(raw: string, order: DateOrder = "unknown"): DateParseResult {
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "the stored date is empty" };

  // ── ISO, or any explicit 4-digit-year-first form. Unambiguous. ──
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!isRealDate(year, month, day)) {
      return { ok: false, reason: `"${value}" is not a real calendar date` };
    }
    return { ok: true, date: { year, month, day }, interpretation: `ISO year-first: ${year}-${month}-${day}` };
  }

  // ── Month named in words. Unambiguous regardless of position. ──
  const worded = /^(\d{1,2})?\s*([A-Za-z]{3,})\.?,?\s*(\d{1,2})?,?\s*(\d{4})$/.exec(value);
  if (worded) {
    const monthName = (worded[2] ?? "").toLowerCase();
    const monthIndex = MONTHS.findIndex((name) => name.startsWith(monthName.slice(0, 3)) && monthName.length >= 3);
    if (monthIndex >= 0) {
      const day = Number(worded[1] ?? worded[3]);
      const year = Number(worded[4]);
      if (Number.isFinite(day) && isRealDate(year, monthIndex + 1, day)) {
        return {
          ok: true,
          date: { year, month: monthIndex + 1, day },
          interpretation: `month named in words: ${MONTHS[monthIndex]} ${day}, ${year}`,
        };
      }
      return { ok: false, reason: `"${value}" is not a real calendar date` };
    }
  }

  // ── Two numbers and a year. THE AMBIGUOUS CASE. ──
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(value);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = Number(numeric[3]);

    // If one component cannot be a month, the reading is forced.
    if (first > 12 && second <= 12) {
      return isRealDate(year, second, first)
        ? {
            ok: true,
            date: { year, month: second, day: first },
            interpretation: `day-first (forced: ${first} cannot be a month)`,
          }
        : { ok: false, reason: `"${value}" is not a real calendar date` };
    }
    if (second > 12 && first <= 12) {
      return isRealDate(year, first, second)
        ? {
            ok: true,
            date: { year, month: first, day: second },
            interpretation: `month-first (forced: ${second} cannot be a month)`,
          }
        : { ok: false, reason: `"${value}" is not a real calendar date` };
    }
    if (first > 12 && second > 12) {
      return { ok: false, reason: `"${value}" has no component that can be a month` };
    }

    // Both ≤ 12. Only an explicitly known order can resolve this.
    if (order === "DMY") {
      return isRealDate(year, second, first)
        ? { ok: true, date: { year, month: second, day: first }, interpretation: "day-first (form stated D/M/Y)" }
        : { ok: false, reason: `"${value}" is not a real calendar date` };
    }
    if (order === "MDY") {
      return isRealDate(year, first, second)
        ? { ok: true, date: { year, month: first, day: second }, interpretation: "month-first (form stated M/D/Y)" }
        : { ok: false, reason: `"${value}" is not a real calendar date` };
    }

    // ⚠️ THE REFUSAL THAT MATTERS.
    return {
      ok: false,
      reason:
        `"${value}" is ambiguous — it could be ${first}/${second} day/month or month/day, and the form does not ` +
        "say which order it expects. Refusing to guess: a wrong date of birth on an application is worse than a " +
        "blank one. Fix the date's format in Settings → profile, or type it into the form yourself.",
    };
  }

  return { ok: false, reason: `"${value}" is not in a date format EasyFilla recognises` };
}

/** `YYYY-MM-DD`, the only value an `input[type="date"]` accepts. */
export function toInputDateValue(date: CalendarDate): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}`;
}

/**
 * Reads the order a form has declared, from a placeholder, aria-label or
 * pattern hint like "DD/MM/YYYY". Returns "unknown" rather than a default —
 * defaulting is how a wrong date gets written.
 */
export function detectDateOrder(hint: string | null | undefined): DateOrder {
  if (!hint) return "unknown";
  const normalized = hint.toLowerCase().replace(/[^dmy]/g, "");
  if (normalized.startsWith("ddmm")) return "DMY";
  if (normalized.startsWith("mmdd")) return "MDY";
  if (normalized.startsWith("yyyy") || normalized.startsWith("yy")) return "YMD";
  return "unknown";
}
