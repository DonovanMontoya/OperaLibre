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

## Chapter detection

Chapters are discovered in this order:

1. **MP4 chapter tracks / chapter lists** in `.m4a`/`.m4b`/`.mp4` files.
2. **MP3 ID3 `CHAP` frames** inside MP3 files.
3. **Multi-file track boundaries** — each audio file in a folder book becomes one chapter.

If a single `.m4b` has internal chapters, those win. If not, you get one chapter per file.

## Cover art

Cover art comes from the artwork embedded in the audio files' tags; the server extracts it during a scan and caches it under `data/covers/`. A book with no embedded art falls back to a generic tile in the UI, so add the artwork with a tag editor (Mp3Tag, Kid3, or similar) and rescan. Loose image files such as `cover.jpg` beside the tracks are not read.

Covers are served from `/api/books/:bookId/cover`.

## Readalong companions

A "companion" is any document or picture that sits beside a book's audio. Documents the reader pane can display:

- `.epub` — the only format that can follow the narration
- `.pdf`
- `.txt`
- `.html` / `.htm`

Loose pictures (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`) are collected into a gallery. Files named `cover`, `folder`, `front`, `back`, `thumb`, `artwork`, or `poster` are treated as artwork and skipped.

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

### Sync maps (following the narration)

When a book has an EPUB companion, a *sync map* lets the reader pane follow the audio: the narrated sentence is highlighted, the page turns with the narration, and tapping any sentence plays from there. There are three levels of precision, and every EPUB gets at least the first:

1. **Estimated.** With no sync map on disk, the server builds one on first request from the chapter list: each audio chapter is pinned to its entry in the EPUB's table of contents, and the chapter's seconds are shared among its sentences by how long the narrator is expected to spend on each. That pace is fitted to the book — seconds per character, per sentence end, per paragraph, and on dialogue — from the chapters' known lengths when there are enough of them. It needs nothing installed and keeps the page and paragraph in step, but the marker can run a few lines ahead or behind. The reader labels it *Approximate sync*, and offers **Sync here**: tapping the sentence being narrated stores an anchor in `{book_id}.anchors.json` and re-times the chapter through it. Estimates live under `data_dir/sync/` as `{book_id}.estimate-{fingerprint}.sync.json` and are rebuilt when the EPUB, the chapters, or the anchors change.
2. **Sentence.** A forced alignment of the audio against the text, exact to the sentence.
3. **Word.** The same alignment also times every word; the reader marks the narrated word inside the sentence.

Sentence and word precision come from a `.sync.json` file matched with the same stem rules as sidecars (`The Hobbit.sync.json` next to `The Hobbit.m4b`). You can provide one yourself, or let the server generate one: install [echogarden](https://github.com/echogarden-project/echogarden) (`npm install -g echogarden`, or set `alignment_cli_path` in `server.config`), then use **Improve sync** in the readalong pane (admins only). Generated maps are stored under `data_dir/sync/`; a sidecar next to the book always wins over a generated one, and both win over an estimate.

Generation force-aligns each audio file against the EPUB text. Single-file audiobooks are aligned in one pass; multi-file books are scoped by matching track titles against the EPUB's table of contents in order. Chapter numbers are recognised as digits, words, or roman numerals (`Chapter 3`, `Chapter Three`, `III.`), duplicate titles land on the right occurrence, and tracks named only `Track 07` are paired by position when both sides list the same number of chapters. A track that matches nothing (opening credits, say) is skipped rather than failing the book.

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
