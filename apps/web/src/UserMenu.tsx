import { BehaviorSection } from "./BehaviorSection";
import { ContinueReadingSetting } from "./ContinueReadingSetting";
import type { usePurchases } from "./usePurchases";
import type { useReadalong } from "./useReadalong";
import type { useReaderPreferences } from "./useReaderPreferences";
import { AlertCircle, LogOut, Pencil, ScrollText, UserCog } from "lucide-react";
import { FOLLOW_AGGRESSIVENESS_LABELS, type FollowAggressiveness } from "./readalongPreferences";
import { useState, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from "react";
import { updateAvatar } from "./api";
import { AvatarFace } from "./Avatar";
import { AVATARS, avatarFor, hasChosenAvatar, supportsAvatars, type AvatarId } from "./avatars";
import type { AuthUser } from "./types";
import type { NativeTab } from "./nativeTabs";
import type { LibrarySource } from "./shelfSort";
import type { ServerCapabilities } from "./serverCapabilities";

/**
 * The top of the account menu: who is signed in, and — where the server can
 * save one — the pictures they can choose from.
 */
function AccountHead({ user, role, onUserChanged }: {
  user: AuthUser;
  role: string;
  onUserChanged: (user: AuthUser) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  // The picture being saved, shown at once so the choice does not lag the tap.
  const [pending, setPending] = useState<{ id: AvatarId | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = avatarFor(user)?.id ?? null;
  const shown = pending ? pending.id : saved;
  const chosen = pending ? pending.id !== null : hasChosenAvatar(user);

  async function choose(id: AvatarId | null) {
    if (pending || id === (user.avatar ?? null)) return;
    setPending({ id });
    setError(null);
    try {
      onUserChanged(await updateAvatar(id));
    } catch {
      setError("Your picture wasn’t saved. Check the connection to your server and try again.");
    } finally {
      setPending(null);
    }
  }

  const portrait = <AvatarFace user={user} choice={shown} />;

  return (
    <div className="user-menu-account">
      <div className="user-menu-head">
        {supportsAvatars(user) ? (
          <button
            type="button"
            className="user-menu-portrait"
            aria-label="Change picture"
            aria-expanded={choosing}
            aria-controls="user-menu-pictures"
            onClick={() => setChoosing((open) => !open)}
          >
            {portrait}
            <span className="user-menu-portrait-edit" aria-hidden="true"><Pencil size={10} /></span>
          </button>
        ) : (
          <span className="user-menu-portrait" aria-hidden="true">{portrait}</span>
        )}
        <div className="user-menu-id">
          <strong>{user.username}</strong>
          <span>{role}</span>
        </div>
      </div>
      {choosing ? (
        <div className="avatar-picker" id="user-menu-pictures">
          <div className="avatar-picker-grid" role="radiogroup" aria-label="Picture">
            {AVATARS.map((avatar) => (
              <button
                key={avatar.id}
                type="button"
                className="avatar-tile"
                role="radio"
                aria-checked={shown === avatar.id}
                aria-label={avatar.label}
                title={avatar.label}
                onClick={() => void choose(avatar.id)}
              >
                <AvatarFace user={user} choice={avatar.id} />
              </button>
            ))}
          </div>
          {chosen ? (
            <button type="button" className="avatar-picker-reset" onClick={() => void choose(null)}>
              Use my initial instead
            </button>
          ) : null}
          {error ? <p className="avatar-picker-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function renderUserMenu({
  continueReadingAutoplay,
  toggleContinueReadingAutoplay,
  audioRef,
  capabilities,
  currentUser,
  demoMode,
  isOperaLibre,
  localMode,
  native,
  onCurrentUserChanged,
  onLogout,
  openNativeTab,
  pausePlayback,
  purchases,
  readalong,
  readerPreferences,
  setLibraryOpen,
  setLibrarySource,
  setProfileOpen,
  setUserMenuOpen,
  setUsersModalOpen
}: {
  continueReadingAutoplay: boolean;
  toggleContinueReadingAutoplay: () => void;
  audioRef: RefObject<HTMLAudioElement | null>;
  capabilities: ServerCapabilities;
  currentUser: AuthUser;
  demoMode: boolean;
  isOperaLibre: boolean;
  localMode: boolean;
  native: boolean;
  onCurrentUserChanged: (user: AuthUser) => void;
  onLogout: () => void | Promise<void>;
  openNativeTab: (tab: NativeTab) => void;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  purchases: ReturnType<typeof usePurchases>;
  readalong: ReturnType<typeof useReadalong>;
  readerPreferences: ReturnType<typeof useReaderPreferences>;
  setLibraryOpen: Dispatch<SetStateAction<boolean>>;
  setLibrarySource: Dispatch<SetStateAction<LibrarySource>>;
  setProfileOpen: Dispatch<SetStateAction<boolean>>;
  setUserMenuOpen: Dispatch<SetStateAction<boolean>>;
  setUsersModalOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const {
    brokenLibationAccounts
  } = purchases;
  const {
    followAggressiveness,
    updateFollowAggressiveness
  } = readerPreferences;
  const {
    sentenceFollowAvailable
  } = readalong;

  return (
    <div className="user-menu" role="menu">
      <AccountHead
        user={currentUser}
        role={isOperaLibre
          ? localMode ? "On-device library" : demoMode ? "On-device demo" : currentUser.isOwner ? "Owner" : currentUser.isAdmin ? "Administrator" : "Reader"
          : currentUser.isAdmin ? "Jellyfin administrator" : "Jellyfin account"}
        onUserChanged={onCurrentUserChanged}
      />
      {capabilities.statistics ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            if (native) {
              openNativeTab("ledger");
            } else {
              setProfileOpen(true);
            }
          }}
        >
          <ScrollText size={16} /> Reader's ledger
        </button>
      ) : null}
      {capabilities.administration ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            if (native) {
              openNativeTab("admin");
            } else {
              setUsersModalOpen(true);
            }
          }}
        >
          <UserCog size={16} /> Administration
        </button>
      ) : null}
      {capabilities.administration && brokenLibationAccounts.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            setLibrarySource("audible");
            setLibraryOpen(true);
            if (native) openNativeTab("shelf");
          }}
        >
          <AlertCircle size={16} /> Audible accounts ({brokenLibationAccounts.length})
        </button>
      ) : null}
      {!native ? <BehaviorSection>
        <ContinueReadingSetting enabled={continueReadingAutoplay} onToggle={toggleContinueReadingAutoplay} />
        {sentenceFollowAvailable ? (
          <div className="user-menu-follow-aggressiveness" role="group" aria-labelledby="menu-follow-aggressiveness-label">
            <div>
              <label id="menu-follow-aggressiveness-label" htmlFor="menu-follow-aggressiveness">
                Aggressiveness
              </label>
              <output htmlFor="menu-follow-aggressiveness">
                {FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
              </output>
            </div>
            <input
              id="menu-follow-aggressiveness"
              type="range"
              min="0"
              max="2"
              step="1"
              value={followAggressiveness}
              style={{ "--scrub-progress": `${followAggressiveness * 50}%` } as CSSProperties}
              aria-valuetext={FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
              onChange={(event) => updateFollowAggressiveness(Number(event.currentTarget.value) as FollowAggressiveness)}
            />
            <small>Current timing <span>A little ahead</span></small>
          </div>
        ) : null}
      </BehaviorSection> : null}
      <button
        type="button"
        role="menuitem"
        className="user-menu-leave"
        onClick={() => {
          setUserMenuOpen(false);
          if (localMode) pausePlayback(audioRef.current);
          void onLogout();
        }}
      >
        <LogOut size={16} /> {localMode ? "Leave local mode" : "Sign out"}
      </button>
    </div>
  );
}
