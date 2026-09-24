import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const installer = await readFile(new URL("./install.sh", import.meta.url), "utf8");
const libationFunctions = ["config_value", "set_config", "configured_port", "configured_data_dir",
  "configured_libation_path", "configured_libation_files_dir", "ensure_libation_files_dir"].map((name) => {
  const definition = installer.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(definition, `Missing installer function ${name}`);
  return definition[0];
}).join("\n");

for (const [key, quote] of [["libation_files_dir", ""], ["LIBATION_FILES_DIR", '"'], ["Libation-Files-Dir", "'"]]) {
  for (const relative of [false, true]) {
    for (const existing of [false, true]) {
      test(`Installer respects ${key}, ${relative ? "relative" : "absolute"} path, ${existing ? "existing" : "missing"} settings`, async () => {
        const fixture = await mkdtemp(path.join(os.tmpdir(), "operalibre-installer-test-"));
        try {
          const install = path.join(fixture, "install");
          const caller = path.join(fixture, "caller");
          const settings = path.join(install, "custom settings");
          await mkdir(install);
          await mkdir(caller);
          const configuredPath = relative ? "custom settings" : settings;
          const config = `${key} = ${quote}${configuredPath}${quote}\n`;
          await writeFile(path.join(install, "server.config"), config);
          if (existing) {
            await mkdir(settings);
            await writeFile(path.join(settings, "Settings.json"), '{"preserve":"settings"}');
            await writeFile(path.join(settings, "AccountsSettings.json"), '{"preserve":"accounts"}');
          }
          execFileSync("sh", ["-eu", "-c", `${libationFunctions}\nensure_libation_files_dir`], {
            cwd: caller,
            env: { ...process.env, INSTALL_DIR: install },
          });
          assert.equal(await readFile(path.join(settings, "Settings.json"), "utf8"),
            existing ? '{"preserve":"settings"}' : "{}");
          assert.equal(await readFile(path.join(settings, "AccountsSettings.json"), "utf8"),
            existing ? '{"preserve":"accounts"}' : "{}");
          const updatedConfig = await readFile(path.join(install, "server.config"), "utf8");
          assert.equal(updatedConfig, existing ? config : `libation_files_dir = ${settings}\n`);
          await assert.rejects(readFile(path.join(install, "LibationFiles", "Settings.json")), { code: "ENOENT" });
          await assert.rejects(readFile(path.join(caller, "custom settings", "Settings.json")), { code: "ENOENT" });
        } finally {
          await rm(fixture, { recursive: true, force: true });
        }
      });
    }
  }
}

for (const lastValue of ["'dup settings'", "", '""']) {
  for (const existing of [false, true]) {
    test(`Installer bootstraps the last normalized files dir (${lastValue || "empty"}, ${existing ? "existing" : "missing"})`, async () => {
      const fixture = await mkdtemp(path.join(os.tmpdir(), "operalibre-installer-test-"));
      try {
        const install = path.join(fixture, "install");
        const caller = path.join(fixture, "caller");
        const settings = path.join(install, lastValue === "'dup settings'" ? "dup settings" : "LibationFiles");
        const config = `libation_files_dir = old\nLIBATION_FILES_DIR = ignored\nLibation-Files-Dir = ${lastValue}\n# libation_files_dir = commented\n`;
        await mkdir(install);
        await mkdir(caller);
        await writeFile(path.join(install, "server.config"), config);
        if (existing) {
          await mkdir(settings);
          await writeFile(path.join(settings, "Settings.json"), '{"preserve":"settings"}');
          await writeFile(path.join(settings, "AccountsSettings.json"), '{"preserve":"accounts"}');
        }
        execFileSync("sh", ["-eu", "-c", `${libationFunctions}\nensure_libation_files_dir`], {
          cwd: caller,
          env: { ...process.env, INSTALL_DIR: install },
        });
        assert.equal(await readFile(path.join(settings, "Settings.json"), "utf8"),
          existing ? '{"preserve":"settings"}' : "{}");
        assert.equal(await readFile(path.join(settings, "AccountsSettings.json"), "utf8"),
          existing ? '{"preserve":"accounts"}' : "{}");
        assert.equal(await readFile(path.join(install, "server.config"), "utf8"),
          existing && lastValue === "'dup settings'" ? config :
            `libation_files_dir = ${settings}\n# libation_files_dir = commented\n`);
        for (const unused of [path.join(install, "old"), path.join(install, "ignored"),
          path.join(caller, "dup settings")]) {
          await assert.rejects(readFile(path.join(unused, "Settings.json")), { code: "ENOENT" });
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
}

for (const [reader, key, alias, value, expected] of [
  ["configured_libation_path", "libation_cli_path", "LIBATION-CLI-PATH", "'/cli/last'", "/cli/last"],
  ["configured_libation_path", "LIBATION-CLI-PATH", "libation_cli_path", '""', ""],
  ["configured_libation_path", "libation_cli_path", "Libation-Cli-Path", "", ""],
  ["configured_port", "port", "Port", "'4123'", "4123"],
  ["configured_port", "PORT", "port", "", "4920"],
  ["configured_data_dir", "data_dir", "Data-Dir", "'last state'", "{install}/last state"],
  ["configured_data_dir", "DATA-DIR", "data_dir", '""', "{install}/data"],
]) {
  test(`Installer ${reader} uses the last normalized value (${value || "empty"})`, async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "operalibre-installer-test-"));
    try {
      const config = `${key} = 1234\n${alias} = ${value}\n# ${key} = commented\n`;
      await writeFile(path.join(fixture, "server.config"), config);
      const output = execFileSync("sh", ["-eu", "-c", `${libationFunctions}\n${reader}`], {
        cwd: fixture,
        env: { ...process.env, INSTALL_DIR: fixture },
        encoding: "utf8",
      });
      assert.equal(output.trimEnd(), expected.replace("{install}", fixture));
      assert.equal(await readFile(path.join(fixture, "server.config"), "utf8"), config);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

{
  const kind = "combined";
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
      // Everything the in-app updater applies ships in the one package.
      assert.equal(await readFile(path.join(output, "operalibre-updater"), "utf8"), "launcher fixture");
      assert.deepEqual(JSON.parse(await readFile(path.join(output, "UPDATE.json"), "utf8")),
        { schemaVersion: 1, version: "1.2.3", platform: "linux-x64" });
      assert.equal(await readFile(path.join(output, "web/index.html"), "utf8"), "web fixture");
      assert.ok((await readFile(path.join(output, "start.sh"), "utf8")).length > 0);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
