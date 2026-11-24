import { chmod, copyFile, cp, mkdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { patchEmptyTimeline } from "../addons/readalong-sync/patch-runtime.mjs";
import { FAST, fetchModel } from "../addons/readalong-sync/recognize.mjs";

// The bundled speech model is CC-BY-4.0, which asks for this attribution.
const MODEL_NOTICE = `# Speech models

parakeet-tdt-110m is NVIDIA's Parakeet TDT-CTC 110M English speech recognition
model (https://huggingface.co/nvidia/parakeet-tdt_ctc-110m), licensed under
Creative Commons Attribution 4.0 International
(https://creativecommons.org/licenses/by/4.0/). The sherpa-onnx project
(https://github.com/k2-fsa/sherpa-onnx) converted its transducer decoder to ONNX
and quantized it to 8 bits. The files here are the ones that project publishes.

Follow-along sync may also download parakeet-tdt-0.6b-v2, NVIDIA's Parakeet TDT
0.6B v2 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), converted by the
same project and under the same license: quantized for the processor, and
unquantized for a graphics card.
`;

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
  await patchEmptyTimeline(path.join(output, "node_modules/echogarden/dist/utilities/Timeline.js"));
  await copyFile(path.join(runtimeRoot, "recognize.mjs"), path.join(output, "recognize.mjs"));
  await fetchModel(FAST, path.join(output, "models"));
  await writeFile(path.join(output, "models/NOTICE.md"), MODEL_NOTICE);
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
  execFileSync(path.join(output, cli), [path.join(output, "recognize.mjs"), "check"], { stdio: "pipe" });

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
      ffmpeg,
      recognizer: "recognize.mjs"
    }, null, 2)}\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
