---
title: Getting Started
nav_order: 2
---

# Getting Started

This guide walks you from a fresh clone to streaming your first audiobook.

## Prerequisites

| Tool | Version | Used for |
| --- | --- | --- |
| [Rust](https://rustup.rs/) | stable (1.75+) | Building and running the `apps/server` binary |
| [Node.js](https://nodejs.org/) | 20 LTS or newer | Building and serving `apps/web` |
| npm | bundled with Node | Workspace + dev scripts |
| A folder of audiobooks | — | The library the server will scan |

> **Tip:** If `cargo --version` and `node --version` both work, you have everything you need.

## 1. Clone and install

```bash
git clone https://github.com/<you>/audiobook-serving.git
cd audiobook-serving
npm install
```

`npm install` installs the web workspace under `apps/web`. The Rust server compiles on first run.

## 2. Create your config

```bash
cp server.config.example server.config
```

Open `server.config` and set at least `library_root` to the absolute path of your audiobook folder. See [Configuration](configuration.md) for every option.

```config
host = 0.0.0.0
port = 4000
library_root = /Users/you/Audiobooks
```

## 3. Run the dev stack

```bash
npm run dev
```

This runs the Rust server and the Vite dev server concurrently. You should see two color-coded prefixes (`server` cyan, `web` magenta).

- Web UI: <http://localhost:5173>
- API:    <http://localhost:4000>

The Vite dev server proxies API calls to the Rust server, so you can browse to the web URL and everything just works.

## 4. Create the admin account

The first browser that hits the app sees a one-time setup form. Fill it in to create the initial administrator account; subsequent visits show the normal sign-in form. See [Users & Accounts](users.md) for details on adding more readers and resetting passwords.

## 5. Start listening

Pick a book, hit play. Progress saves automatically and follows the signed-in reader across devices.

## Running on the LAN

To stream to a phone or tablet:

1. Make sure `host = 0.0.0.0` in `server.config` so the server binds to all interfaces.
2. Find your machine's LAN IP (`ipconfig getifaddr en0` on macOS, `ip addr` on Linux, `ipconfig` on Windows).
3. Allow port `4000` (or whatever you set) through your firewall.
4. On the other device, open `http://<your-lan-ip>:5173` in dev, or the production URL after building (see [Deployment](deployment.md)).

## Production build

```bash
npm run build
```

This produces:

- A release Rust binary at `apps/server/target/release/audiobook-server`
- A static web bundle at `apps/web/dist/`

See [Deployment](deployment.md) for putting both behind a single port on a home server.

## Type-checking everything

```bash
npm run typecheck
```

Runs `cargo check` and the web app's TypeScript compiler. Useful before committing.
