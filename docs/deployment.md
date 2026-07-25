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

The web bundle is plain static files — `index.html`, JS, CSS, the PWA manifest, assets, and a `VERSION.txt` marker. It can be served by the Rust server, a reverse proxy, or any static host that points API calls back at the server.

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

When the Rust server serves this versioned `web/` directory directly, an owner can install verified frontend-only updates from Administration without restarting the server. OperaLibre saves the prior bundle under `data/update-backups`. Frontends deployed to a separate static host must still be updated through that host.

Start with:

```bash
OPERALIBRE_SERVER_CONFIG=/opt/operalibre/server.config \
  /opt/operalibre/operalibre-server
```

In `/opt/operalibre/server.config`, point the server at the copied web bundle:

```config
deployment_mode = local
host =
web_dist_dir = web
```

Then open `http://localhost:4000` on the server itself. For another device on a trusted LAN or VPN, select `deployment_mode = lan`; for public access, select `deployment_mode = proxy` and use the TLS reverse proxy below. Leaving `host` blank lets the profile choose the correct interface.

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
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/opt/operalibre

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin operalibre
sudo chown -R operalibre:operalibre /opt/operalibre
sudo chmod 700 /opt/operalibre/data
sudo chmod 600 /opt/operalibre/server.config
sudo systemctl daemon-reload
sudo systemctl enable --now operalibre.service
sudo journalctl -u operalibre -f
```

The checked-in `operalibre.service` applies the same hardening to the repository's `/srv/OperaLibre` layout. Adjust `WorkingDirectory`, `ExecStart`, `ReadWritePaths`, and the config path together if your installation lives elsewhere. Optional Libation files must be placed somewhere readable by the dedicated account; do not grant the service access to a personal home directory.

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

The checked-in `operalibre-nginx.conf` is the production template. It includes HTTP-to-HTTPS redirection, TLS-only public service, login throttling, connection and body limits, query-string-safe access logs, security headers, long media timeouts, and a larger request allowance only for the authenticated uploader. Replace `books.example.com` and its certificate paths, then test the nginx configuration before reloading it.

The template's uploader ceiling is `20g`, matching the default `max_upload_gib = 20`. If you change one, change the other. ZIP download limits and concurrency are enforced by the Rust server through `max_book_download_gib` and `max_concurrent_book_downloads`.

Use this server profile behind the proxy:

```config
deployment_mode = proxy
host =
```

```nginx
# Defined in nginx's http context. Do not log $request_uri: media tokens
# are query parameters.
limit_req_zone $binary_remote_addr zone=operalibre_login:10m rate=10r/m;
log_format operalibre '$remote_addr [$time_local] '
                     '"$request_method $uri $server_protocol" $status $body_bytes_sent';

server {
  listen 80;
  server_name books.example.com;
  return 308 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name books.example.com;

  ssl_certificate     /etc/letsencrypt/live/books.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/books.example.com/privkey.pem;

  access_log /var/log/nginx/operalibre-access.log operalibre;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

  location = /api/auth/login {
    limit_req zone=operalibre_login burst=5 nodelay;
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /api/ {
    client_max_body_size 2m;
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Range $http_range;
    proxy_buffering off;
  }
}
```

Two notes when fronting with a proxy:

1. **Keep range requests intact.** The `Range` header and `206 Partial Content` responses are what makes seeking through a multi-hour `.m4b` snappy. Cloudflare and similar services often handle this for you; some proxies need explicit configuration.
2. **Disable response buffering for streams.** Long audio reads should not be buffered into memory before being sent to the client.

Proxy-mode first-run setup always asks for the single-use token printed in the server console or protected server log; it expires after 30 minutes. Requiring it even for apparently local requests protects the owner account if a proxy omits forwarded client-address headers. Never expose or port-forward port `4000`; only ports `80` and `443` should reach nginx, with port `80` used solely for the HTTPS redirect.

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

Back up `data_dir` (default `./data/`). That covers user accounts, per-reader progress, and the durable identity map that keeps books connected to their history when library folders are moved or renamed. Back up `library_root` with your usual file backups as well; administrators can add new library folders through the web uploader.

## Updating

```bash
git pull
npm install
npm run build
# restart the service
```

The Rust binary picks up format changes automatically on next startup. The `data/` files use forward-compatible JSON.
