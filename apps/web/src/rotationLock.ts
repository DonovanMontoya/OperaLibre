import { Capacitor } from "@capacitor/core";
import {
  ScreenOrientation,
  type OrientationLockType
} from "@capacitor/screen-orientation";

const ROTATION_LOCK_STORAGE_KEY = "operalibre.rotationLock";
const ORIENTATION_LOCK_TYPES = new Set<OrientationLockType>([
  "natural",
  "landscape",
  "portrait",
  "portrait-primary",
  "portrait-secondary",
  "landscape-primary",
  "landscape-secondary"
]);

type RotationLockStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DeviceNavigator = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent">;

export function isIPadNavigator(deviceNavigator: DeviceNavigator): boolean {
  return /\biPad\b/i.test(deviceNavigator.userAgent)
    || (deviceNavigator.platform === "MacIntel" && deviceNavigator.maxTouchPoints > 1);
}

export function supportsRotationLock(
  native: boolean,
  platform: string,
  deviceNavigator: DeviceNavigator
): boolean {
  if (!native) {
    return false;
  }
  if (platform === "android") {
    return true;
  }
  return platform === "ios" && !isIPadNavigator(deviceNavigator);
}

export function isRotationLockAvailable(): boolean {
  return supportsRotationLock(
    Capacitor.isNativePlatform(),
    Capacitor.getPlatform(),
    window.navigator
  );
}

export function readStoredRotationLock(
  storage: RotationLockStorage = window.localStorage
): OrientationLockType | null {
  try {
    const value = storage.getItem(ROTATION_LOCK_STORAGE_KEY) as OrientationLockType | null;
    return value && ORIENTATION_LOCK_TYPES.has(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredRotationLock(
  orientation: OrientationLockType | null,
  storage: RotationLockStorage = window.localStorage
): void {
  try {
    if (orientation) {
      storage.setItem(ROTATION_LOCK_STORAGE_KEY, orientation);
    } else {
      storage.removeItem(ROTATION_LOCK_STORAGE_KEY);
    }
  } catch {
    // The native lock still works for this session when storage is unavailable.
  }
}

export async function applyStoredRotationLock(): Promise<void> {
  if (!isRotationLockAvailable()) {
    return;
  }
  const orientation = readStoredRotationLock();
  if (orientation) {
    await ScreenOrientation.lock({ orientation });
  }
}

export async function enableRotationLock(): Promise<OrientationLockType> {
  if (!isRotationLockAvailable()) {
    throw new Error("Rotation lock is not available on this device.");
  }
  const { type } = await ScreenOrientation.orientation();
  const orientation = type as OrientationLockType;
  await ScreenOrientation.lock({ orientation });
  writeStoredRotationLock(orientation);
  return orientation;
}

export async function disableRotationLock(): Promise<void> {
  if (!isRotationLockAvailable()) {
    return;
  }
  await ScreenOrientation.unlock();
  writeStoredRotationLock(null);
}
