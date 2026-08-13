const LEFT_EDGE_WIDTH_PX = 28;
const BACK_SWIPE_DISTANCE_PX = 72;
const BACK_SWIPE_DIRECTION_RATIO = 1.5;

export type TouchPoint = {
  clientX: number;
  clientY: number;
};

/**
 * Recognize the intentional, rightward edge swipe used to dismiss a native
 * book-detail page. Keeping this narrower than a general horizontal swipe
 * lets vertical scrolling and controls in the detail view behave normally.
 */
export function isLeftEdgeBackSwipe(start: TouchPoint, end: TouchPoint): boolean {
  const horizontalDistance = end.clientX - start.clientX;
  const verticalDistance = Math.abs(end.clientY - start.clientY);

  return start.clientX <= LEFT_EDGE_WIDTH_PX
    && horizontalDistance >= BACK_SWIPE_DISTANCE_PX
    && horizontalDistance >= verticalDistance * BACK_SWIPE_DIRECTION_RATIO;
}
