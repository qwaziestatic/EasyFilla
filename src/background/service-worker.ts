// ─────────────────────────────────────────────────────────────────────────
// SERVICE WORKER — frame registry owner (STAGE 2a)
//
// This is the only place that can answer "which frame are you?", because
// `sender.frameId` is browser-supplied and unavailable inside a frame. It is
// deliberately a THIN adapter: every decision (ordering, dedup, why a frame
// is inaccessible) lives in ./frame-registry.ts, which has no chrome APIs and
// is covered by `node tests/run.mjs`.
// ─────────────────────────────────────────────────────────────────────────

import {
  FrameRegistry,
  classifyInaccessibleFrame,
  describeFrameCoverage,
  mergeFrameScans,
  resolveFramePlacements,
  type FrameScanResult,
  type FrameTreeEntry,
  type MergedScan,
} from "./frame-registry";
import {
  MESSAGE_TYPE,
  isFrameHelloRequest,
  isScanAllFramesRequest,
  type FrameHelloResponse,
  type GetSectionInfoResponse,
} from "../lib/messaging/messages";
import { debugLog, initDebugLogging } from "../lib/debug";

const registry = new FrameRegistry();
void initDebugLogging();

// A frame that is still loading its content script legitimately takes a
// moment to answer. A frame that will never answer must not hold the whole
// scan hostage — the merge reports it as inaccessible instead.
const FRAME_SCAN_TIMEOUT_MS = 2500;

// ── B5: SURVIVING WORKER TERMINATION ─────────────────────────────────────
// MV3 kills this worker after ~30s idle and restarts it on the next event, so
// `registry` above is volatile by construction. Cached scans do not matter —
// `scanAllFrames` re-enumerates the tree and re-fans-out every single time.
//
// The generation counters DO matter: they are the §3c stale-fill guard.
// Losing them resets every frame to 0, which makes answers issued before the
// restart look mismatched. That is the SAFE direction (they degrade to the
// FIX 1 strict label path rather than filling something wrong) but it is
// needlessly lossy across an idle gap the user never saw. So they are mirrored
// to chrome.storage — integers keyed by frameId, nothing about page content.
const GENERATIONS_KEY = "easyfilla.frameGenerations.v1";
let hydrated = false;

async function hydrateGenerations(): Promise<void> {
  if (hydrated) {
    return;
  }
  hydrated = true; // set first: a concurrent caller must not re-enter
  try {
    const stored = await chrome.storage.session.get(GENERATIONS_KEY);
    const raw = stored[GENERATIONS_KEY];
    if (raw && typeof raw === "object") {
      registry.importGenerations(raw as Record<number, Record<number, number>>);
      debugLog("[EasyFilla] restored frame generation counters after a worker restart.");
    }
  } catch (error) {
    // Non-fatal: without them the guard is merely over-conservative.
    debugLog("[EasyFilla] couldn't restore frame generations; the stale-fill guard stays conservative.", error);
  }
}

async function persistGenerations(): Promise<void> {
  try {
    // chrome.storage.SESSION, not local: these counters describe the frames of
    // currently-open tabs. They are meaningless after a browser restart and
    // should not outlive the browsing session on disk.
    await chrome.storage.session.set({ [GENERATIONS_KEY]: registry.exportGenerations() });
  } catch {
    // Ignore — see hydrateGenerations.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[EasyFilla] service worker installed");
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// ── 1. FRAME IDENTITY HANDSHAKE ──────────────────────────────────────────
// The frame asks; we answer from `sender`, which only the browser can fill
// in. Nothing else in the system is allowed to invent a frameId.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isFrameHelloRequest(message)) {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId === undefined || frameId === undefined) {
      // No tab/frame context: the sender is not a content script (e.g. the
      // sidepanel). Answering with a made-up id would be worse than refusing.
      sendResponse(undefined);
      return false;
    }
    const url = sender.url ?? message.href;
    registry.noteHello(tabId, frameId, url);
    const response: FrameHelloResponse = { frameId, tabId, url };
    debugLog(`[EasyFilla] frame hello — tab ${tabId} frame ${frameId} (${url})`);
    sendResponse(response);
    return false;
  }

  if (isScanAllFramesRequest(message)) {
    void scanAllFrames(message.tabId).then(sendResponse);
    return true; // async
  }

  return false;
});

// ── 2. LIFECYCLE ─────────────────────────────────────────────────────────
// Frames that navigate mid-session invalidate their cached scan AND their
// answers (via the generation counter). Frames that appear late are picked up
// on the next scan, which always re-enumerates the tree.

chrome.webNavigation.onCommitted.addListener((details) => {
  const record = registry.noteNavigated(details.tabId, details.frameId, details.url);
  // B5 — persist immediately. A navigation is precisely the event that must
  // not be forgotten if the worker is killed a moment later.
  void persistGenerations();
  debugLog(
    `[EasyFilla] frame ${details.frameId} navigated to ${details.url} — ` +
      `cached scan dropped, generation now ${record.generation}. Answers from earlier generations will be refused.`,
  );
});

chrome.webNavigation.onCompleted.addListener((details) => {
  // A late-loading frame is not an error — portals mount their application
  // iframe well after the top document is "complete". Reconciling here means
  // the next scan sees it without any re-scan being forced on the user.
  const record = registry.get(details.tabId, details.frameId);
  if (record && !record.scan) {
    console.log(`[EasyFilla] frame ${details.frameId} finished loading (${details.url}) — will be scanned next pass.`);
  }
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  registry.recordInaccessible(details.tabId, details.frameId, {
    frameId: details.frameId,
    parentFrameId: -1,
    url: details.url,
    reason: "load-error",
    detail: `the browser reported an error loading this frame (${details.error})`,
    retryable: true,
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  registry.removeTab(tabId);
  // B5 — drop the tab's persisted counters too, so storage does not grow
  // without bound across a long browsing session.
  void persistGenerations();
});

// ── 3. TREE ENUMERATION + FAN-OUT ────────────────────────────────────────

async function getFrameTree(tabId: number): Promise<FrameTreeEntry[]> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames) {
    return [];
  }
  return frames.map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    url: frame.url,
    errorOccurred: frame.errorOccurred,
  }));
}

async function grantedOrigins(): Promise<string[] | undefined> {
  try {
    const permissions = await chrome.permissions.getAll();
    return permissions.origins ?? [];
  } catch {
    // Unknown is not the same as none: without this, every frame would be
    // blamed on a missing permission we never actually checked.
    return undefined;
  }
}

function askFrame(tabId: number, frameId: number): Promise<GetSectionInfoResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: GetSectionInfoResponse | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(null), FRAME_SCAN_TIMEOUT_MS);

    chrome.tabs
      .sendMessage(tabId, { type: MESSAGE_TYPE.GET_SECTION_INFO }, { frameId })
      .then((response: GetSectionInfoResponse | undefined) => {
        clearTimeout(timer);
        finish(response ?? null);
      })
      .catch(() => {
        // No receiver in that frame — normal for a frame with no content
        // script. Classified by the caller, never silently dropped.
        clearTimeout(timer);
        finish(null);
      });
  });
}

// The single entry point the sidepanel uses. Enumerate → fan out → reconcile
// → merge. Every step's failure mode is recorded, not swallowed.
async function scanAllFrames(tabId: number): Promise<MergedScan & { error?: string }> {
  // B5 — restore generation counters before the first decision that uses them.
  await hydrateGenerations();
  const tree = await getFrameTree(tabId);
  const { removed } = registry.reconcile(tabId, tree);
  removed.forEach((frame) => {
    debugLog(
      `[EasyFilla] frame ${frame.frameId} is gone (${frame.url})` +
        (frame.hadScan ? " — its scanned fields and any answers for them are dropped." : "."),
    );
  });

  // Fan out to every frame in the tree at once. A slow frame delays the scan
  // by at most FRAME_SCAN_TIMEOUT_MS, not by the sum of all frames.
  const responses = await Promise.all(
    tree.map(async (entry) => ({ entry, response: await askFrame(tabId, entry.frameId) })),
  );

  // PASS 1 — record everything that answered with a known identity. A frame
  // that answered but has NOT completed its identity handshake is treated as
  // inaccessible, not as an empty frame: its fields would carry a colliding
  // identity key, and dedup would then delete real fields from another frame.
  for (const { entry, response } of responses) {
    if (!response?.identified) {
      continue;
    }
    const scan: FrameScanResult = {
      frameId: response.frameId,
      url: entry.url,
      adapter: response.adapter,
      formTitle: response.formTitle,
      sectionTitle: response.sectionTitle,
      hasNext: response.hasNext,
      langHint: response.langHint,
      questions: response.questions,
      childFrames: response.childFrames,
      selfIframeIndex: response.selfIframeIndex,
      fingerprint: response.fingerprint,
    };
    registry.recordScan(tabId, entry.frameId, scan);
  }

  // PASS 2 — classify the silent ones. Runs second so it can consult THIS
  // pass's parent scans (for the sandbox attribute) rather than a stale one.
  const origins = await grantedOrigins();
  const scans = registry.scans(tabId);
  const { placements } = resolveFramePlacements(tree, scans);
  const placementByFrame = new Map(placements.map((placement) => [placement.frameId, placement]));

  for (const { entry, response } of responses) {
    if (response?.identified) {
      continue;
    }

    // The parent's view of this <iframe> element carries the sandbox
    // attribute — the one permanent, never-retry cause.
    const placement = placementByFrame.get(entry.frameId);
    const parentScan = scans.get(entry.parentFrameId);
    const ref =
      placement?.iframeIndex !== null && placement?.iframeIndex !== undefined
        ? parentScan?.childFrames.find((child) => child.iframeIndex === placement.iframeIndex) ?? null
        : null;

    const info = classifyInaccessibleFrame({
      entry,
      ref,
      ...(origins ? { grantedOrigins: origins } : {}),
      timedOut: response === null,
    });
    if (response && !response.identified) {
      info.reason = "no-content-script";
      info.detail =
        response.unidentifiedReason ??
        "the content script in this frame never learned its frameId, so it refused to scan " +
          "(scanning unidentified would collide in the dedup keyspace and delete another frame's fields)";
      info.retryable = true;
    }
    registry.recordInaccessible(tabId, entry.frameId, info);
  }

  const merged = mergeFrameScans({
    tree,
    scans: registry.scans(tabId),
    inaccessible: registry.inaccessible(tabId),
    generations: registry.generations(tabId),
  });

  console.log(`[EasyFilla] merged scan for tab ${tabId}:\n${describeFrameCoverage(merged)}`);
  return merged;
}
