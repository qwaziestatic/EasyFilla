// ─────────────────────────────────────────────────────────────────────────
// TASK D2 — MULTI-VARIANT DRAFTS
//
// The invariant that matters (§3, §6b.5): variants are alternative PROSE over
// ONE evidence set. An evidence-empty compose is `notFound` no matter how many
// variants came back — three fluent drafts of an ungrounded answer are three
// fabrications, not a choice.
//
// Also asserted: N variants cost ONE request, not N. §4c's binding constraint is
// the daily request ceiling, so this is a budget invariant as much as a UX one.
// ─────────────────────────────────────────────────────────────────────────

const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key ?? {});
        const out = {};
        keys.forEach((k) => {
          if (storage.has(k)) out[k] = storage.get(k);
        });
        return out;
      },
      set: async (items) => {
        Object.entries(items).forEach(([k, v]) => storage.set(k, v));
      },
      remove: async (key) => {
        (Array.isArray(key) ? key : [key]).forEach((k) => storage.delete(k));
      },
    },
    session: { get: async () => ({}), set: async () => {} },
  },
};
storage.set("geminiApiKey", "TEST-KEY-NOT-A-REAL-SECRET");

const recorded = [];
let respondWith = () => [];

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  recorded.push({ url: String(url), body });
  const payload = {
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(respondWith()) }] }],
  };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const { composeAnswers } = await import("./_bundle-orchestration.mjs");

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const item = (overrides = {}) => ({
  index: 0,
  questionText: "Why do you want this role?",
  isEssay: true,
  seed: "worked on distributed systems; want more impact",
  guidance: "",
  length: "medium",
  tone: "neutral",
  variants: 1,
  ...overrides,
});

/** Finds the schema actually sent on the wire, on either transport. */
function sentSchema(body) {
  return body?.response_format?.schema ?? body?.generationConfig?.responseSchema ?? null;
}

console.log("\n=== D2: N variants cost ONE request, not N ===");
{
  recorded.length = 0;
  respondWith = () => [
    {
      questionIndex: 0,
      draft: "First framing of the answer.",
      drafts: ["First framing of the answer.", "Second framing, same facts.", "Third framing, same facts."],
      notFound: false,
      sourced: true,
      seedUsed: true,
      groundedDocuments: ["cv.pdf"],
      gaps: [],
    },
  ];
  const results = await composeAnswers("cv.pdf contents", ["cv.pdf"], [item({ variants: 3 })], {});

  check("⚠️ exactly ONE request was made for three drafts", recorded.length === 1, `${recorded.length} request(s)`);
  const result = results.get(0);
  check("three variants came back", result.variants.length === 3, JSON.stringify(result.variants));
  check(
    "the primary draft IS the first variant, so existing callers are unaffected",
    result.variants[0] === result.draft,
    `draft="${result.draft}" first="${result.variants[0]}"`,
  );
  check("the variants are distinct", new Set(result.variants).size === 3);
}

console.log("\n=== D2: the variant schema is requested ONLY when variants > 1 ===");
{
  // This is what keeps the orchestration golden byte-identical: the common
  // single-draft compose must send exactly the bytes it always sent.
  recorded.length = 0;
  respondWith = () => [
    {
      questionIndex: 0,
      draft: "One draft.",
      notFound: false,
      sourced: true,
      seedUsed: true,
      groundedDocuments: ["cv.pdf"],
      gaps: [],
    },
  ];
  await composeAnswers("cv.pdf contents", ["cv.pdf"], [item({ variants: 1 })], {});
  const single = sentSchema(recorded[0]?.body);
  check("a single-draft compose does NOT ask for a drafts array", !("drafts" in (single?.items?.properties ?? {})));
  check(
    "and does not require one",
    !(single?.items?.required ?? []).includes("drafts"),
    JSON.stringify(single?.items?.required),
  );

  recorded.length = 0;
  await composeAnswers("cv.pdf contents", ["cv.pdf"], [item({ variants: 2 })], {});
  const multi = sentSchema(recorded[0]?.body);
  check("a multi-variant compose DOES ask for a drafts array", "drafts" in (multi?.items?.properties ?? {}));
  check("and requires it", (multi?.items?.required ?? []).includes("drafts"));
  check(
    "⚠️ the evidence fields are NOT duplicated per draft",
    !("groundedDocuments" in (multi?.items?.properties?.drafts?.items ?? {})) &&
      multi?.items?.properties?.drafts?.items?.type === "string",
    "per-variant evidence would let a picked variant carry a different claim than the one verified",
  );
}

console.log("\n=== D2 PROVENANCE INVARIANT: no amount of variants rescues an ungrounded answer ===");
{
  // The model returns THREE fluent drafts while declaring notFound. §3 decides
  // structurally, so the count must not matter.
  recorded.length = 0;
  respondWith = () => [
    {
      questionIndex: 0,
      draft: "A confident, well-written, entirely ungrounded paragraph.",
      drafts: [
        "A confident, well-written, entirely ungrounded paragraph.",
        "A second fluent paragraph with no basis in the documents.",
        "A third, equally groundless but very readable paragraph.",
      ],
      notFound: true,
      sourced: false,
      seedUsed: false,
      groundedDocuments: [],
      gaps: ["Nothing in the documents covers this."],
    },
  ];
  const results = await composeAnswers("", [], [item({ seed: "", variants: 3 })], {});
  const result = results.get(0);

  check("⚠️ it is still notFound", result.notFound === true);
  check("⚠️ the draft is emptied", result.draft === "", `got "${result.draft}"`);
  check(
    "⚠️ AND THE VARIANTS ARE DISCARDED — three fabrications are not a choice",
    result.variants.length === 0,
    JSON.stringify(result.variants),
  );
  check("no documents are credited", result.groundedDocuments.length === 0);
  check("the gap is reported instead of padded over", result.gaps.length > 0, JSON.stringify(result.gaps));
}

console.log("\n=== D2: variants inherit ONE evidence set ===");
{
  recorded.length = 0;
  respondWith = () => [
    {
      questionIndex: 0,
      draft: "Grounded draft one.",
      drafts: ["Grounded draft one.", "Grounded draft two."],
      notFound: false,
      sourced: true,
      seedUsed: true,
      groundedDocuments: ["cv.pdf", "transcript.pdf"],
      gaps: [],
    },
  ];
  const result = (await composeAnswers("ctx", ["cv.pdf", "transcript.pdf"], [item({ variants: 2 })], {})).get(0);

  check("there is exactly one groundedDocuments list", Array.isArray(result.groundedDocuments));
  check("it names both files", result.groundedDocuments.join(",") === "cv.pdf,transcript.pdf");
  check(
    "⚠️ variants are plain strings, carrying no provenance of their own",
    result.variants.every((v) => typeof v === "string"),
    "picking a variant chooses WORDING, never a different claim about the documents",
  );
  check("sourced is a property of the result, not of a variant", result.sourced === true);
}

console.log("\n=== D2: the leak guard applies PER VARIANT, not just to the first ===");
{
  // The decoy must be something the guard actually recognises. Its patterns
  // target AI meta-commentary ("as an AI", "I cannot", "please provide") — NOT
  // echoed directive brackets. An earlier version of this test used
  // "[Target: 120–220 words]" and failed; the guard was right and the test was
  // wrong about what it does. See the note below on what that leaves uncovered.
  recorded.length = 0;
  respondWith = () => [
    {
      questionIndex: 0,
      draft: "A genuine grounded draft.",
      drafts: [
        "A genuine grounded draft.",
        "As an AI language model, I cannot write this for you — please provide more detail.",
        "Another genuine draft.",
      ],
      notFound: false,
      sourced: true,
      seedUsed: true,
      groundedDocuments: ["cv.pdf"],
      gaps: [],
    },
  ];
  const result = (await composeAnswers("ctx", ["cv.pdf"], [item({ variants: 3 })], {})).get(0);
  check(
    "meta-commentary in variant 2 is filtered out, not offered as a choice",
    !result.variants.some((v) => /as an ai/i.test(v)),
    JSON.stringify(result.variants),
  );
  check("the genuine drafts survive", result.variants.length === 2, JSON.stringify(result.variants));
  check("and the primary draft is untouched", result.draft === "A genuine grounded draft.");
}

console.log("\n=== D2: a malformed drafts field degrades to a single draft ===");
{
  recorded.length = 0;
  respondWith = () => [
    {
      questionIndex: 0,
      draft: "The one real draft.",
      drafts: "not an array",
      notFound: false,
      sourced: true,
      seedUsed: true,
      groundedDocuments: ["cv.pdf"],
      gaps: [],
    },
  ];
  const result = (await composeAnswers("ctx", ["cv.pdf"], [item({ variants: 2 })], {})).get(0);
  check("the draft is still usable", result.draft === "The one real draft.");
  check("and variants is empty rather than throwing", result.variants.length === 0);
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
