import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { haptic, selectionHaptic } from "./native";

// Holding still this long lifts a planned book; moving first is a scroll.
const LIFT_DELAY_MS = 350;
const LIFT_SLOP_PX = 8;
// Near the scroller's top or bottom edge, a lifted book scrolls the page.
const EDGE_PX = 64;
const MAX_SCROLL_STEP_PX = 14;
const SETTLE_MS = 180;

type Pending = { id: string; row: HTMLElement; touchId: number; x: number; y: number; timer: number };
type Slot = { id: string; row: HTMLElement; rect: DOMRect };
type Lift = {
  id: string;
  row: HTMLElement;
  touchId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  slots: Slot[];
  from: number;
  target: number;
  scroller: HTMLElement;
  scrollTop: number;
  frame: number;
};

function scrollerOf(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function touchById(list: TouchList, id: number) {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
  return null;
}

/**
 * Hold a planned book in Up Next and drag it to a new place. Rows are moved
 * with transforms while the finger is down and React only learns the new
 * order on release: the plan spans two lists, and a row React moved between
 * them mid-drag would be a new node that no longer receives the touch.
 *
 * Rows that take part carry `data-queue-id` and a `.continue-reading-book`
 * grip; play and the queue buttons keep their own taps.
 */
export function useQueueReorder(section: HTMLElement | null, plannedIds: readonly string[], onDrop: (id: string, index: number) => void) {
  const latestDrop = useRef(onDrop);
  latestDrop.current = onDrop;
  const cancelRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!section) return;
    let pending: Pending | null = null;
    let lift: Lift | null = null;

    function clearPending() {
      if (pending) window.clearTimeout(pending.timer);
      pending = null;
    }

    // Planned rows in plan order; the DOM order already matches it.
    function rows(): Slot[] {
      return Array.from(section!.querySelectorAll<HTMLElement>("[data-queue-id]"), row => ({
        id: row.dataset.queueId!, row, rect: row.getBoundingClientRect()
      }));
    }

    function begin() {
      const start = pending;
      clearPending();
      if (!start || !start.row.isConnected) return;
      const slots = rows();
      const from = slots.findIndex(slot => slot.id === start.id);
      if (from < 0 || slots.length < 2) return;
      const scroller = scrollerOf(section!);
      lift = {
        id: start.id, row: start.row, touchId: start.touchId,
        startX: start.x, startY: start.y, x: start.x, y: start.y,
        slots, from, target: from, scroller, scrollTop: scroller.scrollTop, frame: 0
      };
      for (const slot of slots) slot.row.style.transition = slot.row === start.row || reducedMotion() ? "none" : `transform ${SETTLE_MS}ms ease, opacity 160ms ease`;
      start.row.classList.add("is-lifted");
      section!.classList.add("is-reordering");
      haptic("medium");
      lift.frame = window.requestAnimationFrame(autoScroll);
    }

    // Which slot the lifted book's centre has reached. Books that share its
    // line (the open Duo's strip) are passed left to right, others top to bottom.
    function targetFor(current: Lift, cx: number, cy: number) {
      const own = current.slots[current.from].rect;
      let index = 0;
      current.slots.forEach((slot, i) => {
        if (i === current.from) return;
        const { rect } = slot;
        const overlap = Math.min(own.bottom, rect.bottom) - Math.max(own.top, rect.top);
        const sameLine = overlap >= Math.min(own.height, rect.height) / 2;
        if (sameLine ? cx > rect.left + rect.width / 2 : cy > rect.top + rect.height / 2) index++;
      });
      return index;
    }

    function update() {
      const current = lift;
      if (!current) return;
      const scrolled = current.scroller.scrollTop - current.scrollTop;
      const dx = current.x - current.startX;
      const dy = current.y - current.startY + scrolled;
      current.row.style.transform = `translate(${dx}px, ${dy}px)`;
      const own = current.slots[current.from].rect;
      const target = targetFor(current, own.left + own.width / 2 + dx, own.top + own.height / 2 + dy);
      if (target === current.target) return;
      current.target = target;
      selectionHaptic("change");
      // Every other book slides into the place it would hold after the drop.
      const order = current.slots.filter((_, i) => i !== current.from);
      order.splice(target, 0, current.slots[current.from]);
      order.forEach((slot, i) => {
        if (slot.row === current.row) return;
        const home = current.slots[i].rect;
        slot.row.style.transform = home === slot.rect ? "" : `translate(${home.left - slot.rect.left}px, ${home.top - slot.rect.top}px)`;
      });
    }

    function autoScroll() {
      const current = lift;
      if (!current) return;
      const bounds = current.scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : current.scroller.getBoundingClientRect();
      const step = current.y < bounds.top + EDGE_PX
        ? -Math.ceil(MAX_SCROLL_STEP_PX * (bounds.top + EDGE_PX - current.y) / EDGE_PX)
        : current.y > bounds.bottom - EDGE_PX
          ? Math.ceil(MAX_SCROLL_STEP_PX * (current.y - bounds.bottom + EDGE_PX) / EDGE_PX)
          : 0;
      if (step) {
        const before = current.scroller.scrollTop;
        current.scroller.scrollTop = before + Math.sign(step) * Math.min(Math.abs(step), MAX_SCROLL_STEP_PX);
        if (current.scroller.scrollTop !== before) update();
      }
      current.frame = window.requestAnimationFrame(autoScroll);
    }

    function finish(commit: boolean) {
      const current = lift;
      lift = null;
      if (!current) return;
      window.cancelAnimationFrame(current.frame);
      section!.classList.remove("is-reordering");
      const moved = commit && current.target !== current.from;
      // Where the lifted book is drawn right now, to settle it from there.
      const drawn = current.row.getBoundingClientRect();
      if (moved) flushSync(() => latestDrop.current(current.id, current.target));
      for (const slot of current.slots) {
        slot.row.style.transition = "none";
        slot.row.style.transform = "";
      }
      current.row.classList.remove("is-lifted");
      if (!current.row.isConnected || reducedMotion()) {
        for (const slot of current.slots) slot.row.style.transition = "";
        return;
      }
      const home = current.row.getBoundingClientRect();
      current.row.style.transform = `translate(${drawn.left - home.left}px, ${drawn.top - home.top}px)`;
      current.row.classList.add("is-settling");
      void current.row.offsetWidth;
      for (const slot of current.slots) slot.row.style.transition = `transform ${SETTLE_MS}ms ease, opacity 160ms ease`;
      current.row.style.transform = "";
      window.setTimeout(() => {
        current.row.classList.remove("is-settling");
        for (const slot of current.slots) slot.row.style.transition = "";
      }, SETTLE_MS);
    }

    function onTouchStart(event: TouchEvent) {
      if (lift) return;
      clearPending();
      if (event.touches.length !== 1) return;
      const target = event.target as Element;
      const grip = target.closest(".continue-reading-book");
      const row = grip?.closest<HTMLElement>("[data-queue-id]");
      if (!row || !section!.contains(row)) return;
      const touch = event.changedTouches[0];
      pending = {
        id: row.dataset.queueId!, row, touchId: touch.identifier, x: touch.clientX, y: touch.clientY,
        timer: window.setTimeout(begin, LIFT_DELAY_MS)
      };
    }

    function onTouchMove(event: TouchEvent) {
      if (pending) {
        const touch = touchById(event.changedTouches, pending.touchId);
        if (event.touches.length > 1 || (touch && Math.hypot(touch.clientX - pending.x, touch.clientY - pending.y) > LIFT_SLOP_PX)) clearPending();
        return;
      }
      if (!lift) return;
      // Holding a book, the finger drags it rather than scrolling or pulling
      // the shelf to refresh.
      event.preventDefault();
      event.stopPropagation();
      const touch = touchById(event.changedTouches, lift.touchId);
      if (!touch) return;
      lift.x = touch.clientX;
      lift.y = touch.clientY;
      update();
    }

    function onTouchEnd(event: TouchEvent) {
      clearPending();
      if (!lift || !touchById(event.changedTouches, lift.touchId)) return;
      // The book stays closed: this lift was a move, not a tap.
      event.preventDefault();
      finish(true);
    }

    function onTouchCancel() {
      clearPending();
      finish(false);
    }

    // Android opens a context menu on a long press.
    function onContextMenu(event: Event) {
      if (pending || lift || (event.target as Element).closest("[data-queue-id] .continue-reading-book")) event.preventDefault();
    }

    cancelRef.current = onTouchCancel;
    section.addEventListener("touchstart", onTouchStart, { passive: true });
    section.addEventListener("touchmove", onTouchMove, { passive: false });
    section.addEventListener("touchend", onTouchEnd, { passive: false });
    section.addEventListener("touchcancel", onTouchCancel);
    section.addEventListener("contextmenu", onContextMenu);
    return () => {
      onTouchCancel();
      cancelRef.current = () => undefined;
      section.removeEventListener("touchstart", onTouchStart);
      section.removeEventListener("touchmove", onTouchMove);
      section.removeEventListener("touchend", onTouchEnd);
      section.removeEventListener("touchcancel", onTouchCancel);
      section.removeEventListener("contextmenu", onContextMenu);
    };
  }, [section]);

  // A plan changed elsewhere mid-drag (the book page, another tab) leaves
  // the measured slots wrong; drop the lift rather than guess.
  const key = plannedIds.join("\n");
  useEffect(() => () => cancelRef.current(), [key]);
}
