import assert from "node:assert/strict";
import test from "node:test";
import { checkStyles } from "../lint/styleColors.ts";

const tokens = `
:root {
  --paper: #f1e7d0;
  --ink: #1a1410;
  --gold: #b8893a;
  --gold-soft: #d9b574;
  --on-spine: var(--paper);
  --on-spine-rgb: 241, 231, 208;
  --spine-gold-rgb: 217, 181, 116;
  --ink-rgb: 26, 20, 16;
}
`;

const rules = (css: string) => checkStyles(tokens + css).map((finding) => finding.rule);

test("the saved-clips sheet's cream text on a sheet that turns to paper is caught", () => {
  // What shipped: unreadable in the light appearance, where the sheet is paper.
  const findings = checkStyles(`${tokens}
.clip-empty strong {
  color: var(--paper);
}
.clip-empty p {
  color: rgba(241, 231, 208, 0.74);
}
.clip-row {
  border-bottom: 1px solid rgba(241, 231, 208, 0.13);
}`);
  assert.deepEqual(findings.map(({ rule, line }) => [rule, line]), [
    ["fixed-text", 14],
    ["theme-literal", 17],
    ["fixed-text", 17],
    ["theme-literal", 20]
  ]);
});

test("the same styles drawn from the surface's tokens pass", () => {
  assert.deepEqual(rules(`
.clip-empty strong { color: var(--on-spine); }
.clip-empty p { color: rgba(var(--on-spine-rgb), 0.74); }
.clip-row { border-bottom: 1px solid rgba(var(--on-spine-rgb), 0.13); }
.status { color: var(--cv-success, #2f5a3c); }`), []);
});

test("a fixed text colour is fine where the rule paints its own surface", () => {
  assert.deepEqual(rules(`
.clip-error { color: #fff6ef; background: #8b2e1f; }
.gift-tag { color: #1a1410; background: #f6eedb; }
.badge { color: var(--paper); }
.badge { background-color: var(--ink); }`), []);
  // A transparent or absent background is not a surface, and neither is a
  // faint wash: the clip sheet's buttons were cream over 5% white.
  assert.deepEqual(rules(`.ghost { color: #fff; background: transparent; }`), ["fixed-text"]);
  assert.deepEqual(rules(`
.clip-length button { color: rgba(255, 250, 237, 0.88); background: rgba(255, 255, 255, 0.05); }
.clip-field textarea { color: var(--paper); background: rgba(255, 255, 255, 0.05); }
.clip-play { color: var(--gold-soft); background: rgba(var(--spine-gold-rgb), 0.08); }`), ["fixed-text", "fixed-text", "fixed-text"]);
  assert.deepEqual(rules(`.chip { color: white; } .tag { color: hsl(40 60% 80%); }`), ["fixed-text", "fixed-text"]);
});

test("rules written for one appearance may name their colours", () => {
  assert.deepEqual(rules(`
html.dark-mode .state { color: #9fd3ac; }
html:not(.dark-mode)[data-light-theme="sage"] .state { color: #17201b; }`), []);
});

test("shadows and fills are not held to the text palette", () => {
  assert.deepEqual(rules(`
.card { box-shadow: 0 8px 20px rgba(26, 20, 16, 0.35); }
.meter { background: linear-gradient(90deg, #b8893a, #8b2e1f); }`), []);
});

test("an allowance needs the rule's name and a reason, and covers only its line", () => {
  assert.deepEqual(rules(`
.desk p {
  /* lint-colors: allow fixed-text: Desk View is always black */
  color: #fff;
}`), []);
  assert.deepEqual(rules(`
.desk p {
  /* lint-colors: allow fixed-text */
  color: #fff;
}`), ["fixed-text"]);
  assert.deepEqual(rules(`
.desk p {
  /* lint-colors: allow theme-literal: wrong rule */
  color: #fff;
}
.desk b { color: #fff; }`), ["fixed-text", "fixed-text"]);
});

test("rules inside media queries and beside data URLs are still read", () => {
  assert.deepEqual(rules(`
.wash { background: url("data:image/svg+xml;utf8,<svg a='{;}'/>"); }
@media (min-width: 720px) {
  .note { color: var(--gold-soft); }
}`), ["fixed-text"]);
});

test("a sheet without :root takes its palette from the one that has it", () => {
  const sheet = `.gift { border: 1px solid rgba(241, 231, 208, 0.2); }`;
  assert.deepEqual(checkStyles(sheet).length, 0);
  assert.deepEqual(checkStyles(sheet, tokens).map((finding) => finding.rule), ["theme-literal"]);
});
