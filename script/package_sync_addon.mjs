import { chmod, copyFile, cp, mkdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

function argumentsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received: ${argv.join(" ")}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing required --${name} option.`);
  return options[name];
}

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findNodeLicense() {
  let current = path.dirname(process.execPath);
  for (let depth = 0; depth < 4; depth += 1) {
    for (const name of ["LICENSE", "LICENSE.txt"]) {
      const candidate = path.join(current, name);
      if (await exists(candidate)) return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error("Could not find the Node.js runtime LICENSE file.");
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const output = path.resolve(required(options, "output"));
  const platform = required(options, "platform");
  const version = required(options, "version");
  const hostPlatform = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (platform !== hostPlatform) {
    throw new Error(`Build ${platform} on a matching native runner; this runtime is ${hostPlatform}.`);
  }
  if (await exists(output)) throw new Error(`Output already exists: ${output}. Choose a fresh staging directory.`);
  const runtimeRoot = path.resolve("addons/readalong-sync");
  const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
  const windows = platform.startsWith("windows-");
  const nodeName = windows ? "node.exe" : "node";
  const ffmpegSource = runtimeRequire("ffmpeg-static");

  await mkdir(path.join(output, "runtime"), { recursive: true });
  await cp(path.join(runtimeRoot, "node_modules"), path.join(output, "node_modules"), {
    recursive: true
  });
  await copyFile(process.execPath, path.join(output, "runtime", nodeName));
  await copyFile("LICENSE.md", path.join(output, "LICENSE.md"));
  await copyFile(await findNodeLicense(), path.join(output, "NODE-LICENSE.txt"));

  const packagedFfmpeg = path.relative(runtimeRoot, ffmpegSource);
  const ffmpeg = packagedFfmpeg.replaceAll(path.sep, "/");
  const cli = `runtime/${nodeName}`;
  if (!windows) {
    await chmod(path.join(output, "runtime", nodeName), 0o755);
    await chmod(path.join(output, ffmpeg), 0o755);
  }

  // Fail the release build if a packaged runtime or its dependencies cannot load.
  execFileSync(path.join(output, cli), [path.join(output, "node_modules/echogarden/dist/cli/CLILauncher.js"), "help"], { stdio: "pipe" });
  execFileSync(path.join(output, ffmpeg), ["-version"], { stdio: "pipe" });

  await writeFile(
    path.join(output, "ADDON.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "readalong-sync",
      version,
      platform,
      protocolVersion: 1,
      cli,
      cliArgs: ["node_modules/echogarden/dist/cli/CLILauncher.js"],
      ffmpeg
    }, null, 2)}\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
