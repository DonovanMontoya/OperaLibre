import { spawn } from "node:child_process";

function spawnNpm(args) {
  // npm is a .cmd shim on Windows, which child_process.spawn() cannot resolve
  // like an interactive shell does. npm exposes its real JavaScript entry
  // point to lifecycle scripts, so run that with the current Node executable.
  if (process.env.npm_execpath) {
    return spawn(process.execPath, [process.env.npm_execpath, ...args], {
      stdio: "inherit"
    });
  }

  return spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
}

const children = [
  spawn("cargo", ["run", "--manifest-path", "apps/server/Cargo.toml"], { stdio: "inherit" }),
  spawnNpm(["run", "dev", "-w", "@operalibre/web"])
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop();
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
