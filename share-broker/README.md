# OperaLibre owner relay contract

This directory documents the owner-deployed signaling boundary. It is not a
deployed service and contains no credentials.

The sender's OperaLibre server remains the content authority. The experimental
broker stores room membership, bounded signaling and an encrypted preview; it
never receives book bytes. The owner-authenticated broker issues room/role/nonce/
expiry capabilities. Separately, the server signs the selected archive size,
digest, asset inventory and gift metadata in the encrypted preview. The recipient
pins that signing key from the private gift-link fragment and authenticates the
peer exchange against the preview. These are separate trust boundaries, not a
single capability that the broker can rewrite to authorize arbitrary assets.

Cloudflare Realtime TURN is a relay fallback, not a free hard-cap: current
official documentation lists $0.05/GB of outbound TURN egress after a shared
1,000 GB monthly allowance, with per-allocation rate and bandwidth limits.
[SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
are available on Workers Free, currently with 100,000 requests and 13,000 GB-s
duration per day; exceeding free limits causes errors. The checked-in migration
uses SQLite. [TURN pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
is separate: a Workers Free broker does not impose a TURN spending limit. The
prototype has no enforceable relay billing cap or configured TURN credentials.
Owners must control their own account, domain, credentials and billing choices.
Recheck provider terms and limits before setup; none of these allowances is an
OperaLibre guarantee of free operation.

[Cloudflare's TURN documentation](https://developers.cloudflare.com/realtime/turn/)
describes per-allocation data-rate limits around 50–100 Mbps, with packet drops
above limits, not a guaranteed throughput. Its [FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
includes data-channel use and recommends handling allocation disruption. This
does not establish a contractual large-file SLA or a verified OperaLibre relay.
The current broker caps a session at 15 minutes: the 25 GiB archive safety ceiling
is not a promise that an archive that large can finish before expiry. Credential
renewal, longer-transfer expiry policy and live relay testing remain unresolved.

Arbitrary owner domains cannot be assumed to open an installed native app.
Universal/App Links require app-owned association files and domain control.
The web landing page must preserve the invitation URL and offer an explicit
“Open in OperaLibre” action; deferred restoration after an app-store install
is not promised.

The experimental explicit action uses `operalibre://gift#…`, not verified HTTPS
Universal/App Links. Custom schemes do not establish exclusive app ownership:
another installed application can register the same scheme and receive the
gift capability and fragment keys. The landing page warns recipients to use a
trusted installation and cancel an unexpected app/chooser. Do not treat this
action as a domain-verified or interception-resistant delivery mechanism. The
production gift gate remains closed pending platform and security review.
See Apple's [custom-scheme ownership warning](https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app)
and Android's [deep-link hijacking guidance](https://developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks).

The transfer protocol must prefer direct WebRTC data channels, fall back to
owner-configured TURN, resume by verified chunk offset, and verify each asset
SHA-256 before local import. If relay quota or provider configuration is
missing, the recipient receives a clear failure and no partial library entry.

## Experimental initial peer authentication

After claiming its role, the recipient sends sequence 1 `ready`, with message
`{"challenge":"..."}` containing a fresh 32-byte canonical unpadded base64url
challenge. The producer sends sequence 1 `offer` containing a JSON signed
envelope over its complete gathered description and the trusted gift, room,
expiry, archive digest and size, generation, zero offset, empty-prefix SHA-256,
and challenge. The recipient verifies the envelope against the link signing key
and its authenticated preview before applying the offer.

The recipient sends sequence 2 `answer` containing
`{"descriptionJson":"...","proof":"..."}`. `descriptionJson` is the exact
`JSON.stringify(connection.localDescription)` string; `proof` is the canonical
unpadded base64url HMAC from the peer proof protocol, binding that exact string,
the exact signed offer description, archive fields, generation, and challenge.
The sender verifies the proof before parsing or applying the answer and before
sending archive bytes. Initial transfers use offset zero. A resumed generation
includes the locked native staging offset and its SHA-256 prefix in `ready`;
the sender checks the prefix against the original archive before signing the
same binding into its offer. Descriptions are limited to 4096 UTF-8 bytes by the proof
primitive, signal messages to 7168 bytes, and request bodies to 8192 bytes.
The broker is untrusted and enforces role, ordering, and size limits but does
not verify the peer cryptography. This remains gated and needs independent
security and native review before activation.

Authenticated archive frames use an application persistence window in addition
to SCTP backpressure: at most eight 16 KiB chunks await acknowledgement. After
each native append completes, the recipient sends `{"type":"persisted",
"offset":16384}` with the exact next archive offset. The sender requires these
offsets in order, drains the window before its final marker, and fails closed
on invalid messages, cancellation or expiry. After complete archive SHA-256
verification, the recipient sends the separate `verified` receipt and waits for
the sender's matching `receipt-confirmed` before permitting import. These
acknowledgements are not evidence of offline-reader or device testing.

## Experimental broker claim rotation

The Worker remains disabled unless explicitly enabled. Legacy test peers use
owner-delivered capabilities: after a successful
`POST /claim/{room}`, the owner may issue a successor using the existing
authenticated `POST /issue` endpoint. It must have the same room, role, and
expiry as the current claim, a fresh, unpredictable nonce, and `previousNonce`
equal to the current nonce. Treat both signed
claims as bearer secrets and deliver the successor securely to that same peer.

The peer sends `POST /resume/{room}` with the current `payload` and `signature`
and the successor as `nextPayload` and `nextSignature`, plus the current
`generation`. A successful 204 returns `x-signaling-generation` and
atomically replaces the current role membership; the old claim and every
previously used nonce for that role are rejected. Concurrent rotations have at
most one winner. Invalid, expired, replayed, cross-room or cross-role claims,
and revoked rooms receive 403. The original expiry cannot be extended. Room
revocation and rotation share the storage transaction boundary. Rotation clears
both signaling queues; peers must coordinate the new generation and restart
their sequences. Each role is
limited to 16 rotations per room; nonce records require eventual room cleanup.

The response contains no replacement secret. If a success response is lost,
the caller must retain both capabilities: `POST /session/{room}` with a claimed,
unexpired capability returns the current generation, while a prior or revoked
claim receives 403. This is a point-in-time observation; every subsequent signal
still checks the generation transactionally. The experimental recipient helper
persists both claims before rotation and probes the pending successor after an
ambiguous response. An opt-in recovery peer adapter authenticates gathered SDP,
receives bounded resumed frames, and acknowledges only after native full-archive
verification; it waits for a matching sender confirmation before import.

## Recipient-bound recovery

The opt-in persistent recipient adapter generates a separate 32-byte recovery
secret, durably stores it beside its original verified archive identity, then
calls `POST /recovery-claim/{room}` with the initial signed capability and
`recoverySecret`. One transaction enrolls membership and a digest of that secret.
An exact retry is idempotent; a different secret or a legacy-claimed recipient
cannot enroll. The original link can still be stolen and claimed first: it is
a bearer invitation, not a verified recipient identity.

After enrollment, recipient signaling, session lookup and preview reads require
both a signed capability and the independent secret, even before the first
rotation. The original gift URL contains no recovery secret. Over HTTPS,
`POST /recovery-successor/{room}` accepts the current member and secret and
returns one cached, broker-signed successor scoped to the same room, recipient
role and exact expiry. Retries return the same successor until rotation; they
cannot create new invitations or extend authority. `POST /resume/{room}` also
requires the secret and cached successor for enrolled recipients, so legacy
resume cannot bypass enrollment. Revoke and reservation cleanup clear this
recovery record. No owner credential is delivered to the recipient app.

The client persists the pending claim pair before rotation and reconciles lost
responses through authenticated session probes. Its first accepted transfer
uses this same path at generation one, consuming one of the sixteen rotation
slots. An optional opaque gift ID in the link lets a reopened app find its
private recovery state and retrieve the encrypted preview with the current or
pending member. That ID is a locator, not authorization. Opening the app without
the original link does not yet show a pending-gifts inbox.

Native staging acquire/append/verify/release methods hold an OS lock and use
plugin-owned random lease tokens and exact offsets; the application no longer
appends through the generic Filesystem plugin. Extraction holds the same staging
lock. After verified commit, incoming ZIP/recovery sidecars can be cleaned while
the published book remains recoverable from its committed directory. Stable lock
files are retained to avoid inode-replacement races. Native CAS uses separate
record locks and atomic rename. CI compiles the gated iOS simulator sources and
Android app; native device behavior remains unverified. Recipient records can
survive an app restart, but the sender's archive
and keys cannot yet survive a server restart, which ends that live transfer.
All application, import and broker production gates remain
disabled pending independent security and platform review.

## Experimental sender setup and selection

The test router now connects owner setup, an authorized scanned-book inventory,
selected-asset invitation creation and sender startup. The development UI has
separate disabled-by-default sender and recipient gates; setting up a broker
does not activate either. These routes are not available in production builds.

Owner configuration is held in the private server database and therefore also
in its backups. Responses expose configured markers, never the broker owner
secret or TURN REST shared secret. Credential submission requires `proxy`
deployment mode, a loopback proxy peer and its HTTPS forwarding declaration.
The app additionally requires direct HTTPS administration, not a development
proxy or plain Tailscale HTTP. Loading, editing and saving settings do not
contact the provider. Cleanup is an explicit owner action using the retained
configuration; pending room recovery prevents replacing or deleting it. Removing
local settings does not rotate provider credentials or cancel provider billing.
Reader gifting is off unless the owner explicitly permits it.

The sender selects server asset IDs, not paths, hashes, metadata or access
grants. Metadata is required; the lightweight default selects an available EPUB
and cover, never audio automatically. The inventory explains unavailable files
and dependencies and reports selected byte sizes; ZIP overhead changes the
actual transfer size shown to the recipient. Read-along alignment remains
disabled until native import, track timing and local sentence-follow agree.
Only share material you have permission to distribute; nothing removes DRM.
Retained invitations and heavy preparation are bounded, including cancellation
of the HTTP waiter. A private management token is returned only to the signed-in
sender for authenticated revocation and is not put in the recipient gift URL.

The implemented owner relay configuration is **coturn-compatible TURN REST**,
not the Cloudflare Realtime credential API. It derives independent, short-lived
sender and recipient credentials following the
[coturn credential format](https://github.com/coturn/coturn/blob/master/README.turnserver).
The master secret stays on the server. Static owner passwords cannot be copied
into recipient previews. Expiry limits credential lifetime, not transfer bytes,
allocation destinations, or billing. No account is enrolled or relay deployed.

The installed Rust gatherers currently support only UDP `stun:` and `turn:`
URLs. They skip secure and TCP variants; configuration rejects those variants
instead of accepting a relay that cannot work. Relay-only is explicit and
requires owner relay consent and a suitable TURN server. Local tests exercise
actual Rust peers with STUN candidates and authenticated relay-only UDP through
a disposable test TURN responder. They do not verify Internet NAT traversal,
coturn/Cloudflare deployment, TCP/443 fallback or mobile connectivity. Networks
that block outbound UDP remain unsupported by this transport.

Selected cover previews come from the verified selected archive, not an
additional library path or remote URL. Raster decoding and normalized thumbnails
have input, allocation, dimension and output bounds; the thumbnail belongs only
in the signed encrypted preview. Large/unsupported covers or a full preview
budget use the placeholder while retaining any selected full cover in the
archive. This is not a hard CPU-time sandbox.

## Development verification

### Optional owner-domain app associations

No stock app domain or signing identity is assumed. The disabled Worker can
serve public `/.well-known/apple-app-site-association` and
`/.well-known/assetlinks.json` declarations only after an owner explicitly sets
`GIFT_APP_ASSOCIATIONS` to bounded JSON with `origin`, `appleAppIds`,
`androidApps` (`packageName` and uppercase `sha256Fingerprints`), and
`matchingAppBuildAcknowledged: true`. Use the actual application-identifier
prefix/bundle identifier and actual installed release signing certificates,
not guessed IDs or debug fingerprints. The exact HTTPS origin must match the
served host; redirects, wildcard hosts and request-derived identities are not
used. Missing configuration returns 404, and the experimental gate stays closed
by default. No private gift data appears in either declaration.

This is only the website half of a two-way association. A matching owner-built
iOS app still needs an authorized Associated Domains entitlement for the exact
host. Android needs an `autoVerify` HTTPS intent filter restricted to `/gift`
and the exact host. Its website statement delegates the host, so the manifest's
path restriction matters on older Android releases. Both builds must set
`VITE_GIFT_ASSOCIATED_ORIGINS` to a JSON array of the same exact HTTPS origins
(at most four) to route received HTTPS gifts through the native pre-onboarding
boundary. This is a domain allowlist, not an API server origin. It is empty in
stock builds and does not enable gifts or modify native entitlements/manifests.
Do not set `VITE_API_BASE`.

See Apple's [two-way association guidance](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app)
and Android's [website association requirements](https://developer.android.com/training/app-links/configure-assetlinks).
Owners must control the domain, use a matching signed build and verify OS link
delivery on the intended devices. A setting or served JSON is not proof of
ownership, verification or deferred restoration after installing from a store.
No domain, entitlement, credential or application has been provisioned here.

From the repository root, `npm run test:broker` compiles and exercises the
actual Worker entrypoint with simulated transactional Durable Object storage.
`npm run test:book-gifts` starts its own disposable loopback Vite server and
tests preview, acceptance, private successor retrieval, interruption/recovery
and the pre-onboarding native launch boundary. These fixtures use real
WebCrypto but simulated peers and native storage. Their screenshots are written
under ignored `output/book-gifts/`; they contain fixture books only. Set
`OPERALIBRE_TEST_CHROMIUM` to an already installed supported Chromium executable
if Playwright's managed browser is unavailable.

Those commands intentionally do not claim real ICE coverage. The separate
`share-broker/test/webrtc.test.mjs` exercises browser peer connectivity; a browser
that gathers no ICE candidates fails that test. Local Rust peer tests provide
separate host-ICE evidence, not evidence for browser/mobile NAT traversal or TURN.

The macOS CI job also compiles the iOS simulator app with the explicit
`OPERALIBRE_EXPERIMENTAL_GIFTS` Swift define and code signing disabled. This checks
otherwise excluded Swift bridge sources, not device transfer, extraction,
background execution or OS link delivery. The app/web, broker and server gates
remain closed. Android's existing build compiles its gated native sources;
instrumentation still requires a suitable Android runtime. Neither check
publishes an application or verifies a working gift installation.

## Isolated successor mailbox experiment

`src/successor-mailbox.ts` is an older test-only state machine, with no Worker route,
configuration switch, or production activation. Its protocol is separate from
the legacy claim and resume endpoints above. It is not safe to combine them:
the legacy claim does not atomically bind a recovery secret, and legacy resume
accepts the old signed claim and a successor without that secret. Merely adding
mailbox routes would therefore leave a bypass. Existing links cannot be migrated
after claim without an authenticated channel to establish a new secret. The
recipient-bound routes above do not invoke this mailbox or its envelope scheme.

For a new, isolated protocol, the recipient generates 32 random bytes using a
CSPRNG and encodes them as canonical unpadded base64url. Over a confidential
channel it presents that secret with an owner-signed initial recipient claim.
After signature verification, `claimMailbox` atomically consumes the mailbox
membership and stores only SHA-256 of the secret, together with the room,
recipient nonce, exact expiry, and state. Claim lifetime is at most 900 seconds.
The initial bearer link can still be stolen and claimed first; it cannot read
the mailbox after a different recipient has claimed it without that recipient's
secret. A lost claim response requires the recipient to retain its secret; the
prototype does not provide a claim-status or recovery endpoint.

The authenticated owner publishes one opaque encrypted envelope after claim;
the nonce is 16 base64url characters and ciphertext is 22–10,924 base64url
characters. The primitive checks the original claim's room, recipient role,
nonce and expiry, and does not authenticate the owner, verify a signature,
encrypt, decrypt, or validate the successor inside the ciphertext. A future
caller must enforce those requirements and use authenticated encryption with
unique nonces and authenticated room, role, expiry and claim binding. Key
distribution is outside this prototype; the original shared link must not be
the sole encryption key or the sole authorization to retrieve a successor.
The recipient presents the original verified claim and recovery secret to
consume the envelope. The comparison uses a fixed-length digest, and consumption
is transactional, one time, and removes the stored envelope. A lost successful
read response cannot be retried; a later design needs an authenticated
acknowledgement/retry protocol before this is usable for reliable delivery.
Only one publication is permitted per initial claim, including after reading.
Revocation and expiry are checked in each transaction. State and tombstones
have no automatic reclamation. No secrets or envelopes are logged by this
module; any future transport and infrastructure must also avoid logging bodies,
credentials, or sensitive URLs and must enforce request-size and rate limits.

Activation additionally requires atomic integration with real claim and
revocation state, disabling all legacy paths for enrolled rooms, verified and
scoped successor issuance and rotation, recipient persistence and encrypted
delivery/key management, retry semantics, cleanup, threat review and client
support. The caller must use the same transactional room storage and `revoked`
key for this primitive and revocation. Its independent namespace does not
consume or protect a legacy `claim:recipient` membership.

## Experimental room reservation

With the existing experimental gate enabled, an owner authenticated with the
existing bearer credential can `POST /reserve/{room}` with JSON
`{"reservationId":"...","expiresAt":123}`. The experimental server derives
a 32-byte reservation ID from its owner credential, invitation digest and fresh
random room, then encodes it as unpadded base64url. The server persists the room
and expiry before sending the request, and derives the same ID for retry without
persisting the owner credential. Expiry is Unix
seconds, at most 15 minutes ahead. A 204 reserves the previously untouched room;
409 means unavailable or expired. Retrying the exact request after a lost
response returns 204 while live. A different secret or expiry cannot acquire it.

`POST /cleanup/{room}` uses the same owner authentication and exact JSON. A
204 atomically revokes the room and clears its preview and signaling queues;
an exact retry, including after expiry, also returns 204. Mismatches and prior independent
revocation return 403. Neither operation can reactivate a cleaned room. Both
are serialized with existing room transactions. The broker stores a digest of
the reservation secret and retains a permanent reservation/revocation tombstone;
room identifiers must never be reused. There is no automatic storage reclamation.

This is an additive ownership primitive: existing issue, preview, claim and
unconditional owner revoke routes remain compatible and do not require a
reservation. The global owner credential is shared; the reservation secret
distinguishes individual reservations, not separate broker administrators.
An issued but unused legacy claim leaves no room state and cannot be detected
by reservation. Callers must use unpredictable room IDs, reserve before issuing
claims or writing previews, protect the reservation secret, and coordinate all
legacy owner operations. Cleanup requires an explicit owner retry; expired
records remain on the server until cleanup is confirmed. This prototype does
not provide deployment or automatic expiration cleanup.
