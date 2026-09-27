import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const NIGHTLY = /^v?(\d+\.\d+\.\d+)-nightly\.\d{8}\.\d+$/;

export function resolveRelease({ channel, tag = "", stableTag, date, run, sourceNightly = "" }) {
  if (!["stable", "nightly"].includes(channel)) throw new Error("Unknown release channel.");
  if (sourceNightly && (channel !== "stable" || !NIGHTLY.test(sourceNightly))) {
    throw new Error("Only a stable release can promote an immutable nightly tag.");
  }
  const match = stableTag?.match(STABLE);
  const next = match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : "0.1.0";
  if (channel === "nightly") {
    if (tag) throw new Error("Nightly tags are generated; leave tag blank.");
    if (!match) throw new Error("Publish a stable release before enabling nightlies.");
    if (!/^\d{8}$/.test(date) || !/^[1-9]\d*$/.test(String(run))) throw new Error("Invalid nightly build identifier.");
    return `${next}-nightly.${date}.${run}`;
  }
  const result = tag.trim() || (sourceNightly ? sourceNightly.match(NIGHTLY)[1] : next);
  if (!STABLE.test(result)) throw new Error("Stable release tags must be semantic versions such as 0.5.0.");
  return result;
}

export function releasePlan(options, api, paginate) {
  const { event, channel, branch, sha, sourceNightly = "" } = options;
  if (channel === "nightly" && branch !== "refs/heads/main") {
    throw new Error("Nightlies must be dispatched from main.");
  }
  // Keep stable's next-patch behavior even if GitHub's latest pointer names
  // an older release. Failed API requests still abort rather than picking 0.1.0.
  const releases = paginate("releases");
  const stableReleases = releases.filter((release) => !release.draft && !release.prerelease && STABLE.test(release.tag_name));
  const highestStable = stableReleases.sort((a, b) => {
    const left = a.tag_name.match(STABLE).slice(1).map(Number);
    const right = b.tag_name.match(STABLE).slice(1).map(Number);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  })[0];
  const stable = highestStable ? api("releases/latest") : undefined;
  if (stable && !STABLE.test(stable.tag_name)) throw new Error("GitHub's latest release must be a stable server release.");
  const tag = resolveRelease({ ...options, stableTag: highestStable?.tag_name });
  let ref = sha;
  const exists = paginate("tags").some((item) => item.name === tag);
  if (channel === "stable") {
    if (sourceNightly) {
      const release = api(`releases/tags/${sourceNightly}`);
      if (release.draft || !release.prerelease) throw new Error("The source nightly must be published.");
      ref = api(`commits/${sourceNightly}`).sha;
      if (exists && api(`commits/${tag}`).sha !== ref) throw new Error("The stable tag points at a different commit.");
    } else if (exists) ref = tag;
  } else if (exists && api(`commits/${tag}`).sha !== sha) {
    throw new Error("The nightly tag points at a different commit.");
  }
  let publish = true;
  if (channel === "nightly" && event === "schedule") {
    const previous = releases
      .filter((release) => !release.draft && release.prerelease && NIGHTLY.test(release.tag_name))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    if (previous && nightlyFeedMatches(releases.find((release) => release.tag_name === "nightly"), previous)) {
      publish = api(`compare/${previous.tag_name}...${ref}`).status !== "identical";
    }
  }
  return { tag, ref, channel, publish, tag_exists: exists, stable_tag: stable?.tag_name ?? "" };
}

export function nightlyFeedMatches(feed, release) {
  const manifest = (candidate) => candidate?.assets?.find((asset) => asset.name === "operalibre-manifest-v1.json" && asset.state === "uploaded");
  const digest = manifest(release)?.digest;
  return Boolean(feed && !feed.draft && feed.prerelease && digest && manifest(feed)?.digest === digest);
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const api = (route) => JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${route}`], { encoding: "utf8" }));
  // Full release objects grow past execFileSync's default output limit quickly.
  const paginate = (route) => {
    const fields = route === "tags" ? ".[] | {name} | @json"
      : '.[] | {tag_name, draft, prerelease, published_at, assets: [.assets[] | select(.name == "operalibre-manifest-v1.json") | {name, digest, state}]} | @json';
    const output = execFileSync("gh", ["api", "--paginate", `repos/${repository}/${route}?per_page=100`, "--jq", fields], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
    return output ? output.split("\n").map((line) => JSON.parse(line)) : [];
  };
  const event = process.env.GITHUB_EVENT_NAME;
  const plan = releasePlan({
    event,
    channel: event === "schedule" ? "nightly" : process.env.RELEASE_CHANNEL || "stable",
    branch: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    tag: event === "push" ? process.env.GITHUB_REF_NAME : process.env.REQUESTED_TAG,
    date: new Date().toISOString().slice(0, 10).replaceAll("-", ""),
    run: process.env.GITHUB_RUN_NUMBER,
    sourceNightly: process.env.SOURCE_NIGHTLY || ""
  }, api, paginate);
  for (const [key, value] of Object.entries(plan)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
