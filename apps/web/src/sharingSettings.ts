import type { AuthUser } from "./types";

/**
 * What the shared-reading switches on an account actually mean.
 *
 * Kept apart from the card that renders them so the rules can be tested
 * directly — the reasoning below is all about which server sent the account,
 * which is exactly the part worth pinning down.
 */

export function isSharingProgress(user: AuthUser): boolean {
  // Servers released before progress sharing omit the field; they share by
  // default, which is what the toggle should show rather than a false "off".
  return user.shareProgress !== false;
}

/**
 * Whether this server has the finish feed at all.
 *
 * The server sends `announceFinishes` and `notifyFinishes` as plain booleans
 * and never omits them once the feature exists, so their absence is an exact
 * signal that the server predates it — a capability check that costs no extra
 * request. It is also why the two settings below cannot fall back to "on" the
 * way `shareProgress` does: against an older server there is nothing to be on,
 * and defaulting to enabled would leave a permanently empty bell and two
 * switches that will not stay where they are put.
 */
export function supportsFinishFeed(user: AuthUser): boolean {
  return user.announceFinishes !== undefined && user.notifyFinishes !== undefined;
}

/**
 * On a server that has the feature the stored default is on, so someone
 * already sharing is not silently opted out of something they never saw.
 */
export function isAnnouncingFinishes(user: AuthUser): boolean {
  return supportsFinishFeed(user) && isSharingProgress(user) && user.announceFinishes !== false;
}

export function isNotifiedOfFinishes(user: AuthUser): boolean {
  return supportsFinishFeed(user) && isSharingProgress(user) && user.notifyFinishes !== false;
}
