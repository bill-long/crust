# Room permission parity

## Why the gap survived

Issue #73 deliberately shipped only two presets for six top-level requirements.
It explicitly excluded a detailed editor. Later feature audits tracked calls,
pins and room mentions without verifying whether a room administrator could
configure those capabilities for ordinary members. A creator-only call test
also missed the distinction between room-version-12 creators and members.

## Scope and ownership

The Permissions tab owns edits to `m.room.power_levels`: named actions plus
all event, user and notification overrides. The catalogue in
`permissionEditor.ts` owns named labels and inheritance. Unknown event types
remain editable without pretending to know whether they are state events.
Existing unknown fields survive writes. General/Advanced tabs still own the
actual name, topic, address, join-rule and history settings.

Each operation changes one property. The UI updates optimistically, disables
additional writes while pending, fetches the current server document, checks
for a conflicting change to the selected property, and merges into that
fresh document before sending through the SDK. Failure restores server state
and reports inline. The server remains authoritative for authorization.
Matrix does not offer compare-and-swap for this endpoint: a concurrent edit
between the fresh read and write remains a protocol-level limitation.

Permission loss and room switches invalidate pending editor actions before
sending. A request already dispatched may finish after the editor closes;
closing the UI cannot recall a server write. No crypto, sync or login lifecycle
changes are part of this work.

## Coverage contract

A parity audit must cover discoverability, configuration, execution as an
ordinary member, and interpretation in another client. A creator/admin success
is not evidence of member access. For each configurable action, verify its
named setting or the generic override editor can read, set and reset it.

Named controls cover room defaults, moderation, room-wide notifications, both
call-membership event formats, pins, room metadata, access/history, permissions,
space relationships, reactions, stickers, and other-client widget permissions.
The generic editor covers arbitrary event types, per-user levels, and notification
keys with bounded pages. Members, moderators, admins and custom integer levels
are editable, with explicit versus inherited values and reset semantics.

Regression coverage must exercise preserved unrelated fields, inheritance,
custom values, reset, errors, external edits, authority restrictions, creator
protection, and keyboard/browser interaction. The Members tab labels permanent
creator privilege instead of displaying an unexplained Infinity value.
