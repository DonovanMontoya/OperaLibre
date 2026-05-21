---
title: Deployment
nav_order: 8
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

## Recommended layout on a home server

```text
/opt/operalibre/
  operalibre-server          # the release binary
  web/                      # contents of apps/web/dist/
  server.config             # your config
  data/                     # progress.json, users.json
```

Start with:

```bash
OPERALIBRE_SERVER_CONFIG=/opt/operalibre/server.config \
  /opt/operalibre/operalibre-server
```

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

## iOS / Capacitor

The web app is intentionally a plain React/Vite project so it can be wrapped with [Capacitor](https://capacitorjs.com/) for an iOS native app later:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios -w @operalibre/web
```

When building for a native wrapper, set `VITE_API_BASE` to the server URL reachable from the phone:

```bash
VITE_API_BASE=https://books.example.com npm run build -w @operalibre/web
```

This is a planned future build; the web PWA is the current happy path for mobile.

## Backups

Back up `data_dir` (default `./data/`). That covers user accounts and per-reader progress. The library itself is read-only from the server's point of view — back it up with your usual file backups.

## Updating

```bash
git pull
npm install
npm run build
# restart the service
```

The Rust binary picks up format changes automatically on next startup. The `data/` files use forward-compatible JSON.
