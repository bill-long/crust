import type { MatrixClient } from "matrix-js-sdk";
import { SetPresence } from "matrix-js-sdk/lib/sync";
import { onCleanup } from "solid-js";
import { sanitizeStatusMsg } from "../lib/presence";
import { reportError } from "../lib/reportError";
import { enqueueKeyedWrite } from "../lib/writeQueue";
import {
	recordSelfPresence,
	recordSelfStatusMsg,
	selfRawStatusMsg,
} from "./presence";

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
 * Conduwuity answered 404 on the presence endpoints when the feature was
 * off (the same shape as its `voip/turnServer` 404); Continuwuity answers
 * 403 `M_FORBIDDEN` ("Presence is disabled on this server") on both GET and
 * PUT (`src/api/client/presence.rs`); a server that never implemented them
 * answers `M_UNRECOGNIZED`. All are permanent for the session. Everything
 * else - timeouts, 5xx, rate limits - is transient, and the difference
 * decides whether we may contradict our own optimistic write.
 *
 * The write is what this classifies. A not-found from the read that
 * precedes it never reaches here: `currentStatusMsg` reads that as "no
 * status set" and lets the write be the one claim about the endpoint.
 */
function meansPresenceUnsupported(e: unknown): boolean {
	const err = e as { httpStatus?: unknown; errcode?: unknown } | null;
	return (
		err?.httpStatus === 404 ||
		err?.errcode === "M_NOT_FOUND" ||
		err?.errcode === "M_FORBIDDEN" ||
		err?.errcode === "M_UNRECOGNIZED"
	);
}

/**
 * Presence writes run one at a time per client. A sharing publish reads
 * the current status before it writes (see `publish`), and a status save
 * may land in that gap; unserialised, the publish would re-send the status
 * it read a moment before the save and undo it. Keyed by client (a
 * WeakMap, as the account-data writers do) so a re-login never queues
 * behind a dead session's request.
 */
const presenceChains = new WeakMap<MatrixClient, Promise<void>>();

function publishedPresence(): PublishedPresence {
	return sharing ? "online" : "offline";
}

/**
 * The account's current raw `status_msg`, or "" when none is set.
 *
 * A presence publish has to carry it: the endpoint treats an omitted
 * `status_msg` as "clear" (verified on Continuwuity - a presence-only PUT
 * wiped the message; Synapse reads the field the same way), so publishing
 * sharing without it would delete a status set from any client, ours
 * included. Whether to read at all is `publish`'s decision, documented
 * there; this only performs one.
 *
 * A "not found" reads as no status. Two servers answer it and the plain
 * reading serves both: a homeserver with no presence at all (the older
 * Conduwuity 404) goes on to fail the PUT, which is where that gets
 * classified once and where the dot rollback belongs; and Continuwuity
 * answers it for an account that shares no room with ITSELF - zero joined
 * rooms - where the alternative, failing every publish, would also mean
 * the status editor could never open. The accepted cost is the corner of
 * that corner: an account with no rooms at all, and a status set from
 * another client, loses it on the next launch's publish. It shares no
 * room with anyone, so nobody could see that status.
 *
 * Any other failure rejects: a publish must not go out without a status
 * it could not read, since the server would clear it.
 */
async function currentStatusMsg(c: MatrixClient): Promise<string> {
	const uid = c.getUserId();
	if (!uid) return "";
	try {
		const res = await c.getPresence(uid);
		return typeof res.status_msg === "string" ? res.status_msg : "";
	} catch (e) {
		const err = e as { httpStatus?: unknown; errcode?: unknown } | null;
		if (err?.httpStatus === 404 || err?.errcode === "M_NOT_FOUND") return "";
		throw e;
	}
}

/**
 * PUT our presence, and record the status the server accepted so the store
 * has it ahead of the /sync echo. The identity guard is the one the
 * failure path keeps: after a session swap the store belongs to another
 * account, and a late write would land under the previous user's ID.
 */
async function sendPresence(
	c: MatrixClient,
	presence: PublishedPresence,
	status_msg: string,
): Promise<void> {
	await c.setPresence({ presence, status_msg });
	if (client !== c) return;
	const uid = c.getUserId();
	if (uid) recordSelfStatusMsg(uid, status_msg);
}

function publish(userInitiated: boolean): void {
	// Captured, not re-read in the callback: a session swap between the
	// request and its rejection must not roll back the new account's dot.
	const c = client;
	if (!c) return;
	const presence = publishedPresence();
	// Keep the sync loop from re-asserting the opposite on its next poll.
	// Silently a no-op before `startClient` - see applySyncPresence.
	c.setSyncPresence(syncPresenceValue());
	enqueueKeyedWrite(presenceChains, c, async () => {
		// The status the server last confirmed for us goes back out with the
		// presence, so the PUT is on the wire synchronously once /sync (or a
		// round trip) has told us - a tab closed inside a read's RTT would
		// otherwise drop the offline publish, and a read races a change made
		// from another client in that RTT. Only the first publish of a
		// session, before the initial sync, has to read first, and a failed
		// read fails the publish (handled below like a failed write) rather
		// than sending a PUT that would clear the status we could not read.
		// Nothing is lost by not publishing: `set_presence` on every /sync
		// carries the sharing decision on its own.
		const status_msg = selfRawStatusMsg() ?? (await currentStatusMsg(c));
		await sendPresence(c, presence, status_msg);
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
		// server will never carry presence at all. The store draws our own
		// status from the sharing preference rather than from the wire
		// (recordSelfPresence), and on a homeserver with presence disabled
		// this publish is exactly what 404s while no peer produces an event
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
			// And only for the offline direction: the wording is about it, and
			// turning sharing on is already carried by `set_presence=online` on
			// the very next /sync, so a failed online publish costs nothing.
			userMessage:
				userInitiated && !unsupported && presence === "offline"
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
 * The account's raw `status_msg` for an editor to prefill from - never the
 * display rendering, which `sanitizeStatusMsg` has collapsed, cleaned and
 * cut, so saving it back unedited would rewrite the real status (#538).
 * Rejects on failure; the caller decides what an editor does without it.
 */
export async function fetchStatusMessage(): Promise<string> {
	const c = client;
	if (!c) throw new Error("Presence is not attached.");
	return currentStatusMsg(c);
}

/**
 * Publish our own status message, verbatim. An empty string clears it.
 *
 * Rides on the presence we already publish (`online` while sharing, else
 * `offline`), so saving a status never flips the sharing decision, and
 * sharing-off keeps the status - `publish` re-sends it - rather than
 * clearing it and losing it on the way back (the round trip #538 was cut
 * over; the settings copy promises only the presence change). Rejects on
 * failure so the editor renders the error inline; on success the store
 * learns the message from the value the server accepted, and the /sync
 * echo confirms or corrects it.
 */
export function setStatusMessage(raw: string): Promise<void> {
	const c = client;
	if (!c || sharing === null) {
		return Promise.reject(new Error("Presence is not attached."));
	}
	const presence = publishedPresence();
	// A status that renders as nothing is a clear: "set a status of spaces"
	// and "clear" collapse to the same case here as they do on display.
	const status_msg = sanitizeStatusMsg(raw) === null ? "" : raw;
	return enqueueKeyedWrite(presenceChains, c, () =>
		sendPresence(c, presence, status_msg),
	);
}
