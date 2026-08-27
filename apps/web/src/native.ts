import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { StatusBar, Style } from "@capacitor/status-bar";
import type { AppearanceMode } from "./appearance";

/**
 * Native-only ergonomics for the Capacitor Android and iOS builds. Everything here is a
 * no-op on the web so the reference web app is unaffected.
 */

let nativeViewportSyncInstalled = false;

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export async function openNativeBrowser(url: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("The native browser is only available in the mobile app.");
  }
  await Browser.open({ url, presentationStyle: "fullscreen" });
}

function installNativeViewportSync(root: HTMLElement): void {
  const viewport = window.visualViewport;
  let animationFrame: number | null = null;
  let orientationTimer: number | null = null;

  const sync = () => {
    animationFrame = null;
    const visibleHeight = Math.max(1, Math.round(viewport?.height ?? window.innerHeight));
    // `visualViewport.height` deliberately shrinks when the iOS keyboard is
    // open. Keep the layout viewport separately so long, scrollable sheets
    // can remain anchored to the screen instead of being resized into the
    // small area above the keyboard.
    const layoutHeight = Math.max(1, Math.round(window.innerHeight));
    root.style.setProperty("--native-viewport-height", `${visibleHeight}px`);
    root.style.setProperty("--native-layout-height", `${layoutHeight}px`);
  };

  const scheduleSync = () => {
    if (animationFrame !== null) {
      window.cancelAnimationFrame(animationFrame);
    }
    animationFrame = window.requestAnimationFrame(sync);
  };

  const handleOrientationChange = () => {
    scheduleSync();
    if (orientationTimer !== null) {
      window.clearTimeout(orientationTimer);
    }
    // WKWebView can report the old visual viewport for the first resize event
    // during rotation. Recheck after the transition has settled.
    orientationTimer = window.setTimeout(scheduleSync, 300);
  };

  sync();
  if (nativeViewportSyncInstalled) {
    return;
  }
  nativeViewportSyncInstalled = true;
  window.addEventListener("resize", scheduleSync, { passive: true });
  window.addEventListener("orientationchange", handleOrientationChange, { passive: true });
  viewport?.addEventListener("resize", scheduleSync, { passive: true });
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
