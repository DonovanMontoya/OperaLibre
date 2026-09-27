import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function command(program, args) {
  return execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function publishRelease({ repository, tag, channel, assets, notes }, run = command) {
  if (!["stable", "nightly"].includes(channel)) throw new Error("Unknown release channel.");
  const gh = (...args) => run("gh", [...args, "--repo", repository]);
  const release = (name) => {
    try {
      return JSON.parse(run("gh", ["api", `repos/${repository}/releases/tags/${name}`]));
    } catch (error) {
      if (String(error.stderr).includes("(HTTP 404)")) return null;
      throw error;
    }
  };

  // A failed publication can leave its tag behind. Check the actual checkout
  // again instead of relying on the prepare job's earlier snapshot.
  const head = run("git", ["rev-parse", "HEAD"]);
  const tags = run("git", ["tag", "--list", tag]);
  if (tags) {
    if (run("git", ["rev-parse", `${tag}^{commit}`]) !== head) {
      throw new Error("The release tag points at a different commit.");
    }
  } else {
    run("git", ["tag", tag]);
  }
  run("git", ["push", "origin", `refs/tags/${tag}`]);

  const existing = release(tag);
  const files = readdirSync(assets).sort().map((name) => path.join(assets, name));
  if (channel === "stable") {
    if (existing) {
      gh("release", "upload", tag, ...files, "--clobber");
      gh("release", "edit", tag, "--title", `OperaLibre ${tag}`, "--notes-file", notes);
    } else {
      gh("release", "create", tag, ...files, "--verify-tag", "--latest",
        "--title", `OperaLibre ${tag}`, "--notes-file", notes);
    }
    return;
  }

  if (existing && !existing.prerelease) throw new Error("A nightly tag already names a stable release.");
  if (!existing || existing.draft) {
    if (!existing) {
      gh("release", "create", tag, "--verify-tag", "--draft", "--prerelease", "--latest=false",
        "--title", `OperaLibre Nightly ${tag}`, "--notes-file", notes);
    }
    gh("release", "upload", tag, ...files, "--clobber");
    gh("release", "edit", tag, "--draft=false", "--prerelease", "--latest=false",
      "--title", `OperaLibre Nightly ${tag}`, "--notes-file", notes);
  }

  // Always use the published bytes: a retry's rebuild may differ from the
  // immutable packages, even though it came from the same commit.
  const feedDir = mkdtempSync(path.join(tmpdir(), "operalibre-nightly-feed-"));
  try {
    const manifest = path.join(feedDir, "operalibre-manifest-v1.json");
    gh("release", "download", tag, "--pattern", "operalibre-manifest-v1.json", "--dir", feedDir);
    run(process.execPath, [fileURLToPath(new URL("./release_signing.mjs", import.meta.url)), "verify-manifest", manifest]);
    const payload = JSON.parse(JSON.parse(readFileSync(manifest, "utf8")).payload);
    if (payload.version !== tag.replace(/^v/, "")) throw new Error("The published nightly manifest has the wrong version.");
    const feed = release("nightly");
    if (feed && (feed.draft || !feed.prerelease)) throw new Error("The nightly feed must be a published prerelease.");
    if (!feed) {
      gh("release", "create", "nightly", "--target", head, "--prerelease", "--latest=false",
        "--title", "OperaLibre nightly update feed",
        "--notes", "The signed manifest points to the latest tested nightly web/server packages.");
    }
    gh("release", "upload", "nightly", manifest, "--clobber");
  } finally {
    rmSync(feedDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  publishRelease({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG,
    channel: process.env.RELEASE_CHANNEL, assets: "release-assets", notes: "release/RELEASE_BODY.md" });
}
