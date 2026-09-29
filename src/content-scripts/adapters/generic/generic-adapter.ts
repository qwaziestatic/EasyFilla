import { scanGenericPage, harvestChoiceOptions, applyHarvestToCoverage } from "./detect";
import { fillVisibleGenericSection, scrollToGenericQuestion } from "./fill";
import { buildNavCandidates, resolveNav } from "../nav-resolver";
import { queryAllOpenRoots } from "../../shared/dom-roots";
import type { FormAdapter } from "../adapter";

// Generic wizard nav controls: real <button>/<a>/[role=button] elements.
// Candidate gathering is structural; the shared resolver applies the
// multilingual dictionary and the submit-safety guards (native-submit
// filtering, submit-label rejection, refuse-to-guess-next). No English
// label list here anymore — that lived in this file before and broke every
// non-English form.
function navCandidates() {
  const elements = queryAllOpenRoots<HTMLElement>(
    'button, input[type="button"], input[type="submit"], [role="button"], [role="link"], a',
  );
  return buildNavCandidates(elements);
}

function readLangHint(): string | null {
  return document.documentElement.getAttribute("lang");
}

export const genericFormAdapter: FormAdapter = {
  name: "generic",

  async getSectionData() {
    if (document.readyState !== "complete") {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        window.addEventListener("load", done, { once: true });
        setTimeout(done, 3000);
      });
    }

    const { questions, sectionTitle, inaccessibleFrames, coverage } = scanGenericPage();

    // STAGE 2c — harvest lazily-rendered choice widgets so the scanner reports
    // real options instead of empty ones. Non-destructive (scroll + focus are
    // restored) and budgeted; whatever the budget doesn't reach is marked
    // `optionsPending` and harvested on demand at fill time rather than
    // stalling the scan.
    const harvest = await harvestChoiceOptions(questions);
    if (coverage) {
      console.log("EasyFilla(coverage, post-harvest):", applyHarvestToCoverage(coverage, questions, harvest));
    }

    const plainQuestions = questions.map(
      ({ elements: _elements, fillKind: _fillKind, identity: _identity, ...question }) => question,
    );

    return {
      formTitle: document.title,
      sectionTitle,
      questions: plainQuestions,
      hasNext: resolveNav(navCandidates(), "next").confident,
      inaccessibleFrames,
      langHint: readLangHint(),
      // STAGE 2a — elements can't cross the message boundary, so the frame
      // layer uses these to compute this frame's reading order (fields
      // interleaved with child iframes) before anything is serialized.
      orderAnchors: questions.map((question) => question.elements[0] ?? null),
      identityKeys: questions.map((question) => question.identity?.key ?? ""),
    };
  },

  resolveNav(direction) {
    return resolveNav(navCandidates(), direction);
  },

  fillVisibleSection: fillVisibleGenericSection,

  scrollToQuestion(questionText) {
    return scrollToGenericQuestion(questionText);
  },
};
