# MatrixRTC membership and JWT migration (#505)

Verified against matrix-js-sdk 44.0.0 and the upstream state on October 14, 2026:

- [lk-jwt-service v0.8.0](https://github.com/element-hq/lk-jwt-service/releases/tag/v0.8.0)
- [Service request schemas](https://github.com/element-hq/lk-jwt-service/blob/0e176b1eca44e67b11484d0bdf56999807bf2b8e/src/requests.rs)
- [Service identity derivation](https://github.com/element-hq/lk-jwt-service/blob/0e176b1eca44e67b11484d0bdf56999807bf2b8e/src/helper.rs)
- [SDK 44 membership identities](https://github.com/matrix-org/matrix-js-sdk/blob/v44.0.0/src/matrixrtc/CallMembership.ts)
- [Element Call authentication](https://github.com/element-hq/element-call/tree/4b73ce68e36dffb530eb7aa73f5e5976efebb140/sdk/src/media-backend/livekit/auth)

## Ownership and protocol selection

The RTC hook chooses and publishes one transport per join. It creates the local
member ID before starting the SDK's membership and encryption managers, and
shares that identity with primary and foreign media connections. A modern join
uses a new UUID, sticky events, and the current two-component SDK identity hash.
Current publishers use a URL advertised by their own homeserver so remote token
requests can be routed using the membership sender. The selected transport remains
fixed until leave/rejoin; another peer's transport
change must not silently move our publisher away from its advertised transport.

Modern publishing requires an advertised WebSocket URL and MSC4354 support.
Service-only deployments keep legacy state memberships and user:device identities.
Transitional transports advertise both URL and service URL, allowing SDK 44 to
bind the same media key to both identities. URL-only transports never invent an
OpenID fallback. Internal normalized transports use an empty service string for
URL-only inputs; publishedTransport removes it before the SDK sees the wire data.

The call button considers both permission forms, and join rechecks the permission
for the selected form. Sticky memberships require ordinary event permission;
legacy memberships require state-event permission. Both require room membership.
SDK 44's removal of oldest-membership election is adapted in rtcProtocol so older
peers' unused offers are not mistaken for their publishing SFU.

## Authentication boundaries

| Connection | Preferred request | Fallback |
| --- | --- | --- |
| Current publisher or subscriber with URL | Authenticated homeserver /rtc/livekit/get_token with flat member_id, room_id, slot_id, url, and remote server_name when needed | Only an explicitly unsupported Matrix endpoint permits an advertised service fallback |
| Legacy publisher | Standalone /sfu/get with room, openid_token, device_id | None |
| Standalone foreign subscriber | /get_token with room_id, slot_id, openid_token, and nested member | /sfu/get on 404 or 405 |

The flat member_id change applies to the proxied C-S/S-S APIs. The deprecated
standalone /get_token still takes nested member and produces the old three-part
hash. It is used only for receive-only foreign connections, never for publishing
under a current membership. SDK 44's C-S convenience method still types the older
body, so fetchLivekitToken owns the narrow flat-body adaptation through the SDK's
authenticated HTTP API. Matrix access tokens stay at the homeserver; only OpenID
tokens go to advertised standalone services. Cancellation, authentication errors,
malformed responses, and transient failures do not trigger an endpoint downgrade.

A failed foreign connection retains the existing per-origin failure and retry
surface. Primary and foreign connection owners retain their stale-attempt and
resource cleanup checks. The successful publisher route supplies the identity
used when replaying its latest encryption key into a fresh LiveKit binding.

## SDK upgrade

SDK 44 supplies transport-dependent backendIdentities and the matching encryption
key events. Peer resolution consumes every identity rather than its deprecated
single rtcBackendIdentity. Deprecated standalone subscriber hashes are resolved
only for participant display, never added to encryption-key bindings. The roster
keeps the advertised publisher identity even for camera-only calls. The crypto runtime is kept in lockstep with the SDK.
OAuth login passes redirect URI to each grant operation; refresh uses oauthClientId
and onTokenRefresh, with the existing account-identity and storage-lock protections.

## Validation boundaries

The browser Join regression uses Chromium, a real MatrixRTCSession, serialized
membership events, simulated sync delivery, real SDK media-key generation, and a
mocked token response. It checks the member ID and both key identities across the
membership/JWT boundary. It does not connect to a live Matrix server or LiveKit SFU,
exchange media with Element Call, or prove live media decryption.

Unit regressions cover current request bodies, fallback order and failure rules,
alias-less and URL-only transports, legacy election, mixed membership identities,
permissions, foreign-SFU isolation, and actual SDK OAuth refresh with mocked HTTP.
Live interoperability still needs a two-client encrypted call using current RTC,
legacy compatibility, and foreign-SFU deployments, including camera/screenshare,
leave/rejoin, and endpoint fallback. Older experimental Matrix 2.0 clients using
the superseded three-part publisher hash are not established as interoperable by
these tests.
