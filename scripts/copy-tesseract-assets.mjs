// Copies Tesseract.js's worker/core/language-data files from node_modules into
// public/tesseract/ so they ship as local extension assets instead of being
// fetched from a CDN at runtime (required under MV3 CSP and the project's
// local-processing-only requirement).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targetDir = join(root, "public", "tesseract");
const langDataDir = join(targetDir, "lang-data");

mkdirSync(langDataDir, { recursive: true });

const copies = [
  [
    join(root, "node_modules", "tesseract.js", "dist", "worker.min.js"),
    join(targetDir, "worker.min.js"),
  ],
  [
    join(root, "node_modules", "tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"),
    join(targetDir, "tesseract-core-simd-lstm.wasm.js"),
  ],
  [
    join(root, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"),
    join(langDataDir, "eng.traineddata.gz"),
  ],
];

for (const [from, to] of copies) {
  cpSync(from, to);
}

console.log("EasyFilla: copied local Tesseract.js assets into public/tesseract/");
