---
title: Deployment
nav_order: 10
---

# Deployment

The dev stack runs Vite and Rust side-by-side. In production you typically want a single port, supervised process, and the server fronted by either nothing (LAN only) or a reverse proxy (TLS, remote access).

## Build artifacts

```bash
npm run build
```

Produces:

| Artifact | Path |
| --- | --- |
| Server binary | `apps/server/target/release/operalibre-server` |
| Web bundle | `apps/web/dist/` |

The web bundle is plain static files — `index.html`, JS, CSS, the PWA manifest, and assets. It can be served by the Rust server, a reverse proxy, or any static host that points API calls back at the server.

You can also omit the bundled web app and run OperaLibre as a headless API/media server for a custom frontend. In that setup, keep the server binary, `server.config`, `data/`, and your audiobook library on the machine that performs scanning and streaming. The custom frontend only needs network access to the server API.

## Recommended layout on a home server

```text
/opt/operalibre/
  operalibre-server          # the release binary
  web/                       # contents of apps/web/dist/
  server.config             # your config
  data/                     # progress.json, users.json
```

After building, create that layout by copying the release binary and the *contents* of `apps/web/dist/` into `web/`. Keep `server.config` and `data/` outside the source checkout so updates do not touch your accounts or progress.

Start with:

```bash
OPERALIBRE_SERVER_CONFIG=/opt/operalibre/server.config \
  /opt/operalibre/operalibre-server
```

In `/opt/operalibre/server.config`, point the server at the copied web bundle:

```config
web_dist_dir = web
```

Then open `http://<server-address>:4000` in a browser. This is the recommended one-address setup: the server supplies both the site and its API.

## systemd unit (Linux)

```ini
# /etc/systemd/system/operalibre.service
[Unit]
Description=OperaLibre
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=operalibre
Group=operalibre
Environment=OPERALIBRE_SERVER_CONFIG=/opt/operalibre/server.config
ExecStart=/opt/operalibre/operalibre-server
Restart=on-failure
RestartSec=5
WorkingDirectory=/opt/operalibre

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now operalibre.service
sudo journalctl -u operalibre -f
```

## launchd (macOS)

Drop the following at `~/Library/LaunchAgents/com.you.operalibre.plist` and load with `launchctl load ...`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.you.operalibre</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/you/operalibre/operalibre-server</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>OPERALIBRE_SERVER_CONFIG</key>
      <string>/Users/you/operalibre/server.config</string>
    </dict>
    <key>WorkingDirectory</key><string>/Users/you/operalibre</string>
    <key>KeepAlive</key><true/>
    <key>RunAtLoad</key><true/>
  </dict>
</plist>
```

## Serving the web app from the server

The simplest single-origin deployment needs no reverse proxy at all: build the frontend and point the server at the bundle.

```bash
npm run build
```

```config
web_dist_dir = apps/web/dist
```

The server then serves the frontend at `/` and the API at `/api/...` from the same origin. Unknown paths fall back to `index.html` for client-side routing. Use a reverse proxy in front when you need TLS.

## Reverse proxy with TLS (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name books.example.com;

  ssl_certificate     /etc/letsencrypt/live/books.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/books.example.com/privkey.pem;

  client_max_body_size 0;       # large zip downloads

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Range requests for audio seeking.
    proxy_set_header Range $http_range;
    proxy_buffering off;
  }
}
```

Two notes when fronting with a proxy:

1. **Keep range requests intact.** The `Range` header and `206 Partial Content` responses are what makes seeking through a multi-hour `.m4b` snappy. Cloudflare and similar services often handle this for you; some proxies need explicit configuration.
2. **Disable response buffering for streams.** Long audio reads should not be buffered into memory before being sent to the client.

## Custom frontends

For custom clients, the most reliable production shape is still same-origin:

```text
https://books.example.com/        -> custom frontend static files
https://books.example.com/api/... -> operalibre-server
```

That keeps cookies, bearer-token API calls, media URLs, and browser security behavior predictable. Different-origin deployments can work, but they require deliberate CORS and credential handling. Avoid exposing a permissive cross-origin API on an untrusted network.

Client authors should treat the API as the contract and the bundled web app as a reference implementation. The important media convention is that JSON API calls can use `Authorization: Bearer ...`, while direct media elements such as `<audio>` and `<img>` should use the authenticated URLs with `?token=...`.

## Android / Capacitor

The checked-in Capacitor Android project packages the web app as a native Android 7+ app. With Android Studio, the Android SDK, and JDK 21 installed, build a debug APK from the repository root with:

```bash
npm run build:android
```

Open and synchronize the project with `npm run android:open -w @operalibre/web` to run it on a device, configure release signing, or generate an Android App Bundle. The app accepts private-network HTTP addresses and requires HTTPS for public hosts.

## iOS / Capacitor

The checked-in Capacitor iOS project packages the web app as a native iPhone app. On a Mac with Xcode, open and synchronize it with:

```bash
npm run ios:open -w @operalibre/web
```

In Xcode, select your development team and an attached iPhone, then press Run. For a server outside the app bundle, enter the reachable server URL on the app’s first screen. The app accepts private-network HTTP addresses and requires HTTPS for public hosts. See [Using OperaLibre](using-operalibre.md#native-iphone-app) for the listener-oriented steps.

## Backups

Back up `data_dir` (default `./data/`). That covers user accounts and per-reader progress. Back up `library_root` with your usual file backups as well; administrators can add new library folders through the web uploader.

## Updating

```bash
git pull
npm install
npm run build
# restart the service
```

The Rust binary picks up format changes automatically on next startup. The `data/` files use forward-compatible JSON.
