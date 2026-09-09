// Guard: keep wrangler.dev.toml (local development) honest against wrangler.toml
// (production). Wrangler does not merge configs — the dev file stands alone — so a var
// added to production is simply ABSENT locally, and the Worker reads undefined for it.
// That failure is silent and only shows up as odd local behavior, so this check makes
// it a build error instead.
//
// Two things are verified:
//   1. Coverage — every [vars] key in wrangler.toml is answered for in wrangler.dev.toml
//      (a deliberate local-only omission is recorded in DEV_OMITS below, with a reason).
//   2. Dev posture — the settings that make local runs safe are actually set that way,
//      so a copy-paste from the prod config can't quietly re-enable them.
// Run in CI and locally (`npm run check:devconfig`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal TOML reader for the shape these two files actually use: `[table]` headers and
// `KEY = "value"` / `KEY = value` pairs. Enough to read [vars] and the d1 block without
// taking on a TOML dependency; it is not a general parser.
function readTable(file, table) {
  const out = new Map();
  let inTable = false;
  for (const raw of readFileSync(join(root, file), "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("[")) {
      inTable = line === `[${table}]` || line === `[[${table}]]`;
      continue;
    }
    if (!inTable) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // Strip an inline trailing comment, then surrounding quotes.
    let value = line.slice(eq + 1).replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

// Production [vars] keys intentionally not carried into the dev config, and why.
const DEV_OMITS = new Map([
  // Per-product Halo client_ids are commented out in prod too; locally the whole pair
  // (id + secret) lives in .dev.vars so the two halves stay together.
  ["HALO_CLIENT_ID_HUNTRESS", "set in .dev.vars alongside its secret"],
]);

// Settings that define the safe local posture. A dev config that disagrees is a bug.
const REQUIRED_DEV_VALUES = new Map([
  ["SEND_TICKET_CREATED_EMAIL", "false"], // must never email a real requester from dev
  ["SENTRY_ENABLED", "false"], // dev noise must not land in the shared Sentry project
  ["ENFORCE_IP_ALLOWLIST", "false"], // wrangler dev has no CF-Connecting-IP header
]);

const prodVars = readTable("wrangler.toml", "vars");
const devVars = readTable("wrangler.dev.toml", "vars");
const problems = [];

for (const key of prodVars.keys()) {
  if (devVars.has(key) || DEV_OMITS.has(key)) continue;
  problems.push(
    `wrangler.dev.toml is missing [vars] "${key}" (in wrangler.toml). ` +
      "Add it with a dev-appropriate value, or record it in DEV_OMITS with a reason.",
  );
}

for (const [key, expected] of REQUIRED_DEV_VALUES) {
  const actual = devVars.get(key);
  if (actual !== expected) {
    problems.push(
      `wrangler.dev.toml [vars] ${key} must be "${expected}" for local development, got ` +
        (actual === undefined ? "no value" : `"${actual}"`) + ".",
    );
  }
}

// The dev config must not point at the production D1. Local runs ignore database_id, but
// `--remote` does not: a real id here reads and writes the live mirror.
const prodDb = readTable("wrangler.toml", "d1_databases").get("database_id");
const devDb = readTable("wrangler.dev.toml", "d1_databases").get("database_id");
if (prodDb && devDb === prodDb) {
  problems.push(
    "wrangler.dev.toml points at the PRODUCTION D1 database_id. Use the nil UUID so " +
      "`--remote` fails loudly instead of touching production data.",
  );
}

if (problems.length) {
  console.error(
    "wrangler.dev.toml is out of sync with wrangler.toml:\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nSee the header comments in wrangler.dev.toml and scripts/check-dev-config.mjs.\n",
  );
  process.exit(1);
}

console.log(
  `wrangler.dev.toml OK — ${devVars.size} dev vars cover ${prodVars.size} production vars.`,
);
