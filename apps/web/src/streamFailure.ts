export const STREAM_LOAD_FAILED = "This audio track could not be loaded.";
export const STREAM_FORMAT_UNSUPPORTED = "This audio format is not supported on this device.";

/**
 * Why the media element rejected a stream.
 *
 * Browsers report MEDIA_ERR_SRC_NOT_SUPPORTED for any response they cannot
 * play, including a refused or missing stream, so the code alone cannot tell
 * an unplayable file from a failed request. Asking the server for the first
 * byte separates the two. A request that cannot be made at all (offline, or a
 * separately hosted frontend without access to the response) stays generic.
 */
export async function streamFailureMessage(
  streamUrl: string,
  fetchStream: typeof fetch = fetch
): Promise<string> {
  let response: Response;
  try {
    response = await fetchStream(streamUrl, {
      headers: { Range: "bytes=0-0" },
      // The media element sends cookies even to another origin; the probe must
      // too, or a proxy's sign-in check answers instead of the stream.
      credentials: "include",
      cache: "no-store"
    });
  } catch {
    return STREAM_LOAD_FAILED;
  }
  void response.body?.cancel().catch(() => undefined);
  if (response.ok) return STREAM_FORMAT_UNSUPPORTED;
  if (response.status === 401) {
    return "The server did not accept this session for audio. Reload the page, or sign in again.";
  }
  if (response.status === 403) return "This account no longer has access to this audiobook.";
  if (response.status === 404) {
    return "The server no longer has this audio file. Reload the page to refresh the library.";
  }
  return `The audiobook server could not send this track (error ${response.status}).`;
}
