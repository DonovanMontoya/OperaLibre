import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const kind of ["server", "combined"]) {
  test(`Linux ${kind} package includes coordinated systemd handoff`, async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "operalibre-package-test-"));
    try {
      const binary = path.join(fixture, "server");
      const launcher = path.join(fixture, "launcher");
      const web = path.join(fixture, "web");
      const output = path.join(fixture, "package");
      await writeFile(binary, "server fixture");
      await writeFile(launcher, "launcher fixture");
      await mkdir(web);
      await writeFile(path.join(web, "index.html"), "web fixture");
      execFileSync(process.execPath, ["script/package_release.mjs", "--kind", kind,
        "--platform", "linux-x64", "--binary", binary, "--launcher", launcher,
        "--web", web, "--output", output, "--version", "1.2.3"]);
      assert.equal(await readFile(path.join(output, "operalibre-service"), "utf8"), "launcher fixture");
      const unit = await readFile(path.join(output, "systemd/operalibre.service"), "utf8");
      assert.match(unit, /operalibre-service --service-start/);
      assert.match(unit, /KillMode=process/);
      const watcher = await readFile(path.join(output, "systemd/operalibre-update.path"), "utf8");
      assert.match(watcher, /^PathChanged=.*\/update-result\.txt$/m);
      assert.doesNotMatch(watcher, /^PathChanged=.*VERSION/m);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
