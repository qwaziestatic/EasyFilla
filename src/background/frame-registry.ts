// ─────────────────────────────────────────────────────────────────────────
// FRAME REGISTRY AND MERGE (STAGE 2a)
//
// Most real application portals — Workday, Taleo, Greenhouse, SuccessFactors —
// render their form inside one or more cross-origin iframes. Before this
// module the extension scanned only the top document and reported nothing on
// those sites.
//
// This file is DELIBERATELY FREE OF CHROME APIS AND DOM. It is the decision
// layer: given a frame tree and what each frame reported, it decides the
// merged order, what was deduplicated, and which frames are inaccessible and
// why. service-worker.ts is the thin adapter that feeds it real browser data.
// Keeping the split means the hard parts are testable with `node tests/run.mjs`
// (see tests/frames.test.mjs) instead of only in a live browser.
// ─────────────────────────────────────────────────────────────────────────

import { dedupeByIdentity } from "../content-scripts/adapters/identity";
import type { AdapterName, ChildFrameRef, FrameQuestion } from "../lib/messaging/messages";
import type { CoverageReport } from "../content-scripts/adapters/adapter";

// What chrome.webNavigation.getAllFrames() gives us, narrowed to the fields
// the merge actually uses. The frame TREE is browser truth; what frames
// reported is a separate, fallible thing, and the whole point of reconciling
// is that the two can disagree.
export interface FrameTreeEntry {
  frameId: number;
  parentFrameId: number; // -1 for the main frame
  url: string;
  errorOccurred: boolean;
}

// One frame's scan, as reported by its content script.
export interface FrameScanResult {
  frameId: number;
  url: string;
  adapter: AdapterName;
  formTitle: string;
  sectionTitle: string | null;
  hasNext: boolean;
  langHint: string | null;
  questions: FrameQuestion[];
  childFrames: ChildFrameRef[];
  selfIframeIndex: number | null;
  coverage?: CoverageReport;
  fingerprint: string;
}

export type InaccessibleReason =
  | "sandboxed-without-allow-scripts"
  | "load-error"
  | "no-host-access"
  | "no-content-script"
  | "scan-timeout"
  | "scan-error";

export interface InaccessibleFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
  reason: InaccessibleReason;
  detail: string;
  // False for permanent conditions. A sandbox without allow-scripts will
  // never run a content script; retrying it forever burns time on every scan
  // and buries the real message ("this part of the form cannot be automated").
  retryable: boolean;
}

// How a frame's position among its siblings was established.
export type FrameOrderMethod =
  | "root"
  | "frame-element" // exact: child read window.frameElement (same-origin parent)
  | "src-match" // heuristic: parent's iframe src matched the frame's url
  | "unresolved"; // fell back to depth + frameId; reported, never hidden

export interface FramePlacement {
  frameId: number;
  parentFrameId: number;
  depth: number;
  method: FrameOrderMethod;
  iframeIndex: number | null;
  // The `order` of the owning <iframe> inside the parent's item sequence, so
  // the child's questions can be spliced in at the right point.
  slotOrder: number | null;
  note?: string;
}

export interface MergedQuestion extends FrameQuestion {
  frameId: number;
  frameUrl: string;
  frameGeneration: number;
}

export interface FrameCoverage {
  frameId: number;
  parentFrameId: number;
  depth: number;
  url: string;
  scanned: boolean;
  fieldCount: number;
  manualOnlyCount: number;
  orderMethod: FrameOrderMethod;
  inaccessibleReason?: InaccessibleReason;
  inaccessibleDetail?: string;
}

export interface MergedScan {
  questions: MergedQuestion[];
  duplicatesCollapsed: { questionText: string; frameId: number; duplicateOf: string }[];
  frames: FrameCoverage[];
  inaccessible: InaccessibleFrame[];
  placements: FramePlacement[];
  // Ordering problems stated in plain language. The heuristic is best-effort
  // by nature; when it cannot resolve a frame's slot it SAYS SO here rather
  // than silently emitting a plausible-looking wrong order.
  orderingWarnings: string[];
  formTitle: string;
  sectionTitle: string | null;
  langHint: string | null;
  adapter: AdapterName;
  // Which frame should receive CLICK_NAV. Prefers the frame that owns the
  // fields; the submit-safety guard still runs inside whichever frame fires.
  navFrameId: number | null;
  hasNext: boolean;
  fingerprint: string;
}

// ── URL matching for the ordering heuristic ──────────────────────────────
// Progressively looser tiers. A tier that yields EXACTLY ONE candidate wins;
// a tier that yields several is ambiguous and stops the search rather than
// falling through to something even looser (a looser tier cannot disambiguate
// what a stricter one already found twice).

function stripHash(url: string): string {
  const index = url.indexOf("#");
  return index === -1 ? url : url.slice(0, index);
}

function originAndPath(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i.exec(url);
  return match ? `${match[1]}${match[2]}` : null;
}

function originOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url);
  return match?.[1] ?? null;
}

type UrlTier = (url: string) => string | null;

const URL_TIERS: { name: string; project: UrlTier }[] = [
  { name: "exact src", project: (url) => (url ? url : null) },
  { name: "src ignoring #fragment", project: (url) => (url ? stripHash(url) : null) },
  { name: "origin + path", project: originAndPath },
  { name: "origin only", project: originOf },
];

interface SrcMatch {
  ref: ChildFrameRef | null;
  tier: string | null;
  ambiguous: boolean;
}

function matchChildBySrc(candidates: ChildFrameRef[], frameUrl: string): SrcMatch {
  for (const tier of URL_TIERS) {
    const wanted = tier.project(frameUrl);
    if (!wanted) {
      continue;
    }
    const hits = candidates.filter((ref) => ref.src && tier.project(ref.src) === wanted);
    if (hits.length === 1) {
      return { ref: hits[0] ?? null, tier: tier.name, ambiguous: false };
    }
    if (hits.length > 1) {
      // Two sibling iframes pointing at the same place. Looser matching can
      // only make this worse, so stop and report ambiguity honestly.
      return { ref: null, tier: tier.name, ambiguous: true };
    }
  }
  return { ref: null, tier: null, ambiguous: false };
}

// ── Placement ────────────────────────────────────────────────────────────

function depthOf(frameId: number, byId: Map<number, FrameTreeEntry>): number {
  let depth = 0;
  let current = byId.get(frameId);
  const guard = new Set<number>();
  while (current && current.parentFrameId >= 0 && !guard.has(current.frameId)) {
    guard.add(current.frameId);
    depth += 1;
    current = byId.get(current.parentFrameId);
  }
  return depth;
}

export function resolveFramePlacements(
  tree: FrameTreeEntry[],
  scans: Map<number, FrameScanResult>,
): { placements: FramePlacement[]; warnings: string[] } {
  const byId = new Map(tree.map((entry) => [entry.frameId, entry]));
  const placements: FramePlacement[] = [];
  const warnings: string[] = [];

  for (const entry of tree) {
    const depth = depthOf(entry.frameId, byId);

    if (entry.parentFrameId < 0) {
      placements.push({
        frameId: entry.frameId,
        parentFrameId: entry.parentFrameId,
        depth,
        method: "root",
        iframeIndex: null,
        slotOrder: null,
      });
      continue;
    }

    const parentScan = scans.get(entry.parentFrameId);
    const ownScan = scans.get(entry.frameId);

    if (!parentScan) {
      const note = `parent frame ${entry.parentFrameId} did not report, so this frame's position in it is unknown`;
      placements.push({
        frameId: entry.frameId,
        parentFrameId: entry.parentFrameId,
        depth,
        method: "unresolved",
        iframeIndex: null,
        slotOrder: null,
        note,
      });
      warnings.push(`Frame ${entry.frameId} (${entry.url}): ${note}.`);
      continue;
    }

    // EXACT path: the child read window.frameElement, which only works when
    // the parent document is same-origin. No guessing involved.
    if (ownScan && ownScan.selfIframeIndex !== null) {
      const ref = parentScan.childFrames.find((child) => child.iframeIndex === ownScan.selfIframeIndex);
      if (ref) {
        placements.push({
          frameId: entry.frameId,
          parentFrameId: entry.parentFrameId,
          depth,
          method: "frame-element",
          iframeIndex: ref.iframeIndex,
          slotOrder: ref.order,
        });
        continue;
      }
    }

    // HEURISTIC path: cross-origin. All we can do is match what the parent
    // says the iframe's src is against where the frame actually ended up.
    const match = matchChildBySrc(parentScan.childFrames, entry.url);
    if (match.ref) {
      placements.push({
        frameId: entry.frameId,
        parentFrameId: entry.parentFrameId,
        depth,
        method: "src-match",
        iframeIndex: match.ref.iframeIndex,
        slotOrder: match.ref.order,
        note: `matched on ${match.tier}`,
      });
      continue;
    }

    const note = match.ambiguous
      ? `several <iframe> elements in frame ${entry.parentFrameId} share this src (matched on ${match.tier}), so which one this is cannot be told apart`
      : `no <iframe> in frame ${entry.parentFrameId} has a src matching this frame's url — the usual cause is a redirect after load, which leaves src and url permanently different`;
    placements.push({
      frameId: entry.frameId,
      parentFrameId: entry.parentFrameId,
      depth,
      method: "unresolved",
      iframeIndex: null,
      slotOrder: null,
      note,
    });
    warnings.push(
      `Frame ${entry.frameId} (${entry.url}) could not be placed within its parent: ${note}. ` +
        "Its questions are appended after its parent's instead of being interleaved, so their ORDER may be wrong. " +
        "The questions themselves are complete.",
    );
  }

  return { placements, warnings };
}

// ── Merge ────────────────────────────────────────────────────────────────

export interface MergeInput {
  tree: FrameTreeEntry[];
  scans: Map<number, FrameScanResult>;
  inaccessible: InaccessibleFrame[];
  // frameId → generation counter, so an answer can be refused if its frame
  // navigated between scan and fill.
  generations?: Map<number, number>;
}

export function mergeFrameScans(input: MergeInput): MergedScan {
  const { tree, scans, inaccessible } = input;
  const generations = input.generations ?? new Map<number, number>();
  const { placements, warnings } = resolveFramePlacements(tree, scans);
  const placementByFrame = new Map(placements.map((placement) => [placement.frameId, placement]));

  const childrenOf = new Map<number, FrameTreeEntry[]>();
  for (const entry of tree) {
    if (entry.parentFrameId < 0) {
      continue;
    }
    childrenOf.set(entry.parentFrameId, [...(childrenOf.get(entry.parentFrameId) ?? []), entry]);
  }

  const roots = tree.filter((entry) => entry.parentFrameId < 0 || !tree.some((o) => o.frameId === entry.parentFrameId));

  // Depth-first walk. Within a frame, items are its own questions plus a slot
  // marker per resolvable child frame, all sorted by the document-order index
  // the frame computed over (fields ∪ iframes). Children whose slot could not
  // be resolved are appended at the end of their parent's items, ordered by
  // depth then frameId — deterministic, and flagged in `orderingWarnings`.
  const ordered: MergedQuestion[] = [];
  const visited = new Set<number>();

  const walk = (frameId: number): void => {
    if (visited.has(frameId)) {
      return; // frame trees are acyclic, but never trust that with a while loop
    }
    visited.add(frameId);

    const scan = scans.get(frameId);
    const children = [...(childrenOf.get(frameId) ?? [])];

    type Item =
      | { order: number; tiebreak: number; kind: "question"; question: MergedQuestion }
      | { order: number; tiebreak: number; kind: "frame"; frameId: number };

    const items: Item[] = [];

    if (scan) {
      scan.questions.forEach((question, index) => {
        items.push({
          order: question.order,
          tiebreak: index,
          kind: "question",
          question: {
            ...question,
            frameId,
            frameUrl: scan.url,
            frameGeneration: generations.get(frameId) ?? 0,
          },
        });
      });
    }

    const unplaced: FrameTreeEntry[] = [];
    for (const child of children) {
      const placement = placementByFrame.get(child.frameId);
      if (placement && placement.slotOrder !== null) {
        items.push({
          order: placement.slotOrder,
          // A child frame sits AFTER a field that shares its order index only
          // by accident; document order already separated them, so the
          // tiebreak just keeps the sort stable and deterministic.
          tiebreak: placement.iframeIndex ?? 0,
          kind: "frame",
          frameId: child.frameId,
        });
      } else {
        unplaced.push(child);
      }
    }

    items.sort((a, b) => (a.order === b.order ? a.tiebreak - b.tiebreak : a.order - b.order));

    for (const item of items) {
      if (item.kind === "question") {
        ordered.push(item.question);
      } else {
        walk(item.frameId);
      }
    }

    unplaced
      .sort((a, b) => {
        const depthA = placementByFrame.get(a.frameId)?.depth ?? 0;
        const depthB = placementByFrame.get(b.frameId)?.depth ?? 0;
        return depthA === depthB ? a.frameId - b.frameId : depthA - depthB;
      })
      .forEach((child) => walk(child.frameId));
  };

  roots
    .sort((a, b) => a.frameId - b.frameId)
    .forEach((root) => walk(root.frameId));

  // Any frame the walk never reached (its parent is missing from the tree
  // entirely) still deserves to have its fields reported.
  for (const entry of tree) {
    if (!visited.has(entry.frameId)) {
      walk(entry.frameId);
    }
  }

  // ── DEDUP ──
  // Runs on the MERGED list, using the existing identity key. Never on label
  // text: portals repeat labels per row, and two frames legitimately holding
  // an "Email" field are two fields, not one. The key already begins with
  // frameId, so cross-frame collisions can only happen if a frame failed to
  // identify itself — which is precisely why an unidentified frame refuses to
  // scan at all.
  const shaped = ordered.map((question) => ({ ...question, identity: { key: question.identityKey } }));
  const { kept, removed } = dedupeByIdentity(shaped);
  const questions: MergedQuestion[] = kept.map(({ identity: _identity, ...question }) => question);
  const duplicatesCollapsed = removed.map(({ item, duplicateOf }) => ({
    questionText: item.questionText,
    frameId: item.frameId,
    duplicateOf,
  }));

  // ── PER-FRAME COVERAGE ──
  const inaccessibleByFrame = new Map(inaccessible.map((frame) => [frame.frameId, frame]));
  const fieldsByFrame = new Map<number, MergedQuestion[]>();
  questions.forEach((question) => {
    fieldsByFrame.set(question.frameId, [...(fieldsByFrame.get(question.frameId) ?? []), question]);
  });

  const frames: FrameCoverage[] = tree.map((entry) => {
    const placement = placementByFrame.get(entry.frameId);
    const scan = scans.get(entry.frameId);
    const mine = fieldsByFrame.get(entry.frameId) ?? [];
    const blocked = inaccessibleByFrame.get(entry.frameId);
    const coverage: FrameCoverage = {
      frameId: entry.frameId,
      parentFrameId: entry.parentFrameId,
      depth: placement?.depth ?? 0,
      url: entry.url,
      scanned: Boolean(scan),
      fieldCount: mine.length,
      manualOnlyCount: mine.filter((question) => question.manualOnly).length,
      orderMethod: placement?.method ?? "unresolved",
    };
    if (blocked) {
      coverage.inaccessibleReason = blocked.reason;
      coverage.inaccessibleDetail = blocked.detail;
    }
    return coverage;
  });

  // ── NAV FRAME ──
  // The Next/Continue control often lives in the PARENT page chrome while the
  // fields live in an embedded child — so "search all frames" is not optional.
  // Preference goes to the frame that owns the FORM, measured by how many
  // fillable (non-manual-only) fields it has: a host page whose only field is
  // a login password must not outrank the frame holding the application.
  // The submit-safety guard runs inside whichever frame is asked, unchanged,
  // so this choice can never promote a submit control.
  const withNext = tree
    .map((entry) => ({ entry, scan: scans.get(entry.frameId) }))
    .filter((row): row is { entry: FrameTreeEntry; scan: FrameScanResult } => Boolean(row.scan?.hasNext));
  const ranked = [...withNext].sort((a, b) => {
    const fieldsA = fieldsByFrame.get(a.entry.frameId) ?? [];
    const fieldsB = fieldsByFrame.get(b.entry.frameId) ?? [];
    const fillableA = fieldsA.filter((question) => !question.manualOnly).length;
    const fillableB = fieldsB.filter((question) => !question.manualOnly).length;
    if (fillableA !== fillableB) {
      return fillableB - fillableA;
    }
    if (fieldsA.length !== fieldsB.length) {
      return fieldsB.length - fieldsA.length;
    }
    return a.entry.frameId - b.entry.frameId;
  });
  const navFrameId = ranked[0]?.entry.frameId ?? null;

  // Title/lang come from the frame that actually owns the form: the one with
  // the most fields, falling back to the main frame. On a portal the top
  // document's <title> is often site chrome ("Careers"), while the embedded
  // application frame carries the real one.
  const richest = [...fieldsByFrame.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const mainScan = scans.get(roots[0]?.frameId ?? 0);
  const titleScan = (richest !== undefined ? scans.get(richest) : undefined) ?? mainScan;

  const fingerprint = [
    String(questions.length),
    ...tree.map((entry) => `${entry.frameId}:${scans.get(entry.frameId)?.fingerprint ?? "-"}`),
  ].join("|");

  return {
    questions,
    duplicatesCollapsed,
    frames,
    inaccessible,
    placements,
    orderingWarnings: warnings,
    formTitle: mainScan?.formTitle ?? titleScan?.formTitle ?? "",
    sectionTitle: titleScan?.sectionTitle ?? mainScan?.sectionTitle ?? null,
    langHint: titleScan?.langHint ?? mainScan?.langHint ?? null,
    adapter: titleScan?.adapter ?? mainScan?.adapter ?? "generic",
    navFrameId,
    hasNext: navFrameId !== null,
    fingerprint,
  };
}

// ── Inaccessibility classification ───────────────────────────────────────
// A frame present in the tree but silent is INACCESSIBLE. It is recorded with
// a reason — never silently omitted, which is how "the form has 8 fields"
// became a confident lie about a 40-field application.

export interface ClassifyInput {
  entry: FrameTreeEntry;
  // The parent's view of this iframe element, when the parent reported and
  // the frame could be placed. Carries the sandbox attribute.
  ref: ChildFrameRef | null;
  // Origins the extension currently holds host access for. Undefined means
  // "unknown" and suppresses the no-host-access verdict rather than guessing.
  grantedOrigins?: string[];
  timedOut: boolean;
}

function hasAllowScripts(sandbox: string): boolean {
  return sandbox
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .includes("allow-scripts");
}

// Does any granted host permission cover this frame's URL?
//
// Chrome match patterns are `<scheme>://<host><path>`: scheme may be `*`, host
// may be `*` or `*.suffix`, the port is ignored, and THE PATH IS PART OF THE
// PATTERN. That last point is load-bearing — `https://docs.google.com/forms/*`
// does NOT grant `https://docs.google.com/picker`, which is precisely where
// Google Forms puts its Drive-picker child frame. An origin-only check would
// call that frame covered, classify its silence as "no-content-script", and
// bury the one message that would have fixed it ("grant access to this origin").
//
// Getting this wrong permissively hides a real Grant-access prompt behind a
// vague timeout; getting it wrong strictly blames the user for a permission
// they already gave. So it is parsed, not regex-approximated.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function patternCoversUrl(url: string, patterns: string[]): boolean {
  const parsed = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (!parsed) {
    // about:blank / srcdoc / data: — these inherit their parent's access, so
    // there is no separate grant to ask for.
    return true;
  }
  const scheme = (parsed[1] ?? "").toLowerCase();
  const host = (parsed[2] ?? "").toLowerCase().replace(/:\d+$/, "");
  const path = parsed[3] || "/";

  return patterns.some((pattern) => {
    if (pattern === "<all_urls>") {
      return true;
    }
    const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
    if (!match) {
      return false;
    }
    const patternScheme = (match[1] ?? "").toLowerCase();
    const patternHost = (match[2] ?? "").toLowerCase().replace(/:\d+$/, "");
    // A pattern with no path component grants the whole host, matching how
    // chrome.permissions reports origins.
    const patternPath = match[3] ?? "/*";

    if (patternScheme !== "*" && patternScheme !== scheme) {
      return false;
    }
    if (patternHost !== "*") {
      if (patternHost.startsWith("*.")) {
        const suffix = patternHost.slice(2);
        if (host !== suffix && !host.endsWith(`.${suffix}`)) {
          return false;
        }
      } else if (patternHost !== host) {
        return false;
      }
    }
    return globToRegExp(patternPath).test(path);
  });
}

export function classifyInaccessibleFrame(input: ClassifyInput): InaccessibleFrame {
  const { entry, ref, grantedOrigins, timedOut } = input;
  const base = { frameId: entry.frameId, parentFrameId: entry.parentFrameId, url: entry.url };

  // PERMANENT: a sandbox without allow-scripts cannot execute a content
  // script. Not retryable — retrying it every scan wastes the timeout budget
  // and hides the real message.
  if (ref?.sandbox !== null && ref?.sandbox !== undefined && !hasAllowScripts(ref.sandbox)) {
    return {
      ...base,
      reason: "sandboxed-without-allow-scripts",
      detail:
        `this <iframe> is sandboxed as "${ref.sandbox}", which forbids scripts — ` +
        "no extension can read or fill it. Any fields inside must be completed by hand.",
      retryable: false,
    };
  }

  if (entry.errorOccurred) {
    return {
      ...base,
      reason: "load-error",
      detail: "the browser reported this frame failed to load, so there is nothing in it to read",
      retryable: true,
    };
  }

  if (grantedOrigins && !patternCoversUrl(entry.url, grantedOrigins)) {
    return {
      ...base,
      reason: "no-host-access",
      detail:
        `EasyFilla has no host access to ${originOf(entry.url) ?? entry.url}, so it cannot inject into this frame. ` +
        "Grant access to that origin to include its fields.",
      retryable: true,
    };
  }

  if (timedOut) {
    return {
      ...base,
      reason: "scan-timeout",
      detail: "the content script in this frame did not answer in time",
      retryable: true,
    };
  }

  return {
    ...base,
    reason: "no-content-script",
    detail: "no content script is running in this frame (it may still be loading, or injection was refused)",
    retryable: true,
  };
}

// ── Registry ─────────────────────────────────────────────────────────────
// Map<tabId, Map<frameId, FrameRecord>>, exactly as specified. Lifecycle is
// pure state transitions here; the chrome event wiring lives in the worker.

export interface FrameRecord {
  tabId: number;
  frameId: number;
  parentFrameId: number;
  url: string;
  // Bumped on every committed navigation in this frame. An answer produced
  // against generation N must never be written into generation N+1 — that is
  // filling a stale frameId with someone else's answers.
  generation: number;
  helloAt: number | null;
  scan: FrameScanResult | null;
  scannedAtGeneration: number | null;
  inaccessible: InaccessibleFrame | null;
}

export interface RemovedFrame {
  frameId: number;
  url: string;
  hadScan: boolean;
}

export class FrameRegistry {
  private readonly tabs = new Map<number, Map<number, FrameRecord>>();

  private frames(tabId: number): Map<number, FrameRecord> {
    const existing = this.tabs.get(tabId);
    if (existing) {
      return existing;
    }
    const created = new Map<number, FrameRecord>();
    this.tabs.set(tabId, created);
    return created;
  }

  private ensure(tabId: number, frameId: number): FrameRecord {
    const frames = this.frames(tabId);
    const existing = frames.get(frameId);
    if (existing) {
      return existing;
    }
    const created: FrameRecord = {
      tabId,
      frameId,
      parentFrameId: frameId === 0 ? -1 : 0,
      url: "",
      generation: 0,
      helloAt: null,
      scan: null,
      scannedAtGeneration: null,
      inaccessible: null,
    };
    frames.set(frameId, created);
    return created;
  }

  get(tabId: number, frameId: number): FrameRecord | undefined {
    return this.tabs.get(tabId)?.get(frameId);
  }

  all(tabId: number): FrameRecord[] {
    return [...(this.tabs.get(tabId)?.values() ?? [])];
  }

  generations(tabId: number): Map<number, number> {
    return new Map(this.all(tabId).map((record) => [record.frameId, record.generation]));
  }

  // A frame said hello. This is the ONLY moment a frame learns its own id,
  // and the id comes from the browser (sender.frameId), never from the frame.
  noteHello(tabId: number, frameId: number, url: string, at = Date.now()): FrameRecord {
    const record = this.ensure(tabId, frameId);
    record.url = url || record.url;
    record.helloAt = at;
    record.inaccessible = null;
    return record;
  }

  recordScan(tabId: number, frameId: number, scan: FrameScanResult): void {
    const record = this.ensure(tabId, frameId);
    record.scan = scan;
    record.scannedAtGeneration = record.generation;
    record.url = scan.url || record.url;
    record.inaccessible = null;
  }

  recordInaccessible(tabId: number, frameId: number, info: InaccessibleFrame): void {
    const record = this.ensure(tabId, frameId);
    record.inaccessible = info;
    record.scan = null;
    record.scannedAtGeneration = null;
  }

  // A frame navigated. Its cached scan and any answers keyed to it are now
  // stale: the DOM they were computed against is gone. Bumping the generation
  // is what makes a stale fill IMPOSSIBLE rather than merely unlikely.
  noteNavigated(tabId: number, frameId: number, url: string): FrameRecord {
    const record = this.ensure(tabId, frameId);
    record.generation += 1;
    record.url = url || record.url;
    record.scan = null;
    record.scannedAtGeneration = null;
    record.helloAt = null;
    record.inaccessible = null;
    return record;
  }

  // Reconcile against browser truth. Frames in the tree are created (silent
  // ones stay scan-less, to be classified); frames NOT in the tree are gone
  // and are dropped, so nothing can route a fill into them.
  reconcile(tabId: number, tree: FrameTreeEntry[]): { removed: RemovedFrame[] } {
    const frames = this.frames(tabId);
    const live = new Set(tree.map((entry) => entry.frameId));

    for (const entry of tree) {
      const record = this.ensure(tabId, entry.frameId);
      record.parentFrameId = entry.parentFrameId;
      if (entry.url) {
        record.url = entry.url;
      }
    }

    const removed: RemovedFrame[] = [];
    for (const [frameId, record] of [...frames.entries()]) {
      if (!live.has(frameId)) {
        removed.push({ frameId, url: record.url, hadScan: Boolean(record.scan) });
        frames.delete(frameId);
      }
    }
    return { removed };
  }

  removeTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  // ── B5: MV3 TERMINATION SURVIVAL ───────────────────────────────────────
  // An MV3 service worker is killed after ~30s idle and restarted on the next
  // event, so everything above is volatile. Cached SCANS being lost is
  // harmless — `scanAllFrames` re-enumerates and re-fans-out every time.
  //
  // The GENERATION COUNTERS are different: they are the stale-fill guard
  // (§3c). Losing them resets every frame to 0, which makes previously-issued
  // answers look mismatched — safe (they degrade to the FIX 1 strict label
  // path) but needlessly lossy, turning precise structural fills into
  // ambiguity refusals after an idle gap the user never noticed.
  //
  // So generations, and only generations, are persisted. They are integers
  // keyed by frameId — no URLs, no page content, nothing about what the user
  // was filling.
  exportGenerations(): Record<number, Record<number, number>> {
    const out: Record<number, Record<number, number>> = {};
    for (const [tabId, frames] of this.tabs) {
      const perTab: Record<number, number> = {};
      for (const [frameId, record] of frames) {
        if (record.generation > 0) {
          perTab[frameId] = record.generation;
        }
      }
      if (Object.keys(perTab).length > 0) {
        out[tabId] = perTab;
      }
    }
    return out;
  }

  // Restores counters into a fresh registry. Never LOWERS a live counter: if
  // this worker instance has already observed a navigation, its own count is
  // the newer truth and the stored one is stale.
  importGenerations(stored: Record<number, Record<number, number>>): void {
    for (const [tabKey, frames] of Object.entries(stored)) {
      const tabId = Number(tabKey);
      if (!Number.isFinite(tabId)) {
        continue;
      }
      for (const [frameKey, generation] of Object.entries(frames)) {
        const frameId = Number(frameKey);
        if (!Number.isFinite(frameId) || typeof generation !== "number") {
          continue;
        }
        const record = this.ensure(tabId, frameId);
        record.generation = Math.max(record.generation, generation);
      }
    }
  }

  // Is this frame still the same document the answer was written against?
  // Used before routing a fill; a mismatch is refused with a clear reason
  // rather than written into whatever loaded since.
  isCurrent(tabId: number, frameId: number, generation: number): { ok: boolean; reason?: string } {
    const record = this.get(tabId, frameId);
    if (!record) {
      return { ok: false, reason: `frame ${frameId} no longer exists on this page` };
    }
    if (record.generation !== generation) {
      return {
        ok: false,
        reason: `frame ${frameId} navigated after the scan (generation ${generation} → ${record.generation})`,
      };
    }
    return { ok: true };
  }

  scans(tabId: number): Map<number, FrameScanResult> {
    const result = new Map<number, FrameScanResult>();
    for (const record of this.all(tabId)) {
      if (record.scan) {
        result.set(record.frameId, record.scan);
      }
    }
    return result;
  }

  inaccessible(tabId: number): InaccessibleFrame[] {
    return this.all(tabId)
      .map((record) => record.inaccessible)
      .filter((info): info is InaccessibleFrame => info !== null);
  }
}

// ── Human-readable coverage ──────────────────────────────────────────────

export function describeFrameCoverage(merged: MergedScan): string {
  const scanned = merged.frames.filter((frame) => frame.scanned);
  const blocked = merged.frames.filter((frame) => frame.inaccessibleReason);
  const lines = [
    `Frames found: ${merged.frames.length} · scanned: ${scanned.length} · inaccessible: ${blocked.length}`,
    ...scanned.map(
      (frame) =>
        `  frame ${frame.frameId} (depth ${frame.depth}, order via ${frame.orderMethod}): ` +
        `${frame.fieldCount} field(s)` +
        (frame.manualOnlyCount > 0 ? `, ${frame.manualOnlyCount} manual-only` : "") +
        ` — ${frame.url}`,
    ),
    ...blocked.map((frame) => `  frame ${frame.frameId}: INACCESSIBLE (${frame.inaccessibleReason}) — ${frame.inaccessibleDetail}`),
  ];
  if (merged.duplicatesCollapsed.length > 0) {
    lines.push(`  ${merged.duplicatesCollapsed.length} duplicate field(s) collapsed on identity key`);
  }
  merged.orderingWarnings.forEach((warning) => lines.push(`  ORDERING: ${warning}`));
  return lines.join("\n");
}
