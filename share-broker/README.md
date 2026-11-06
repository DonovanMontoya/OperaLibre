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

## Experimental broker claim rotation

The Worker remains disabled unless explicitly enabled; this is a broker-only
prototype, not a completed transfer resume implementation. After a successful
`POST /claim/{room}`, the owner may issue a successor using the existing
authenticated `POST /issue` endpoint. It must have the same room, role, and
expiry as the current claim and a fresh, unpredictable nonce. Treat both signed
claims as bearer secrets and deliver the successor securely to that same peer.

The peer sends `POST /resume/{room}` with the current `payload` and `signature`
and the successor as `nextPayload` and `nextSignature`. A successful 204
atomically replaces the current role membership; the old claim and every
previously used nonce for that role are rejected. Concurrent rotations have at
most one winner. Invalid, expired, replayed, cross-room or cross-role claims,
and revoked rooms receive 403. The original expiry cannot be extended. Room
revocation and rotation share the storage transaction boundary. Signaling
queues are retained, including their sequence numbers and quotas. Each role is
limited to 16 rotations per room; nonce records require eventual room cleanup.

The response contains no replacement secret. If a success response is lost,
the caller cannot safely distinguish it from failure using the old claim alone;
the peer must retain the successor and check its membership through an existing
operation. No sender or recipient currently performs this exchange, persists
claims, negotiates a new connection, or resumes from a verified transfer offset.
This mechanism needs independent security and native review before use.

## Experimental room reservation

With the existing experimental gate enabled, an owner authenticated with the
existing bearer credential can `POST /reserve/{room}` with JSON
`{"reservationId":"...","expiresAt":123}`. Generate a fresh 32-byte
cryptographically random secret, encode it as unpadded base64url (43 characters),
and retain it with the room and expiry before sending the request. Expiry is Unix
seconds, at most 15 minutes ahead. A 204 reserves the previously untouched room;
409 means unavailable or expired. Retrying the exact request after a lost
response returns 204 while live. A different secret or expiry cannot acquire it.

`POST /cleanup/{room}` uses the same owner authentication and exact JSON. A
204 atomically revokes the room and clears its preview and signaling queues;
an exact live retry also returns 204. Mismatches, expiry, and prior independent
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
legacy owner operations. Expired reservations cannot be cleaned with this API;
the existing owner revoke route remains available. This prototype does not
provide server integration, deployment, or automatic expiration cleanup.
