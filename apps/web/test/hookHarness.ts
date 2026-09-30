import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Execute the actual hooks with deterministic React, storage, media and API
// boundaries. No browser clock or network timing is needed to reproduce races.
export function loadHook(name: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const compiled = stripTypeScriptTypes(source)
    .replace(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/g, 'const {$1} = require("$2");')
    .replace(/export function /g, "function ");
  const exports: Record<string, (options: any) => any> = {};
  new Function("require", "exports", `${compiled}\nexports.${name} = ${name};`)((id: string) => {
    if (!(id in dependencies)) throw new Error(`Unmocked dependency: ${id}`);
    return dependencies[id];
  }, exports);
  return exports[name];
}
