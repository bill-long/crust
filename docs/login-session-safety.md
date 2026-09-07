# Login session safety

Password login and OAuth callbacks share `features/auth/persistLogin.ts`.
The route's arrival guard is a convenience; the persistence step protects
accounts added after a form opened or while an OAuth exchange was in flight.

- A successful login preserves all existing accounts and their settings.
- A second login for an already-stored user is refused. Its newly minted token
  is revoked, and the user can return to the existing account or log it out.
- The five-account limit applies to both plain and explicit add-account login.
  A refused or failed write revokes only the incoming credential.
- Login, refresh, switch, logout, display-name writes, and legacy session
  migration share a Web Lock across windows. Waiting for the lock is bounded
  to five seconds; browsers without Web Locks refuse the persist safely.
- A login with previous account state reloads the document, with account-scoped
  writes frozen during the handoff. A failed commit lifts the freeze.

## Logout recovery

A logout can revoke a token but fail to remove its storage entry. The logout
tail records a SHA-256 fingerprint of its exact stored credential before the
clear. Only a match to that fingerprint may be replaced at login, and the store
rechecks the credential after asynchronous preparation. Refreshes, new devices,
other accounts, and other homeservers do not match an old logout marker.

The marker contains no tokens. It is tab-scoped in sessionStorage so OAuth can
carry it through a redirect, with an in-memory fallback for a password login
when sessionStorage is unavailable. Successful persistence clears the markers.
If recovery evidence cannot be retained, login preserves existing accounts
rather than assuming they are disposable. Settings for a departed account are
removed only after the replacement session write succeeds.

This deliberately avoids using a BroadcastChannel timeout as proof of logout:
a suspended or closed tab can still have valid credentials. Neither that tab
nor a running ClientProvider needs to answer a probe to protect its account.

Coverage includes stale password and OAuth forms, account limits, duplicate
devices, rejected writes, exact-credential recovery, and real browser Web Locks
and WebCrypto. The existing hung-boot escape remains the first half of #551.
