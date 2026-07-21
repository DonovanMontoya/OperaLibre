---
title: Install a Release
nav_order: 2
---

# Install a Release

This is the easiest way to use OperaLibre. You do not need Rust, Node.js, Xcode, or programming experience.

## 1. Download the complete package

Open the [OperaLibre releases page](https://github.com/DonovanMontoya/OperaLibre/releases), choose the newest release, and expand **Assets** if the downloads are hidden.

Most people should download a filename containing **combined**:

| Your computer | Filename contains |
| --- | --- |
| Windows PC | `combined-windows-x64.zip` |
| Apple Silicon Mac (M1, M2, M3, M4, or newer) | `combined-macos-arm64.tar.gz` |
| Intel Mac | `combined-macos-x64.tar.gz` |
| Normal Intel/AMD Linux computer | `combined-linux-x64.tar.gz` |
| 64-bit ARM Linux or Raspberry Pi | `combined-linux-arm64.tar.gz` |

The **combined** package includes both pieces OperaLibre needs: the audiobook server and the web app. The server-only and frontend-only files are intended for custom hosting.

## 2. Extract it

Move the download somewhere permanent, such as Documents or Applications, and extract the whole archive. Do not run the start file from inside the ZIP or TAR.GZ preview.

Keep the extracted OperaLibre folder. Your default audiobook library, accounts, passwords, and listening progress live inside it.

## 3. Start OperaLibre

### Windows

Double-click `Open OperaLibre.exe`. It starts OperaLibre in the background and opens your browser. If Windows Defender Firewall asks, allow OperaLibre on **Private networks**. You do not need to allow public networks.

### macOS

Double-click `Open OperaLibre.app`. It starts OperaLibre in the background and opens your browser.

The downloads are not Apple-notarized yet. If macOS blocks the first launch:

1. Open the Terminal app.
2. Type `xattr -dr com.apple.quarantine `, including the space at the end.
3. Drag the extracted OperaLibre folder into the Terminal window.
4. Press Return, then double-click `Open OperaLibre.app` again.

### Linux

Double-click `open-operalibre`. If your file manager does not run executable files when they are double-clicked, open a terminal in the extracted folder and run:

```bash
./open-operalibre
```

If the browser does not open automatically on any platform, open <http://localhost:4000>.

The launcher exits after OperaLibre is ready. No command or Terminal window needs to remain open, and closing the browser does not stop the server. Use the same Open action whenever you want to return.

## Stop OperaLibre

You can normally leave the server running in the background. Before moving its folder, changing important settings, or installing an update, use the included Stop action:

- Windows: `Stop OperaLibre.exe`
- macOS: `Stop OperaLibre.app`
- Linux: `stop-operalibre`

Starting it again is as simple as using the Open action.

## 4. Create the administrator

The first page asks for the initial administrator name and password. The administrator can upload books, rescan the library, and create accounts for other readers.

Use a password you can remember. See [Users & Accounts](users.md) for household accounts and password recovery.

## 5. Add audiobooks

The simplest method is:

1. Sign in as the administrator.
2. Choose **Upload audiobook**.
3. Enter the book name.
4. Select one M4B or other audio file, or select all audio tracks for a multi-file book.
5. Wait for the upload and automatic library scan to finish.

You can also copy audiobooks into the package's `audiobooks` folder, then choose **Rescan library**. See [Library Layout](library-layout.md) if you want covers, chapters, or readalong files to be matched automatically.

## Use an existing audiobook folder

Stop OperaLibre and open `server.config` in a plain text editor. Change:

```config
library_root = audiobooks
```

to the full path of your existing folder:

```config
# Windows
library_root = C:\Users\YourName\Audiobooks

# macOS
library_root = /Users/YourName/Audiobooks

# Linux
library_root = /home/yourname/Audiobooks
```

Save the file and start OperaLibre again.

## Listen on a phone or another computer

The server computer must be turned on with OperaLibre running. Connect the other device to the same trusted home network, then open:

```text
http://SERVER-COMPUTER-IP:4000
```

The server computer's local IP usually looks like `192.168.1.25` or `10.0.0.25`. See [Use it on a phone or tablet](using-operalibre.md#use-it-on-a-phone-or-tablet) for installing the web app on the home screen.

Do not expose this plain HTTP address directly to the public internet. Remote access requires the HTTPS setup described in [Deployment](deployment.md).

## Back up your library

Back up these folders from the extracted combined package:

- `data` — reader accounts, passwords, progress, and generated sync maps
- `audiobooks` — books uploaded into the default library

If `library_root` points somewhere else, back up that audiobook folder instead.

## Update to a newer release

OperaLibre checks the latest GitHub release when an administrator opens **Administration**. Every administrator sees an update banner when a newer server is available. An owner can choose **Update server** to download the package for the server computer, verify its SHA-256 digest, install it, restart OperaLibre, and reconnect the page.

Automatic install is available when OperaLibre is running from a combined release package and was started with its included Open action. It preserves `data`, `audiobooks`, and `server.config`. The prior server and web files remain under `data/update-backups` for rollback; if the new server cannot start, the launcher restores and starts the previous version automatically.

Custom deployments, server-only packages, and system services still show the available version and release-notes link, but must be updated manually:

1. Stop OperaLibre.
2. Download and extract the new combined or server package into a new folder.
3. Copy the old `data` folder into the new package, replacing the empty one.
4. If you used the default library, copy the old `audiobooks` folder into the new package too.
5. If you edited `server.config`, copy your settings into the new file.
6. Start the new package and confirm your readers, progress, and books appear.
7. Keep the old folder until you know the update works.

Do not extract an update directly over a running installation. Keeping the old folder makes it easy to go back.

The first release that introduces in-app updating must itself be installed manually. Later combined-package releases can be installed from Administration.
