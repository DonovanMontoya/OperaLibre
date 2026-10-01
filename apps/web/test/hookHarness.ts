import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const registry = new Map<string, (id: string) => unknown>();
let loads = 0;
(globalThis as any).__hookDependencies = registry;

// Execute the actual hooks with deterministic React, storage, media and API
// boundaries. No browser clock or network timing is needed to reproduce races.
// Imports are rewritten to read the supplied mocks and the result is loaded by
// Node's own type stripping, which the minimum supported Node 22.12 already has;
// `stripTypeScriptTypes` from `node:module` only exists from 22.13.
export function loadHook(name: string, dependencies: Record<string, unknown>) {
  const key = `${name}:${loads++}`;
  registry.set(key, (id: string) => {
    if (!(id in dependencies)) throw new Error(`Unmocked dependency: ${id}`);
    return dependencies[id];
  });
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8")
    .replace(/import\s+type\s+[^;]+;/g, "")
    .replace(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/g, (_all, names: string, id: string) => {
      const bindings = names.split(",").map(part => part.trim())
        .filter(part => part && !part.startsWith("type "))
        .map(part => part.replace(/^(\S+)\s+as\s+(\S+)$/, "$1: $2"));
      return `const {${bindings.join(", ")}} = (globalThis as any).__hookDependencies.get(${JSON.stringify(key)})(${JSON.stringify(id)});`;
    });
  const directory = mkdtempSync(join(tmpdir(), "operalibre-hook-"));
  try {
    const file = join(directory, `${name}.mts`);
    writeFileSync(file, source);
    return require(file)[name] as (options: any) => any;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
