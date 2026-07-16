---
title: Getting Started
nav_order: 2
---

# Getting Started

This guide walks you from downloading OperaLibre to streaming your first audiobook. You only need a Terminal window for the initial setup. Once it is running, everyday use happens in the app.

## Choose the right starting point

- **You have audiobook files on this computer:** follow the steps below.
- **Your books are already in Jellyfin:** you do not need to install this server. Open the OperaLibre web, macOS, or iPhone app, choose **Jellyfin**, enter your Jellyfin address, and sign in with your usual Jellyfin account. See [Using OperaLibre](using-operalibre.md#connect-to-jellyfin-instead).
- **You want to listen from a phone:** finish the local setup first, then see [Use it on a phone or tablet](using-operalibre.md#use-it-on-a-phone-or-tablet).

## Prerequisites

| Tool | Version | Used for |
| --- | --- | --- |
| [Rust](https://rustup.rs/) | stable (1.75+) | Building and running the server |
| [Node.js](https://nodejs.org/) | 20 LTS or newer | Building and serving `apps/web` |
| npm | bundled with Node | Workspace + dev scripts |
| A folder of audiobooks | — | The library the server will scan |

> **Tip:** If `cargo --version` and `node --version` both work, you have everything you need. On a Mac, install Apple’s Command Line Tools too by running `xcode-select --install` once.

## 1. Clone and install

```bash
git clone https://github.com/DonovanMontoya/OperaLibre.git
cd OperaLibre
npm install
```

`npm install` installs the web workspace under `apps/web`. The Rust server compiles on first run.

## 2. Create your config

```bash
cp server.config.example server.config
```

On Windows PowerShell, use this instead:

```powershell
Copy-Item server.config.example server.config
```

Open `server.config` in a text editor and replace `/Users/you/Audiobooks` with the full path to the folder that contains your books. Keep the rest as-is for now. On Windows, use a full path such as `C:\Users\you\Audiobooks`.

```config
host = 0.0.0.0
port = 4000
library_root = /Users/you/Audiobooks
```

## 3. Start OperaLibre

```bash
npm run dev
```

This starts the server and the web app together. Leave this Terminal window open while you listen. You should see two color-coded prefixes (`server` cyan, `web` magenta).

- Web UI: <http://localhost:5173>
- API:    <http://localhost:4000>

The Vite web app forwards its requests to the server automatically, so use the **Web UI** address above—not the API address—in your browser.

## 4. Create the admin account

The first browser that hits the app sees a one-time setup form. Fill it in to create the initial administrator account; subsequent visits show the normal sign-in form. See [Users & Accounts](users.md) for details on adding more readers and resetting passwords.

## 5. Start listening

Pick a book and press play. Progress saves automatically and follows the signed-in reader across devices. See [Using OperaLibre](using-operalibre.md) for uploading a book, adding family members, installing the web app, readalong, and the optional integrations.

## Running on the LAN

To stream to a phone or tablet:

1. Make sure `host = 0.0.0.0` in `server.config` so the server binds to all interfaces.
2. Find your machine's LAN IP (`ipconfig getifaddr en0` on macOS, `ip addr` on Linux, `ipconfig` on Windows).
3. Allow port `4000` (or whatever you set) through your firewall.
4. On the other device, open `http://<your-lan-ip>:5173` in dev, sign in, and start listening. For a setup that keeps working after you close the development Terminal, use the production setup below.

> **Safety:** a LAN address uses plain HTTP. It is suitable for a trusted home network. Do not port-forward it to the public internet; use HTTPS and the guidance in [Deployment](deployment.md) for access away from home.

## Keep it running (recommended after you have tried it)

```bash
npm run build
```

This produces:

- A release Rust binary at `apps/server/target/release/operalibre-server`
- A static web bundle at `apps/web/dist/`

Then add this line to `server.config`:

```config
web_dist_dir = apps/web/dist
```

Start the server with:

```bash
./apps/server/target/release/operalibre-server
```

Now open [http://localhost:4000](http://localhost:4000). The server and web app share one address, which is simpler to bookmark and use on another device. To make it start automatically when the computer restarts, follow the macOS or Linux instructions in [Deployment](deployment.md).

## Type-checking everything

```bash
npm run typecheck
```

Runs `cargo check` and the web app's TypeScript compiler. Useful before committing.
