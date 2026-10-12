import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const patterns = {
  stable: /^v?\d+\.\d+\.\d+$/,
  nightly: /^v?\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/
};

export function previousReleaseTag(tags, { channel, tag, stableTag = "" }) {
  const pattern = patterns[channel];
  if (!pattern?.test(tag)) throw new Error("Invalid release channel or tag.");
  // Git's version sort treats the optional v prefix as part of the version,
  // placing v0.1.0 ahead of 0.4.10. Compare normalized versions but return the
  // original tag spelling for the changelog link and commit range.
  const compare = (a, b) => a.replace(/^v/, "").localeCompare(b.replace(/^v/, ""), "en", { numeric: true });
  return tags.filter((candidate) => pattern.test(candidate) && compare(candidate, tag) < 0)
    .sort((a, b) => compare(b, a))[0] ?? (channel === "nightly" ? stableTag : "");
}

// History rewritten after a release leaves its tag unreachable from HEAD but
// still naming the tree it released. Returns the tag when HEAD descends from
// it, otherwise the newest commit on HEAD that carries that tree. Listing
// commits since an unrelated tag would sign most of the history into the notes.
export function changelogBase(tag, git) {
  if (!tag) return "";
  const commit = git(["rev-parse", `${tag}^{commit}`]);
  const tree = git(["rev-parse", `${tag}^{tree}`]);
  const history = git(["log", "--format=%H %T", "HEAD"]).split("\n").map((line) => line.split(" "));
  if (history.some(([hash]) => hash === commit)) return tag;
  const match = history.find(([, candidate]) => candidate === tree);
  if (!match) throw new Error(`No commit in this history matches release ${tag}; its changelog has no starting point.`);
  return match[0];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  const tag = previousReleaseTag(git(["tag"]).split("\n"), { channel: process.env.RELEASE_CHANNEL,
    tag: process.env.RELEASE_TAG, stableTag: process.env.STABLE_TAG });
  console.log(changelogBase(tag, git));
}
