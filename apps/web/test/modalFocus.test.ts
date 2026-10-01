import assert from 'node:assert/strict';
import test from 'node:test';
import { containModalFocus } from '../src/modalFocus.ts';

// A minimal DOM boundary lets the production controller's keyboard and nesting
// state machine run in the Node suite. Browser geometry is covered separately.
function fixture() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const doc = {
    activeElement: null as ElementStub | null,
    addEventListener(name: string, fn: (event: any) => void) {
      const entries = listeners.get(name) ?? new Set(); entries.add(fn); listeners.set(name, entries);
    },
    removeEventListener(name: string, fn: (event: any) => void) { listeners.get(name)?.delete(fn); }
  };
  class ElementStub {
    children: ElementStub[] = [];
    tabIndex = 0;
    disabled = false;
    hidden = false;
    inert = false;
    initial = false;
    isConnected = true;
    visibility = 'visible';
    contains(node: ElementStub | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll() { return this.children; }
    matches() { return this.disabled || this.hidden; }
    closest() { return this.inert ? this : null; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    hasAttribute() { return this.initial; }
    focus() {
      doc.activeElement = this;
      for (const fn of listeners.get('focusin') ?? []) fn({ target: this });
    }
  }
  const globals = { document: globalThis.document, HTMLElement: globalThis.HTMLElement, getComputedStyle: globalThis.getComputedStyle };
  Object.assign(globalThis, { document: doc, HTMLElement: ElementStub, getComputedStyle: (node: ElementStub) => ({visibility:node.visibility}) });
  const opener = new ElementStub(); opener.focus();
  const dialog = new ElementStub(); dialog.tabIndex = -1;
  const first = new ElementStub(); const last = new ElementStub(); dialog.children = [first, last];
  let dismissed = 0;
  const close = containModalFocus(dialog as unknown as HTMLElement, () => { dismissed++; });
  return { doc, opener, dialog, first, last, ElementStub, close,
    get dismissed() { return dismissed; },
    key(key: string, shiftKey = false) {
      const event = {key, shiftKey, prevented:false, preventDefault() {this.prevented = true;}, stopImmediatePropagation() {}};
      for (const fn of listeners.get('keydown') ?? []) fn(event);
      return event;
    },
    cleanup() { close(); Object.assign(globalThis, globals); }
  };
}

test('modal keyboard navigation wraps, blocks background focus and restores its opener', () => {
  const f = fixture();
  try {
    assert.equal(f.doc.activeElement, f.first);
    assert.equal(f.key('Tab', true).prevented, true);
    assert.equal(f.doc.activeElement, f.last);
    assert.equal(f.key('Tab').prevented, true);
    assert.equal(f.doc.activeElement, f.first);
    f.opener.focus(); assert.equal(f.doc.activeElement, f.first);
    f.key('Escape'); assert.equal(f.dismissed, 1);
  } finally { f.cleanup(); }
  assert.equal(f.doc.activeElement, f.opener);
});

test('disabled or hidden controls cannot leak focus out of a busy modal', () => {
  const f = fixture();
  try {
    f.first.disabled = true; f.last.hidden = true;
    f.key('Tab'); assert.equal(f.doc.activeElement, f.dialog);
    f.key('Tab', true); assert.equal(f.doc.activeElement, f.dialog);
  } finally { f.cleanup(); }
});

test('only the top nested modal handles Escape and its close returns to the parent', () => {
  const f = fixture();
  const nested = new f.ElementStub(); const button = new f.ElementStub(); nested.children = [button];
  let dismissed = 0;
  const closeNested = containModalFocus(nested as unknown as HTMLElement, () => { dismissed++; });
  try {
    assert.equal(f.doc.activeElement, button);
    f.key('Escape'); assert.equal(dismissed, 1); assert.equal(f.dismissed, 0);
    closeNested(); assert.equal(f.doc.activeElement, f.first);
    f.key('Escape'); assert.equal(f.dismissed, 1);
  } finally { f.cleanup(); }
});
