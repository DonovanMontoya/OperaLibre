## Downloads

### The easy way (macOS and Linux)

One command downloads the right package for your computer, verifies its SHA-256 digest, walks you through setup, and starts the server — and updates an existing installation in place when run again:

```
curl -fsSL https://raw.githubusercontent.com/DonovanMontoya/OperaLibre/main/script/install.sh | sh
```

Add `| sh -s -- --help` to see its options, including `--server-only` for headless machines.

### Which file should I download?

- **Most people:** download the `combined` package for your computer. It includes the server and web app, starts in the background, and opens in your browser without leaving a Terminal window open.
- **Server only:** use the same `combined` package and set `web_dist_dir =` (blank) in its `server.config`, then start it with `start.sh` or `start.cmd`. The installer's `--server-only` option does this for you.
- **Frontend only:** download the file ending in `frontend.zip` when you already have an OperaLibre or Jellyfin server and want to deploy only the static web app.
- **Android:** the file ending in `android-unsigned.apk` is an unsigned release build for developers or distributors to sign before installation.
- **Update manifest:** `operalibre-manifest-v1.json` is what installations read to update themselves; you do not need to download it.
- **Read-along sync add-on:** the optional sync add-on is published in its own `readalong-sync-v…` release, only when it changes. Install it from **Administration**; you do not need to download it yourself.
- **Deployment profiles:** new installs start in `local` mode. Choose `lan` for a trusted LAN/VPN or `proxy` behind same-machine HTTPS; remote first-run setup uses a one-time server token.
- **Transfer limits:** uploads, generated ZIP downloads, and simultaneous ZIP generation now have configurable server-side limits. Existing configs automatically receive safe defaults.

Choose `windows-x64` for a 64-bit Windows PC, `linux-x64` for a typical Intel/AMD Linux server, `linux-arm64` for a 64-bit ARM Linux server or Raspberry Pi, `macos-arm64` for an Apple Silicon Mac, or `macos-x64` for an Intel Mac.

Every user-facing installation package contains a `START-HERE.txt` file. The `SHA256SUMS.txt` attachment can be used to verify downloaded files.

Administrators are notified in the app when a newer release is available. On combined and server-only release installations, an owner can install the matching verified package from **Administration** — server-only installations update just the server and leave a custom frontend untouched; other custom deployments use the release link for a manual update.

New users can follow the full [release installation guide](https://donovanmontoya.github.io/OperaLibre/installing-a-release.html) for first launch, adding books, phone access, backups, and updates.
