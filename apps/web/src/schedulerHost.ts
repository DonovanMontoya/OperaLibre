import { Capacitor } from "@capacitor/core";

type TimerGlobals = {
  setImmediate?: unknown;
  clearImmediate?: unknown;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

/**
 * React's scheduler runs every non-urgent render through one MessageChannel
 * loop and posts again only when the last message has been delivered, so one
 * message that never arrives stops that loop for good. On iOS that looks like
 * a frozen player: native events such as the clock and tab selections stop
 * drawing until the app restarts, while audio plays on and only taps render.
 * The scheduler prefers setImmediate when it exists, and a timer does not
 * depend on that delivery.
 *
 * The scheduler reads this once as it loads, so main.tsx must import this
 * module before React.
 */
export function installTimerSchedulerHost(platform: string, globals: TimerGlobals) {
  if (platform !== "ios" || globals.setImmediate) return;
  globals.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    globals.setTimeout(callback, 0, ...args);
  globals.clearImmediate = (timer: ReturnType<typeof setTimeout>) => globals.clearTimeout(timer);
}

installTimerSchedulerHost(Capacitor.getPlatform(), globalThis as unknown as TimerGlobals);
