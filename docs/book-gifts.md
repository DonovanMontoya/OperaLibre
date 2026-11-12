---
title: Book Gifts
nav_order: 9
---

# Book gifts (experimental)

A book gift sends one book from your server to one person as a private link. They open the link in the OperaLibre app on their phone, unwrap it, read your note, and accept. The book is then saved on their phone and works with no account and no server of their own.

The book travels directly from your server to their phone. Your server makes only outgoing connections, so it does not need a port forwarded or a public address. Book gifts are off until the owner turns them on.

Book gifts are experimental. They have been tested from a Linux server to the iPhone app in the simulator, over a home network and Tailscale. They have not yet been tested on a physical phone, on Android, or between two separate home networks. Expect rough edges and report what you find.

## What you need

| Piece | What it does | Cost |
| --- | --- | --- |
| An OperaLibre server on Linux or macOS | Sends the book. Windows servers cannot send gifts yet. | |
| HTTPS in front of the server | Needed while you set gifts up. Tailscale Serve, Cloudflare Tunnel, or Caddy all work. | Free options exist |
| A Cloudflare account | Runs the gift broker, which introduces your server and the recipient's phone to each other. OperaLibre installs the broker for you. | Free plan is enough for personal use |
| A STUN server | Tells each side its public address so they can connect directly. | Free (Cloudflare and others run public ones) |
| A TURN relay (optional) | Carries the book when a direct connection is impossible. | You host or pay for it |
| The OperaLibre app on the recipient's phone | Receives and stores the book. A browser cannot receive a gift. | |

### How the pieces fit

1. You choose a book and create a gift. Your server reserves a private room on your broker and stores an encrypted preview there (title, cover thumbnail, your note). The keys to that preview exist only inside the gift link.
2. The recipient opens the link. Their app reads and decrypts the preview from the broker. Nothing else is downloaded yet.
3. When they accept, the app and your server exchange connection details through the broker and open a direct, encrypted WebRTC connection. Each side reaches out from behind its own router, which is why no port forwarding is needed.
4. The book is sent in pieces over that connection, checked against a signed checksum, and saved on the phone.

The broker never receives the book. It sees the encrypted preview, connection details, and the network addresses of the server and the phone. The recipient's phone learns your server's public address, as with any direct connection. To hide it, use a TURN relay and turn on **Always use the relay**.

## 1. Put HTTPS in front of the server

Gift setup handles secrets, so the server accepts it only with `deployment_mode = proxy` in `server.config` and an HTTPS reverse proxy on the same machine. This keeps the secrets from ever crossing the network in plain text. None of these options needs a forwarded port:

- **Tailscale Serve:** `tailscale serve --bg --https=443 http://127.0.0.1:4920` gives the server an HTTPS address inside your tailnet.
- **Cloudflare Tunnel:** `cloudflared` gives it a public HTTPS address through an outgoing tunnel.
- **Caddy or another reverse proxy** on the same machine, if you already have a domain.

See [Deployment](deployment.md) and [Configuration](configuration.md#reference) for the server side of each. If your server already runs this way, there is nothing to change.

Gifts themselves do not travel through this proxy. It is only for you, when you open OperaLibre to manage the server.

## 2. Turn gifts on

1. Open OperaLibre in a browser at its HTTPS address and sign in as the owner. The phone apps cannot change these settings.
2. Go to **Administration → Experiments → Book gifts** and choose **Enable**.

## 3. Set up the broker

The broker is a small Cloudflare Worker that runs in your own Cloudflare account; there is no shared one. OperaLibre installs it for you:

1. Under **Set up with Cloudflare**, choose **Create a Cloudflare token**. Sign in to Cloudflare, or make a free account. The page that opens is already filled in with the one permission needed, editing Workers. Choose **Continue to summary**, then **Create Token**.
2. Copy the token, paste it into **Cloudflare API token**, and choose **Set up gifts**.

Your server contacts Cloudflare once, installs the broker, creates its secrets, and saves a STUN server (`stun:stun.cloudflare.com:3478`). The token is used for that one installation and is not stored; you can delete it in Cloudflare afterwards. A brand new broker can take a minute to start answering.

If the token works for more than one Cloudflare account, open **More than one Cloudflare account?** and enter the Account ID of the one to use.

After a server update that changes gifts, open **Update or reinstall the broker** and paste a token again. This also replaces the broker's secrets, so links you have already sent stop working.

The Workers free plan allows about 100,000 requests a day, far more than personal gifting uses. Check [Cloudflare's current limits](https://developers.cloudflare.com/workers/platform/limits/) before relying on that; when a free limit is reached, gifts fail until the next day.

Optional settings, once the broker is set up:

- **Let readers send gifts too.** Off by default, so only the owner can send. Readers can only gift books they can already open.
- **Server restarts.** A waiting gift normally stops working if the server restarts before it is opened. **Keep waiting gifts across restarts** stores each waiting gift in the server's data folder until it is received or expires.
- **Connection servers.** Change the STUN server or add a TURN relay. See [When the two sides cannot connect](#when-the-two-sides-cannot-connect).

### Deploying the broker yourself

If you would rather not give your server a Cloudflare token, deploy the broker from the `share-broker` folder of the OperaLibre source. You need Node.js 22 or newer:

```bash
git clone https://github.com/DonovanMontoya/OperaLibre.git
cd OperaLibre/share-broker
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints the broker's address, such as `https://operalibre-share-broker.your-name.workers.dev`. Next, create two secrets. The first is the owner secret your server uses to prove it may create gifts. The broker stores only its SHA-256 digest:

```bash
# The owner secret. Save this; you will paste it into OperaLibre.
openssl rand -hex 32

# Its digest. Paste the 64-character result when wrangler asks.
printf '%s' 'PASTE-THE-OWNER-SECRET-HERE' | shasum -a 256
npx wrangler secret put OWNER_SECRET_DIGEST_HEX

# A second random value, used only inside the broker. You never need it again.
openssl rand -hex 32
npx wrangler secret put SIGNING_SECRET
```

On Linux, use `sha256sum` in place of `shasum -a 256`.

Then, in OperaLibre, open **Use a broker you deployed yourself**. Enter the **Broker address** and the **Broker owner secret**. Open **Connection servers**, tick **Replace the connection servers**, and enter a STUN server such as `stun:stun.cloudflare.com:3478`. Tick **I run this broker and accept its costs**, then **Save gift setup**.

Either way, you can check the broker by opening `https://your-broker-address/gift` in a browser. A page titled "Someone sent you a book" saying the link is incomplete means it is running.

## 4. Send a gift

1. Open a book's page and choose **Share gift**.
2. Choose what to include. The ebook and cover are selected by default; add the audiobook or read-along timing if you want. The sheet shows the size.
3. Add a personal message if you like, choose how long the link works (5 or 15 minutes), and choose **Create gift link**.
4. Copy the link and send it privately. Anyone who has the link can claim the gift, and it can be claimed once.

Keep the server running until the gift arrives. **Revoke gift** in the same sheet cancels a link that has not been used. A copy someone has already accepted cannot be taken back.

## 5. Receive a gift

1. Install the OperaLibre app on the phone. Gifts need a build that includes them: a recent nightly or TestFlight build.
2. Open the gift link. The page that appears offers **Open in OperaLibre**.
3. The first time, the app says book gifts are turned off on this device and offers **Turn on gifts and open**. To turn receiving off again, use **Settings → Receive book gifts**.
4. Tap the parcel to unwrap it, read the note, and choose **Accept book**. Nothing is downloaded before that.

The book appears on the shelf as a book on this device.

## When the two sides cannot connect

A direct connection works in most homes, but not all. It usually fails when both sides sit behind strict networks, for example a phone on some mobile carriers and a server behind carrier-grade NAT, or a network that blocks UDP. The recipient then sees "This gift is unavailable right now."

Things to try, in order:

1. Ask the recipient to switch between Wi-Fi and mobile data and open the link again.
2. Check that a STUN server is saved under **Connection servers**.
3. Add a TURN relay. OperaLibre supports [coturn](https://github.com/coturn/coturn) with a shared secret (`use-auth-secret` and `static-auth-secret`), over UDP. Enter it as `turn:relay.example.com:3478?transport=udp`, enter the shared secret, and tick **Allow the TURN relay**. A relay must itself be reachable from the internet, so it needs a public host such as a small cloud server. Relayed gifts use that host's bandwidth.

Cloudflare's hosted TURN service is not supported yet, and neither are TCP or TLS relays.

## Limits

- A gift link works for at most 15 minutes and can be claimed once.
- A gift can be up to `max_book_download_gib` in size and never more than 25 GiB, but it must finish before the link expires, so very large audiobooks may not make it on a slow connection.
- Waiting gifts share the server's `max_concurrent_book_downloads` slots. With the default of `1`, one gift can wait at a time, and offline downloads wait while it does. Raise the setting if that gets in the way.
- Gift links open the app with an `operalibre://` link. Another app on the phone could register the same kind of link, so recipients should cancel if anything other than OperaLibre offers to open it.
- Nothing removes copy protection, and protected files the server recognizes are left out. Only share books you have the right to share.

## Turning it off

**Administration → Experiments → Book gifts → Disable** stops gifts at once: transfers in progress end, and links already sent stop working until it is turned back on. Your broker settings are kept. To remove them from the server, open **Maintenance** and choose **Remove gift setup**. To stop the broker itself, delete the `operalibre-share-broker` Worker under **Workers & Pages** in the Cloudflare dashboard.

The broker secrets are stored in the server's database and therefore in its backups. If a backup is exposed, use **Update or reinstall the broker** to give the broker new secrets.
