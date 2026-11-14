import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

const SHARE_DIRECTORY = "shared-clips";

function toBase64(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function wasDismissed(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /cancel/i.test(error.message));
}

/**
 * Hand a clip to the system share sheet, or save it where there is none.
 * Resolves false when the listener closed the sheet without sending it.
 */
export async function shareClipFile(audio: Blob, fileName: string, title: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    // Only the newest clip is kept: the sheet reads the file after this
    // returns on Android, so it cannot be removed once the share is handed off.
    await Filesystem.rmdir({ path: SHARE_DIRECTORY, directory: Directory.Cache, recursive: true })
      .catch(() => undefined);
    const { uri } = await Filesystem.writeFile({
      path: `${SHARE_DIRECTORY}/${fileName}`,
      directory: Directory.Cache,
      data: toBase64(await audio.arrayBuffer()),
      recursive: true
    });
    try {
      await Share.share({ title, files: [uri] });
      return true;
    } catch (error) {
      if (wasDismissed(error)) return false;
      throw error;
    }
  }

  const file = new File([audio], fileName, { type: "audio/mp4" });
  if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title, files: [file] });
      return true;
    } catch (error) {
      if (wasDismissed(error)) return false;
      // Preparing the file can outlast the tap that asked for it, and a
      // browser then refuses the sheet. Saving the file still delivers it.
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The click only queues the download; revoking the URL right away can
  // cancel it in browsers that start the fetch asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
