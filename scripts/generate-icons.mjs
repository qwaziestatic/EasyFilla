// Generates the extension's PNG icon set from a single source logo using
// sharp (a devDependency — it never enters the extension bundle).
//
// The source is a landscape image whose distinctive brand mark is a centered
// ORANGE rounded-square app icon, surrounded by a dark background, a tagline,
// and speed-lines. Per the design decision, we auto-detect and crop to the
// orange mark (the piece that stays recognizable at 16px and works in both
// light and dark themes), then emit square icons from it.
//
// Fail-soft by design: if no source logo is present, it warns and exits 0 so
// `npm run build` still succeeds with whatever icons already exist.
import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "public", "icons");

const SOURCE_CANDIDATES = ["logo.png", "logo.svg", "logo.webp", "logo.jpg", "logo.jpeg"].map((name) =>
  join(root, "src", "assets", name),
);
// Optional hand-simplified 16px source (1.3): used for icon16 only, if present.
const SMALL_SOURCE = join(root, "src", "assets", "logo-16.png");

const SIZES = [16, 32, 48, 128, 512];
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

function findSource() {
  return SOURCE_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

// Finds the bounding box of the orange brand mark. Returns null if the orange
// region is implausibly small (i.e. this isn't the expected asset) so the
// caller falls back to the whole image.
async function detectOrangeBox(source) {
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = channels === 4 ? data[i + 3] : 255;
      if (a > 128 && r > 150 && g > 70 && g < 190 && b < 100 && r > b + 60) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        count += 1;
      }
    }
  }
  if (count < width * height * 0.03) {
    return null;
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function main() {
  const source = findSource();
  if (!source) {
    console.warn(
      "EasyFilla(icons): no source logo found at src/assets/logo.{png,svg,webp,jpg}. " +
        "Keeping existing icons. Add your logo there and re-run `npm run icons`.",
    );
    return;
  }

  const meta = await sharp(source).metadata();
  console.log(
    `EasyFilla(icons): source ${source.replace(root, ".")} — ${meta.width}x${meta.height}, ` +
      `${meta.channels}ch, alpha=${meta.hasAlpha}, format=${meta.format}`,
  );

  const box = await detectOrangeBox(source);
  // A cropped Buffer is the master everything is resized from, so the crop
  // runs once. Falls back to the full image when the mark isn't detected.
  const master = box
    ? await sharp(source).extract(box).png().toBuffer()
    : await sharp(source).png().toBuffer();
  console.log(
    box
      ? `EasyFilla(icons): cropped to orange mark ${box.width}x${box.height} at (${box.left},${box.top}).`
      : "EasyFilla(icons): orange mark not detected — using full image.",
  );

  const longest = box ? Math.max(box.width, box.height) : Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longest < 128) {
    console.warn(`EasyFilla(icons): mark longest side ${longest}px (<128) — 128/512 will be upscaled and may look soft.`);
  }

  mkdirSync(outDir, { recursive: true });
  const useSmall16 = existsSync(SMALL_SOURCE);
  for (const size of SIZES) {
    const input = size === 16 && useSmall16 ? SMALL_SOURCE : master;
    await sharp(input)
      .resize(size, size, { fit: "contain", background: TRANSPARENT, kernel: sharp.kernel.lanczos3 })
      .ensureAlpha()
      .png()
      .toFile(join(outDir, `icon${size}.png`));
  }
  console.log(
    `EasyFilla(icons): wrote ${SIZES.map((s) => `icon${s}`).join(", ")} to public/icons/` +
      (useSmall16 ? " (icon16 from logo-16.png)" : ""),
  );
}

main().catch((error) => {
  console.error("EasyFilla(icons): generation failed —", error);
  process.exitCode = 1;
});
