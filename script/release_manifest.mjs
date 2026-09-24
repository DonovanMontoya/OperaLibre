// Builds the update manifest payload for a release. See docs/update-manifest.md.
//
//   node script/release_manifest.mjs --assets <dir> --version <x.y.z> --tag <tag>
//     --repository <owner/name> --notes <file> --output <payload-file>
//     [--sync-release <github-release.json>]
//
// --assets holds the release's packages; --sync-release is the GitHub API
// description of the read-along sync add-on release the packages point at.
// Sign the result with `release_signing.mjs sign-envelope manifest`.

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fileSha256Hex } from "./release_signing.mjs";

const POLICY_FILE = fileURLToPath(new URL("../release/update-policy.json", import.meta.url));
const MAX_NOTES_CHARS = 20_000;
const PLATFORM = "(linux-x64|linux-arm64|macos-x64|macos-arm64|windows-x64)";
// The sync add-on's ADDON.json protocolVersion; see script/package_sync_addon.mjs.
const SYNC_ADDON_PROTOCOL = 1;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function releasePackages({ assets, version, tag, repository }) {
  const base = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  const server = new RegExp(`^operalibre-${escape(version)}-combined-${PLATFORM}\\.(tar\\.gz|zip)$`);
  const frontend = `operalibre-${version}-frontend.zip`;
  const packages = [];
  for (const name of (await readdir(assets)).sort()) {
    const file = path.join(assets, name);
    const common = async () => ({
      version,
      url: `${base}${encodeURIComponent(name)}`,
      sha256: await fileSha256Hex(file),
      size: (await stat(file)).size
    });
    const match = name.match(server);
    if (match) {
      packages.push({
        component: "server",
        platform: match[1],
        ...(await common()),
        format: match[2],
        root: name.slice(0, -(match[2].length + 1))
      });
    } else if (name === frontend) {
      packages.push({
        component: "frontend",
        platform: "any",
        ...(await common()),
        format: "zip",
        root: name.slice(0, -".zip".length)
      });
    }
  }
  return packages;
}

export function syncAddonPackages(release) {
  const pattern = new RegExp(`^operalibre-readalong-sync-(.+)-${PLATFORM}\\.zip$`);
  return release.assets.flatMap((asset) => {
    const match = asset.name.match(pattern);
    const digest = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
    if (!match) return [];
    if (!digest) throw new Error(`${asset.name} has no SHA-256 digest in the release metadata.`);
    return [{
      component: "readalong-sync",
      platform: match[2],
      version: match[1],
      url: asset.browser_download_url,
      sha256: digest.toLowerCase(),
      size: asset.size,
      format: "zip",
      root: asset.name.slice(0, -".zip".length),
      protocol: SYNC_ADDON_PROTOCOL
    }];
  });
}

export function manifestPayload({ version, tag, repository, notes, packages, policy, published }) {
  return {
    type: "manifest",
    schema: 1,
    version,
    published,
    releaseUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    notes: notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}…` : notes,
    ...(policy.notice ? { notice: policy.notice } : {}),
    ...(policy.redirect ? { redirect: policy.redirect } : {}),
    bridges: policy.bridges ?? [],
    packages
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received: ${argv.join(" ")}`);
    }
    options[key.slice(2)] = value;
  }
  for (const key of ["assets", "version", "tag", "repository", "notes", "output"]) {
    if (!options[key]) throw new Error(`Missing required --${key} option.`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packages = await releasePackages(options);
  if (!packages.some((entry) => entry.component === "server")) {
    throw new Error(`No server packages for ${options.version} in ${options.assets}.`);
  }
  if (options["sync-release"]) {
    packages.push(...syncAddonPackages(JSON.parse(await readFile(options["sync-release"], "utf8"))));
  }
  const payload = manifestPayload({
    ...options,
    notes: await readFile(options.notes, "utf8"),
    packages,
    policy: JSON.parse(await readFile(POLICY_FILE, "utf8")),
    published: new Date().toISOString()
  });
  await writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote a manifest for ${options.version} with ${packages.length} packages.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
