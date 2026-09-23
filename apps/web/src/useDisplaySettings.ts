import { useState } from "react";
import { disableRotationLock, enableRotationLock, readStoredRotationLock } from "./rotationLock";
import {
  type AppearanceMode,
  applyAppearanceMode,
  readStoredAppearanceMode,
  writeAppearanceMode
} from "./appearance";
import { haptic, syncStatusBarStyle } from "./native";

export function useDisplaySettings({
  ios
}: {
  ios: boolean;
}) {
  const [rotationLockEnabled, setRotationLockEnabled] = useState(() => readStoredRotationLock() !== null);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() =>
    ios ? readStoredAppearanceMode() : "light"
  );
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
      setRotationLockError(error instanceof Error ? error.message : "Could not change the rotation lock.");
    } finally {
      setRotationLockBusy(false);
    }
  }

  return {
    appearanceMode,
    rotationLockBusy,
    rotationLockEnabled,
    rotationLockError,
    toggleRotationLock,
    updateAppearanceMode
  };
}
