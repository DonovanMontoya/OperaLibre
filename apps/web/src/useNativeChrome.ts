import { nativeShellColor, type NativeTab, nativeTabItems, nativeTabSelection } from "./nativeTabs";
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useState } from "react";
import { useNativeTabs } from "./useNativeTabs";
import type { ServerCapabilities } from "./serverCapabilities";
import type { AuthUser, Book, LibationAccount, Track } from "./types";
import type { ShelfLayout } from "./shelfSort";
import type { AppearanceMode } from "./appearance";

export function useNativeChrome({
  appearanceMode,
  brokenLibationAccounts,
  capabilities,
  currentTrack,
  currentUser,
  gamesEnabled,
  miniPlayerRef,
  native,
  nativeTab,
  openNativeTab,
  playbackBook,
  readalongOpen,
  readerClosing,
  setReadalongOpen,
  setReaderClosing,
  shelfLayout,
  shellRef
}: {
  appearanceMode: AppearanceMode;
  brokenLibationAccounts: LibationAccount[];
  capabilities: ServerCapabilities;
  currentTrack: Track | null;
  currentUser: AuthUser;
  gamesEnabled: boolean;
  miniPlayerRef: RefObject<HTMLElement | null>;
  native: boolean;
  nativeTab: NativeTab;
  openNativeTab: (tab: NativeTab) => void;
  playbackBook: Book | null;
  readalongOpen: boolean;
  readerClosing: boolean;
  setReadalongOpen: Dispatch<SetStateAction<boolean>>;
  setReaderClosing: Dispatch<SetStateAction<boolean>>;
  shelfLayout: ShelfLayout;
  shellRef: RefObject<HTMLElement | null>;
}) {
  const showLedgerTab = native && capabilities.statistics;
  const iosTabs = nativeTabItems(gamesEnabled, showLedgerTab,
    currentUser.isAdmin ? brokenLibationAccounts.length : 0);
  const [chrome, setChrome] = useState<string | undefined>(undefined);
  const [barTint, setBarTint] = useState<string | undefined>(undefined);
  // The tab class carries the screen's colors, and the appearance switch flips
  // the palette on the document, so watch both for the tones UIKit should hold.
  useEffect(() => {
    if (!native) return;
    const read = () => {
      setChrome(nativeShellColor(shellRef.current, "--native-chrome"));
      setBarTint(nativeShellColor(shellRef.current, "--native-bar"));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [native, nativeTab, shelfLayout, shellRef]);
  const { ready: nativeTabsReady, shown: nativeTabsShown } = useNativeTabs({
    tabs: iosTabs,
    selected: nativeTabSelection(nativeTab, iosTabs),
    visible: !readalongOpen || readerClosing,
    appearance: appearanceMode,
    chrome,
    bar: barTint
  }, openNativeTab);
  useEffect(() => {
    if (!readerClosing || (nativeTabsReady && !nativeTabsShown)) return;
    setReaderClosing(false);
    setReadalongOpen(false);
  }, [nativeTabsReady, nativeTabsShown, readerClosing, setReadalongOpen, setReaderClosing]);
  const hasMiniPlayer = Boolean(playbackBook && currentTrack);

  useEffect(() => {
    const shell = shellRef.current;
    const player = miniPlayerRef.current;
    if (!native || !shell || !player) {
      shell?.style.removeProperty("--mini-player-height");
      return;
    }

    const updatePlayerHeight = () => {
      const height = Math.ceil(player.getBoundingClientRect().height);
      // Reading hides the mini-player. Retain the last non-zero measurement so
      // Shelf has the right clearance on the first frame after switching back.
      if (height > 0) shell.style.setProperty("--mini-player-height", `${height}px`);
    };
    updatePlayerHeight();
    const observer = new ResizeObserver(updatePlayerHeight);
    observer.observe(player);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--mini-player-height");
    };
  }, [hasMiniPlayer, miniPlayerRef, native, shellRef]);

  return {
    hasMiniPlayer,
    nativeTabsReady,
    nativeTabsShown,
    showLedgerTab
  };
}
