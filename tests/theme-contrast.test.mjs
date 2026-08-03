// ─────────────────────────────────────────────────────────────────────────
// PART 2 — ORANGE THEME: CONTRAST IS ASSERTED, NOT ASSUMED
//
// Bright orange (#ff7a00) on white is 2.61:1. That fails WCAG AA for body text
// (4.5:1) and even AA-large (3:1), and **bold does not change a contrast
// ratio** — a bold label on a bright-orange fill is exactly as unreadable.
//
// So this suite computes the real ratio for every text-on-fill pair the theme
// ships and fails if any is under 4.5:1. It also asserts the semantic states
// stay non-orange, because an orange theme whose warning colour is also orange
// has no warning colour.
//
// Ratios are printed as numbers so the values are reviewable, not just green.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS ✅" : "FAIL ❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── WCAG 2.x relative luminance and contrast ratio ───────────────────────
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function luminance(hex) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Self-check the maths against the two reference points in WCAG itself, so a
// broken formula cannot silently bless a failing palette.
console.log("\n=== PART 2: the contrast formula itself is correct ===");
{
  check("black on white is 21:1", contrast("#000000", "#ffffff").toFixed(0) === "21");
  check("white on white is 1:1", contrast("#ffffff", "#ffffff").toFixed(0) === "1");
  check(
    "a known-failing pair is detected (#ff7a00 on white ≈ 2.61)",
    contrast("#ff7a00", "#ffffff").toFixed(2) === "2.61",
    "this is why bright orange is never text",
  );
}

// ── Read the tokens from the ONE place they are defined ──────────────────
const themeSource = readFileSync("src/theme.css", "utf8");

/** Tokens from a given block (`:root` base, or a media-query override). */
function tokensIn(source) {
  const out = {};
  const re = /(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|var\(--[a-z0-9-]+\))\s*;/g;
  let match;
  while ((match = re.exec(source)) !== null) out[match[1]] = match[2];
  return out;
}
function resolve(tokens, name, seen = new Set()) {
  const value = tokens[name];
  if (value === undefined) return null;
  if (value.startsWith("#")) return value;
  const ref = /var\((--[a-z0-9-]+)\)/.exec(value)?.[1];
  if (!ref || seen.has(ref)) return null;
  seen.add(ref);
  return resolve(tokens, ref, seen);
}

const darkStart = themeSource.indexOf("@media (prefers-color-scheme: dark)");
const contrastStart = themeSource.indexOf("@media (prefers-contrast: more)");
const light = tokensIn(themeSource.slice(0, darkStart));
const dark = { ...light, ...tokensIn(themeSource.slice(darkStart, contrastStart)) };
const moreContrast = { ...light, ...tokensIn(themeSource.slice(contrastStart)) };

console.log("\n=== PART 2: the palette lives in ONE file ===");
{
  check("theme.css defines the base tokens", Object.keys(light).length >= 20, `${Object.keys(light).length} tokens`);
  // No stylesheet other than theme.css may contain a hex literal.
  for (const file of ["src/sidepanel/sidepanel.css", "src/options/options.css"]) {
    const hex = readFileSync(file, "utf8").match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    check(`${file} contains no hex literal`, hex.length === 0, hex.join(" "));
    check(`${file} imports the theme`, readFileSync(file, "utf8").includes('@import "../theme.css";'));
  }
}

// ── Every text-on-fill pair the theme ships ──────────────────────────────
const AA = 4.5;

function pairs(tokens, label) {
  const t = (name) => resolve(tokens, name);
  return [
    ["primary button label", t("--color-on-primary"), t("--brand-deep")],
    ["primary button label, hover", t("--color-on-primary"), t("--brand-deepest")],
    ["secondary button label on page", t("--brand-text"), t("--color-bg")],
    ["secondary button label on surface", t("--brand-text"), t("--color-surface")],
    ["link text", t("--brand-text"), t("--color-bg")],
    ["body text", t("--color-text"), t("--color-bg")],
    ["subtle text", t("--color-subtle"), t("--color-bg")],
    ["subtle text on surface", t("--color-subtle"), t("--color-surface")],
    ["brand badge", t("--color-badge-text"), t("--color-badge-bg")],
    ["state: answered", t("--state-ok-text"), t("--state-ok-bg")],
    ["state: needs input", t("--state-info-text"), t("--state-info-bg")],
    ["state: draft/manual", t("--state-draft-text"), t("--state-draft-bg")],
    ["state: failed", t("--state-error-text"), t("--state-error-bg")],
    ["state: skipped", t("--state-skipped-text"), t("--state-skipped-bg")],
    ["splash notice", t("--splash-text"), t("--splash-bg")],
  ].map(([name, fg, bg]) => ({ name: `${label}: ${name}`, fg, bg }));
}

for (const [label, tokens] of [
  ["light", light],
  ["dark", dark],
  ["prefers-contrast: more", moreContrast],
]) {
  console.log(`\n=== PART 2: text-on-fill contrast — ${label} ===`);
  for (const { name, fg, bg } of pairs(tokens, label)) {
    if (fg === null || bg === null) {
      check(`${name} resolves to real colours`, false, `fg=${fg} bg=${bg}`);
      continue;
    }
    const ratio = contrast(fg, bg);
    const grade = ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : "FAIL";
    check(`${name} ≥ ${AA}:1`, ratio >= AA, `${fg} on ${bg} = ${ratio.toFixed(2)}:1 (${grade})`);
  }
}

console.log("\n=== PART 2: bright orange is NEVER used as text ===");
{
  const bright = resolve(light, "--brand-bright");
  check(
    "bright orange would fail as text, which is why it is accent-only",
    contrast(bright, resolve(light, "--color-bg")) < AA,
    `${bright} on white = ${contrast(bright, resolve(light, "--color-bg")).toFixed(2)}:1`,
  );
  // It must not be wired into any token whose job is text.
  const textTokens = ["--color-text", "--color-subtle", "--color-on-primary", "--color-badge-text", "--splash-text"];
  const misuse = textTokens.filter((name) => resolve(light, name) === bright);
  check("no text token resolves to bright orange", misuse.length === 0, misuse.join(", "));
  // And it must not be a fill that carries white text.
  check(
    "no filled-button token resolves to bright orange",
    resolve(light, "--brand-deep") !== bright && resolve(light, "--brand-deepest") !== bright,
  );
}

console.log("\n=== PART 2: the splash was ~14.5:1 and must not regress ===");
{
  // The previous value shipped at 1.20:1 in light mode while a comment claimed
  // 14.5:1 — true only against a #10131c background that no longer existed.
  const lightRatio = contrast(resolve(light, "--splash-text"), resolve(light, "--splash-bg"));
  const darkRatio = contrast(resolve(dark, "--splash-text"), resolve(dark, "--splash-bg"));
  check("light-mode splash notice ≥ 14.5:1", lightRatio >= 14.5, `${lightRatio.toFixed(2)}:1`);
  check("dark-mode splash notice ≥ 13:1", darkRatio >= 13, `${darkRatio.toFixed(2)}:1`);
  check(
    "the old near-white-on-white pairing is gone",
    contrast("#e8eaf2", resolve(light, "--splash-bg")) < 2 && resolve(light, "--splash-text") !== "#e8eaf2",
    "it shipped at 1.20:1 — effectively invisible",
  );

  // The splash <style> is inline BY DESIGN (first-frame paint before the bundle
  // parses), so its literals are duplicated. They must equal the tokens.
  const html = readFileSync("src/sidepanel/index.html", "utf8");
  const splashBlock = html.slice(html.indexOf("#splash {"), html.indexOf("</style>"));
  check(
    "the inline splash text colour equals --splash-text",
    splashBlock.includes(resolve(light, "--splash-text")),
    `expected ${resolve(light, "--splash-text")}`,
  );
  check(
    "the inline splash background equals --splash-bg",
    splashBlock.includes(resolve(light, "--splash-bg")),
  );
  check("the inline splash bar equals --splash-bar", splashBlock.includes(resolve(light, "--splash-bar")));
}

console.log("\n=== PART 2: semantic states stay DISTINGUISHABLE from the brand ===");
{
  // An orange theme must not make an orange-ish warning state invisible. The
  // previous "needs input" pill was #92400e on #fef3c7 — dark orange on amber.
  const hue = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const brandHue = hue(resolve(light, "--brand-deep"));
  const separation = (h) => Math.min(Math.abs(h - brandHue), 360 - Math.abs(h - brandHue));

  // 40° is a deliberate floor: orange sits near 24°, so amber/gold (~40-45°)
  // is the collision that had to be removed.
  // ⚠️ THE 40° FLOOR APPLIES ONLY TO STATES THAT ARE FREE TO MOVE.
  // Red is INHERENTLY adjacent to orange — #b91c1c is 24° from #b84a00 — and the
  // requirement is explicitly that failure stays red. So a blanket hue-distance
  // rule is the wrong test for it: it would force failure to stop being red in
  // order to pass. The floor is asserted for the four states that can move, and
  // red is covered by the stricter rule below (it must be red AND must not rely
  // on colour at all).
  [
    ["answered", "--state-ok-text"],
    ["needs input", "--state-info-text"],
    ["draft/manual", "--state-draft-text"],
    ["skipped", "--state-skipped-text"],
  ].forEach(([name, token]) => {
    const value = resolve(light, token);
    const gap = separation(hue(value));
    check(`${name} is ≥40° from the brand hue`, gap >= 40, `${value} hue ${hue(value).toFixed(0)}° vs brand ${brandHue.toFixed(0)}° → ${gap.toFixed(0)}° apart`);
  });

  // Failure must stay RED specifically — the one association worth not
  // reinventing. Red is ~0-20° or ~340-360°.
  const errorHue = hue(resolve(light, "--state-error-text"));
  check("failed is red", errorHue <= 20 || errorHue >= 340, `hue ${errorHue.toFixed(0)}°`);
  check(
    "failure is NOT conveyed by colour alone — the row carries the word 'failed'",
    /badge\.textContent = entry\.outcome/.test(readFileSync("src/sidepanel/sidepanel.ts", "utf8")),
    "red-vs-orange is only 24° apart and unreliable under protanopia, so the text is what carries it",
  );
  check(
    "and the failed row is additionally marked by a border AND a wash, not just text colour",
    /fill-report__row--failed\s*\{[\s\S]{0,160}border-color:[\s\S]{0,80}background:/.test(
      readFileSync("src/sidepanel/sidepanel.css", "utf8"),
    ),
  );
  check(
    "the fill report's failed row border is red, not orange",
    separation(hue(resolve(light, "--state-error-border"))) >= 20,
    `${resolve(light, "--state-error-border")} hue ${hue(resolve(light, "--state-error-border")).toFixed(0)}°`,
  );
  // The amber warning that collided with the brand must be gone entirely.
  const allCss = ["src/theme.css", "src/sidepanel/sidepanel.css", "src/options/options.css"]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  ["#92400e", "#fef3c7", "#fcd34d", "#b45309", "#b47808"].forEach((old) => {
    check(`the amber/orange warning colour ${old} is no longer used`, !new RegExp(old, "i").test(allCss.replace(/\/\*[\s\S]*?\*\//g, "")));
  });
}

console.log("\n=== PART 2: selection is not conveyed by colour alone ===");
{
  const css = readFileSync("src/sidepanel/sidepanel.css", "utf8");
  check(
    "the ✓ affordance on checked radiogroup options survives (WCAG 1.4.1)",
    /\[aria-checked="true"\]::before\s*\{\s*content:\s*"✓/.test(css),
  );
  check(
    "the variant picker's selected card also carries a ✓",
    /compose__variant\[aria-checked="true"\][\s\S]{0,120}content:\s*"✓/.test(css),
  );
  check("focus-visible styling is present, so keyboard focus is never invisible", /:focus-visible/.test(css));
}

console.log("\n=== PART 2: reduced-motion and contrast preferences are honoured ===");
{
  const css = readFileSync("src/sidepanel/sidepanel.css", "utf8");
  check("prefers-reduced-motion is still respected", /@media \(prefers-reduced-motion: reduce\)/.test(css));
  check("prefers-color-scheme is still respected", /@media \(prefers-color-scheme: dark\)/.test(themeSource));
  check("prefers-contrast: more hardens the palette", /@media \(prefers-contrast: more\)/.test(themeSource));
  check(
    "under prefers-contrast the primary fill gets DARKER, not lighter",
    contrast(resolve(moreContrast, "--color-on-primary"), resolve(moreContrast, "--brand-deep")) >
      contrast(resolve(light, "--color-on-primary"), resolve(light, "--brand-deep")),
    `${contrast(resolve(light, "--color-on-primary"), resolve(light, "--brand-deep")).toFixed(2)} → ${contrast(
      resolve(moreContrast, "--color-on-primary"),
      resolve(moreContrast, "--brand-deep"),
    ).toFixed(2)}`,
  );
}

console.log(`\n================ ${fails === 0 ? "ALL PASSED ✅" : `${fails} FAILED ❌`} ================\n`);
process.exit(fails === 0 ? 0 : 1);
