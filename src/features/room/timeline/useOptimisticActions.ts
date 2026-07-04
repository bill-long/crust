import type { EventStatus, MatrixEvent } from "matrix-js-sdk";
import { createStore, produce, reconcile } from "solid-js/store";

/**
 * Optimistic-echo state for the timeline: the failed / in-flight redaction,
 * reaction, and edit echoes that drive the Retry / Discard affordances. Owns the
 * three stores and their mutators; the timeline hook keeps the SDK listeners and
 * user-action handlers that call these mutators in. resetOptimistic() clears all
 * three synchronously at a room switch.
 */
export function useOptimisticActions() {
	/**
	 * Pending-redaction status keyed by *target* event ID. Surfaces a
	 * "Deleting…" overlay on the target while the redaction round-trips,
	 * and a "Delete failed — Retry / Discard" affordance when the
	 * redaction echo transitions to NOT_SENT. Cleared when the
	 * redaction confirms (the SDK's confirm path also removes the
	 * target from `events`) or is cancelled.
	 *
	 * The redaction `MatrixEvent` reference is stored directly so
	 * Retry/Discard work even when the user has scrolled away from
	 * live; the SDK's TimelineWindow may not include the redaction
	 * echo (it lives at the live end) once `followingLive` is false.
	 */
	interface PendingRedaction {
		redactionEvent: MatrixEvent;
		status: EventStatus;
	}
	const [pendingRedactions, setPendingRedactions] = createStore<
		Record<string, PendingRedaction>
	>({});

	function recordPendingRedaction(redactionEvent: MatrixEvent): void {
		const targetId = redactionEvent.event.redacts;
		const status = redactionEvent.status;
		if (typeof targetId !== "string" || !status) return;
		setPendingRedactions(targetId, { redactionEvent, status });
	}

	function clearPendingRedaction(targetId: string): void {
		setPendingRedactions(
			produce((d) => {
				delete d[targetId];
			}),
		);
	}

	/**
	 * Failed reaction echoes keyed by target event ID, then by reaction
	 * key (unicode emoji or `mxc://` URL for custom emotes). Each entry
	 * is the array of failed `MatrixEvent`s — multiple clicks during an
	 * outage can stack failures for the same key.
	 *
	 * Lifecycle (per-event-ID): NOT_SENT upserts; SENDING / QUEUED /
	 * ENCRYPTING (retry in-flight) removes; null (confirmed) / CANCELLED
	 * removes. Empty inner records are pruned, then empty outer keys.
	 *
	 * Stores `MatrixEvent` directly so Retry / Discard work even when
	 * the user has scrolled away from live; the SDK's TimelineWindow
	 * may not include the failed reaction echo once `followingLive` is
	 * false.
	 */
	const [pendingReactions, setPendingReactions] = createStore<
		Record<string, Record<string, MatrixEvent[]>>
	>(Object.create(null));

	/**
	 * Failed edit (m.replace) echoes keyed by target event ID. Same
	 * stacking semantics as `pendingReactions`: each entry is an array
	 * of failed `MatrixEvent`s so repeated retries during an outage
	 * remain discoverable / discardable. Retry uses the most-recent
	 * entry; Discard cancels all.
	 */
	const [pendingEdits, setPendingEdits] = createStore<
		Record<string, MatrixEvent[]>
	>(Object.create(null));

	function upsertPendingReaction(reactionEvent: MatrixEvent): void {
		const content = reactionEvent.getContent();
		const targetId = content?.["m.relates_to"]?.event_id;
		const key = content?.["m.relates_to"]?.key;
		const eid = reactionEvent.getId();
		if (typeof targetId !== "string" || typeof key !== "string" || !eid) {
			return;
		}
		setPendingReactions(
			produce((d) => {
				let byKey = d[targetId];
				if (!byKey) {
					byKey = Object.create(null);
					d[targetId] = byKey;
				}
				let arr = byKey[key];
				if (!arr) {
					arr = [];
					byKey[key] = arr;
				}
				if (!arr.some((e) => e.getId() === eid)) {
					arr.push(reactionEvent);
				}
			}),
		);
	}

	function removePendingReaction(reactionEvent: MatrixEvent): void {
		const content = reactionEvent.getContent();
		const targetId = content?.["m.relates_to"]?.event_id;
		const key = content?.["m.relates_to"]?.key;
		const eid = reactionEvent.getId();
		if (typeof targetId !== "string" || typeof key !== "string" || !eid) {
			return;
		}
		setPendingReactions(
			produce((d) => {
				const byKey = d[targetId];
				if (!byKey) return;
				const arr = byKey[key];
				if (!arr) return;
				const idx = arr.findIndex((e) => e.getId() === eid);
				if (idx >= 0) arr.splice(idx, 1);
				if (arr.length === 0) delete byKey[key];
				if (Object.keys(byKey).length === 0) delete d[targetId];
			}),
		);
	}

	function upsertPendingEdit(editEvent: MatrixEvent): void {
		const targetId = editEvent.getContent()?.["m.relates_to"]?.event_id;
		const eid = editEvent.getId();
		if (typeof targetId !== "string" || !eid) return;
		setPendingEdits(
			produce((d) => {
				let arr = d[targetId];
				if (!arr) {
					arr = [];
					d[targetId] = arr;
				}
				if (!arr.some((e) => e.getId() === eid)) {
					arr.push(editEvent);
				}
			}),
		);
	}

	function removePendingEdit(editEvent: MatrixEvent): void {
		const targetId = editEvent.getContent()?.["m.relates_to"]?.event_id;
		const eid = editEvent.getId();
		if (typeof targetId !== "string" || !eid) return;
		setPendingEdits(
			produce((d) => {
				const arr = d[targetId];
				if (!arr) return;
				const idx = arr.findIndex((e) => e.getId() === eid);
				if (idx >= 0) arr.splice(idx, 1);
				if (arr.length === 0) delete d[targetId];
			}),
		);
	}

	function resetOptimistic(): void {
		setPendingRedactions(reconcile({}, { merge: false }));
		setPendingReactions(reconcile(Object.create(null), { merge: false }));
		setPendingEdits(reconcile(Object.create(null), { merge: false }));
	}

	return {
		pendingRedactions,
		pendingReactions,
		pendingEdits,
		recordPendingRedaction,
		clearPendingRedaction,
		upsertPendingReaction,
		removePendingReaction,
		upsertPendingEdit,
		removePendingEdit,
		resetOptimistic,
	};
}

/** The optimistic-echo stores and mutators, for consumers (e.g. the timeline's
 *  message-action handlers) that receive a subset threaded in as deps. */
export type OptimisticActions = ReturnType<typeof useOptimisticActions>;
