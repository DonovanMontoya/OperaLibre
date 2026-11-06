# OperaLibre owner relay contract

This directory documents the owner-deployed signaling boundary. It is not a
deployed service and contains no credentials.

The sender's OperaLibre server remains the content authority. A broker stores
only a short-lived room identifier, an authenticated offer/answer exchange,
and bounded ICE candidates; it never receives book bytes. The server signs a
room capability containing the invitation digest, expiry, recipient nonce,
maximum bytes, and selected asset IDs. The app rejects messages whose room,
nonce, expiry, or byte counter does not match that capability.

Cloudflare Realtime TURN is a relay fallback, not a free hard-cap: current
official documentation lists $0.05/GB of outbound TURN egress after a shared
1,000 GB monthly allowance, with per-allocation rate and bandwidth limits.
Workers/Durable Objects can provide signaling state, but a paid Workers plan
may be required for Durable Objects. Owners must create and control their own
Cloudflare account, domain, credentials, and billing controls.

Arbitrary owner domains cannot be assumed to open an installed native app.
Universal/App Links require app-owned association files and domain control.
The web landing page must preserve the invitation URL and offer an explicit
“Open in OperaLibre” action; deferred restoration after an app-store install
is not promised.

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
sending archive bytes. Initial transfers use offset zero; authenticated resume
is not implemented. Descriptions are limited to 4096 UTF-8 bytes by the proof
primitive, signal messages to 7168 bytes, and request bodies to 8192 bytes.
The broker is untrusted and enforces role, ordering, and size limits but does
not verify the peer cryptography. This remains gated and needs independent
security and native review before activation.

## Experimental broker claim rotation

The Worker remains disabled unless explicitly enabled; this is a broker-only
prototype, not a completed transfer resume implementation. After a successful
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
their sequences. There is no implemented generation-discovery protocol. Each role is
limited to 16 rotations per room; nonce records require eventual room cleanup.

The response contains no replacement secret. If a success response is lost,
the caller must retain both capabilities: `POST /session/{room}` with a claimed,
unexpired capability returns the current generation, while a prior or revoked
claim receives 403. This is a point-in-time observation; every subsequent signal
still checks the generation transactionally. No sender or recipient currently
performs this exchange, persists
claims, negotiates a new connection, or resumes from a verified transfer offset.
This mechanism needs independent security and native review before use.

## Isolated successor mailbox experiment

`src/successor-mailbox.ts` is a test-only state machine, with no Worker route,
configuration switch, or production activation. Its protocol is separate from
the legacy claim and resume endpoints above. It is not safe to combine them:
the legacy claim does not atomically bind a recovery secret, and legacy resume
accepts the old signed claim and a successor without that secret. Merely adding
mailbox routes would therefore leave a bypass. Existing links cannot be migrated
after claim without an authenticated channel to establish a new secret.

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
