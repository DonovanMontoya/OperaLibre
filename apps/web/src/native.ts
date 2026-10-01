import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { StatusBar, Style } from "@capacitor/status-bar";
import type { AppearanceMode } from "./appearance";
import { installDeviceFold } from "./deviceFold";

/**
 * Native-only ergonomics for the Capacitor Android and iOS builds. Everything here is a
 * no-op on the web so the reference web app is unaffected.
 */

let nativeViewportSyncInstalled = false;

function installNativeViewportSync(root: HTMLElement): void {
  const viewport = window.visualViewport;
  let animationFrame: number | null = null;
  let settleTimer: number | null = null;

  const sync = () => {
    animationFrame = null;
    const visibleHeight = Math.max(1, Math.round(viewport?.height ?? window.innerHeight));
    // `visualViewport.height` deliberately shrinks when the iOS keyboard is
    // open. Keep the layout viewport separately so long, scrollable sheets
    // can remain anchored to the screen instead of being resized into the
    // small area above the keyboard.
    const layoutHeight = Math.max(1, Math.round(root.clientHeight || window.innerHeight));
    root.style.setProperty("--native-viewport-height", `${visibleHeight}px`);
    root.style.setProperty("--native-viewport-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
    root.style.setProperty("--native-layout-height", `${layoutHeight}px`);
    root.classList.toggle("native-keyboard-open", layoutHeight - visibleHeight > 120);
  };

  const scheduleSync = () => {
    if (animationFrame !== null) {
      window.cancelAnimationFrame(animationFrame);
    }
    animationFrame = window.requestAnimationFrame(sync);
  };

  const handleViewportChange = () => {
    scheduleSync();
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
    }
    // WKWebView can dispatch resize before updating its visual viewport,
    // including window resizing and switching Duo displays without rotation.
    // That final viewport update does not always emit another resize event.
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      scheduleSync();
    }, 300);
  };

  const handleNativeLayoutChange = () => {
    // The native view can finish resizing without WebKit delivering resize.
    // Read now as well as after its visual viewport settles; animation frames
    // may still be suspended during the handoff between device displays.
    sync();
    handleViewportChange();
  };

  sync();
  if (nativeViewportSyncInstalled) {
    return;
  }
  nativeViewportSyncInstalled = true;
  window.addEventListener("resize", handleViewportChange, { passive: true });
  window.addEventListener("orientationchange", handleViewportChange, { passive: true });
  window.addEventListener("pageshow", handleViewportChange, { passive: true });
  window.addEventListener("operalibre:viewportchange", handleNativeLayoutChange);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) handleNativeLayoutChange();
  });
  viewport?.addEventListener("resize", handleViewportChange, { passive: true });
  viewport?.addEventListener("scroll", scheduleSync, { passive: true });
  new ResizeObserver(handleViewportChange).observe(root);
}

/**
 * Tag <html> so CSS can opt into the native shell (spine tab bar, safe-area
 * veils, press states) without touching the web layout.
 */
export function markNativePlatform(): void {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  const root = document.documentElement;
  root.classList.add("native-app");
  root.classList.add(`platform-${Capacitor.getPlatform()}`);
  installNativeViewportSync(root);
  installDeviceFold(root);

  // Native apps don't pinch-zoom their chrome. Locking the viewport here
  // (rather than in index.html) keeps zoom available on the web build.
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no"
    );
}

type HapticStyle = "light" | "medium" | "heavy";

export function haptic(style: HapticStyle = "light"): void {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  const impactStyle = {
    light: ImpactStyle.Light,
    medium: ImpactStyle.Medium,
    heavy: ImpactStyle.Heavy
  }[style];
  void Haptics.impact({ style: impactStyle }).catch(() => undefined);
}

export function selectionHaptic(phase: "start" | "change" | "end"): void {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  const feedback = {
    start: () => Haptics.selectionStart(),
    change: () => Haptics.selectionChanged(),
    end: () => Haptics.selectionEnd()
  }[phase];
  void feedback().catch(() => undefined);
}

/* The web view's veils can disagree with the device theme once the user pins
   an appearance, so the status-bar icons must follow the chosen mode rather
   than the system. System mode hands control back to iOS (Style.Default),
   which also keeps the icons in step with live device-theme changes. */
export function syncStatusBarStyle(mode: AppearanceMode): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") {
    return;
  }
  const style = {
    light: Style.Light,
    dark: Style.Dark,
    system: Style.Default
  }[mode];
  void StatusBar.setStyle({ style }).catch(() => undefined);
}
