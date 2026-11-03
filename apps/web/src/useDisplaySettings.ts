import { useState } from "react";
import { disableRotationLock, enableRotationLock, readStoredRotationLock } from "./rotationLock";
import {
  type AppearanceMode,
  type DarkTheme,
  applyAppearanceMode,
  readStoredAppearanceMode,
  readStoredDarkTheme,
  switchDarkTheme,
  writeAppearanceMode,
  writeDarkTheme
} from "./appearance";
import { haptic, syncStatusBarStyle } from "./native";
import { errorMessage } from "./formatting";

export function useDisplaySettings({
  ios
}: {
  ios: boolean;
}) {
  const [rotationLockEnabled, setRotationLockEnabled] = useState(() => readStoredRotationLock() !== null);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() =>
    ios ? readStoredAppearanceMode() : "light"
  );
  const [darkTheme, setDarkTheme] = useState<DarkTheme>(readStoredDarkTheme);
  const [rotationLockBusy, setRotationLockBusy] = useState(false);
  const [rotationLockError, setRotationLockError] = useState<string | null>(null);

  function updateAppearanceMode(mode: AppearanceMode) {
    if (mode === appearanceMode) return;
    setAppearanceMode(mode);
    writeAppearanceMode(window.localStorage, mode);
    applyAppearanceMode(mode);
    syncStatusBarStyle(mode);
    haptic("light");
  }

  async function toggleRotationLock() {
    setRotationLockBusy(true);
    setRotationLockError(null);
    try {
      if (rotationLockEnabled) {
        await disableRotationLock();
        setRotationLockEnabled(false);
      } else {
        await enableRotationLock();
        setRotationLockEnabled(true);
      }
      haptic("light");
    } catch (error) {
      setRotationLockError(errorMessage(error, "Could not change the rotation lock."));
    } finally {
      setRotationLockBusy(false);
    }
  }

  function updateDarkTheme(theme: DarkTheme) {
    if (theme === darkTheme) return;
    setDarkTheme(theme);
    writeDarkTheme(window.localStorage, theme);
    switchDarkTheme(theme);
    haptic("light");
  }

  return {
    appearanceMode,
    darkTheme,
    rotationLockBusy,
    rotationLockEnabled,
    rotationLockError,
    toggleRotationLock,
    updateAppearanceMode,
    updateDarkTheme
  };
}
