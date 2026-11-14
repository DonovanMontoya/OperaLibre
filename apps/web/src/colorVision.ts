export const COLOR_VISION_STORAGE_KEY = "operalibre.colorVision";
export const VISUAL_CUES_STORAGE_KEY = "operalibre.strongerVisualCues";

export const COLOR_VISION_OPTIONS = [
  { id: "default", label: "Default colors", description: "Original OperaLibre colors." },
  { id: "red-green", label: "Red–green", description: "For protanopia and deuteranopia." },
  { id: "blue-yellow", label: "Blue–yellow", description: "For tritanopia." },
  { id: "monochrome", label: "Monochrome", description: "Neutral accents and status colors." }
] as const;

export type ColorVision = (typeof COLOR_VISION_OPTIONS)[number]["id"];
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function readColorVision(storage?: StorageReader): ColorVision {
  try {
    const stored = (storage ?? window.localStorage).getItem(COLOR_VISION_STORAGE_KEY);
    return COLOR_VISION_OPTIONS.find(({ id }) => id === stored)?.id ?? "default";
  } catch {
    return "default";
  }
}

export function readStrongerVisualCues(storage?: StorageReader): boolean {
  try {
    return (storage ?? window.localStorage).getItem(VISUAL_CUES_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeColorVision(mode: ColorVision, storage?: StorageWriter): void {
  try {
    (storage ?? window.localStorage).setItem(COLOR_VISION_STORAGE_KEY, mode);
  } catch {
    // The choice still applies for this session when device storage is blocked.
  }
}

export function writeStrongerVisualCues(enabled: boolean, storage?: StorageWriter): void {
  try {
    (storage ?? window.localStorage).setItem(VISUAL_CUES_STORAGE_KEY, String(enabled));
  } catch {
    // The choice still applies for this session when device storage is blocked.
  }
}

export function applyColorVision(mode: ColorVision, root: Pick<HTMLElement, "setAttribute" | "removeAttribute"> = document.documentElement): void {
  if (mode === "default") root.removeAttribute("data-color-vision");
  else root.setAttribute("data-color-vision", mode);
}

export function applyStrongerVisualCues(enabled: boolean, root: Pick<HTMLElement, "toggleAttribute"> = document.documentElement): void {
  root.toggleAttribute("data-stronger-cues", enabled);
}

export function applyStoredColorVision(): void {
  applyColorVision(readColorVision());
  applyStrongerVisualCues(readStrongerVisualCues());
}
