import type { MatrixClient } from "matrix-js-sdk";
import { SetPresence } from "matrix-js-sdk/lib/sync";
import { onCleanup } from "solid-js";
import { reportError } from "../lib/reportError";
import { recordSelfPresence } from "./presence";

/**
 * What we tell the homeserver about ourselves.
 *
 * Only two states are published. `online` while sharing is on, `offline`
 * while it is off - and `offline` is a real publish rather than simply going
 * quiet, because a server that has heard nothing recently reports the last
 * value it was given. Silence would leave us showing as online indefinitely,
 * which is the opposite of what turning the setting off means.
 *
 * Idle is deliberately not published. Deciding we have gone idle needs an
 * activity timer and input listeners across the whole app, and the server
 * already derives `currently_active` / `last_active_ago` from our sync
 * traffic - which is what other clients render as idle anyway. We display
 * idle for other people; we just do not assert it about ourselves.
 */
export type PublishedPresence = "online" | "offline";

let client: MatrixClient | null = null;
let sharing: boolean | null = null;

function syncPresenceValue(): SetPresence {
	return sharing ? SetPresence.Online : SetPresence.Offline;
}

/**
 * Whether a `setPresence` rejection means this server does not do presence,
 * as opposed to this one attempt having failed.
 *
 * Conduwuity answers 404 on the presence endpoints when the feature is off
 * (the same shape as its `voip/turnServer` 404), and a server that never
 * implemented them answers `M_UNRECOGNIZED`. Both are permanent for the
 * session. Everything else - timeouts, 5xx, rate limits - is transient, and
 * the difference decides whether we may contradict our own optimistic write.
 */
function meansPresenceUnsupported(e: unknown): boolean {
	const err = e as { httpStatus?: unknown; errcode?: unknown } | null;
	return (
		err?.httpStatus === 404 ||
		err?.errcode === "M_NOT_FOUND" ||
		err?.errcode === "M_UNRECOGNIZED"
	);
}

function publish(userInitiated: boolean): void {
	// Captured, not re-read in the callback: a session swap between the
	// request and its rejection must not roll back the new account's dot.
	const c = client;
	if (!c) return;
	const presence: PublishedPresence = sharing ? "online" : "offline";
	// Keep the sync loop from re-asserting the opposite on its next poll.
	// Silently a no-op before `startClient` - see applySyncPresence.
	c.setSyncPresence(syncPresenceValue());
	c.setPresence({
		presence,
		// status_msg is never sent. This client does not set one, and
		// including the field would rewrite or clear whatever the account
		// has set from another client - an empty string clears.
	}).catch((e) => {
		// Start-up is best effort and self-correcting, and a homeserver
		// with presence disabled answers 404 here - not something to put
		// in front of the user on every launch.
		//
		// The toggle is different: it is a user action whose only feedback
		// is the switch itself, which stays flipped whether or not the
		// publish landed. Silently leaving someone reporting as online
		// after they asked not to is exactly the case AGENTS.md says to
		// surface.
		// Take our own dot back down, but only when the failure means the
		// server will never carry presence at all. The store writes
		// `online` for us optimistically because no event delivers our own
		// presence, and on a homeserver with presence disabled that
		// publish is exactly what 404s while no peer produces an event
		// either - so left alone, the one green dot on screen would be
		// ours, sourced from the single claim the server refused.
		//
		// A blip is the opposite case and must not be rolled back. Nothing
		// retries this, and the effect that calls it only re-runs when the
		// setting itself changes, so a 5xx during a flaky start-up would
		// strip our own dot for the rest of the session - while
		// `set_presence` on every /sync keeps us genuinely online to
		// everyone else. The only cure would be toggling the switch twice.
		//
		// `client === c` because the store is module-level and shared:
		// after logout and login as someone else, a late rejection from
		// the old session would otherwise write `unknown` under the
		// *previous* user's ID, blanking them as a peer in the new one.
		const unsupported = meansPresenceUnsupported(e);
		if (client === c && unsupported) {
			const uid = c.getUserId();
			if (uid) recordSelfPresence(uid, false);
		}
		reportError(e, {
			logLabel: "setPresence",
			// No toast when the server simply does not do presence. The
			// message would be untrue there - nobody sees us as anything,
			// because presence is off server-side - and this is the expected
			// Conduwuity quirk AGENTS.md files alongside the sibling
			// `voip/turnServer` 404, in the console-only bucket. The dot
			// rollback just above is the inline surface for it, so a toast
			// would be the second signal AGENTS.md says not to stack.
			userMessage:
				userInitiated && !unsupported
					? "Couldn't update your presence. Others may still see you as online."
					: undefined,
		});
	});
}

/**
 * Point the publisher at a client, and forget any previous one.
 *
 * Module-level to match `presenceOf`, and reset rather than accumulated: the
 * only state here is the sharing preference, which describes one session.
 * Carrying it across would apply one account's answer to a privacy question
 * to the next account without asking.
 */
export function attachPresencePublisher(next: MatrixClient): () => void {
	client = next;
	sharing = null;
	const detach = (): void => {
		if (client !== next) return;
		client = null;
		sharing = null;
	};
	onCleanup(detach);
	return detach;
}

/**
 * Re-assert the sync loop's `set_presence` once the sync API exists.
 *
 * `MatrixClient.setSyncPresence` is `this.syncApi?.setPresence(...)`, and
 * `syncApi` is not created until `startClient()`. The provider publishes
 * during setup - before the awaited crypto init that `startClient` sits
 * behind - so that first call reaches nothing. `SyncApi` then starts with no
 * presence set, omits `set_presence` from the query, and the spec's default
 * for an omitted value is `online`.
 *
 * Without this, turning sharing off and reloading publishes one `offline`
 * that the very first `/sync` immediately overrides, and the account reads as
 * online for the whole session. Only a mid-session toggle ever worked.
 */
export function applySyncPresence(): void {
	if (!client || sharing === null) return;
	client.setSyncPresence(syncPresenceValue());
}

/**
 * Publish the current sharing preference. Safe to call repeatedly - it skips
 * the round trip when nothing has changed.
 */
export function setPresenceSharing(next: boolean): void {
	if (sharing === next) return;
	// The first call is start-up applying the stored preference; anything
	// after is the user reaching for the switch.
	const userInitiated = sharing !== null;
	sharing = next;
	publish(userInitiated);
}

/**
 * Setting our *own* status message is deliberately not implemented here.
 *
 * Displaying other people's statuses works and is wired up; publishing our
 * own turned out to need more than a setter. We never hold the raw text the
 * user typed - only `sanitizeStatusMsg`'s display rendering of it - so a
 * round trip through this module silently rewrites a status set from another
 * client (whitespace collapsed, control characters replaced, truncated past
 * the cap). Fixing that properly means fetching our own presence for the
 * prefill and keeping raw and rendered apart, and it interacts with the
 * share-presence switch: turning sharing off has to clear the status, and
 * turning it back on cannot restore what was cleared.
 *
 * That is a design with real decisions in it, not a missing function, so it
 * is tracked separately rather than guessed at here.
 */
