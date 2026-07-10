import { spawn } from "node:child_process";

const children = [
  spawn("cargo", ["run", "--manifest-path", "apps/server/Cargo.toml"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "@operalibre/web"], { stdio: "inherit" })
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
