import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArguments(argv) {
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

function requireOption(options, key) {
  const value = options[key];
  if (!value) {
    throw new Error(`Missing required --${key} option.`);
  }
  return value;
}

async function copyExecutable(source, destination) {
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}

async function stageFrontend({ output, version, web }) {
  await cp(web, path.join(output, "web"), { recursive: true });
  await copyFile("release/START-HERE-frontend.txt", path.join(output, "START-HERE.txt"));
  await copyFile("LICENSE.md", path.join(output, "LICENSE.md"));
  await writeFile(path.join(output, "VERSION.txt"), `${version}\n`);
}

async function writeMacApp({ destination, executable, name }) {
  const contents = path.join(destination, "Contents");
  const macos = path.join(contents, "MacOS");
  await mkdir(macos, { recursive: true });
  await copyExecutable(executable, path.join(macos, "operalibre-launcher"));
  await writeFile(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${name}</string>
  <key>CFBundleExecutable</key>
  <string>operalibre-launcher</string>
  <key>CFBundleIdentifier</key>
  <string>com.donovanmontoya.operalibre.${name.startsWith("Stop") ? "stop" : "open"}</string>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
`,
  );
}

async function stageNative({ binary, kind, launcher, output, platform, version, web }) {
  const windows = platform.startsWith("windows");
  const macos = platform.startsWith("macos");
  const binaryName = windows ? "operalibre-server.exe" : "operalibre-server";

  await copyExecutable(binary, path.join(output, binaryName));
  await copyFile(
    kind === "combined" ? "release/combined.config" : "release/server-only.config",
    path.join(output, "server.config"),
  );
  await copyFile(
    kind === "combined"
      ? "release/START-HERE-combined.txt"
      : "release/START-HERE-server.txt",
    path.join(output, "START-HERE.txt"),
  );
  await copyFile("LICENSE.md", path.join(output, "LICENSE.md"));
  await writeFile(path.join(output, "VERSION.txt"), `${version}\n`);
  await mkdir(path.join(output, "audiobooks"), { recursive: true });
  await writeFile(
    path.join(output, "audiobooks", "PUT_AUDIOBOOKS_HERE.txt"),
    "Copy audiobook files or book folders here, then rescan the library.\n",
  );
  await mkdir(path.join(output, "data"), { recursive: true });

  if (kind === "combined") {
    if (!web) {
      throw new Error("Combined packages require --web.");
    }
    if (!launcher) {
      throw new Error("Combined packages require --launcher.");
    }
    await cp(web, path.join(output, "web"), { recursive: true });
    if (windows) {
      await copyExecutable(launcher, path.join(output, "Open OperaLibre.exe"));
      await copyExecutable(launcher, path.join(output, "Stop OperaLibre.exe"));
    } else if (macos) {
      await writeMacApp({
        destination: path.join(output, "Open OperaLibre.app"),
        executable: launcher,
        name: "Open OperaLibre",
      });
      await writeMacApp({
        destination: path.join(output, "Stop OperaLibre.app"),
        executable: launcher,
        name: "Stop OperaLibre",
      });
    } else {
      await copyExecutable(launcher, path.join(output, "open-operalibre"));
      await copyExecutable(launcher, path.join(output, "stop-operalibre"));
    }
  } else if (windows) {
    await copyFile("release/start.cmd", path.join(output, "start.cmd"));
  } else {
    await copyExecutable("release/start.sh", path.join(output, "start.sh"));
  }
}

async function stageUpdate({ binary, launcher, output, platform, version, web }) {
  const windows = platform.startsWith("windows");
  const binaryName = windows ? "operalibre-server.exe" : "operalibre-server";
  const updaterName = windows ? "operalibre-updater.exe" : "operalibre-updater";

  await copyExecutable(binary, path.join(output, binaryName));
  await copyExecutable(launcher, path.join(output, updaterName));
  await cp(web, path.join(output, "web"), { recursive: true });
  await writeFile(path.join(output, "VERSION.txt"), `${version}\n`);
  await writeFile(
    path.join(output, "UPDATE.json"),
    `${JSON.stringify({ schemaVersion: 1, version, platform }, null, 2)}\n`,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const kind = requireOption(options, "kind");
  const output = path.resolve(requireOption(options, "output"));
  const version = requireOption(options, "version");

  if (!["server", "frontend", "combined", "update"].includes(kind)) {
    throw new Error(`Unsupported package kind: ${kind}`);
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  if (kind === "frontend") {
    await stageFrontend({
      output,
      version,
      web: requireOption(options, "web"),
    });
    return;
  }

  if (kind === "update") {
    await stageUpdate({
      binary: requireOption(options, "binary"),
      launcher: requireOption(options, "launcher"),
      output,
      platform: requireOption(options, "platform"),
      version,
      web: requireOption(options, "web"),
    });
    return;
  }

  await stageNative({
    binary: requireOption(options, "binary"),
    kind,
    launcher: options.launcher,
    output,
    platform: requireOption(options, "platform"),
    version,
    web: options.web,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
