import { Capacitor } from "@capacitor/core";

/**
 * Native-only ergonomics for the Capacitor iOS build. Everything here is a
 * no-op on the web so the reference web app is unaffected.
 */

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
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

/**
 * Fire a light impact through Capacitor's plugin proxy if @capacitor/haptics
 * is installed. Accessing the plugin off the global proxy means we never take
 * a build-time dependency on it: if it isn't installed, this silently does
 * nothing.
 */
export function haptic(style: HapticStyle = "light"): void {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  try {
    const plugins = (Capacitor as unknown as { Plugins?: Record<string, any> }).Plugins;
    const Haptics = plugins?.Haptics;
    Haptics?.impact?.({ style: style.charAt(0).toUpperCase() + style.slice(1) });
  } catch {
    // Plugin not installed — no-op.
  }
}
