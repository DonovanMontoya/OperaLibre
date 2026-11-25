// Colour checks for the stylesheets, run by `npm run lint`.
//
// The app has one stylesheet and many appearances: the web's paper and dark
// shelf, five iOS dark themes and five iOS light themes. In iOS light mode the
// shelf, the mini player, the games and every sheet turn from dark wood to
// paper, so text there is legible only if it is drawn from the tokens that
// turn with them. These rules fail the mistakes that break that:
//
//   theme-literal    a theme colour typed out as a number or hex where its
//                    token belongs, so it cannot follow the theme.
//   fixed-text       text in a colour that never changes, in a rule that does
//                    not also paint the surface under it.
//
// A declaration that is right as written carries a reason on its own line or
// the line above:  /* lint-colors: allow <rule>: <why> */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Declaration = { prop: string; value: string; line: number };
type Rule = { selector: string; declarations: Declaration[] };
export type Finding = { rule: string; line: number; message: string };
type Rgb = [number, number, number];

const ALLOW = /lint-colors:\s*allow\s+([a-z-]+):\s*(?!\*\/)\S/;

// Comments become spaces so line numbers survive; allowances are read first.
function stripComments(css: string): { text: string; allowed: Map<number, Set<string>> } {
  const allowed = new Map<number, Set<string>>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment, offset: number) => {
    const match = ALLOW.exec(comment);
    if (match) {
      const end = css.slice(0, offset + comment.length).split("\n").length;
      for (const line of [end, end + 1]) {
        if (!allowed.has(line)) allowed.set(line, new Set());
        allowed.get(line)!.add(match[1]);
      }
    }
    return comment.replace(/[^\n]/g, " ");
  });
  return { text, allowed };
}

function parseRules(css: string): { rules: Rule[]; allowed: Map<number, Set<string>> } {
  const { text, allowed } = stripComments(css);
  const rules: Rule[] = [];
  let line = 1;
  let index = 0;

  const advance = (to: number) => {
    for (; index < to; index += 1) if (text[index] === "\n") line += 1;
  };
  // The end of a prelude or declaration: the next `{`, `}` or `;` outside
  // parentheses and strings (data URLs carry all three).
  const scan = () => {
    let depth = 0;
    let quote = "";
    for (let at = index; at < text.length; at += 1) {
      const char = text[at];
      if (quote) {
        if (char === "\\") at += 1;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (depth === 0 && (char === "{" || char === "}" || char === ";")) return at;
    }
    return text.length;
  };

  const block = (selector: string | null) => {
    const rule: Rule | null = selector === null ? null : { selector, declarations: [] };
    if (rule) rules.push(rule);
    while (index < text.length) {
      const start = index;
      const end = scan();
      const chunk = text.slice(start, end);
      const lead = chunk.length - chunk.trimStart().length;
      advance(start + lead);
      const startLine = line;
      advance(end);
      const body = chunk.trim();
      const stop = text[end];
      index = end + 1;
      if (stop === "{") {
        // Conditional groups hold rules; anything else at-shaped (keyframes,
        // font-face) is read as one rule so its colours are still checked.
        block(/^@(media|supports|layer|container)\b/.test(body) ? null : body.replace(/\s+/g, " "));
      } else {
        const colon = body.indexOf(":");
        if (rule && colon > 0) {
          rule.declarations.push({
            prop: body.slice(0, colon).trim().toLowerCase(),
            value: body.slice(colon + 1).trim().replace(/\s+/g, " "),
            line: startLine
          });
        }
        if (stop === "}" || stop === undefined) return;
      }
    }
  };
  block(null);
  return { rules, allowed };
}

// ---------- colours ----------

function parseHex(hex: string): Rgb | null {
  const digits = hex.replace("#", "");
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(digits)) return null;
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as Rgb;
}

const key = (rgb: Rgb) => rgb.join(",");

// Every colour typed out in a value: hexes and the first three numbers of
// rgb()/rgba(). A literal that is only the fallback of a token still follows
// the token, so fallbacks are not read.
function literalColours(value: string): Rgb[] {
  const found: Rgb[] = [];
  const withoutUrls = value
    .replace(/url\([^)]*\)/g, "")
    .replace(/var\(\s*--[\w-]+\s*,[^()]*(\([^()]*\)[^()]*)*\)/g, "var()");
  for (const match of withoutUrls.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
    const rgb = parseHex(match[0]);
    if (rgb) found.push(rgb);
  }
  for (const match of withoutUrls.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) {
    found.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  return found;
}

// ---------- theme-literal ----------

const PAINT = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|caret-color|text-decoration(-color)?|column-rule(-color)?)$/;

// The colours text, hairlines and tints are drawn in, read from :root. The
// fills (gold, oxblood, the lifted surfaces) are left out: a typed-out fill
// is a missed retint, not unreadable text.
const TEXT_TOKENS = /^--(paper|ink|ink-soft|ink-faded|gold-soft|(ink|on-spine|on-spine-bright|spine-gold)-rgb)$/;

function palette(rules: Rule[]): Map<string, string> {
  const byColour = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selector !== ":root") continue;
    for (const { prop, value } of rule.declarations) {
      if (!TEXT_TOKENS.test(prop)) continue;
      const triple = /^(\d+),\s*(\d+),\s*(\d+)$/.exec(value);
      const rgb = triple ? ([Number(triple[1]), Number(triple[2]), Number(triple[3])] as Rgb) : parseHex(value);
      if (!rgb || byColour.has(key(rgb))) continue;
      byColour.set(key(rgb), prop);
    }
  }
  return byColour;
}

// ---------- fixed-text ----------

// Tokens that keep one tone in every appearance, so text in them is legible
// on one kind of surface only.
const FIXED_TOKENS = /var\(\s*--(paper|paper-deep|spine|spine-deep|gold|gold-soft|dark-bg|dark-card)\s*[,)]/;
// A wash of a few percent lets the surface behind show through, so the text
// over it is still at the mercy of that surface. Only a background with
// something at half strength or more counts as the rule's own surface.
const FAINT = /rgba?\((?:[^()]|\([^()]*\))*[,/]\s*(?:0?\.[0-4]\d*|0)\s*\)/gi;
const SOLID = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|var\(\s*--|\b(?:white|black)\b/i;

function paintsSurface(rule: Rule): boolean {
  return rule.declarations.some(
    ({ prop, value }) => (prop === "background" || prop === "background-color") && SOLID.test(value.replace(FAINT, ""))
  );
}

// Colours the palette check cannot turn into numbers but that are just as fixed.
const NAMED = /\bhsla?\(|(?<![\w-])(?:white|black)(?![\w-])/i;

// A selector written for one appearance knows what it sits on.
const APPEARANCE_SELECTOR = /\.dark-mode|data-(dark|light)-theme/;

function fixedTextColour(value: string): string | null {
  const token = FIXED_TOKENS.exec(value);
  if (token) return `--${token[1]} keeps one tone in every appearance`;
  if (literalColours(value).length > 0 || NAMED.test(value.replace(/var\([^()]*\)/g, ""))) {
    return "a typed-out colour never changes with the appearance";
  }
  return null;
}

// ---------- the checks ----------

// `tokens` is the stylesheet that defines :root, when that is another file.
export function checkStyles(css: string, tokens = css): Finding[] {
  const { rules, allowed } = parseRules(css);
  const findings: Finding[] = [];
  const report = (rule: string, line: number, message: string) => {
    if (!allowed.get(line)?.has(rule)) findings.push({ rule, line, message });
  };

  const colours = palette(tokens === css ? rules : parseRules(tokens).rules);
  const surfaces = new Set(rules.filter(paintsSurface).map((rule) => rule.selector));

  for (const rule of rules) {
    // Text over a fill the same rule paints is a fixed pair, right as typed.
    const ownSurface = surfaces.has(rule.selector);
    for (const { prop, value, line } of rule.declarations) {
      if (PAINT.test(prop) && !(prop === "color" && ownSurface)) {
        for (const rgb of literalColours(value)) {
          const token = colours.get(key(rgb));
          if (token) report("theme-literal", line, `${prop} spells out the value of ${token}; use the token so it follows the theme`);
        }
      }
      if (prop === "color" && !ownSurface && !APPEARANCE_SELECTOR.test(rule.selector)) {
        const reason = fixedTextColour(value);
        if (reason) {
          report("fixed-text", line, `${rule.selector} { color: ${value} }: ${reason}, and this rule does not paint what is under it. Use the text token for its surface (--ink, --on-spine, --spine-gold, --on-gold …)`);
        }
      }
    }
  }

  return findings;
}

// ---------- command line ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = 0;
  const sheets = process.argv.slice(2).map((file) => [file, readFileSync(file, "utf8")]);
  const tokens = sheets.map(([, css]) => css).find((css) => /^:root\s*\{/m.test(css));
  for (const [file, css] of sheets) {
    for (const finding of checkStyles(css, tokens)) {
      failed += 1;
      console.error(`${file}:${finding.line}  ${finding.rule}  ${finding.message}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} colour ${failed === 1 ? "problem" : "problems"}. See the top of lint/styleColors.ts for what each rule means and how to allow an exception.`);
    process.exit(1);
  }
}
