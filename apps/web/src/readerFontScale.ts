import type { FoldPosture } from "./deviceFold";

export const READER_FONT_SCALE_MIN = 50;
export const READER_FONT_SCALE_MAX = 300;

export type ReaderOrientation = "portrait" | "landscape";
export type ReaderFontScaleBucket = `${"closed" | "open"}.${ReaderOrientation}`;

/**
 * Text size follows both the physical reading surface and its orientation.
 * A non-folding phone uses the open surface, but still keeps independent
 * portrait and landscape sizes.
 */
export function readerFontScaleBucket(
  posture: FoldPosture,
  orientation: ReaderOrientation
): ReaderFontScaleBucket {
  const surface = posture === "closed" ? "closed" : "open";
  return `${surface}.${orientation}`;
}

function storedFontScaleKeys(bucket: ReaderFontScaleBucket): string[] {
  const surface = bucket.split(".", 1)[0] as "closed" | "open";
  return [
    `operalibre.readerFontScale.${bucket}`,
    // Preserve the per-screen setting used before orientation was added.
    `operalibre.readerFontScale.${surface}`,
    // The original single preference represented the open/ordinary screen.
    ...(surface === "open" ? ["operalibre.readerFontScale"] : [])
  ];
}

export function readStoredFontScale(
  bucket: ReaderFontScaleBucket,
  readValue: (key: string) => string | null
): number {
  const raw = storedFontScaleKeys(bucket)
    .map(readValue)
    .find((value) => value !== null);
  const stored = Number(raw);
  return Number.isFinite(stored) && stored >= READER_FONT_SCALE_MIN && stored <= READER_FONT_SCALE_MAX
    ? stored
    : 100;
}
