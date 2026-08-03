import { googleFormsAdapter } from "./adapters/google-forms-adapter";
import { genericFormAdapter } from "./adapters/generic/generic-adapter";
import type { FormAdapter } from "./adapters/adapter";
import { ensureFrameIdentity, identityFailureReason } from "./frame-identity";
import { computeFrameLayout } from "./frame-layout";
import { currentFrameId } from "./adapters/identity";
import { debugLog, initDebugLogging } from "../lib/debug";
import {
  isGetSectionInfoRequest,
  isClickNavRequest,
  isFillCurrentSectionRequest,
  isScrollToQuestionRequest,
  isRevealFrameRequest,
  type GetSectionInfoResponse,
  type ClickNavResponse,
  type FillCurrentSectionResponse,
  type ScrollToQuestionResponse,
  type RevealFrameResponse,
  type FrameQuestion,
} from "../lib/messaging/messages";
import type { FillPayload } from "../types/questions";

declare global {
  interface Window {
    __easyFillaContentScriptLoaded?: boolean;
  }
}

function chooseAdapter(): FormAdapter {
  const isGoogleForms = location.hostname === "docs.google.com" && location.pathname.startsWith("/forms");
  return isGoogleForms ? googleFormsAdapter : genericFormAdapter;
}

// The sidepanel explicitly (re-)injects this script via
// chrome.scripting.executeScript before messaging a tab — both to reach
// tabs that were open before the extension loaded, and to re-attach after
// each wizard/section navigation (advancing can load a whole new page,
// destroying the previous script context). This module can therefore run
// multiple times per page lifetime, so everything below registers at most
// once per document.
//
// STAGE 2a: with `all_frames`, it now also runs once per FRAME. Each copy
// must learn its own frameId from the service worker before it scans
// anything — see frame-identity.ts for why that ordering is load-bearing.
if (!window.__easyFillaContentScriptLoaded) {
  window.__easyFillaContentScriptLoaded = true;

  const adapter = chooseAdapter();

  // Kick the handshake off at injection time so it is usually finished before
  // the first request arrives; every handler still awaits it, so an early
  // request simply queues behind the same promise rather than racing it.
  void initDebugLogging();
  const identityReady = ensureFrameIdentity();
  void identityReady.then((identity) => {
    console.log(
      `EasyFilla: content script initialized — adapter: ${adapter.name}, ` +
        (identity ? `frame ${identity.frameId}` : "frame UNIDENTIFIED (will not scan)"),
    );
  });

  // A frame that never learned its id reports that plainly. It does NOT fall
  // back to 0: two frames claiming 0 would produce colliding identity keys,
  // and the merge's dedup would then delete one frame's real fields.
  function unidentifiedResponse(): GetSectionInfoResponse {
    return {
      adapter: adapter.name,
      formTitle: document.title,
      sectionTitle: null,
      questions: [],
      hasNext: false,
      inaccessibleFrames: 0,
      langHint: null,
      fingerprint: "unidentified",
      frameId: -1,
      identified: false,
      unidentifiedReason: identityFailureReason(),
      childFrames: [],
      selfIframeIndex: null,
    };
  }

  const handleGetSectionInfo = (sendResponse: (response: GetSectionInfoResponse) => void): void => {
    void (async () => {
      const identity = await identityReady;
      if (!identity) {
        sendResponse(unidentifiedResponse());
        return;
      }

      const data = await adapter.getSectionData();

      // Interleave this frame's fields with its child <iframe> elements in one
      // reading order, so the worker can splice a child frame's questions in
      // at the point its iframe actually sits.
      const anchors = data.orderAnchors ?? data.questions.map(() => null);
      const layout = computeFrameLayout(anchors);
      const identityKeys = data.identityKeys ?? [];

      const questions: FrameQuestion[] = data.questions.map((question, index) => ({
        ...question,
        order: layout.questionOrders[index] ?? index,
        // Fallback key still carries the frameId, so it can never collide
        // across frames even when an adapter supplies no structural key.
        identityKey: identityKeys[index] ?? `${identity.frameId}|q${index}|${question.questionText}`,
      }));

      // Includes every question text (not just the first) so two sections
      // that happen to share an opening question still fingerprint apart.
      const fingerprint = [
        data.sectionTitle ?? "",
        String(data.questions.length),
        ...data.questions.map((question) => question.questionText),
      ].join(" ");

      debugLog(
        `EasyFilla(${adapter.name}) frame ${identity.frameId}: section info — ${data.questions.length} question(s)` +
          (data.sectionTitle ? ` ("${data.sectionTitle}")` : "") +
          `, hasNext=${data.hasNext}, ${layout.childFrames.length} child frame(s)` +
          (data.inaccessibleFrames > 0 ? `, ${data.inaccessibleFrames} unreadable region(s)` : ""),
      );

      sendResponse({
        adapter: adapter.name,
        formTitle: data.formTitle,
        sectionTitle: data.sectionTitle,
        questions,
        hasNext: data.hasNext,
        inaccessibleFrames: data.inaccessibleFrames,
        langHint: data.langHint,
        fingerprint,
        frameId: identity.frameId,
        identified: true,
        childFrames: layout.childFrames,
        selfIframeIndex: layout.selfIframeIndex,
      });
    })();
  };

  const handleClickNav = (direction: "next" | "back", sendResponse: (response: ClickNavResponse) => void): void => {
    const resolution = adapter.resolveNav(direction);

    // THE submit-safety gate. `resolveNav` already refuses to return a
    // native-submit control or an unconfident "next" — but we assert it
    // here too, so no future change to an adapter can make this handler
    // click something it shouldn't. An unconfident result is reported as
    // not-clicked with its reason, never clicked hopefully.
    //
    // STAGE 2a: this runs in WHICHEVER frame the nav control lives in. The
    // sidepanel picks the frame; the guard is unchanged and unconditional, so
    // routing a nav click to a different frame cannot weaken it.
    if (!resolution.confident || !resolution.element) {
      console.warn(
        `EasyFilla(${adapter.name}) frame ${currentFrameId()}: nav "${direction}" not clicked — ${resolution.reason}`,
      );
      sendResponse({ clicked: false, reason: resolution.reason, method: resolution.method });
      return;
    }

    console.log(`EasyFilla(${adapter.name}) frame ${currentFrameId()}: nav "${direction}" — ${resolution.method}`);

    // Respond BEFORE clicking: on sites where steps are separate page
    // loads, the click destroys this script context — responding first
    // guarantees the sidepanel gets its answer instead of a dead channel.
    const target = resolution.element;
    sendResponse({ clicked: true, method: resolution.method });
    setTimeout(() => {
      console.log(`EasyFilla(${adapter.name}): clicking "${direction}"…`);
      target.click();
    }, 0);
  };

  const handleFillCurrentSection = (
    payload: FillPayload,
    sendResponse: (response: FillCurrentSectionResponse) => void,
  ): void => {
    void (async () => {
      const identity = await identityReady;
      if (!identity) {
        sendResponse({
          filledQuestions: [],
          skippedQuestions: [],
          consumedAnswers: [],
          attachedFiles: [],
          failedAttachments: [],
          fillLog: [],
        });
        return;
      }

      const result = await adapter.fillVisibleSection(payload);

      // Stamp the frame on every row centrally, so a failure can always name
      // its frame without each fill path having to remember to do it.
      const fillLog = result.fillLog?.map((entry) => ({
        ...entry,
        frameId: identity.frameId,
        frameUrl: identity.url,
      }));

      debugLog(
        `EasyFilla(${adapter.name}) frame ${identity.frameId}: filled ${result.filledQuestions.length} question(s), ` +
          `attached ${result.attachedFiles.length} file(s), skipped ${result.skippedQuestions.length}.`,
      );
      sendResponse(fillLog ? { ...result, fillLog } : result);
    })();
  };

  const handleScrollToQuestion = (
    questionText: string,
    sendResponse: (response: ScrollToQuestionResponse) => void,
  ): void => {
    const found = adapter.scrollToQuestion(questionText);
    debugLog(
      `EasyFilla(${adapter.name}) frame ${currentFrameId()}: scroll to "${questionText}" — ${found ? "found" : "not found"}`,
    );
    sendResponse({ found });
  };

  // STAGE 2a — step 1 of the two-step reveal. A child frame can scroll within
  // itself but CANNOT scroll its own <iframe> element into view: that element
  // belongs to this document. Widgets that only react when visible were
  // failing silently without this — the child scrolled to a field that was
  // still off-screen because its whole iframe was.
  const handleRevealFrame = (
    iframeIndex: number,
    sendResponse: (response: RevealFrameResponse) => void,
  ): void => {
    const frames = Array.from(document.querySelectorAll("iframe"));
    const target = frames[iframeIndex];
    if (!target) {
      sendResponse({
        revealed: false,
        reason: `this frame has ${frames.length} iframe(s); there is no iframe at index ${iframeIndex} (the page changed since the scan)`,
      });
      return;
    }
    target.scrollIntoView({ block: "center", inline: "nearest" });
    debugLog(`EasyFilla frame ${currentFrameId()}: revealed child iframe #${iframeIndex} for filling.`);
    sendResponse({ revealed: true });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isGetSectionInfoRequest(message)) {
      handleGetSectionInfo(sendResponse);
      return true; // keep the message channel open for the async sendResponse above
    }

    if (isClickNavRequest(message)) {
      handleClickNav(message.direction, sendResponse);
      return true;
    }

    if (isFillCurrentSectionRequest(message)) {
      handleFillCurrentSection(
        { answers: message.answers, fileAttachments: message.fileAttachments ?? [] },
        sendResponse,
      );
      return true;
    }

    if (isScrollToQuestionRequest(message)) {
      handleScrollToQuestion(message.questionText, sendResponse);
      return true;
    }

    if (isRevealFrameRequest(message)) {
      handleRevealFrame(message.iframeIndex, sendResponse);
      return true;
    }

    return false;
  });
}
