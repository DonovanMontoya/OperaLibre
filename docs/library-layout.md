---
title: Library Layout
nav_order: 5
---

# Library Layout

The server scans `library_root` and groups files into books. The rules are simple, but knowing them helps you organize for the best metadata and readalong matching.

## The two book shapes

### Folder books

A folder under `library_root` becomes one book. All supported audio files inside become its tracks, sorted lexicographically (so prefix filenames with `01`, `02`, … for correct order).

```text
/Audiobooks
  /The Hobbit
    01 - An Unexpected Party.mp3
    02 - Roast Mutton.mp3
    03 - A Short Rest.mp3
    The Hobbit.pdf       # optional readalong companion
```

### Single-file books

A standalone audio file directly inside `library_root` is its own book. This is the natural shape for `.m4b` files, which already bundle the whole book plus chapters.

```text
/Audiobooks
  Project Hail Mary.m4b
  Project Hail Mary.epub   # optional same-stem readalong
```

## Supported audio formats

`.mp3`, `.m4b`, `.m4a`, `.mp4`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`, `.aiff`

Extensions are matched case-insensitively. Everything else is ignored by the scanner.

### Hidden files and system folders

Files and folders whose names begin with a single dot are skipped, along with common recycle-bin and NAS metadata folders (`#recycle`, `@Recycle`, `@eaDir`, `$RECYCLE.BIN`, `System Volume Information`, and `lost+found`). This keeps the `._` copies macOS leaves beside files on network and exFAT drives, and anything sitting in a trash or snapshot folder, from showing up as tracks or books. Names that start with an ellipsis, like `...And Then There Were None`, are ordinary titles and are scanned as usual.

## Chapter detection

Chapters are discovered in this order:

1. **MP4 chapter tracks / chapter lists** in `.m4a`/`.m4b`/`.mp4` files.
2. **MP3 ID3 `CHAP` frames** inside MP3 files.
3. **Multi-file track boundaries** — each audio file in a folder book becomes one chapter.

If a single `.m4b` has internal chapters, those win. If not, you get one chapter per file.

## Cover art

Cover art initially comes from the artwork embedded in the audio files' tags; the server extracts it during a scan and caches it under `data_dir/covers/`. A book with no embedded art falls back to a generic tile. Loose image files such as `cover.jpg` beside the tracks are not used as covers.

An administrator can replace the cover through **Edit Info** with a JPEG, PNG, or WebP, without changing the audio. The replacement survives rescans and restarts; **Restore original cover** returns to embedded art or the generic tile. Replacements need a writable book folder and are stored there as hidden OperaLibre files. Keep those files with the library and preserve the server's metadata in backups. See [Add books to the library](using-operalibre.md#add-books-to-the-library) for image limits.

Covers are served from `/api/books/:bookId/cover`.

## Readalong companions

A "companion" is any document or picture that sits beside a book's audio. Documents the reader pane can display:

- `.epub` — the only format that can follow the narration
- `.pdf`
- `.txt`
- `.html` / `.htm`

Loose pictures (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`) are collected into a gallery. Files named `cover`, `folder`, `front`, `back`, `thumb`, `artwork`, or `poster` are treated as artwork and skipped. Images whose names match the audio file, book title, or book folder are also treated as covers, as are byte-identical copies of the embedded cover (up to 16 MiB). These files do not trigger the **Extras included** marker. Other images and companion documents remain available as extras or reading material. Rescan the library to update existing books.

### Which files belong to a book

| Book shape | Rule |
| --- | --- |
| **Folder book** | Every document and picture directly inside the folder. A folder holds one book, so all of them belong to it. |
| **Single-file book** | Files in `library_root` whose stem matches the audio file, the book title, or the folder name. |

So for a folder named `The Hobbit`, all of these are picked up:

```text
/Audiobooks/The Hobbit/The Hobbit.epub          # the text — read-along follows this
/Audiobooks/The Hobbit/The Hobbit - Maps.pdf    # pictures — shown as extras
/Audiobooks/The Hobbit/thror's-map.png          # pictures — shown in the gallery
```

And for `Project Hail Mary.m4b` you need `Project Hail Mary.epub` (or `.pdf`, etc.) sitting beside it in `library_root`.

### The book versus the extras

Audible downloads often include a PDF supplement — maps, illustrations, a recipe booklet — but no ebook. A file's extension says nothing about which it is, so the server opens each document during a scan and classifies it:

- **Book** — the text the narrator reads. The reader's **Read Along** control opens it, and an EPUB can be followed.
- **Supplement** — a document that is mostly pictures. It is offered under **Extras** and never mistaken for the text.
- **Image** — a loose picture, shown in the gallery.

The judgement compares how much text a document holds against how much a narration of the book's length implies (a narrator reads roughly fourteen characters a second). A twelve-page atlas with captions beside a ten-hour audiobook is a supplement; a picture book's short EPUB beside a four-minute recording is still the book. A document that cannot be opened is offered as the book rather than hidden. Results are cached by file size and modification time, so a rescan re-reads only documents that changed. When several documents qualify as the book, the EPUB is preferred, then HTML, text, and PDF.

To keep scans and uploads responsive, EPUB analysis stops after processing 100,000 markup tags in a chapter. Chapters over this limit cannot be analyzed or automatically aligned, and uploading such an EPUB is rejected.

### Sync maps (following the narration)

When a book has an EPUB companion, a *sync map* lets the reader follow the audio sentence by sentence. With the server’s follow-along experiment enabled and an aligned map available, tapping a mapped sentence plays from there. Pressing **Follow** also highlights the narrated sentence and turns the page with the audio. Without an aligned map, chapter sync remains available; the server does not create estimated sentence timings.

Sentence timings come from a matching `.sync.json` sidecar or the optional generator, which aligns the audio against the text. Owners can install and enable it under **Administration → Experiments**, then administrators can choose **Improve sync** in the reader. Manual installations can set `alignment_cli_path` to an existing echogarden executable. Generated maps live under `data_dir/sync/`. A sidecar takes priority unless a current generated map replaces an outdated OperaLibre-generated sidecar. Existing outdated maps remain usable while you regenerate them; current maps and third-party maps do not need remapping just because the application was updated. Disabling or removing the generator keeps those maps but disables sentence following until the experiment is enabled again.

Generation uses embedded chapter boundaries when they match the EPUB; otherwise it uses whole-track scopes. Long scopes are processed in transcription and alignment windows to limit drift. Multi-file books use ordered chapter matching, including spelled-out and roman chapter numbers, repeated titles, and unmatched credits. Generation runs one book at a time and requires no paid transcription service.

## Metadata fields shown in the UI

Whatever your tags expose — pulled best-effort from each container:

- Title and subtitle
- Author(s)
- Narrator(s)
- Publisher
- Publication date and recording date
- Genres
- Language
- Description / summary
- Series, series part
- Plus the raw tag dump for debugging

For Libation downloads, an adjacent `.metadata.json` file is also read during
a rescan. Its Audible catalog values take precedence over embedded audio tags;
metadata saved through OperaLibre still wins over both.

Cleaner tags = cleaner library. [MP3Tag](https://www.mp3tag.de/en/), [Kid3](https://kid3.kde.org/), and the Audible CLI exporters all produce tags this server understands.

## Rescanning

The library is scanned on startup. To pick up new books without restarting, the web UI has a **Rescan library** action (Settings menu / admin). It hits `POST /api/library/rescan`.

Administrators can also use **Upload audiobook** in the web library header. Choose a single M4B (or other supported audio file), or select every track for a multi-file book. OperaLibre streams the files into a temporary folder, moves the completed upload into `library_root`, and rescans automatically. The book name becomes the new folder name, and an existing folder is never overwritten.

The Libation integration also kicks off a rescan after each successful download.
