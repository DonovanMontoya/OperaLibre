import type { Page } from '@playwright/test';

export type ContrastIssue = {
  element: string;
  text: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
};

type Sample = { element: string; text: string; required: number; color: number[]; box: number[] };

// Measures every piece of text on screen against the pixels under it and
// reports the ones below WCAG AA (4.5:1, or 3:1 for large text and for the
// icon of an icon-only control). The colour
// lint reads the stylesheet, but a rule cannot know which surface its element
// lands on in which appearance, so this looks at the rendered page.
//
// The page is photographed once with its text hidden, so what is under each
// run of text is whatever the browser really painted there: gradients, glass,
// a cover. Each run is held to the middle of its backdrop, so paper grain and
// a stray edge do not decide it. Text that is
// covered, scrolled out of view or in a disabled control is not measured.
// Mark text that is meant to be faint with `data-contrast-ok`.
export async function auditContrast(page: Page, scope = 'body'): Promise<ContrastIssue[]> {
  // The audit sees one screenful, so a longer screen is read a page at a time.
  const scroller = await page.evaluateHandle((scope) => {
    const root = document.querySelector(scope);
    const candidates = root ? [root, ...root.querySelectorAll('*')] : [];
    const scrolls = (el: Element) => el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY)
      && el.getBoundingClientRect().height > window.innerHeight / 3;
    return candidates.find(scrolls) ?? (document.scrollingElement!.scrollHeight > window.innerHeight + 40 ? document.scrollingElement : null);
  }, scope);
  const start = await scroller.evaluate((el) => el?.scrollTop ?? 0);
  const found = new Map<string, ContrastIssue>();
  for (;;) {
    for (const issue of await auditScreen(page, scope)) found.set(`${issue.element}|${issue.color}|${issue.background}`, issue);
    const more = await scroller.evaluate((el) => {
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop += el.clientHeight * 0.8;
      return el.scrollTop > before + 1;
    });
    if (!more) break;
  }
  await scroller.evaluate((el, start) => { if (el) el.scrollTop = start; }, start);
  return [...found.values()];
}

async function auditScreen(page: Page, scope: string): Promise<ContrastIssue[]> {
  const samples: Sample[] = await page.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return [];
    const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    // Any CSS colour, including color-mix() and named colours, as RGBA.
    const parse = (value: string) => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = '#000';
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const classes = (el: Element | null, limit: number) => el && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, limit).join('.')
      : '';
    const name = (el: Element) => {
      const parent = classes(el.parentElement, 1);
      return `${parent ? `${parent} > ` : ''}${el.tagName.toLowerCase()}${classes(el, 2)}`;
    };
    const skipped = (el: Element) => {
      if (el.closest('[data-contrast-ok], [inert], :disabled, [aria-disabled="true"]')) return true;
      const details = el.closest('details:not([open])');
      if (details && !el.closest('summary')) return true;
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return true;
      }
      return false;
    };

    const found: Sample[] = [];
    const add = (el: Element, rect: DOMRect, text: string, colourValue: string, minimum?: number) => {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (rect.width < 2 || rect.height < 2 || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return;
      // Covered by something that is not part of it: not on screen here.
      // Scrolled out of a clipping box: in the window but not shown.
      for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const box = node.getBoundingClientRect();
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
      }
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === el || el.contains(top) || top.contains(el))) return;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const colour = parse(colourValue);
      for (let node: Element | null = el; node; node = node.parentElement) colour[3] *= Number(getComputedStyle(node).opacity);
      found.push({
        element: name(el),
        text: text.trim().replace(/\s+/g, ' ').slice(0, 40),
        // A lone symbol is a graphic, held to 3:1 like an icon.
        required: minimum ?? (/^[^\p{L}\p{N}]+$/u.test(text.trim()) || size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5),
        color: colour,
        box: [rect.left, rect.top, rect.right, rect.bottom]
      });
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const text = node.textContent ?? '';
      if (!el || !text.trim() || skipped(el)) continue;
      range.selectNodeContents(node);
      const rect = range.getClientRects()[0];
      if (!rect) continue;
      const style = getComputedStyle(el);
      const fill = style.webkitTextFillColor;
      add(el, rect, text, fill && fill !== 'currentcolor' ? fill : style.color);
    }
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]')) {
      if (field.value || skipped(field)) continue;
      add(field, field.getBoundingClientRect(), field.placeholder, getComputedStyle(field, '::placeholder').color);
    }
    // A control that is only an icon has to show against its backdrop too.
    for (const control of root.querySelectorAll('button, a[href], [role="button"], [role="tab"], summary')) {
      if ((control.textContent ?? '').trim() || skipped(control)) continue;
      const icon = control.querySelector('svg');
      if (!icon) continue;
      const style = getComputedStyle(icon);
      const paint = style.stroke !== 'none' ? style.stroke : style.fill;
      if (paint === 'none') continue;
      add(icon, icon.getBoundingClientRect(), control.getAttribute('aria-label') ?? 'icon', paint, 3);
    }
    return found;
  }, scope);
  if (samples.length === 0) return [];

  const hidden = await page.addStyleTag({ content: `
    *, *::before, *::after, ::placeholder {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
      transition: none !important;
    }
    :is(button, a, summary, [role="button"], [role="tab"]) svg { visibility: hidden !important; }` });
  const backdrop = (await page.screenshot({ animations: 'disabled', scale: 'css' })).toString('base64');
  // Let the colours snap back before transitions are allowed again; otherwise
  // the next reading catches text fading in from transparent.
  await hidden.evaluate(async (style) => {
    style.textContent = '*, *::before, *::after { transition: none !important; }';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    (style as Element).remove();
  });

  return page.evaluate(async ({ samples, backdrop }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${backdrop}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);

    const luminance = (rgb: number[]) => rgb.slice(0, 3)
      .map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const hex = (rgb: number[]) => '#' + rgb.slice(0, 3).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

    const issues = new Map<string, ContrastIssue>();
    for (const sample of samples) {
      const [left, top, right, bottom] = sample.box.map(Math.round);
      const width = Math.min(right, canvas.width) - left;
      const height = Math.min(bottom, canvas.height) - top;
      if (width < 1 || height < 1) continue;
      const pixels = context.getImageData(left, top, width, height).data;
      const step = Math.max(1, Math.floor((width * height) / 400));
      const measured: { ratio: number; text: number[]; back: number[] }[] = [];
      for (let at = 0; at < width * height; at += step) {
        const back = [pixels[at * 4], pixels[at * 4 + 1], pixels[at * 4 + 2]];
        const alpha = sample.color[3];
        const text = back.map((channel, index) => sample.color[index] * alpha + channel * (1 - alpha));
        const [light, dark] = [luminance(text), luminance(back)].sort((a, b) => b - a);
        measured.push({ ratio: (light + 0.05) / (dark + 0.05), text, back });
      }
      measured.sort((a, b) => a.ratio - b.ratio);
      const typical = measured[Math.floor(measured.length / 2)];
      if (typical.ratio >= sample.required) continue;
      const issue = {
        element: sample.element,
        text: sample.text,
        ratio: Math.round(typical.ratio * 100) / 100,
        required: sample.required,
        color: hex(typical.text),
        background: hex(typical.back)
      };
      const id = `${issue.element}|${issue.color}|${issue.background}`;
      if (!issues.has(id)) issues.set(id, issue);
    }
    return [...issues.values()];
  }, { samples, backdrop });
}
