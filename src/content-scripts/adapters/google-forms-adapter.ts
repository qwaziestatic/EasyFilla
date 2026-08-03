import { waitForFormReady } from "../google-forms/detector";
import { getSectionInfo } from "../google-forms/extractor";
import { fillVisibleSection, scrollToGoogleQuestion } from "../google-forms/filler";
import { buildNavCandidates, resolveNav } from "./nav-resolver";
import { fieldIdentity, currentFrameId } from "./identity";
import type { FormAdapter } from "./adapter";

// Google Forms renders its Next/Back/Submit as custom role="button" divs.
// We gather them structurally, then hand off to the shared resolver, which
// applies the multilingual + submit-safety logic. Scoped to the <form>
// (falling back to body) so unrelated page buttons aren't considered.
function navCandidates() {
  const root = document.querySelector("form") ?? document.body;
  const elements = Array.from(root.querySelectorAll<HTMLElement>('div[role="button"], span[role="button"], button'));
  return buildNavCandidates(elements);
}

function readLangHint(): string | null {
  const htmlLang = document.documentElement.getAttribute("lang");
  if (htmlLang) {
    return htmlLang;
  }
  try {
    const hl = new URL(location.href).searchParams.get("hl");
    if (hl) {
      return hl;
    }
  } catch {
    // ignore malformed URL
  }
  return null;
}

export const googleFormsAdapter: FormAdapter = {
  name: "google-forms",

  async getSectionData() {
    await waitForFormReady();
    const { title, questions } = getSectionInfo();
    const plainQuestions = questions.map(({ listitem: _listitem, ...question }) => question);
    return {
      formTitle: document.title,
      sectionTitle: title,
      questions: plainQuestions,
      hasNext: resolveNav(navCandidates(), "next").confident,
      inaccessibleFrames: 0,
      langHint: readLangHint(),
      // STAGE 2a — the listitem is this adapter's anchor for reading order and
      // structural identity. Google Forms puts every question in the top
      // frame, so cross-frame interleaving is a no-op here; the identity key
      // still carries frameId, which keeps it distinct if that ever changes.
      orderAnchors: questions.map((question) => question.listitem),
      identityKeys: questions.map((question) =>
        fieldIdentity(question.listitem, currentFrameId(), question.questionText).key,
      ),
    };
  },

  resolveNav(direction) {
    return resolveNav(navCandidates(), direction);
  },

  fillVisibleSection,

  scrollToQuestion(questionText) {
    return scrollToGoogleQuestion(questionText);
  },
};
