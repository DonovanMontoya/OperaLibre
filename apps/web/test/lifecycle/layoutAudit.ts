import type { Page } from '@playwright/test';

export type LayoutIssue = {
  kind: 'page-overflow' | 'text-overlap' | 'control-overlap' | 'clipped-text' | 'clipped-control';
  detail: string;
};

// Geometry checks for what a screenshot reviewer would flag at once: words
// printed over other words, controls stacked on each other, and text or
// controls cut off by their own box or the window. CSS cannot be linted for
// this because it depends on the rendered width of each pane, so these run in
// the browser at every viewport the layout spec visits.
//
// Something covered by a dialog, scrim, or other opaque layer is not reported.
// Mark an intentional overlap with `data-layout-overlap-ok` on either element.
export async function auditLayout(page: Page): Promise<LayoutIssue[]> {
  return page.evaluate(() => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const issues: { kind: string; detail: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const viewport: Box = { left: 0, top: 0, right: vw, bottom: vh };
    const slack = 2;

    const intersect = (a: Box, b: Box): Box | null => {
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      return right - left > 0 && bottom - top > 0 ? { left, top, right, bottom } : null;
    };
    const area = (b: Box) => (b.right - b.left) * (b.bottom - b.top);
    const box = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

    const name = (el: Element) => {
      const label = el.getAttribute('aria-label') || (el.textContent || '').trim().replace(/\s+/g, ' ');
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      return `${el.tagName.toLowerCase()}${cls}${label ? ` "${label.slice(0, 40)}"` : ''}`;
    };

    const shown = (el: Element) => {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
      if (el.closest('[aria-hidden="true"], [inert]')) return false;
      // A closed <details> hides its body through a pseudo-element, which
      // computed styles on the body itself do not show.
      const details = el.closest('details:not([open])');
      if (details && !el.closest('summary')) return false;
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };

    const optedOut = (el: Element) => !!el.closest('[data-layout-overlap-ok]');

    // `visible` is the part of an element its clipping ancestors let
    // through. `hard` is the part left after only the clips nobody can scroll
    // past: overflow hidden on an axis no scroller below already handles, and
    // not a deliberate ellipsis or line clamp. A box that scrolls vertically
    // but hides horizontal overflow still cuts content off at its sides.
    // Text starts at its own element, whose overflow (often an ellipsis)
    // clips it too; a control starts at its parent.
    const clipFor = (el: Element, self = false) => {
      let visible: Box | null = viewport;
      let hard: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
      let clipper: Element | null = null;
      let scrolledX = false;
      let scrolledY = false;
      for (let node = self ? el : el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        const clipsX = style.overflowX !== 'visible';
        const clipsY = style.overflowY !== 'visible';
        if (!clipsX && !clipsY) continue;
        const r = node.getBoundingClientRect();
        visible = visible && intersect(visible, {
          left: clipsX ? r.left : -Infinity,
          right: clipsX ? r.right : Infinity,
          top: clipsY ? r.top : -Infinity,
          bottom: clipsY ? r.bottom : Infinity
        });
        const scrollsX = /auto|scroll/.test(style.overflowX);
        const scrollsY = /auto|scroll/.test(style.overflowY);
        const truncates = style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none';
        const hardX = clipsX && !scrollsX && !scrolledX && !truncates && node !== el;
        const hardY = clipsY && !scrollsY && !scrolledY && !truncates && node !== el;
        if (hardX || hardY) {
          hard = {
            left: hardX ? Math.max(hard.left, r.left) : hard.left,
            right: hardX ? Math.min(hard.right, r.right) : hard.right,
            top: hardY ? Math.max(hard.top, r.top) : hard.top,
            bottom: hardY ? Math.min(hard.bottom, r.bottom) : hard.bottom
          };
          clipper ??= node;
        }
        scrolledX ||= scrollsX;
        scrolledY ||= scrollsY;
      }
      return { visible, hard, clipper };
    };
    const cutOff = (rect: Box, hard: Box, keep: number) => {
      const left = intersect(rect, hard);
      return !left || area(left) < area(rect) * keep;
    };

    const paints = (el: Element) => {
      const style = getComputedStyle(el);
      return style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none' || style.backdropFilter !== 'none';
    };
    // Whether `layer` belongs to something laid over the page (a dialog,
    // popover, sheet, or scrim) rather than to the same flow as `under`.
    const overlay = (layer: Element, under: Element) => {
      for (let node: Element | null = layer; node && !node.contains(under); node = node.parentElement) {
        if (node.matches('dialog, [popover], [role="dialog"], [role="menu"]')) return true;
        if (/fixed|absolute|sticky/.test(getComputedStyle(node).position)) return true;
      }
      return false;
    };
    // A collision hidden under a dialog, menu, or scrim is not a defect. Find
    // the lower of the two elements in the paint stack at the overlap; it is
    // hidden when a painted overlay sits above it there.
    const covered = (a: Element, b: Element, at: Box) => {
      const stack = document.elementsFromPoint((at.left + at.right) / 2, (at.top + at.bottom) / 2);
      const depth = (el: Element) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const index = stack.findIndex(layer => layer === node || node.contains(layer));
          if (index >= 0) return index;
        }
        return stack.length;
      };
      const [lower, index] = depth(a) >= depth(b) ? [a, depth(a)] : [b, depth(b)];
      return stack.slice(0, index).some(layer => !layer.contains(lower) && paints(layer) && overlay(layer, lower));
    };

    const truncatesText = (el: Element) => {
      for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none') return true;
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return false;
      }
      return false;
    };

    // Lines of text with the element that owns them.
    const lines: { el: Element; rect: Box }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Map<Element, boolean>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const el = node.parentElement;
      if (!el || el.closest('script, style, noscript, option, select, textarea')) continue;
      if (!seen.has(el)) seen.set(el, shown(el));
      if (!seen.get(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const { visible, hard, clipper } = clipFor(el, true);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 2 || r.height < 4) continue;
        const rect = box(r);
        if (!intersect(rect, viewport)) continue;
        const inside = visible && intersect(rect, visible);
        if (clipper && !truncatesText(el) && !optedOut(el) && cutOff(rect, hard, 0.9) && !covered(el, el, rect)) {
          issues.push({ kind: 'clipped-text', detail: `${name(el)} is cut off by ${name(clipper)}` });
        }
        if (inside) lines.push({ el, rect: inside });
      }
    }

    const reported = new Set<string>();
    const pairKey = (a: Element, b: Element) => [name(a), name(b)].sort().join(' | ');

    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const a = lines[i];
        const b = lines[j];
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const hit = intersect(a.rect, b.rect);
        // Line boxes of display type can graze each other by a few pixels
        // without any glyphs touching.
        const minHeight = Math.max(slack, 0.25 * Math.min(a.rect.bottom - a.rect.top, b.rect.bottom - b.rect.top));
        if (!hit || hit.right - hit.left < slack || hit.bottom - hit.top < minHeight) continue;
        if (optedOut(a.el) || optedOut(b.el) || covered(a.el, b.el, hit)) continue;
        const key = pairKey(a.el, b.el);
        if (reported.has(key)) continue;
        reported.add(key);
        issues.push({ kind: 'text-overlap', detail: `${name(a.el)} overlaps ${name(b.el)}` });
      }
    }

    const controls = Array.from(document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="slider"], [role="switch"]'
    )).filter(shown).filter(el => !(el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox') && el.getBoundingClientRect().width < 4));

    const controlBoxes: { el: Element; rect: Box }[] = [];
    for (const el of controls) {
      const rect = box(el.getBoundingClientRect());
      if (!intersect(rect, viewport)) continue;
      const { visible, hard, clipper } = clipFor(el);
      const inside = visible && intersect(rect, visible);
      if (clipper && !optedOut(el) && cutOff(rect, hard, 0.75) && !covered(el, el, rect)) {
        issues.push({ kind: 'clipped-control', detail: `${name(el)} is cut off by ${name(clipper)}` });
      }
      if (inside) controlBoxes.push({ el, rect: inside });
    }

    for (let i = 0; i < controlBoxes.length; i += 1) {
      for (let j = i + 1; j < controlBoxes.length; j += 1) {
        const a = controlBoxes[i];
        const b = controlBoxes[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const hit = intersect(a.rect, b.rect);
        if (!hit || hit.right - hit.left < 4 || hit.bottom - hit.top < 4) continue;
        // A small control placed wholly inside a card-sized one (a play
        // button on a clickable card) is a deliberate overlay, not a collision.
        if (area(hit) >= Math.min(area(a.rect), area(b.rect)) * 0.98) continue;
        if (optedOut(a.el) || optedOut(b.el) || covered(a.el, b.el, hit)) continue;
        issues.push({ kind: 'control-overlap', detail: `${name(a.el)} overlaps ${name(b.el)}` });
      }
    }

    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth > vw + 1) {
      issues.push({ kind: 'page-overflow', detail: `page is ${scrollWidth}px wide in a ${vw}px window` });
    }

    return Array.from(new Map(issues.map(issue => [issue.kind + issue.detail, issue])).values());
  }) as Promise<LayoutIssue[]>;
}
