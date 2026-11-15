import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const publicRoot = new URL("../public/", import.meta.url);

test("the app shell loads its fonts from its own deployment, including proxy subpaths", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/<link\b[^>]*href="([^"]+)"/g)) {
    const resource = new URL(match[1], "https://books.example.org/operalibre/");
    assert.equal(resource.origin, "https://books.example.org", "shell must not contact a font provider");
  }
  const css = readFileSync(new URL("fonts.css", publicRoot), "utf8");
  for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
    const resource = new URL(match[1], "https://books.example.org/operalibre/fonts.css");
    assert.ok(resource.href.startsWith("https://books.example.org/operalibre/fonts/"));
    const bytes = readFileSync(new URL(match[1], new URL("fonts.css", publicRoot)));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2", "every declared font ships with the app");
  }
  for (const family of ["Fraunces", "Instrument Serif", "JetBrains Mono"]) {
    assert.ok(css.includes(`font-family: '${family}'`));
  }
});
