---
title: Install a Release
nav_order: 2
---

# Install a Release

This is the easiest way to use OperaLibre. You do not need Rust, Node.js, Xcode, or programming experience.

## One-line install on macOS and Linux

Open the Terminal app and paste this:

```bash
curl -fsSL https://raw.githubusercontent.com/DonovanMontoya/OperaLibre/main/script/install.sh | sh
```

The installer walks you through the whole setup:

1. It detects whether you are on an Intel or Apple Silicon Mac, or on Intel/AMD or ARM Linux, and picks the matching combined package from the newest release.
2. It asks where to install OperaLibre. The default is a new `OperaLibre` folder in your home folder.
3. It asks which folder holds your audiobooks. Press Return to use the folder inside the installation, or type the path of a library you already have.
4. It asks whether OperaLibre should be reachable only from this computer (`local`) or from phones and other devices on your trusted home network (`lan`).
5. It downloads the package, checks it against the published `SHA256SUMS.txt` digest, and stops without installing anything if the digest does not match.
6. It offers to set up the optional Audible import. Answer `n` to skip it — the feature stays hidden and can be turned on later.
7. It writes your answers into `server.config`, clears the macOS download quarantine, and starts the server in the background.

When it finishes, open the address it prints — usually <http://localhost:4000> — and create the administrator account.

Running the same command again updates an existing installation in place. It stops the running server, replaces the program files, and keeps your `data` folder, `audiobooks` folder, and `server.config` settings.

Useful options, passed after `sh -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/DonovanMontoya/OperaLibre/main/script/install.sh \
  | sh -s -- --dir ~/OperaLibre --library ~/Audiobooks --mode lan --yes
```

| Option | What it does |
| --- | --- |
| `--dir PATH` | Install into `PATH` instead of `~/OperaLibre` |
| `--library PATH` | Use `PATH` as the audiobook library folder |
| `--version VERSION` | Install a specific release, such as `0.3.4` |
| `--mode local` or `--mode lan` | Choose network access without being asked |
| `--server-only` | Install the API and media server without the bundled web app |
| `--libation` | Set up the Audible import without being asked |
| `--libation-path PATH` | Use the Libation CLI at `PATH` |
| `--no-libation` | Skip the Audible import question entirely |
| `--yes` | Accept every default and never ask a question |
| `--no-start` | Install without starting OperaLibre |
| `--help` | List all options |

### Setting up the Audible import during install

If you say yes to the Audible import, the installer handles [Libation](https://github.com/rmcrackan/Libation) for you:

- It first looks for a Libation you already have — on `PATH`, in `/Applications/Libation.app` on macOS, or in `/usr/lib/libation` or `/opt/Libation` on Linux — and offers to use it.
- If there is none, it offers to download the newest official Libation release for your computer and unpack it into a `libation` folder inside your OperaLibre installation. Nothing is installed system-wide and no administrator password is needed, so removing it later means deleting that one folder.
- You can also type the path of a Libation command-line program yourself, or press Return to skip.

The chosen program is written to `libation_cli_path` in `server.config`. After the server starts, sign in as the administrator, open **Audible**, and choose **Add account**; your Audible password is only ever entered on Amazon's own sign-in page. See [Libation / Audible Import](libation.md) for the rest of the workflow.

Running the installer again never disturbs an Audible import you already configured.

### Headless servers

`--server-only` installs the server package instead of the combined one, for a machine that serves the frontend separately (or not at all):

```bash
curl -fsSL https://raw.githubusercontent.com/DonovanMontoya/OperaLibre/main/script/install.sh \
  | sh -s -- --server-only --dir /srv/operalibre --library /srv/audiobooks --mode lan --yes
```

That package has no `Open`/`Stop` launcher, so the installer writes two helper scripts beside the server — `start-operalibre.sh` runs it in the background and records its process ID in `data/operalibre-server.pid`, and `stop-operalibre.sh` stops it. `web_dist_dir` stays blank; point a separately hosted frontend at the API and list its address in `allowed_origins`, or set `web_dist_dir` to a folder holding the frontend release package. To run it as a system service instead, see [Deployment](deployment.md) and the `operalibre.service` unit in the repository.

Re-running the installer on an existing folder keeps whichever package is already there. Installing the other kind requires a different `--dir`.

Windows is not covered by the installer. Follow the manual steps below, which also work on macOS and Linux if you would rather download the package yourself.

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

Uploads are limited to 20 GiB by default. Administrators can change the upload and generated-download limits in `server.config`; see [Configuration](configuration.md#transfer-limits).

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

The secure default listens only on the server computer. For a trusted home network or private VPN, set `deployment_mode = lan` and leave `host` blank in `server.config`, restart OperaLibre, and connect the other device to that same trusted network. Then open:

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

On macOS and Linux, running the one-line installer again is the simplest update. It stops the server, installs the newest release, and preserves `data`, `audiobooks`, and `server.config`.

OperaLibre checks the latest GitHub release when an administrator opens **Administration**. Every administrator sees an update banner when a newer server is available. An owner can choose **Update server** to download the package for the server computer, verify its SHA-256 digest, install it, restart OperaLibre, and reconnect the page.

Published packages also receive GitHub build-provenance attestations after the release workflow verifies that the source commit belongs to `main`, runs the Rust and web tests, lints Rust, and audits production dependencies. To verify a package manually with GitHub CLI, run `gh attestation verify FILE --repo DonovanMontoya/OperaLibre`. The in-app updater currently enforces the release digest and package structure; provenance verification is an additional manual check for security-sensitive installations.

Automatic install is available for managed combined and server-only release packages. It preserves `data`, `audiobooks`, and `server.config`, so deployment profiles and custom paths survive upgrades. Configs from older versions remain compatible: a non-loopback `host` with no profile is inferred as `lan`. Combined updates replace the server, bundled web app, and launchers together; server-only updates replace only the server and leave a separately hosted frontend untouched. The prior managed files remain under `data/update-backups` for rollback; if the new server cannot start, the launcher restores and starts the previous version automatically.

New configuration keys use secure defaults when they are absent, so an existing managed installation does not need a manual config migration after an automatic update. Add the keys from `server.config.example` only when you want to override those defaults.

The browser frontend is tracked separately. When a newer standalone frontend package is available, an owner can choose **Update frontend** to verify and replace only the served web files. The server and playback keep running, the previous frontend is copied to `data/update-backups`, and the Administration page reloads into the new bundle.

Custom source deployments and system services still show the available version and release-notes link, but must be updated manually:

1. Stop OperaLibre.
2. Download and extract the new combined or server package into a new folder.
3. Copy the old `data` folder into the new package, replacing the empty one.
4. If you used the default library, copy the old `audiobooks` folder into the new package too.
5. If you edited `server.config`, copy your settings into the new file.
6. Start the new package and confirm your readers, progress, and books appear.
7. Keep the old folder until you know the update works.

Do not extract an update directly over a running installation. Keeping the old folder makes it easy to go back.

The first release that introduces in-app updating must itself be installed manually. Later combined-package releases can be installed from Administration.
