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

## Homeserver investigation (2026-09-07 UTC)

The live strange.pizza server reports **26.8.1 (ab3c05d)**. Its container uses
`forgejo.ellis.link/continuwuation/continuwuity:v26.8.1`, and its current
configuration does not enable `allow_sticky_events`. The public client
versions response does not advertise `org.matrix.msc4354`.

[The 26.8.1 release](https://forgejo.ellis.link/continuwuation/continuwuity/releases/tag/v26.8.1)
already includes MSC4354 and MSC4480 behind `allow_sticky_events`, defaulting
to false. An image upgrade is unnecessary to enable this support.

The deployed release's source establishes the distinction:

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
The configuration change and live probe remain pending approval to use the
designated test account. No server change was made during this investigation.

## Remaining live acceptance

1. Back up the server configuration, enable `allow_sticky_events`, validate
   Compose, and restart the pinned homeserver. Verify versions advertises
   MSC4354 and that the server remains healthy.
2. In a private scratch room, check sticky metadata on a fetched event and
   verify a limited/initial sync includes the membership in its sticky section.
3. Join from an Element matrix.org account in Matrix 2.0 mode and Crust.
   Capture the federated membership delivered to Crust; verify the real
   participant name, mute state, and bidirectional audio. Verify encryption
   on the wire, rather than inferring it from UI or mocked tests.

Issue #504 stays open until the live acceptance is complete. Crust's own
membership publishing and JWT identity migration remain tracked by #505;
`unstableSendStickyEvents` stays false for our own sessions.
