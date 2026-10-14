import type { ReactNode } from "react";
import { AVATARS, avatarFor, initialOf, type AvatarId } from "./avatars";
import type { AuthUser } from "./types";

const PAPER = "#f7edd8";
const line = { fill: "none", stroke: PAPER, strokeLinecap: "round" } as const;
const cut = { fill: "currentColor" } as const;
const cutLine = { fill: "none", stroke: "currentColor", strokeLinecap: "round" } as const;

// Drawn on a 48-unit square in paper on the picture's own tone. `currentColor`
// is that tone, so eyes and other details are cut out of the paper shapes.
const ART: Record<AvatarId, ReactNode> = {
  owl: (
    <>
      <path d="M13 21c0-7.5 4.7-12 11-12s11 4.5 11 12v6c0 7.5-4.7 12-11 12s-11-4.5-11-12z" />
      <path d="M13 20 11.5 9.5 20 12.5zM35 20l1.5-10.5L28 12.5z" />
      <circle cx="19.2" cy="21.5" r="4.6" {...cut} />
      <circle cx="28.8" cy="21.5" r="4.6" {...cut} />
      <circle cx="19.2" cy="21.5" r="1.9" />
      <circle cx="28.8" cy="21.5" r="1.9" />
      <path d="M22.2 26h3.6L24 29.6z" {...cut} />
    </>
  ),
  fox: (
    <>
      <path d="M9.5 11 20 18.5q4-1.4 8 0L38.5 11 37 27q-3.5 9.5-13 13-9.5-3.5-13-13z" />
      <path d="M13.2 14.8 17.6 18 14 21zM34.8 14.8 30.4 18 34 21z" {...cut} />
      <circle cx="18.8" cy="26" r="1.7" {...cut} />
      <circle cx="29.2" cy="26" r="1.7" {...cut} />
      <ellipse cx="24" cy="36.2" rx="2.2" ry="1.7" {...cut} />
    </>
  ),
  cat: (
    <>
      <path d="M12 10.5 20.5 17q3.5-1 7 0L36 10.5V27c0 7-5 11.5-12 11.5S12 34 12 27z" />
      <path d="M13 28.5 5.5 27.5M13 31.5 5.5 32.5M35 28.5l7.5-1M35 31.5l7.5 1" strokeWidth="1.2" {...line} />
      <ellipse cx="19" cy="25.5" rx="1.7" ry="2.5" {...cut} />
      <ellipse cx="29" cy="25.5" rx="1.7" ry="2.5" {...cut} />
      <path d="M22.4 30h3.2L24 32z" {...cut} />
    </>
  ),
  hare: (
    <>
      <ellipse cx="18.5" cy="14" rx="3.6" ry="9.5" transform="rotate(-9 18.5 14)" />
      <ellipse cx="29.5" cy="14" rx="3.6" ry="9.5" transform="rotate(9 29.5 14)" />
      <ellipse cx="18.5" cy="13.5" rx="1.3" ry="6" transform="rotate(-9 18.5 14)" {...cut} />
      <ellipse cx="29.5" cy="13.5" rx="1.3" ry="6" transform="rotate(9 29.5 14)" {...cut} />
      <ellipse cx="24" cy="30" rx="10.5" ry="9.5" />
      <circle cx="19.8" cy="28.5" r="1.6" {...cut} />
      <circle cx="28.2" cy="28.5" r="1.6" {...cut} />
      <path d="M22.5 32.5h3L24 34.3z" {...cut} />
    </>
  ),
  bear: (
    <>
      <circle cx="14" cy="15" r="5" />
      <circle cx="34" cy="15" r="5" />
      <circle cx="24" cy="26" r="12.5" />
      <circle cx="14" cy="15" r="2.1" {...cut} />
      <circle cx="34" cy="15" r="2.1" {...cut} />
      <circle cx="19" cy="24" r="1.6" {...cut} />
      <circle cx="29" cy="24" r="1.6" {...cut} />
      <ellipse cx="24" cy="29.5" rx="2.8" ry="2" {...cut} />
      <path d="M24 31.5v2.2M21.3 35q2.7 1.6 5.4 0" strokeWidth="1.3" {...cutLine} />
    </>
  ),
  moon: (
    <>
      <path d="M27 9.5a14.5 14.5 0 1 0 11.5 21A12 12 0 0 1 27 9.5z" />
      <path d="M34 10.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" />
      <circle cx="38" cy="22.5" r="1.1" />
    </>
  ),
  teacup: (
    <>
      <path d="M10 21h22v5a11 11 0 0 1-22 0z" />
      <path d="M32 23.5h2.2a3.7 3.7 0 0 1 0 7.4H31" strokeWidth="2.4" {...line} />
      <rect x="9" y="38.5" width="24" height="2.6" rx="1.3" />
      <path d="M17 17.5q-2.2-2.6 0-5.2t0-5.2M25 17.5q-2.2-2.6 0-5.2t0-5.2" strokeWidth="1.8" {...line} />
    </>
  ),
  candle: (
    <>
      <path d="M24 7.5c3.8 4.8 5.2 7.6 5.2 10a5.2 5.2 0 0 1-10.4 0c0-2.4 1.4-5.2 5.2-10z" />
      <path d="M24 14.5c1.3 1.8 1.8 2.8 1.8 3.7a1.8 1.8 0 0 1-3.6 0c0-.9.5-1.9 1.8-3.7z" {...cut} />
      <path d="M24 22.7V26" strokeWidth="1.4" {...line} />
      <rect x="19.5" y="25.5" width="9" height="12.5" rx="1.2" />
      <rect x="13" y="38" width="22" height="2.8" rx="1.4" />
    </>
  ),
  key: (
    <>
      <circle cx="17.5" cy="17.5" r="6.8" strokeWidth="3.6" {...line} />
      <path d="M22.5 22.5 37 37M31 31l4-4M35.5 35.5 39 32" strokeWidth="3.6" {...line} />
    </>
  ),
  quill: (
    <>
      <path d="M38 8.5C25.5 9 15.5 16.5 14.2 29.5l2.3 2C28.8 30.2 37.5 21 38 8.5z" />
      <path d="M16 30.5 9.5 40.5" strokeWidth="2.2" {...line} />
      <path d="M15.5 31.2C20 23.5 26.5 16.5 34.5 12" strokeWidth="1.3" {...cutLine} />
      <path d="M30.5 25.2l-4-1.3 1.5 3.7z" {...cut} />
    </>
  ),
  sailboat: (
    <>
      <path d="M25.5 8.5V29h12z" />
      <path d="M22.5 13v16H12z" />
      <path d="M9.5 32h29L34 39.5H14z" />
    </>
  ),
  mountain: (
    <>
      <circle cx="34.5" cy="13.5" r="3.6" />
      <path d="M5.5 38 18 15.5l6.5 10L28.5 20.5 42.5 38z" />
    </>
  )
};

function AvatarArt({ id }: { id: AvatarId }) {
  const avatar = AVATARS.find((candidate) => candidate.id === id);
  return (
    <svg className="avatar-art" viewBox="0 0 48 48" fill={PAPER} color={avatar?.tone} aria-hidden="true">
      <rect width="48" height="48" {...cut} />
      {ART[id]}
    </svg>
  );
}

/**
 * What goes inside an account's round badge: its chosen picture, or its
 * initial. The badge itself — size, shape, the colour behind an initial —
 * belongs to whichever surface is drawing it.
 */
export function AvatarFace({ user, choice }: {
  user: Pick<AuthUser, "username" | "avatar">;
  /** Draw this picture (or `null` for the initial) instead of the saved one. */
  choice?: AvatarId | null;
}) {
  const id = choice === undefined ? avatarFor(user)?.id ?? null : choice;
  return id ? <AvatarArt id={id} /> : <>{initialOf(user.username)}</>;
}
