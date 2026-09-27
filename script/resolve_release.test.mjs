import assert from "node:assert/strict";
import test from "node:test";
import { resolveRelease, releasePlan } from "./resolve_release.mjs";

test("nightlies preview the next stable patch with distinct build identities", () => {
  const options = { channel: "nightly", stableTag: "v0.4.9", date: "20260927", run: 12 };
  assert.equal(resolveRelease(options), "0.4.10-nightly.20260927.12");
  assert.notEqual(resolveRelease(options), resolveRelease({ ...options, run: 13 }));
  assert.throws(() => resolveRelease({ ...options, tag: "0.4.10" }));
  assert.throws(() => resolveRelease({ ...options, stableTag: "readalong-sync-v1.0.0" }));
});

test("stable supports an explicit version or promotion of the tested nightly", () => {
  assert.equal(resolveRelease({ channel: "stable", stableTag: "0.4.9" }), "0.4.10");
  assert.equal(resolveRelease({ channel: "stable", tag: "v0.5.0" }), "v0.5.0");
  assert.equal(resolveRelease({ channel: "stable", sourceNightly: "0.5.0-nightly.20260927.12" }), "0.5.0");
  assert.throws(() => resolveRelease({ channel: "stable", tag: "0.5.0-nightly.20260927.12" }));
  assert.throws(() => resolveRelease({ channel: "stable", sourceNightly: "nightly" }));
});

const scheduled = { channel: "nightly", event: "schedule", branch: "refs/heads/main",
  sha: "main-sha", date: "20260927", run: 12 };
const stable = { tag_name: "0.4.9", draft: false, prerelease: false };
const publishedNightly = { tag_name: "0.4.10-nightly.20260926.11", prerelease: true,
  draft: false, published_at: "2026-09-26T06:00:00Z",
  assets: [{ name: "operalibre-manifest-v1.json", state: "uploaded", digest: "sha256:manifest" }] };
const feed = { ...publishedNightly, tag_name: "nightly" };
const paginate = (releases = [], tags = []) => (route) => route === "tags" ? tags : [stable, ...releases];

test("scheduled builds skip unchanged source while manual nightlies can rebuild", () => {
  const api = (route) => route === "releases/latest" ? { tag_name: "0.4.9" } : { status: "identical" };
  const releases = paginate([publishedNightly, feed]);
  assert.equal(releasePlan(scheduled, api, releases).publish, false);
  assert.equal(releasePlan({ ...scheduled, event: "workflow_dispatch" }, api, releases).publish, true);
  for (const status of ["ahead", "behind", "diverged"]) {
    assert.equal(releasePlan(scheduled,
      (route) => route === "releases/latest" ? api(route) : { status }, releases).publish, true);
  }
  assert.throws(() => releasePlan({ ...scheduled, branch: "refs/heads/test" }, api, releases));
  assert.throws(() => releasePlan(scheduled, () => { throw new Error("GitHub unavailable"); }, releases));
});

test("schedules repair missing or stale feeds even without new commits", () => {
  const api = (route) => {
    assert.equal(route, "releases/latest", "an unhealthy feed must not skip publication using a commit comparison");
    return stable;
  };
  for (const broken of [null, { ...feed, assets: [] }, { ...feed, draft: true },
    { ...feed, assets: [{ ...feed.assets[0], digest: "sha256:older" }] }]) {
    assert.equal(releasePlan(scheduled, api, paginate([publishedNightly, ...(broken ? [broken] : [])])).publish, true);
  }
});

test("stable auto-versioning uses the highest published stable, not the latest pointer", () => {
  const result = releasePlan({ ...scheduled, channel: "stable" }, () => stable,
    paginate([{ ...stable, tag_name: "0.4.10" }, { ...stable, tag_name: "v0.5.0" },
      { ...stable, tag_name: "1.0.0", draft: true }, publishedNightly]));
  assert.equal(result.tag, "0.5.1");
  assert.equal(result.stable_tag, "0.4.9");
});

test("the first stable release works but nightlies require a stable baseline", () => {
  const api = () => { throw new Error("No latest release exists"); };
  assert.equal(releasePlan({ ...scheduled, channel: "stable" }, api, () => []).tag, "0.1.0");
  assert.throws(() => releasePlan(scheduled, api, () => []), /Publish a stable release/);
});

test("existing nightly tags can only be retried at the same source commit", () => {
  const tags = [{ name: "0.4.10-nightly.20260927.12" }];
  const api = (route) => route === "releases/latest" ? stable : { sha: scheduled.sha };
  assert.equal(releasePlan(scheduled, api, paginate([], tags)).tag_exists, true);
  assert.throws(() => releasePlan(scheduled,
    (route) => route === "releases/latest" ? stable : { sha: "different" }, paginate([], tags)), /different commit/);
});

test("stable promotion builds the published nightly commit even when main moved", () => {
  const api = (route) => {
    if (route === "releases/latest") return { tag_name: "0.4.9" };
    if (route.startsWith("releases/tags/")) return publishedNightly;
    if (route.startsWith("commits/")) return { sha: "tested-nightly-sha" };
    throw new Error(`Unexpected request: ${route}`);
  };
  const result = releasePlan({ ...scheduled, channel: "stable", event: "workflow_dispatch",
    sourceNightly: publishedNightly.tag_name }, api, paginate());
  assert.equal(result.ref, "tested-nightly-sha");
  assert.equal(result.tag, "0.4.10");
  assert.throws(() => releasePlan({ ...scheduled, channel: "stable",
    sourceNightly: publishedNightly.tag_name },
  (route) => route.startsWith("releases/tags/") ? { ...publishedNightly, draft: true } : api(route), paginate()));
});
