import { SELECTORS } from "./selectors";

const QUIET_PERIOD_MS = 500;
const MAX_WAIT_MS = 8000;

/**
 * Resolves once the form's question list has stopped mutating for
 * QUIET_PERIOD_MS, or MAX_WAIT_MS has elapsed as a safety net — Google
 * Forms is an SPA that can still be rendering questions after document_idle.
 */
export function waitForFormReady(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout>;

    const settle = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(hardCap);
      resolve();
    };

    const scheduleQuietCheck = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(settle, QUIET_PERIOD_MS);
    };

    const observer = new MutationObserver(() => {
      if (document.querySelector(SELECTORS.questionItem)) {
        scheduleQuietCheck();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    if (document.querySelector(SELECTORS.questionItem)) {
      scheduleQuietCheck();
    }

    const hardCap = setTimeout(settle, MAX_WAIT_MS);
  });
}
