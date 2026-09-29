import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const privacy = readFileSync("privacy-policy.md", "utf8");
const failures = [];

if (manifest.version !== packageJson.version) {
  failures.push(`manifest/package version mismatch: ${manifest.version} vs ${packageJson.version}`);
}
if (/TODO|CONTACT EMAIL|REQUIRED BEFORE SUBMISSION/i.test(privacy)) {
  failures.push("privacy-policy.md contains a release placeholder");
}
if (/(^|[\s'"])unsafe-eval([\s;'"]|$)/.test(manifest.content_security_policy?.extension_pages ?? "")) {
  failures.push("extension CSP contains unsafe-eval");
}
if ((manifest.web_accessible_resources ?? []).some((entry) => (entry.matches ?? []).includes("<all_urls>"))) {
  failures.push("web-accessible resources are exposed to <all_urls>");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Release checks passed.");
