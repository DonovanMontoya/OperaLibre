# 0012. Remux faststart files before replacement

Status: Accepted.

## Context

An MP4 audiobook with its index after the audio can require a second fetch before playback starts. The server can move that index without re-encoding the book, but a partial conversion must leave the original available.

## Decision

- Inspect top-level box headers so a large file needs only seeks to locate the index and media. Only consider a known ISO base-media container with its index after the media. Handle the standard extended and end-of-file box lengths. Reject incomplete containers and bound the number of boxes examined.
- Remux to a sibling file, with the same extension so the format tooling selects the corresponding muxer. Exclude working files from library scans. Require room for the second file plus the configured reserve. Use deadlines for ffprobe and grow the remux deadline with the amount of disk I/O.
- Copy audio, artwork, and metadata. Let the muxer regenerate the chapter text track from the chapter list. The MP4 muxer cannot copy the duplicate QuickTime chapter data stream used by some Audible books.
- Require faststart layout and a plausible output size. When ffprobe is available, check duration and stream and chapter layout. Report reduced verification when the optional probe is unavailable. Run work that waits on commands and disk outside the async runtime worker. Drain child pipes independently, and kill and reap an overdue child before returning. Pipe readers need no join because a descendant can keep a pipe open.
- Recheck the original file before replacement. Attempt to copy its permissions. Make a backup hard link where the filesystem allows it, then atomically rename the verified remux over the source. A failed rename can restore a missing original from that link. Clear working files when the operation finishes, and sweep files from interrupted runs under the conversion lock.

## Consequences

Playback can get the index at the beginning of a converted file. Verification and replacement cost one extra file on disk during conversion. Filesystems without hard links use atomic replacement without a separate recovery link.

See [faststart.rs](../../apps/server/src/faststart.rs) and [library identity](0007-resolve-library-identities-across-a-complete-scan.md).
