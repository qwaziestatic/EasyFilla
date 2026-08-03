// ─────────────────────────────────────────────────────────────────────────
// FRAME IDENTITY HANDSHAKE (STAGE 2a)
//
// A content script CANNOT read its own frameId. There is no DOM property and
// no extension API that exposes it from inside the frame — `window.top ===
// window` distinguishes the main frame and nothing else. It must ASK the
// service worker, which reads `sender.frameId` off the message it receives.
//
// THE INVARIANT: nothing in a frame may scan or report before its frameId is
// known. Every identity key starts with frameId (adapters/identity.ts), so
// two frames that both assumed 0 would mint colliding keys and the merge's
// dedup pass would delete one frame's real fields as "duplicates" of the
// other's. A frame that cannot identify itself reports that fact and scans
// nothing — visible and inaccessible beats invisible and wrong.
// ─────────────────────────────────────────────────────────────────────────

import { setFrameId } from "./adapters/identity";
import { MESSAGE_TYPE, type FrameHelloRequest, type FrameHelloResponse } from "../lib/messaging/messages";

export interface FrameIdentity {
  frameId: number;
  url: string;
  tabId: number;
}

// The worker is event-driven and may be asleep when we call; the first
// message wakes it. Retries are short and bounded — this is startup latency
// on every frame of every page, so it must not be generous.
const HELLO_ATTEMPTS = 5;
const HELLO_BACKOFF_MS = [0, 100, 250, 600, 1200];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sayHello(): Promise<FrameHelloResponse | null> {
  const request: FrameHelloRequest = {
    type: MESSAGE_TYPE.FRAME_HELLO,
    href: location.href,
    isTopWindow: window.top === window,
  };
  try {
    const response = (await chrome.runtime.sendMessage(request)) as FrameHelloResponse | undefined;
    return response && typeof response.frameId === "number" ? response : null;
  } catch {
    // Extension context invalidated (reload), or the worker refused. Both are
    // retryable; neither is a reason to guess an id.
    return null;
  }
}

let identityPromise: Promise<FrameIdentity | null> | null = null;
let resolvedIdentity: FrameIdentity | null = null;
let failureReason = "";

// Idempotent: every message handler awaits this, and only the first call
// performs the round trip. This IS the queue — handlers that arrive during
// the handshake simply await the same promise rather than racing ahead.
export function ensureFrameIdentity(): Promise<FrameIdentity | null> {
  if (!identityPromise) {
    identityPromise = (async () => {
      for (let attempt = 0; attempt < HELLO_ATTEMPTS; attempt += 1) {
        const backoff = HELLO_BACKOFF_MS[attempt] ?? 0;
        if (backoff > 0) {
          await wait(backoff);
        }
        const response = await sayHello();
        if (response) {
          // setFrameId BEFORE anything can scan. Ordering is the whole point.
          setFrameId(response.frameId);
          resolvedIdentity = { frameId: response.frameId, url: response.url, tabId: response.tabId };
          console.log(
            `EasyFilla(frame): identified as frame ${response.frameId} of tab ${response.tabId} — ${response.url}`,
          );
          return resolvedIdentity;
        }
      }
      failureReason =
        `this frame asked the extension for its frameId ${HELLO_ATTEMPTS} times and got no answer, so it will not ` +
        "scan — an unidentified frame's fields would collide with another frame's in the deduplication keyspace " +
        "and silently delete real questions. Reload the page (or the extension) to retry.";
      console.warn(`EasyFilla(frame): NOT identified — ${failureReason}`);
      return null;
    })();
  }
  return identityPromise;
}

export function currentIdentity(): FrameIdentity | null {
  return resolvedIdentity;
}

export function identityFailureReason(): string {
  return failureReason;
}
