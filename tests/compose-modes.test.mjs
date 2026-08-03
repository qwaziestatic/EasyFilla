// TASK B — length/tone mapping.
//
// The point of this suite: length must be a REPRODUCIBLE word range, not an
// adjective. "Make it shorter" told the model nothing checkable and produced
// answers of wildly different size between runs. These assertions pin the
// contract that the UI label and the model instruction both read from.
import { LENGTH_TARGETS, lengthTargetFor, TONE_INSTRUCTIONS, DEFAULT_COMPOSE_DEFAULTS } from "./_bundle-uiprefs.mjs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n=== TASK B: length maps to concrete word ranges ===");

{
  const choices = ["short", "medium", "long"];
  choices.forEach((choice) => {
    const s = lengthTargetFor(choice, false);
    const e = lengthTargetFor(choice, true);
    check(`${choice} has a real range on short questions`, s.minWords > 0 && s.maxWords > s.minWords, `${s.minWords}–${s.maxWords}`);
    check(`${choice} has a real range on essays`, e.minWords > 0 && e.maxWords > e.minWords, `${e.minWords}–${e.maxWords}`);
    check(`${choice} allows more words on an essay than a short field`, e.maxWords > s.maxWords, `${e.maxWords} > ${s.maxWords}`);
  });
}

{
  // Monotonic: Short < Medium < Long on both scales. A user who picks Long and
  // gets something shorter than Medium has been lied to by the control.
  const shortScale = ["short", "medium", "long"].map((c) => lengthTargetFor(c, false));
  const essayScale = ["short", "medium", "long"].map((c) => lengthTargetFor(c, true));
  check(
    "short-question targets increase strictly with the choice",
    shortScale[0].maxWords < shortScale[1].maxWords && shortScale[1].maxWords < shortScale[2].maxWords,
    shortScale.map((t) => `${t.minWords}–${t.maxWords}`).join(" < "),
  );
  check(
    "essay targets increase strictly with the choice",
    essayScale[0].maxWords < essayScale[1].maxWords && essayScale[1].maxWords < essayScale[2].maxWords,
    essayScale.map((t) => `${t.minWords}–${t.maxWords}`).join(" < "),
  );
  check(
    "the bands do not overlap confusingly on the short scale",
    shortScale[0].maxWords <= shortScale[1].minWords && shortScale[1].maxWords <= shortScale[2].minWords,
    "each band starts where the previous ended",
  );
}

{
  const unknown = lengthTargetFor("nonsense", false);
  check("an unknown choice falls back to medium rather than throwing", unknown.maxWords === lengthTargetFor("medium", false).maxWords);
}

console.log("\n=== TASK B: length and tone are INDEPENDENT axes ===");

{
  // The bug this design fixes: length and tone used to be one control, so a
  // SHORT FORMAL answer was inexpressible. Every combination must be reachable.
  const lengths = ["short", "medium", "long"];
  const tones = ["neutral", "formal", "conversational"];
  let reachable = 0;
  lengths.forEach((l) => {
    tones.forEach((t) => {
      const target = lengthTargetFor(l, false);
      const instruction = TONE_INSTRUCTIONS[t];
      if (target && instruction) reachable++;
    });
  });
  check("all 9 length×tone combinations are expressible", reachable === 9, `${reachable}/9`);
  check(
    "a SHORT FORMAL answer is expressible (the case the old control could not reach)",
    Boolean(lengthTargetFor("short", false) && TONE_INSTRUCTIONS.formal),
  );
}

{
  // Tone must not smuggle in length guidance, or the axes recouple.
  Object.entries(TONE_INSTRUCTIONS).forEach(([tone, text]) => {
    check(`the ${tone} tone instruction says nothing about length`, !/\b(word|words|sentence|paragraph|length|short|long|brief)\b/i.test(text), text.slice(0, 60) + "…");
  });
}

{
  // Grounding is not negotiable by tone. Each instruction must be a register
  // change only — no licence to add claims.
  check(
    "the formal tone explicitly refuses to add claims to pad the register",
    /must not add|never add|not add a claim|does not/i.test(TONE_INSTRUCTIONS.formal),
    TONE_INSTRUCTIONS.formal,
  );
}

console.log("\n=== TASK B: defaults ===");

{
  check("the shipped default length is medium", DEFAULT_COMPOSE_DEFAULTS.length === "medium");
  check("the shipped default tone is neutral", DEFAULT_COMPOSE_DEFAULTS.tone === "neutral");
  check("LENGTH_TARGETS covers exactly the three choices", Object.keys(LENGTH_TARGETS).sort().join(",") === "long,medium,short");
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
