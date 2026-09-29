# Sticky call memberships (#504)

Crust receives both legacy `org.matrix.msc3401.call.member` state events and
MSC4354 `org.matrix.msc4143.rtc.member` sticky events through matrix-js-sdk
42.3. The SDK already handles ingestion, hashed `rtcBackendIdentity`, keyed
replacement, expiry, and session notifications. There is no separate
`rtcMembershipIngest.ts` implementation to extend; the similarly named test
file checks the SDK contract.

The room summary now reads the SDK sticky store as well as legacy state. It
uses the SDK membership parser, respects the default room slot and sticky
leave tombstones, and listens for sticky arrivals, replacements, and expiry.
Sticky TTLs are measured on the local clock; legacy expiry still uses the
server-time correction. This keeps the sidebar and call button aware of a
call containing only Matrix 2.0 peers.

## Current deployment (2026-09-29 UTC)

strange.pizza now runs **26.9.1 (046074b)** from
`forgejo.ellis.link/continuwuation/continuwuity:v26.9.1`. Both the public
federation version endpoint and the running container confirm this version.

The [release's Ruma pin](https://github.com/continuwuity/continuwuity/blob/v26.9.1/Cargo.toml)
is `e7384f01eacd454c593683de50491201e2160fd1`, which includes
[the sticky-duration query decoder fix](https://github.com/ruma/ruma/commit/a498f4af40f261fe549eac6549b85092bb6141e0).
Its `StickyDurationMs` decoder uses `deserialize_u32`, so the known 26.8.1
query-string parsing blocker is fixed in the deployed source. This source
verification does not replace an authenticated sticky-send test.

Enabled `allow_sticky_events = true` in the `[global]` section of
`/root/continuwuity-new/conduwuit.toml`, validated Compose, and restarted only
the `homeserver` service. Startup completed and the public
`/_matrix/client/versions` endpoint now advertises `org.matrix.msc4354: true`.
The configuration backup is
`/root/continuwuity-new/conduwuit.toml.bak-sticky-504-20260929T150512Z`.
To revert only this change, set `allow_sticky_events = false` in the current
`[global]` section, validate Compose, and restart the same service. Verify the
server is healthy and no longer advertises MSC4354. Keep other configuration
edits intact; the backup is a comparison reference, not a replacement for a
configuration that may have changed since enablement.

## Earlier investigation (2026-09-07 UTC)

At that time strange.pizza ran **26.8.1 (ab3c05d)**, with sticky events
disabled and no MSC4354 advertisement.

[The 26.8.1 release](https://forgejo.ellis.link/continuwuation/continuwuity/releases/tag/v26.8.1)
includes MSC4354 and MSC4480 behind `allow_sticky_events`, defaulting
to false. However, enabling that flag alone was insufficient: the live probe
returned HTTP 400 `M_BAD_JSON` for the standard query parameter
`org.matrix.msc4354.sticky_duration_ms=60000`, because its pinned Ruma decoder
rejected the query-string value as a string. The flag was reverted after
that probe. A release including the decoder fix was required.

The 26.8.1 source establishes the distinction:

- [PDU representation](https://forgejo.ellis.link/continuwuation/continuwuity/src/tag/v26.8.1/src/core/matrix/pdu.rs)
  retains the signed top-level `msc4354_sticky` object. An incoming federated
  sticky event can remain a readable timeline event; the absence of a feature
  flag does not establish that it is dropped.
- [Classic sync](https://forgejo.ellis.link/continuwuation/continuwuity/src/tag/v26.8.1/src/api/client/sync/v3/joined.rs)
  returns an empty sticky catch-up section when the option is disabled.
  Enabling it supplies unexpired sticky events missing from the timeline,
  including initial joins and limited syncs.
- [Local sends](https://forgejo.ellis.link/continuwuation/continuwuity/src/tag/v26.8.1/src/api/client/send.rs)
  ignore requested sticky duration when the option is disabled.

These are source-level findings, not a completed federated wire capture.
The failed local-send probe did not establish that inbound federated sticky
events were dropped.

## Remaining live acceptance

1. In a private scratch room, check sticky metadata on a fetched event and
   verify a limited/initial sync includes the membership in its sticky section.
2. Join from an Element matrix.org account in Matrix 2.0 mode and Crust.
   Capture the federated membership delivered to Crust; verify the real
   participant name, mute state, and bidirectional audio. Verify encryption
   on the wire, rather than inferring it from UI or mocked tests.

Issue #504 stays open until the live acceptance is complete. Crust's own
membership publishing and JWT identity migration remain tracked by #505;
`unstableSendStickyEvents` stays false for our own sessions.
