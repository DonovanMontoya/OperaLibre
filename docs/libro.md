---
title: Libro.fm Import
nav_order: 9
---

# Libro.fm import

Open **Get books** on the shelf, then choose **Libro.fm** from the purchase-source dropdown. Connect your
Libro.fm account with your email and password, then browse your purchases and
choose **Import** on a book. Administrators can also use **Administration →
Imports**. No additional downloader application is required.

OperaLibre loads all library pages, offers search and sorting, and queues selected
books as background jobs. It downloads an M4B when available; otherwise it
downloads and extracts the MP3 archives. Completed audio is checked and published
into the server library, preserving catalog metadata in a sidecar. The book's
button changes to **In library** when it is ready. Choose **Refresh** for new
purchases or **Reconnect** if Libro.fm expires your sign-in.

Each OperaLibre user connects their own account. Purchase lists and tokens are
private to that user through the API. Downloaded audio joins the server's library:
users with all-book access can see it, and the importing user is granted access
if their shelf is restricted. Unlike requests against a shared Audible account,
importing your own Libro.fm purchases does not require another user's approval.
Up to three imports can be queued per user; server publication is serialized.

Your password passes through the selected OperaLibre server to Libro.fm once and
is not saved. The server saves the token and catalog under
`data_dir/libro-accounts/`, with private file permissions. Disconnecting removes
that connection and cached catalog, while keeping imported books. Credentials
are excluded from portable backups; reconnect after moving servers. Listening
positions are maintained in OperaLibre, not synchronized back to Libro.fm.

The integration uses Libro.fm's app endpoints, whose request shapes are also
implemented by [community clients](https://github.com/burntcookie90/librofm-downloader/blob/main/server/app/src/main/kotlin/com/vishnurajeevan/libroabs/libro/LibroAPI.kt).
These endpoints are not a documented public developer API and may change.
Catalog and download behavior is covered with fixtures; a real account is needed
to verify compatibility with Libro.fm's current authentication and delivery service.

## Optional watched folder

If you already download books yourself, expand **Optional: import files from a
server folder** in Administration → Imports. This watches for completed M4Bs or
extracted MP3 books and does not need a connected Libro.fm account.

### Set up

1. Create a dedicated folder on the computer running OperaLibre, outside its
   library and data folders. The server must be able to read it; it only needs
   write access to its own library and data folders.
2. Sign in as the OperaLibre owner, expand the optional folder section, enter the
   folder's absolute path, and choose **Save folder**. A phone or remote browser
   cannot select a folder on its own device for the server to watch.
3. Open [your Libro.fm library](https://libro.fm/user/library), choose **Files**
   beside a purchased book, and download its M4B or all of its MP3 ZIPs.
4. Put a completed M4B directly in the watched folder. For MP3s, extract every
   ZIP outside the watched folder first, then move one complete book folder
   containing all its tracks into the watched folder. Use the book title as
   the file or folder name. Keep alternative formats outside the watched folder.

The server checks every 30 seconds and requires the same file names, sizes, and
modification times for at least 60 seconds before copying. A paused download can
look unchanged, so moving complete downloads into the folder is the most reliable
workflow. ZIPs are shown as needing review; OperaLibre does not extract them.

Audio is validated and copied to a temporary library folder before publication.
Original downloads are kept, existing book folders are not overwritten, and a
library scan makes successful imports available to listeners. Embedded titles,
authors, narrators, artwork, and chapters use the normal scanner. Only audio is
copied; companion PDFs and other extras can be placed alongside the imported
audio separately. Nested MP3 folders are flattened; duplicate track filenames
need to be renamed first.

### Folder access and status

Only owners can change the watched folder or stop watching. Administrators can
view status and choose **Check now**. Imported books follow the same library
access rules as administrator uploads: users with access to all books can see
them, while users with selected-book access need a grant. Imports do not create
reader download requests or automatically grant restricted readers access.

- **Waiting for download:** the book has not stayed unchanged long enough.
- **Imported:** the book was copied; repeat checks do not copy it again.
- **Needs review:** an archive, unreadable track, mixed formats, name collision,
  changed source, or another import problem needs attention. The existing library
  book is retained. Name collisions are conservative checks, not proof that two
  editions are identical; renamed duplicates are not matched by audio content.
- **Missing library copy:** a previously imported folder was removed. It is not
  recreated automatically; use **Upload files** to restore it deliberately.

**Stop watching** keeps original files, imported books, and import history.
Saving a folder resumes watching without restarting the server. For this optional
workflow, you download files from Libro.fm yourself.

The server saves the watched path and import receipts in
`data_dir/libro-import.config.json`. This is host-specific configuration and is
excluded from portable server backups, like `server.config`. Each imported
folder also contains `.operalibre-libro.json`, used to recover an import if the
server stopped between publishing the audio and recording its receipt. Keep
these files when moving an installation. Upload size and free-space limits also
apply to these imports.

In Docker, mount the watched folder into the container and enter its container
path. With the hardened systemd service, place it somewhere the service can read;
personal home directories may be inaccessible. See
[Library layout](library-layout.md) and [Deployment](deployment.md).
