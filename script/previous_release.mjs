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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tags = execFileSync("git", ["tag", "--merged", "HEAD"], { encoding: "utf8" }).trim().split("\n");
  console.log(previousReleaseTag(tags, { channel: process.env.RELEASE_CHANNEL,
    tag: process.env.RELEASE_TAG, stableTag: process.env.STABLE_TAG }));
}
