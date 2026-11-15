/** Whether a released downward drag on a bottom sheet should close it: far
    enough down, or a quick flick that has moved past a small dead zone. */
export function shouldDismissSheet(distance: number, velocity: number, sheetHeight: number): boolean {
  if (distance <= 0) return false;
  return distance >= Math.min(120, sheetHeight * 0.3) || (distance >= 24 && velocity >= 0.5);
}
