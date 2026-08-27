import type { MatrixClient, User } from "matrix-js-sdk";
import { UserEvent } from "matrix-js-sdk";
import { onCleanup, untrack } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import {
	MAX_STATUS_MSG_LENGTH,
	type PresenceInfo,
	type PresenceStatus,
	sanitizeStatusMsg,
	UNKNOWN_PRESENCE,
} from "../lib/presence";

// Re-exported so client-side callers keep one import for the whole concept.
// `components/` must import the SDK-free half from `lib/presence` directly:
// a component may not depend on the Matrix layer (AGENTS.md).
export {
	MAX_STATUS_MSG_LENGTH,
	type PresenceInfo,
	type PresenceStatus,
	sanitizeStatusMsg,
	UNKNOWN_PRESENCE,
};

const [presences, setPresences] = createStore<Record<string, PresenceInfo>>({});
/** The client whose presence currently fills the store; see `detach`. */
let owner: MatrixClient | null = null;
/**
 * Translate an `m.presence` event's content into what the UI renders.
 *
 * The content, not the SDK's `User` fields: `User.setPresenceEvent` only
 * assigns `presenceStatusMsg` when the incoming value is truthy
 * (`models/user.js`), so reading that field would keep showing a status its
 * owner had cleared. Every caller has the event, so there is no second path
 * to keep in step.
 */
export function toPresenceInfo(content: Record<string, unknown>): PresenceInfo {
	const raw = content.presence;
	const status: PresenceStatus =
		raw === "online"
			? "online"
			: raw === "unavailable"
				? "idle"
				: raw === "offline"
					? "offline"
					: "unknown";
	return { status, statusMsg: sanitizeStatusMsg(content.status_msg) };
}

/**
 * Whether a string may be used as a key in the presence store.
 *
 * Every key here is server-controlled - presence-event senders, and the
 * `m.direct` keys `getDmPeers` reads verbatim - and the store is a plain
 * object, so `"__proto__"` is not an ordinary key in either direction.
 * Reading it yields `Object.prototype`, which the UI renders as
 * `aria-label="undefined"`; writing it through `produce` sets the target's
 * prototype instead of adding an entry. `startDm.ts` guards the same input
 * with a null-prototype map for the same reason.
 *
 * The test is what a user ID actually is (the spec requires the sigil)
 * rather than a list of dangerous names, so it cannot fall behind one.
 *
 * Takes `unknown` rather than `string`, and narrows: the runtime already
 * defends against a non-string, and typing the parameter as `string` invited
 * callers to assume that case cannot arrive - which is exactly how the
 * sender-less presence event got through.
 */
function isUserKey(userId: unknown): userId is string {
	// `typeof` as well as the sigil. The SDK builds a re-emitting `User` from
	// `presenceEvent.getSender()`, so an event with no `sender` arrives here
	// with `userId === undefined` - and this runs inside a microtask, where
	// the resulting TypeError is uncaught and takes the rest of that batch's
	// users down with it.
	return typeof userId === "string" && userId.startsWith("@");
}

/**
 * Fold an incoming reading into what we already knew.
 *
 * `unknown` means "the server has not told us", and an event that resolves to
 * it - `presence` absent, or a value no spec version defines - has told us
 * nothing about their status. Asserting it anyway would drop the dot and
 * re-section the member row of someone we currently know is online, which is
 * the same erasure the `if (!event) return` guard prevents for a missing
 * event, reached through a different door. A compliant server never sends
 * one (the field is required), so this is defence, not a supported path.
 *
 * The status message is taken either way: it is carried by the same event,
 * and its absence genuinely does mean "cleared".
 */
function mergePresence(
	prev: PresenceInfo | undefined,
	next: PresenceInfo,
): PresenceInfo {
	if (next.status === "unknown" && prev) {
		return { status: prev.status, statusMsg: next.statusMsg };
	}
	return next;
}

/**
 * Record our *own* presence, which no event will ever deliver.
 *
 * `startClient` builds our own `User` with `new User(userId)` rather than
 * `User.createUser(userId, client)`, so it has no re-emitter: `SyncApi` calls
 * `setPresenceEvent` on that object and the event fires on the `User` alone,
 * never on the client this store listens to. Without this, every self-facing
 * surface - our own member row, our own profile card, a note-to-self DM -
 * reads as `unknown` forever while we are busy telling the server otherwise.
 *
 * Takes the sharing preference rather than a status, because what we publish
 * and how we draw ourselves are not the same thing. Publishing `offline` is
 * how "share my presence: off" works, but writing that here would demote our
 * own row out of its role section into Offline, grey out our own profile card
 * and our note-to-self DM - telling the user they are absent from their own
 * client. `unknown` is the honest rendering: nothing is being published, so
 * there is nothing to show, and no indicator appears.
 */
export function recordSelfPresence(userId: string, sharing: boolean): void {
	if (!isUserKey(userId)) return;
	const status: PresenceStatus = sharing ? "online" : "unknown";
	// Skip the write when nothing changed, the same discipline `applyBatch`
	// keeps. A fresh object would be a new reference, which defeats Solid's
	// equality short-circuit and notifies our own presence key - and the
	// member list's flat list subscribes to every key, so a redundant write
	// costs a full partition and array rebuild.
	//
	// Untracked, because the caller is an effect. Reading the store here
	// would subscribe that effect to our own presence key, and then the
	// publisher's rollback - which writes `unknown` after the server refuses
	// the publish - would notify it, re-run it with the sharing preference
	// still on, and write `online` straight back. The rollback would never
	// survive, on exactly the presence-disabled homeserver it exists for.
	if (untrack(() => presences[userId]?.status) === status) return;
	setPresences(
		produce((draft) => {
			draft[userId] = {
				status,
				statusMsg: draft[userId]?.statusMsg ?? null,
			};
		}),
	);
}

/**
 * Presence for one user. Returns {@link UNKNOWN_PRESENCE} for anyone the
 * server has not told us about, so callers never have to null-check.
 */
export function presenceOf(userId: string): PresenceInfo {
	if (!isUserKey(userId)) return UNKNOWN_PRESENCE;
	return presences[userId] ?? UNKNOWN_PRESENCE;
}

/**
 * Bridges the SDK's per-`User` presence into one reactive store.
 *
 * A module-level store rather than a value on the client context, matching
 * `stores/activeCall`: every surface that shows people wants this, and the
 * context is a type nineteen test files construct by hand.
 *
 * Keyed by user so that one person going idle re-renders one member row
 * rather than the whole list.
 *
 * There is no seed from `client.getUsers()`, and attaching here is what makes
 * that safe: the provider calls this during setup while `startClient` only
 * runs in `onMount`, so the listener is registered before the first sync and
 * misses nothing. Moving this call after `startClient` would silently drop
 * the initial sync's presence block and leave every user reading `unknown`
 * until they next change state - so if it ever moves, it needs the seed back.
 *
 * Returns a detach function, and also registers it with the caller's reactive
 * owner. Detaching clears the store: a module-level singleton outlives the
 * client, and carrying one account's presence into the next session would
 * show the previous user's contacts as online.
 */
export function attachPresence(client: MatrixClient): () => void {
	/**
	 * Apply a whole batch in a single store update.
	 *
	 * Deliberately not one `setPresences` per user: Solid wraps every store
	 * setter call in its own update cycle, so writing inside the loop would
	 * flush subscribing effects once per user and make the batching below
	 * pointless for the case it exists for (many *different* people in one
	 * sync). The changes are computed first so that a batch of pure no-ops
	 * writes nothing at all.
	 */
	const applyBatch = (batch: Map<unknown, Record<string, unknown>>): void => {
		const changes: Array<[string, PresenceInfo]> = [];
		for (const [userId, content] of batch) {
			if (!isUserKey(userId)) continue;
			const prev = presences[userId];
			const next = mergePresence(prev, toPresenceInfo(content));
			// Skip no-op writes: the SDK re-emits on every sync that mentions
			// the user, and a store write would re-render their row each time.
			if (
				prev &&
				prev.status === next.status &&
				prev.statusMsg === next.statusMsg
			) {
				continue;
			}
			changes.push([userId, next]);
		}
		if (changes.length === 0) return;
		setPresences(
			produce((draft) => {
				for (const [userId, info] of changes) draft[userId] = info;
			}),
		);
	};

	let detached = false;

	// Clear on attach as well as on detach. The detach guard deliberately
	// skips the wipe when a newer client already owns the store, so without
	// this an out-of-order session swap would leave the new session showing
	// the previous account's contacts. The publisher resets its state on
	// attach for the same reason.
	setPresences(reconcile({}));
	owner = client;

	// One store write per sync batch, not per event. The member list's flat
	// list subscribes to every member's presence key, so each write costs a
	// full O(n) partition and array rebuild - and a sync routinely carries
	// many presence updates at once. A microtask rather than rAF: the SDK
	// processes a sync's events synchronously, so this coalesces the whole
	// batch, and unlike rAF it still runs in a hidden tab. The single write
	// is `applyBatch`'s job; this only gathers the batch.
	// Keyed by `unknown`, not `string`: the value handed in is
	// `user.userId`, which is exactly what arrives as `undefined` for a
	// sender-less presence event (see `isUserKey`). `applyBatch` is what
	// drops it, but declaring `string` here asserts something false at the
	// boundary where the bad value actually enters.
	let pending: Map<unknown, Record<string, unknown>> | null = null;
	const queueWrite = (
		userId: unknown,
		content: Record<string, unknown>,
	): void => {
		if (pending) {
			pending.set(userId, content);
			return;
		}
		pending = new Map([[userId, content]]);
		queueMicrotask(() => {
			const batch = pending;
			pending = null;
			// `owner` as well as `detached`, matching the guard on `detach`
			// and the publisher's rollback: if a session swap resolved out
			// of order, the new client has already cleared the store and
			// taken ownership while this client's cleanup has not run yet.
			// Writing here would refill the new session with the previous
			// account's peers, who would sit there until each of them next
			// changed state.
			if (!batch || detached || owner !== client) return;
			applyBatch(batch);
		});
	};

	// LastPresenceTs, not Presence. The SDK pushes UserEvent.Presence only
	// when the presence *value* changed, so a peer who is already online and
	// sets or clears a status message emits nothing - which is the primary
	// flow for custom status. LastPresenceTs is pushed on every presence
	// event, so it is the one hook that sees all of them.
	//
	// Not CurrentlyActive either: status derives from `user.presence` alone,
	// and that event fires precisely when presence did not change.
	const onPresence = (
		event: { getContent: () => Record<string, unknown> } | undefined,
		user: User,
	): void => {
		// No event is no information. Synthesizing `{}` here would resolve to
		// `unknown` and actively erase a peer we already know is online -
		// dot removed, member row re-sectioned - on the strength of nothing.
		if (!event) return;
		queueWrite(user.userId, event.getContent());
	};
	client.on(UserEvent.LastPresenceTs, onPresence);

	const detach = (): void => {
		if (detached) return;
		detached = true;
		client.off(UserEvent.LastPresenceTs, onPresence);
		// Only the current owner may clear the shared store. If a new client
		// attached before this cleanup ran (a session swap resolving out of
		// order), wiping here would blank the new session's store, and its
		// entries only refill as people next change state. Mirrors the
		// publisher's identity guard.
		if (owner === client) {
			setPresences(reconcile({}));
			// Drop the reference too, or the module pins a stopped client for
			// the rest of the tab's life after logout.
			owner = null;
		}
	};
	onCleanup(detach);
	return detach;
}
