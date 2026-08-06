// Guard: keep package.json `allowScripts` in sync with the locked versions of the
// dependencies whose install scripts we allow under npm v12 (which blocks dependency
// install scripts by default). `allowScripts` is keyed by exact `name@version`, so a
// Renovate bump to any of these silently invalidates the entry until it's refreshed —
// which would leave the dev container unable to build workerd/esbuild. This check reads
// the LOCKFILE (deterministic; matches what `npm ci` installs) and fails with the exact
// remediation when an entry is missing. Run in CI and locally (`npm run check:allowscripts`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

// Dependencies whose npm-v12 install scripts we intentionally allow.
// workerd = wrangler dev's runtime; esbuild = the bundler. Both fetch native binaries.
const PACKAGES = ["workerd", "esbuild"];

const lock = read("package-lock.json");
const allow = read("package.json").allowScripts ?? {};

const problems = [];
const expected = [];
for (const name of PACKAGES) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) {
    problems.push(`${name}: not found in package-lock.json`);
    continue;
  }
  const key = `${name}@${version}`;
  expected.push(key);
  if (allow[key] !== true) problems.push(`missing allowScripts entry "${key}": true`);
}

if (problems.length) {
  console.error(
    "allowScripts is out of sync with package-lock.json:\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nnpm v12 blocks these install scripts otherwise, breaking the dev container.\n" +
      `Fix: run \`npm approve-scripts ${PACKAGES.join(" ")}\` and commit package.json.\n` +
      `Expected: ${expected.map((k) => `"${k}": true`).join(", ")}`,
  );
  process.exit(1);
}
console.log(`allowScripts OK: ${expected.join(", ")}`);
