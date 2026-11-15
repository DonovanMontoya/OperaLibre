import { type RefObject, useEffect, useRef } from "react";
import { shouldDismissSheet } from "./sheetSwipe";

/** Lets a native bottom sheet be pulled down to close, the way its grabber
    suggests. The drag only takes over once the sheet is scrolled to the top
    and the finger moves mostly downward, so scrolling the sheet still works. */
export function useSheetSwipeDismiss(sheetRef: RefObject<HTMLElement | null>, onDismiss: () => void) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; });

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !document.documentElement.classList.contains("native-app")) return;
    let start: { x: number; y: number; time: number } | null = null;
    let dragging = false;
    let offset = 0;
    let last = { y: 0, time: 0 };
    let velocity = 0;

    const reset = () => {
      sheet.style.transition = "transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)";
      sheet.style.transform = "";
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { start = null; return; }
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
      last = { y: touch.clientY, time: event.timeStamp };
      dragging = false;
      offset = 0;
      velocity = 0;
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      const dy = touch.clientY - start.y;
      if (!dragging) {
        const dx = Math.abs(touch.clientX - start.x);
        if (Math.abs(dy) < 8 && dx < 8) return;
        // Only a downward pull from the top of the sheet's own scroll closes it.
        if (dy <= 0 || dx > dy || sheet.scrollTop > 0) { start = null; return; }
        dragging = true;
        sheet.style.transition = "none";
        sheet.style.animation = "none";
      }
      event.preventDefault();
      offset = Math.max(0, dy);
      const elapsed = event.timeStamp - last.time;
      if (elapsed > 0) velocity = (touch.clientY - last.y) / elapsed;
      last = { y: touch.clientY, time: event.timeStamp };
      sheet.style.transform = `translateY(${offset}px)`;
    };
    const onEnd = () => {
      const wasDragging = dragging;
      start = null;
      dragging = false;
      if (!wasDragging) return;
      if (shouldDismissSheet(offset, velocity, sheet.offsetHeight)) {
        sheet.style.transition = "transform 0.18s ease-in";
        sheet.style.transform = `translateY(${sheet.offsetHeight}px)`;
        window.setTimeout(() => dismissRef.current(), 160);
      } else {
        reset();
      }
    };
    const onCancel = () => { start = null; if (dragging) { dragging = false; reset(); } };

    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd);
    sheet.addEventListener("touchcancel", onCancel);
    return () => {
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onCancel);
    };
  }, [sheetRef]);
}
