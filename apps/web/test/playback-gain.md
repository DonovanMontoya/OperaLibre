# Safari gain comparison (#196)

Open `playback-gain.html` directly in Safari and choose a local file that exhibits
the distortion. Compare the same passage using each button at a comfortable
system volume. The file is not uploaded. The page intentionally bypasses the
application's WebKit boost guard.

The reporter tested the four paths and reported that only Original was clean;
all three Web Audio paths glitched. Playback speed did not contribute. Safari,
OS, file encoding, and output-device versions/details were not supplied.

This isolates the trigger to routing the media element through Web Audio on
the affected setup: neither amplification nor the compressor is necessary to
trigger it. It does not establish which underlying WebKit defect is responsible
or which versions are affected.

The application workaround must avoid creating a media-element source entirely.
Retest with a full page reload after applying the workaround: an element already
attached to Web Audio cannot be restored to native output just by disconnecting
its nodes. Confirm Original and reductions play cleanly, and that a saved
positive boost plays at Original without changing the saved setting. Include
streamed, downloaded, and imported files when available.

Keep this fixture for evaluating future fixes that could restore Safari boost.
Record Safari/OS versions, source format/sample rate, and audio output device
along with each path's listening result.
