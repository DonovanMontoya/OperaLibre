/* WebKit sizes `-apple-system-body` from the iOS text size setting (17px at
   the default). Scaling the root font size by the same ratio grows every rem
   while the px measurements native code passes in (tab bar, fold rects, rails)
   stay put, which WKWebView page zoom would distort. Past LARGE_SCALE the
   `data-text-large` attribute lets dense rows reflow (see styles.css). */
const DEFAULT_BODY_PX = 17;
const ROOT_PX = 16;
const MIN_SCALE = 0.9;
const MAX_SCALE = 2;
const LARGE_SCALE = 1.35;

export function textScaleFor(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, bodyPx / DEFAULT_BODY_PX));
}

export function followSystemTextSize(root: HTMLElement): void {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  // An engine without the system font keyword keeps font-size 0, which reads as "no scaling".
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;font-size:0;font:-apple-system-body";
  probe.textContent = "A";
  root.appendChild(probe);

  let applied = 1;
  const apply = () => {
    const scale = textScaleFor(parseFloat(getComputedStyle(probe).fontSize));
    if (scale === applied) return;
    applied = scale;
    root.style.fontSize = scale === 1 ? "" : `${ROOT_PX * scale}px`;
    root.toggleAttribute("data-text-large", scale >= LARGE_SCALE);
  };
  apply();
  // The setting changes in the Settings app, so the page sees it on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") apply();
  });
}
