---
title: Library Layout
nav_order: 4
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
    cover.jpg            # optional, embedded art is also used
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

`.mp3`, `.m4b`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`, `.aiff`

Everything else is ignored by the scanner.

## Chapter detection

Chapters are discovered in this order:

1. **MP4 chapter tracks / chapter lists** in `.m4a`/`.m4b`/`.mp4` files.
2. **MP3 ID3 `CHAP` frames** inside MP3 files.
3. **Multi-file track boundaries** — each audio file in a folder book becomes one chapter.

If a single `.m4b` has internal chapters, those win. If not, you get one chapter per file.

## Cover art

The server pulls cover art in this order of preference:

1. Art embedded in the audio file's tags.
2. A `cover.jpg` / `cover.png` next to the tracks.
3. Nothing — the UI falls back to a generic tile.

Covers are served from `/api/books/:bookId/cover`.

## Readalong companions

A "readalong" is any text-based companion file the reader pane can display. Supported types:

- `.epub`
- `.pdf`
- `.txt`
- `.html` / `.htm`

### Matching rules

| Book shape | Match preference |
| --- | --- |
| **Folder book** | First, a file in the folder whose stem matches the folder name. Otherwise, the first supported document found in the folder. |
| **Single-file book** | A file in `library_root` with the same stem and a supported readalong extension. |

So for a folder named `The Hobbit`, both of these work:

```text
/Audiobooks/The Hobbit/The Hobbit.epub     # preferred (matches folder name)
/Audiobooks/The Hobbit/companion.pdf       # used if no same-name file exists
```

And for `Project Hail Mary.m4b` you need `Project Hail Mary.epub` (or `.pdf`, etc.) sitting beside it in `library_root`.

### Sync maps (sentence highlighting)

When a book has an EPUB companion, a *sync map* enables sentence-level readalong: while the book plays, the reader pane highlights the sentence being narrated, turns pages, and follows chapter changes. Clicking a highlighted sentence seeks the audio to it.

Sync maps are `.sync.json` files matched with the same stem rules as readalong companions (`The Hobbit.sync.json` next to `The Hobbit.m4b`). You can provide them yourself, or let the server generate one: install [echogarden](https://github.com/echogarden-project/echogarden) (`npm install -g echogarden`, or set `alignment_cli_path` in `server.config`), then use the **Sync** button in the readalong pane (admins only). Generated maps are stored under `data_dir/sync/` and a sidecar next to the book always wins over a generated one.

Generation force-aligns each audio file against the EPUB text. Single-file audiobooks are aligned in one pass; multi-file books are scoped by matching track titles against the EPUB's table of contents, so it works best when track names correspond to chapters (`03 - Owl Post` ↔ `Chapter 3: Owl Post`).

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

Cleaner tags = cleaner library. [MP3Tag](https://www.mp3tag.de/en/), [Kid3](https://kid3.kde.org/), and the Audible CLI exporters all produce tags this server understands.

## Rescanning

The library is scanned on startup. To pick up new books without restarting, the web UI has a **Rescan library** action (Settings menu / admin). It hits `POST /api/library/rescan`.

The Libation integration also kicks off a rescan after each successful download.
