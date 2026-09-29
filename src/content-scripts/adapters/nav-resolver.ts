import { classifyNavLabel, type NavKind } from "../../lib/i18n/nav-dictionary";

// The result of trying to identify a navigation control. `confident` gates
// whether the sidepanel is allowed to click it — an unconfident or
// submit-classified result must NEVER be clicked during traversal.
export interface NavResolution {
  element: HTMLElement | null;
  kind: NavKind | "unknown";
  confident: boolean;
  method: string; // for the required console instrumentation
  reason: string;
}

export interface NavCandidate {
  element: HTMLElement;
  label: string;
  isNativeSubmit: boolean;
  positionInRow: number; // 0-based index within its nav row/container
  rowSize: number;
}

function buttonLabel(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("data-label") ||
    (element as HTMLInputElement).value ||
    element.textContent ||
    ""
  ).trim();
}

// STAGE 2d — rel="next"/"prev" is an explicit, language-independent statement
// of intent. It is treated as a dictionary match so a portal whose button says
// only "→" or a word in an unlisted language still traverses correctly.
// It can NEVER promote a submit control: Guard 1 runs first.
function relHint(element: HTMLElement): NavKind | null {
  const rel = (element.getAttribute("rel") ?? "").toLowerCase();
  if (/\bnext\b/.test(rel)) {
    return "next";
  }
  if (/\b(prev|previous)\b/.test(rel)) {
    return "back";
  }
  return null;
}

function attributeHint(element: HTMLElement): NavKind | null {
  const values = [
    element.getAttribute("data-action"),
    element.getAttribute("data-nav"),
    element.getAttribute("data-testid"),
    element.getAttribute("id"),
    element.getAttribute("name"),
    element.getAttribute("aria-label"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\b(submit|finish|complete|send)\b/.test(values)) {
    return "submit";
  }
  if (/\b(next|continue|proceed|forward)\b/.test(values) || /^(→|›|»|>)$/.test(values.trim())) {
    return "next";
  }
  if (/\b(back|prev|previous|return)\b/.test(values) || /^(←|‹|«|<)$/.test(values.trim())) {
    return "back";
  }
  return null;
}

function isNativeSubmit(element: HTMLElement): boolean {
  if (element instanceof HTMLButtonElement) {
    // A <button> with no explicit type defaults to submit inside a <form>.
    const explicit = element.getAttribute("type");
    if (explicit) {
      return explicit === "submit";
    }
    return element.form !== null;
  }
  if (element instanceof HTMLInputElement) {
    return element.type === "submit" || element.type === "image";
  }
  return false;
}

// Builds the candidate set from a set of clickable elements, computing each
// one's position within its own nav row so "Back is first, Next/Submit is
// last" positional reasoning is possible.
export function buildNavCandidates(elements: HTMLElement[]): NavCandidate[] {
  const visible = elements.filter((el) => el.getClientRects().length > 0);

  return visible.map((element) => {
    const row = element.parentElement;
    const siblings = row ? Array.from(row.children).filter((c) => visible.includes(c as HTMLElement)) : [element];
    return {
      element,
      label: buttonLabel(element),
      isNativeSubmit: isNativeSubmit(element),
      positionInRow: Math.max(0, siblings.indexOf(element)),
      rowSize: siblings.length,
    };
  });
}

// Resolves a "next" or "back" control from candidates, STRUCTURE FIRST and
// dictionary second, with submit-safety guards that make an accidental
// submit click structurally impossible:
//
//   Guard 1 — a native submit control is never returned as clickable, in
//             any language (isNativeSubmit filters it out up front).
//   Guard 2 — for "next", any candidate whose LABEL classifies as submit in
//             ANY dictionary language is rejected outright, even if it looks
//             positionally like a next button.
//   Guard 3 — positional inference alone is never enough to click: the
//             final returned "next" must be positively dictionary-matched
//             OR (structural next-button with no competing submit present).
//             Pure ambiguity returns confident=false, which the caller
//             treats as "stop traversal", never "click hopefully".
export function resolveNav(candidates: NavCandidate[], direction: "next" | "back"): NavResolution {
  // Guard 1: submit controls can never be navigation targets.
  const navigable = candidates.filter((c) => !c.isNativeSubmit);

  // Dictionary classification for each navigable candidate.
  const classified = navigable.map((candidate) => {
    const dictionary = classifyNavLabel(candidate.label);
    const rel = relHint(candidate.element);
    return {
      candidate,
      match:
        dictionary ??
        (rel
          ? { kind: rel, language: "rel-attribute", matchedLabel: `rel="${rel}"` }
          : (attributeHint(candidate.element)
            ? {
                kind: attributeHint(candidate.element) as NavKind,
                language: "semantic-attribute",
                matchedLabel: buttonLabel(candidate.element),
              }
            : null)),
    };
  });

  // Guard 2 (next only): drop anything whose label reads as submit anywhere.
  const submitLabeled = new Set(
    classified.filter((c) => c.match?.kind === "submit").map((c) => c.candidate.element),
  );

  const wanted = classified.filter(
    (c) => c.match?.kind === direction && !submitLabeled.has(c.candidate.element),
  );

  if (wanted.length === 1) {
    const only = wanted[0];
    if (only) {
      return {
        element: only.candidate.element,
        kind: direction,
        confident: true,
        method: `matched label "${only.candidate.label}" [${only.match?.language}]`,
        reason: "single dictionary match",
      };
    }
  }

  if (wanted.length > 1) {
    // Multiple dictionary matches — pick by position (back = earliest,
    // next = latest in the row) but this is still a confident structural+
    // dictionary decision.
    const sorted = [...wanted].sort((a, b) => a.candidate.positionInRow - b.candidate.positionInRow);
    const chosen = direction === "back" ? sorted[0] : sorted[sorted.length - 1];
    if (chosen) {
      return {
        element: chosen.candidate.element,
        kind: direction,
        confident: true,
        method: `matched label "${chosen.candidate.label}" [${chosen.match?.language}] + position`,
        reason: "dictionary match disambiguated by position",
      };
    }
  }

  // No dictionary match. Structural-only fallback is allowed ONLY for "back"
  // (clicking Back can never submit, so a positional guess there is safe) —
  // never for "next", because a positional guess at "next" could be a
  // submit control in a language not in the dictionary.
  if (direction === "back" && navigable.length >= 2) {
    const first = [...navigable].sort((a, b) => a.positionInRow - b.positionInRow)[0];
    if (first) {
      return {
        element: first.element,
        kind: "back",
        confident: true,
        method: "structure (first control in nav row)",
        reason: "no dictionary match; safe positional fallback for back only",
      };
    }
  }

  return {
    element: null,
    kind: "unknown",
    confident: false,
    method: "none",
    reason:
      direction === "next"
        ? "no confident 'next' control — refusing to guess (could be a submit button in an unrecognized language)"
        : "no 'back' control found",
  };
}
