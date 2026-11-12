#!/usr/bin/env node
// Compiles the gift broker Worker and writes the copy the server embeds, so
// the server can deploy the broker to the owner's Cloudflare account without
// Node.js or the source tree. Run after changing anything in share-broker/.
//
//   node script/gift_broker_modules.mjs          rewrite the embedded copy
//   node script/gift_broker_modules.mjs --check  fail if it is out of date
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "apps/server/src/share_broker_worker.json");
const wrangler = readFileSync(join(root, "share-broker/wrangler.toml"), "utf8");

function setting(name) {
  const match = wrangler.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"));
  if (!match) throw new Error(`share-broker/wrangler.toml has no ${name}`);
  return match[1];
}

const out = mkdtempSync(join(tmpdir(), "operalibre-broker-"));
let built;
try {
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "share-broker/tsconfig.test.json"), "--outDir", out],
    { stdio: "inherit" },
  );
  const modules = {};
  for (const name of readdirSync(out).filter(name => name.endsWith(".js")).sort()) {
    modules[name] = readFileSync(join(out, name), "utf8").replaceAll("\r\n", "\n");
  }
  if (!modules["index.js"]) throw new Error("The broker build produced no index.js");
  built = `${JSON.stringify({ name: setting("name"), compatibilityDate: setting("compatibility_date"), modules }, null, 1)}\n`;
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { /* missing counts as stale */ }
  if (current !== built) {
    console.error("apps/server/src/share_broker_worker.json is out of date. Run: node script/gift_broker_modules.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(target, built);
}
