/**
 * Naming rules for audio files this app stores on the device.
 *
 * Both the offline downloader and the device-library importer write media into
 * app storage and later hand the path back to the platform for playback, so the
 * extension they choose has to be one the platform can actually type.
 */

/** The extension of a file name, without the dot, lowercased. */
export function fileExtension(name: string | null | undefined, fallback: string) {
  const base = (name ?? "").split(/[?#]/)[0];
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return (match ? match[1] : fallback).toLowerCase();
}

/**
 * iOS types `.m4b` as `com.apple.protected-mpeg-4-audio-b` — the DRM-protected
 * Audible type — and that UTType carries no MIME type at all. WKWebView's
 * `capacitor://` file server therefore serves a downloaded audiobook as
 * `application/octet-stream`, which the player refuses to open, and it also
 * misses Capacitor's media-extension list, so the file is read into memory
 * whole instead of being memory-mapped. `.m4a` is the same MPEG-4 container and
 * types cleanly as `audio/x-m4a`, so store audiobooks under that name instead.
 */
const STORED_EXTENSIONS: Record<string, string> = { m4b: "m4a" };

/** The extension to store a downloaded or imported file under. */
export function storedMediaExtension(extension: string) {
  const normalized = extension.toLowerCase();
  return STORED_EXTENSIONS[normalized] ?? normalized;
}

/** True when a stored file needs renaming to satisfy {@link storedMediaExtension}. */
export function storedMediaExtensionChanged(extension: string) {
  return storedMediaExtension(extension) !== extension.toLowerCase();
}
