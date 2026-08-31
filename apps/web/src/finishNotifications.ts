import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

/**
 * OS banners for the shared finish feed, on the Capacitor builds only.
 *
 * These are local notifications, not push: they are posted by the app itself
 * from what a poll returned, so they arrive while the app is running and stay
 * silent when it is not. Everything here is a no-op on the web, where the feed
 * is the bell in the header and nothing more.
 */

/** Distinct from any other notification the app might grow later. */
const FINISH_CHANNEL = "shared-finishes";

let permissionRequested = false;
let finishChannelReady: Promise<void> | null = null;

/** Android 8+ drops notifications aimed at a channel that does not exist. */
function ensureFinishChannel(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return Promise.resolve();
  finishChannelReady ??= LocalNotifications.createChannel({
    id: FINISH_CHANNEL,
    name: "Shared reading",
    description: "Updates when another listener finishes a book"
  }).catch((error) => {
    // Let a later banner retry if channel creation failed transiently.
    finishChannelReady = null;
    throw error;
  });
  return finishChannelReady;
}

export function finishBannersAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Ask once per session, and only when there is something to show.
 *
 * Prompting at launch, before the listener has seen a single finish, asks them
 * to authorise a feature they have no context for — the usual reason people
 * decline. Returns whether banners may be posted.
 */
export async function ensureFinishBannerPermission(): Promise<boolean> {
  if (!finishBannersAvailable()) return false;
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === "granted") return true;
    // "denied" is the listener's answer, not a transient failure. Re-asking
    // is a no-op on both platforms anyway, so take it as final.
    if (current.display === "denied" || permissionRequested) return false;
    permissionRequested = true;
    const requested = await LocalNotifications.requestPermissions();
    return requested.display === "granted";
  } catch {
    // A build without the plugin, or a platform that refuses the query. The
    // feed still works; only the banner is lost.
    return false;
  }
}

/**
 * Post one banner. Callers collapse a poll's arrivals into a single line
 * first, so this never stacks.
 */
export async function postFinishBanner(body: string): Promise<void> {
  if (!finishBannersAvailable() || !body) return;
  try {
    await ensureFinishChannel();
    await LocalNotifications.schedule({
      notifications: [
        {
          // Reused deliberately: a second banner replaces the first rather
          // than piling up behind it in the shade.
          id: 1,
          channelId: FINISH_CHANNEL,
          title: "Shared reading",
          body
        }
      ]
    });
  } catch {
    // Never worth surfacing: the same news is already in the feed.
  }
}
