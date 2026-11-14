import { Capacitor } from "@capacitor/core";
import { useState } from "react";
import {
  type FollowAggressiveness,
  readFollowAggressiveness,
  writeFollowAggressiveness
} from "./readalongPreferences";
import { readPageTurnAnimation, writePageTurnAnimation } from "./readerPageTurn";
import { selectionHaptic } from "./native";

export function useReaderPreferences() {
  const [clippingEnabled, setClippingEnabled] = useState(() => {
    try { return window.localStorage.getItem("operalibre.clippingEnabled") !== "0"; }
    catch { return true; }
  });
  const [followAggressiveness, setFollowAggressiveness] = useState(readFollowAggressiveness);
  const [pageTurnAnimation, setPageTurnAnimation] = useState(readPageTurnAnimation);

  function updateFollowAggressiveness(value: FollowAggressiveness) {
    if (value === followAggressiveness) return;
    writeFollowAggressiveness(value);
    setFollowAggressiveness(value);
    selectionHaptic("change");
  }

  function togglePageTurnAnimation() {
    const enabled = !pageTurnAnimation;
    writePageTurnAnimation(enabled);
    setPageTurnAnimation(enabled);
  }

  function toggleClippingEnabled() {
    const enabled = !clippingEnabled;
    try { window.localStorage.setItem("operalibre.clippingEnabled", enabled ? "1" : "0"); }
    catch { /* Keep the choice usable when device storage is unavailable. */ }
    setClippingEnabled(enabled);
    selectionHaptic("change");
  }

  return {
    clippingEnabled,
    toggleClippingEnabled,
    followAggressiveness,
    // The phone apps only; the setting lives in their Settings page.
    pageTurnAnimation: pageTurnAnimation && Capacitor.isNativePlatform(),
    pageTurnAnimationEnabled: pageTurnAnimation,
    // Reader entry points and sync tools are always available when the book
    // and server support them. The in-reader Follow button owns the choice.
    followSyncEnabled: true,
    readalongEnabled: true,
    togglePageTurnAnimation,
    updateFollowAggressiveness
  };
}
