import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function devServerEnvironment(env = process.env, cwd = process.cwd()) {
  return {
    ...env,
    ...(env.OPERALIBRE_SERVER_CONFIG !== undefined
      ? { OPERALIBRE_SERVER_CONFIG: path.resolve(cwd, env.OPERALIBRE_SERVER_CONFIG) }
      : {})
  };
}

export function devProxyTarget(env = process.env, cwd = repositoryRoot) {
  const explicit = env.OPERALIBRE_SERVER_CONFIG !== undefined;
  const configPath = path.resolve(cwd, env.OPERALIBRE_SERVER_CONFIG ?? "server.config");
  let contents;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" || explicit) throw error;
    contents = "";
  }
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) throw new Error("Invalid server.config: expected key = value");
    const key = line.slice(0, separator).trim().toLowerCase().replaceAll("-", "_");
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values.set(key, value.trim());
  }
  const port = values.get("port") || env.PORT?.trim() || "4920";
  if (!/^\+?\d+$/.test(port) || Number(port) > 65535) {
    throw new Error("Invalid development server port: expected an unsigned 16-bit integer");
  }
  const host = values.get("host") || env.HOST?.trim() || "127.0.0.1";
  const targetHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${targetHost.includes(":") ? `[${targetHost}]` : targetHost}:${Number(port)}`;
}
