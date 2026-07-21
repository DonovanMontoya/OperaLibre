## Which file should I download?

- **Most people:** download a `combined` package for your computer. It includes the server and web app, starts in the background, and opens in your browser without leaving a Terminal window open.
- **Server only:** download a `server` package when the frontend will be hosted separately or you are using another client.
- **Frontend only:** download the file ending in `frontend.zip` when you already have an OperaLibre or Jellyfin server and want to deploy only the static web app.
- **Update packages:** files containing `update` are downloaded and verified automatically by compatible combined installations; you normally do not need to download them yourself.

Choose `windows-x64` for a 64-bit Windows PC, `linux-x64` for a typical Intel/AMD Linux server, `linux-arm64` for a 64-bit ARM Linux server or Raspberry Pi, `macos-arm64` for an Apple Silicon Mac, or `macos-x64` for an Intel Mac.

Every user-facing installation package contains a `START-HERE.txt` file. The `SHA256SUMS.txt` attachment can be used to verify downloaded files.

Administrators are notified in the app when a newer release is available. On launcher-managed combined installations, an owner can install the matching verified package from **Administration**; custom deployments use the release link for a manual update.

New users can follow the full [release installation guide](https://donovanmontoya.github.io/OperaLibre/installing-a-release.html) for first launch, adding books, phone access, backups, and updates.
