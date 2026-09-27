import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishRelease } from "./publish_release.mjs";

const tag = "0.5.1-nightly.20260927.12";
const manifestName = "operalibre-manifest-v1.json";

function fixture(t, failure) {
  const assets = mkdtempSync(path.join(tmpdir(), "operalibre-publish-test-"));
  t.after(() => rmSync(assets, { recursive: true, force: true }));
  const manifest = JSON.stringify({ payload: JSON.stringify({ version: tag, build: "original" }) });
  writeFileSync(path.join(assets, manifestName), manifest);
  writeFileSync(path.join(assets, "package.tar.gz"), "original package");
  const releases = new Map();
  let tagCommit;
  const mutations = [];
  const finish = (operation) => {
    mutations.push(operation);
    if (operation === failure) {
      failure = undefined;
      throw new Error(`Interrupted after ${operation}`);
    }
    return "";
  };
  const run = (program, args) => {
    if (program === "git") {
      if (args[0] === "rev-parse") return args[1] === "HEAD" ? "source-sha" : tagCommit;
      if (args[0] === "tag" && args[1] === "--list") return tagCommit ? tag : "";
      if (args[0] === "tag") { tagCommit = "source-sha"; return finish("tag"); }
      if (args[0] === "push") return finish("push");
    }
    if (program === process.execPath && args[1] === "verify-manifest") {
      assert.ok(readFileSync(args[2], "utf8"));
      return ""; // Signature validation has its own real-key tests.
    }
    if (program === "gh" && args[0] === "api") {
      const name = args[1].split("/").at(-1);
      const release = releases.get(name);
      if (release) return JSON.stringify(release);
      throw Object.assign(new Error("Missing release"), { stderr: "gh: Not Found (HTTP 404)" });
    }
    if (program === "gh" && args[0] === "release") {
      const [, operation, name] = args;
      const option = (flag) => args[args.indexOf(flag) + 1];
      if (operation === "create") {
        assert.equal(releases.has(name), false);
        releases.set(name, { draft: args.includes("--draft"), prerelease: args.includes("--prerelease"), files: {} });
      } else if (operation === "upload") {
        const release = releases.get(name);
        assert.ok(release);
        if (name !== "nightly" && name.includes("-nightly.")) assert.equal(release.draft, true, "published nightly assets must never be replaced");
        for (const file of args.slice(3, args.indexOf("--clobber"))) {
          release.files[path.basename(file)] = readFileSync(file, "utf8");
        }
      } else if (operation === "edit") {
        if (args.includes("--draft=false")) releases.get(name).draft = false;
      } else if (operation === "download") {
        writeFileSync(path.join(option("--dir"), manifestName), releases.get(name).files[manifestName]);
        return "";
      } else throw new Error(`Unexpected gh operation: ${operation}`);
      return finish(`${operation}:${name}`);
    } else throw new Error(`Unexpected command: ${program} ${args.join(" ")}`);
  };
  return { options: { repository: "owner/repo", tag, channel: "nightly", assets, notes: "notes.md" },
    run, releases, mutations, manifest };
}

test("nightly packages stay draft until complete, and the feed uses published bytes", (t) => {
  const { options, run, releases, manifest } = fixture(t);
  publishRelease(options, run);
  assert.equal(releases.get(tag).draft, false);
  assert.equal(releases.get(tag).prerelease, true);
  assert.equal(releases.get("nightly").files[manifestName], manifest);
});

for (const step of ["push", `create:${tag}`, `upload:${tag}`, `edit:${tag}`, "create:nightly", "upload:nightly"]) {
  test(`publication resumes after an interruption at ${step}`, (t) => {
    const { options, run, releases, mutations, manifest } = fixture(t, step);
    assert.throws(() => publishRelease(options, run), /Interrupted/);
    const published = releases.get(tag)?.draft === false;
    mutations.length = 0;
    const rebuilt = JSON.stringify({ payload: JSON.stringify({ version: tag, build: "rebuilt" }) });
    writeFileSync(path.join(options.assets, manifestName), rebuilt);
    publishRelease(options, run);
    assert.equal(releases.get(tag).draft, false);
    assert.equal(releases.get("nightly").files[manifestName], published ? manifest : rebuilt);
    if (published) assert.ok(!mutations.some((entry) => entry.endsWith(`:${tag}`)));
  });
}

test("API outages do not get treated as a missing release", (t) => {
  const { options, run, mutations } = fixture(t);
  assert.throws(() => publishRelease(options, (program, args) => {
    if (program === "gh" && args[0] === "api") throw Object.assign(new Error("Unavailable"), { stderr: "HTTP 503" });
    return run(program, args);
  }), /Unavailable/);
  assert.deepEqual(mutations, ["tag", "push"]);
});

test("a tag left by another commit cannot be overwritten", (t) => {
  const { options, run, mutations } = fixture(t);
  assert.throws(() => publishRelease(options, (program, args) => {
    if (program === "git" && args[1] === "--list") return tag;
    if (program === "git" && args[1] === `${tag}^{commit}`) return "other-sha";
    return run(program, args);
  }), /different commit/);
  assert.deepEqual(mutations, []);
});

test("stable rebuilds retain the existing release upload path", (t) => {
  const { options, run, releases, mutations } = fixture(t);
  releases.set("0.5.0", { prerelease: false, draft: false, files: {} });
  publishRelease({ ...options, tag: "0.5.0", channel: "stable" }, run);
  assert.deepEqual(mutations, ["tag", "push", "upload:0.5.0", "edit:0.5.0"]);
  assert.equal(releases.has("nightly"), false);
});

test("retried nightly notes compare against the preceding nightly or stable baseline", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const selection = workflow.match(/previous_tag="\$\(git tag --merged HEAD .*\n\s+previous_tag=.*\n/)[0];
  const previous = "0.5.1-nightly.20260926.11";
  for (const [tags, expected] of [
    [[tag, previous, "0.5.0"], previous],
    [[tag, "0.5.0"], "0.5.0"],
    [[previous, "0.5.0"], previous]
  ]) {
    const result = execFileSync("bash", ["-eo", "pipefail", "-c",
      'git() { printf "%s\\n" "$TEST_TAGS"; }\n' + selection + 'printf "%s" "$previous_tag"'], {
      encoding: "utf8",
      env: { ...process.env, TEST_TAGS: tags.join("\n"), RELEASE_TAG: tag, STABLE_TAG: "0.5.0" }
    });
    assert.equal(result, expected);
  }
});
