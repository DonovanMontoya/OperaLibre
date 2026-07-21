import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

/**
 * Native-only ergonomics for the Capacitor Android and iOS builds. Everything here is a
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
