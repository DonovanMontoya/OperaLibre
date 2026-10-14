import type { AuthUser } from "./types";

/**
 * The pictures a listener can choose from. The server stores only the id, so
 * an id may be added here freely but never renamed or reused: an account that
 * chose it keeps pointing at whatever this list says it is.
 */
export const AVATARS = [
  { id: "owl", label: "Owl", tone: "#58703f" },
  { id: "fox", label: "Fox", tone: "#b4532a" },
  { id: "cat", label: "Cat", tone: "#6d3b5e" },
  { id: "hare", label: "Hare", tone: "#2f6660" },
  { id: "bear", label: "Bear", tone: "#6a4a32" },
  { id: "moon", label: "Moon", tone: "#2c3a63" },
  { id: "teacup", label: "Teacup", tone: "#8b2e1f" },
  { id: "candle", label: "Candle", tone: "#a06c22" },
  { id: "key", label: "Key", tone: "#4b5560" },
  { id: "quill", label: "Quill", tone: "#3a5a80" },
  { id: "sailboat", label: "Sailboat", tone: "#2a6b83" },
  { id: "mountain", label: "Mountain", tone: "#3d6b4d" }
] as const;

export type Avatar = (typeof AVATARS)[number];
export type AvatarId = Avatar["id"];

type Pictured = Pick<AuthUser, "username" | "avatar">;

/**
 * Whether this account's server stores pictures. It sends the field on every
 * account, `null` when none is chosen, so a missing field means a server that
 * predates them, a Jellyfin account, or an on-device library — places where a
 * choice would have nowhere to be saved.
 */
export function supportsAvatars(user: Pick<AuthUser, "avatar">): boolean {
  return user.avatar !== undefined;
}

/**
 * The picture to draw for an account, or `null` for its initial. An id this
 * build does not know — chosen in a newer app — also falls back to the initial.
 */
export function avatarFor(user: Pictured): Avatar | null {
  return AVATARS.find((avatar) => avatar.id === user.avatar) ?? null;
}

export function initialOf(username: string): string {
  return username.slice(0, 1).toUpperCase();
}
