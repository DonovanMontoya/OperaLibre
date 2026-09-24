import type { usePurchases } from "./usePurchases";
import type { useReadalong } from "./useReadalong";
import type { useReaderPreferences } from "./useReaderPreferences";
import { AlertCircle, BookOpen, LocateFixed, LogOut, ScrollText, UserCog } from "lucide-react";
import { FOLLOW_AGGRESSIVENESS_LABELS, type FollowAggressiveness } from "./readalongPreferences";
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from "react";
import type { AuthUser } from "./types";
import type { NativeTab } from "./nativeTabs";
import type { LibrarySource } from "./shelfSort";
import type { ServerCapabilities } from "./serverCapabilities";

export function renderUserMenu({
  audioRef,
  capabilities,
  currentUser,
  demoMode,
  isOperaLibre,
  localMode,
  native,
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
  audioRef: RefObject<HTMLAudioElement | null>;
  capabilities: ServerCapabilities;
  currentUser: AuthUser;
  demoMode: boolean;
  isOperaLibre: boolean;
  localMode: boolean;
  native: boolean;
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
    followSyncEnabled,
    readalongEnabled,
    toggleFollowSyncEnabled,
    updateFollowAggressiveness
  } = readerPreferences;
  const {
    sentenceFollowAvailable,
    toggleReadalongEnabled
  } = readalong;

  return (
    <div className="user-menu" role="menu">
      <div className="user-menu-head">
        <strong>{currentUser.username}</strong>
        <span>
          {isOperaLibre
            ? localMode ? "On-device library" : demoMode ? "On-device demo" : currentUser.isOwner ? "Owner" : currentUser.isAdmin ? "Administrator" : "Reader"
            : currentUser.isAdmin ? "Jellyfin administrator" : "Jellyfin account"}
        </span>
      </div>
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
          <ScrollText size={14} /> Reader's ledger
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
          <UserCog size={14} /> Administration
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
          <AlertCircle size={14} /> Audible accounts ({brokenLibationAccounts.length})
        </button>
      ) : null}
      {capabilities.readingFiles ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={readalongEnabled}
          onClick={toggleReadalongEnabled}
        >
          <BookOpen size={14} /> Ebook reader: {readalongEnabled ? "On" : "Off"} (beta)
        </button>
      ) : null}
      {readalongEnabled && sentenceFollowAvailable ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={followSyncEnabled}
          onClick={toggleFollowSyncEnabled}
          title="Experimental: the highlight can drift and may move the page to match the audio."
        >
          <LocateFixed size={14} /> Follow narration: {followSyncEnabled ? "On" : "Off"} (experimental)
        </button>
      ) : null}
      {!native && readalongEnabled && sentenceFollowAvailable && followSyncEnabled ? (
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
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setUserMenuOpen(false);
          if (localMode) pausePlayback(audioRef.current);
          void onLogout();
        }}
      >
        <LogOut size={14} /> {localMode ? "Leave local mode" : "Sign out"}
      </button>
    </div>
  );
}
