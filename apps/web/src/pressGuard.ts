/**
 * Lets a finger back out of a press. Pressing a button by mistake and sliding
 * off it before lifting should do nothing, as it does for native buttons, but
 * the iOS and Android web views still deliver the click when the slide is
 * short or the page has nothing to scroll — which describes the player, where
 * an accidental play, rewind, or restart costs the listener their place.
 *
 * Mouse presses are left alone: browsers already cancel a click released
 * outside the button.
 */

const PRESSABLE = 'button, [role="button"], a[href], summary';

// A lifting fingertip rolls a little past the edge it pressed; only a lift
// clearly outside the control counts as backing out.
const LIFT_TOLERANCE_PX = 12;

// The click for a touch arrives right after the lift. A later click on the
// same control (from a keyboard, say) is a new press and must go through.
const CLICK_WINDOW_MS = 1000;

type Rect = { left: number; top: number; right: number; bottom: number };

function liftedOnControl(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.left - LIFT_TOLERANCE_PX &&
    x <= rect.right + LIFT_TOLERANCE_PX &&
    y >= rect.top - LIFT_TOLERANCE_PX &&
    y <= rect.bottom + LIFT_TOLERANCE_PX
  );
}

export function installPressGuard(root: EventTarget = document): void {
  let press: { pointerId: number; control: Element } | null = null;
  let abandoned: { control: Element; at: number } | null = null;

  root.addEventListener("pointerdown", (event) => {
    const pointer = event as PointerEvent;
    abandoned = null;
    press = null;
    if (pointer.pointerType === "mouse" || !pointer.isPrimary) return;
    const control = (pointer.target as Element | null)?.closest?.(PRESSABLE);
    if (control) press = { pointerId: pointer.pointerId, control };
  }, { capture: true, passive: true });

  root.addEventListener("pointerup", (event) => {
    const pointer = event as PointerEvent;
    if (!press || press.pointerId !== pointer.pointerId) return;
    const { control } = press;
    press = null;
    if (!liftedOnControl(control.getBoundingClientRect(), pointer.clientX, pointer.clientY)) {
      abandoned = { control, at: event.timeStamp };
    }
  }, { capture: true, passive: true });

  root.addEventListener("pointercancel", () => {
    press = null;
  }, { capture: true, passive: true });

  root.addEventListener("click", (event) => {
    if (!abandoned) return;
    const { control, at } = abandoned;
    abandoned = null;
    if (event.timeStamp - at > CLICK_WINDOW_MS) return;
    if (!control.contains(event.target as Node | null)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
}
