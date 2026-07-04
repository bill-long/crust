import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { EventStatus, EventType, RelationType } from "matrix-js-sdk";
import type { Accessor } from "solid-js";
import { composerTextareaSelector } from "../composer/composerTextarea";
import type { TimelineEvent } from "./timelineTypes";
import type { useOptimisticActions } from "./useOptimisticActions";

type OptimisticStores = ReturnType<typeof useOptimisticActions>;

interface MessageActionDeps {
	/** The reactive events store; read imperatively at click time. */
	events: TimelineEvent[];
	getSourceEvent: (eventId: string) => MatrixEvent | undefined;
	pendingRedactions: OptimisticStores["pendingRedactions"];
	pendingReactions: OptimisticStores["pendingReactions"];
	pendingEdits: OptimisticStores["pendingEdits"];
	/** Composer-context setters owned by the caller (TimelineView). */
	setReplyTo: (ev: TimelineEvent | null) => void;
	setEditingEvent: (ev: TimelineEvent | null) => void;
}

/**
 * User-triggered message actions for the timeline: reactions, deletes, edits,
 * and the Retry / Discard / Cancel affordances for failed or in-flight
 * reaction / redaction / edit echoes. Each handler is a thin wrapper over the
 * SDK client keyed by event ID; none touch scroll state, so they lift out of
 * TimelineView cleanly.
 *
 * `roomId` and `thread` are read live on each call so a handler invoked after a
 * room / thread switch targets the current scope (the caller owns those
 * values). After any affordance that removes the button the user activated
 * (Retry / Discard / Cancel), focus is returned to the composer so it never
 * strands on `document.body`.
 */
export function useMessageActions(
	client: MatrixClient,
	roomId: Accessor<string>,
	thread: Accessor<{ threadId: string } | undefined>,
	deps: MessageActionDeps,
) {
	// threadId for the SDK's 3-arg overloads: in a thread panel the local
	// echo only gets its thread association (setThread) when a threadId is
	// passed - without it the echo lives in no timeline set and the timeline
	// hook's acceptsEvent gate rejects it, so reactions/redactions would
	// show no optimistic update inside the panel.
	const sendThreadId = (): string | null => thread()?.threadId ?? null;

	const onReact = async (eventId: string, key: string): Promise<void> => {
		const ev = deps.events.find((e) => e.eventId === eventId);
		if (!ev) return;

		const existingId = Object.hasOwn(ev.myReactions, key)
			? ev.myReactions[key]
			: undefined;
		try {
			if (existingId) {
				await client.redactEvent(roomId(), sendThreadId(), existingId);
			} else {
				await client.sendEvent(roomId(), sendThreadId(), EventType.Reaction, {
					"m.relates_to": {
						rel_type: RelationType.Annotation,
						event_id: eventId,
						key,
					},
				});
			}
		} catch (e) {
			console.error("Reaction failed:", e);
		}
	};

	const onDelete = async (eventId: string): Promise<void> => {
		try {
			await client.redactEvent(roomId(), sendThreadId(), eventId);
		} catch (e) {
			console.error("Delete failed:", e);
		}
	};

	/**
	 * Move keyboard focus to the room's composer textarea. Used after
	 * Retry / Discard / Cancel since the failed- or pending-banner
	 * button the user activated disappears and would otherwise strand
	 * focus on `document.body`.
	 *
	 * Re-checks the room ID inside the deferred callback because RAF
	 * runs a frame later; a room switch between the caller's guard and
	 * the actual focus call would otherwise steal focus into the wrong
	 * room.
	 */
	const focusComposer = (expectedRoomId: string): void => {
		requestAnimationFrame(() => {
			if (roomId() !== expectedRoomId) return;
			const textarea = document.querySelector<HTMLTextAreaElement>(
				composerTextareaSelector(thread()?.threadId),
			);
			textarea?.focus();
		});
	};

	/**
	 * Resend a failed local echo through the SDK's pending-event queue.
	 * The SDK will transition the event back to SENDING and re-fire
	 * `LocalEchoUpdated`, which the timeline hook picks up to update status.
	 */
	const onRetry = async (eventId: string): Promise<void> => {
		const originalRoomId = roomId();
		const room = client.getRoom(originalRoomId);
		if (!room) return;
		const matrixEvent = deps.getSourceEvent(eventId);
		if (!matrixEvent) return;
		try {
			await client.resendEvent(matrixEvent, room);
		} catch (e) {
			console.error("Resend failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Cancel a local echo. Used for both Discard (on `NOT_SENT` failed
	 * sends) and Cancel (on in-flight `SENDING` / `QUEUED` / `ENCRYPTING`
	 * sends). In both cases the SDK fires a removed-Timeline event
	 * followed by `LocalEchoUpdated(CANCELLED)`; both paths drop the
	 * event from the store idempotently.
	 */
	const cancelPending = (eventId: string): void => {
		const matrixEvent = deps.getSourceEvent(eventId);
		if (!matrixEvent) return;
		const originalRoomId = roomId();
		try {
			client.cancelPendingEvent(matrixEvent);
		} catch (e) {
			console.error("cancelPendingEvent failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Retry a failed redaction. The pending-redactions map is keyed by
	 * the *target* event ID and stores the redaction `MatrixEvent`
	 * directly, so Retry works even when the user has scrolled away
	 * from live (where the redaction echo lives).
	 * Re-checks the event's status because a concurrent retry from
	 * another path (or a quick succession of clicks) could have already
	 * moved the event back to SENDING.
	 */
	const onRetryRedaction = async (targetId: string): Promise<void> => {
		const pending = deps.pendingRedactions[targetId];
		if (!pending) return;
		const room = client.getRoom(roomId());
		if (!room) return;
		if (pending.redactionEvent.status !== EventStatus.NOT_SENT) return;
		const originalRoomId = roomId();
		try {
			await client.resendEvent(pending.redactionEvent, room);
		} catch (e) {
			console.error("resendEvent (redaction) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Abort a pending redaction echo (whether in-flight QUEUED /
	 * ENCRYPTING or failed NOT_SENT). Both Cancel (in-flight overlay)
	 * and Discard (failed banner) call this - `cancelPendingEvent`
	 * triggers the SDK's `unmarkLocallyRedacted`, which restores the
	 * target's content, and the `_removed` Timeline handler in the
	 * timeline hook clears the pending overlay and re-renders the row.
	 */
	const abortPendingRedaction = (targetId: string): void => {
		const pending = deps.pendingRedactions[targetId];
		if (!pending) return;
		const originalRoomId = roomId();
		try {
			client.cancelPendingEvent(pending.redactionEvent);
		} catch (e) {
			console.error("cancelPendingEvent (redaction) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Retry the most-recent failed reaction echo for `(targetId, key)`.
	 * Earlier failed echoes for the same key stay in the pending store
	 * until the user discards (or their own retry/cancel transitions
	 * clean them up). Resending replays the SDK's pending-event queue,
	 * which fires `LocalEchoUpdated(SENDING)` and pops the echo out of
	 * `pendingReactions` via the per-event lifecycle.
	 */
	const onRetryReaction = async (
		targetId: string,
		key: string,
	): Promise<void> => {
		const arr = deps.pendingReactions[targetId]?.[key];
		if (!arr || arr.length === 0) return;
		const room = client.getRoom(roomId());
		if (!room) return;
		const last = arr[arr.length - 1];
		if (last.status !== EventStatus.NOT_SENT) return;
		const originalRoomId = roomId();
		try {
			await client.resendEvent(last, room);
		} catch (e) {
			console.error("resendEvent (reaction) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Discard every failed reaction echo for `(targetId, key)`. Each
	 * cancel is wrapped in its own try/catch + status guard so one
	 * SDK throw (e.g. an echo whose status raced past NOT_SENT) does
	 * not strand the rest. The SDK's `_removed` Timeline path and
	 * `LocalEchoUpdated(CANCELLED)` both clear the store entries.
	 */
	const onDiscardReaction = (targetId: string, key: string): void => {
		const arr = deps.pendingReactions[targetId]?.[key];
		if (!arr || arr.length === 0) return;
		const originalRoomId = roomId();
		// Snapshot before iterating - the store mutates underneath us as
		// each cancel fires its synchronous lifecycle events.
		const snapshot = [...arr];
		for (const ev of snapshot) {
			if (ev.status !== EventStatus.NOT_SENT) continue;
			try {
				client.cancelPendingEvent(ev);
			} catch (e) {
				console.error("cancelPendingEvent (reaction) failed:", e);
			}
		}
		focusComposer(originalRoomId);
	};

	/** Retry the most-recent failed edit echo for `targetId`. */
	const onRetryEdit = async (targetId: string): Promise<void> => {
		const arr = deps.pendingEdits[targetId];
		if (!arr || arr.length === 0) return;
		const room = client.getRoom(roomId());
		if (!room) return;
		const last = arr[arr.length - 1];
		if (last.status !== EventStatus.NOT_SENT) return;
		const originalRoomId = roomId();
		try {
			await client.resendEvent(last, room);
		} catch (e) {
			console.error("resendEvent (edit) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/** Discard every failed edit echo for `targetId`. */
	const onDiscardEdit = (targetId: string): void => {
		const arr = deps.pendingEdits[targetId];
		if (!arr || arr.length === 0) return;
		const originalRoomId = roomId();
		const snapshot = [...arr];
		for (const ev of snapshot) {
			if (ev.status !== EventStatus.NOT_SENT) continue;
			try {
				client.cancelPendingEvent(ev);
			} catch (e) {
				console.error("cancelPendingEvent (edit) failed:", e);
			}
		}
		focusComposer(originalRoomId);
	};

	const onEdit = (ev: TimelineEvent): void => {
		// Get current body from SDK event for accurate prefill
		// Use getContent() (includes edits) not getOriginalContent()
		const sourceEvent = deps.getSourceEvent(ev.eventId);
		if (sourceEvent) {
			const content = sourceEvent.getContent();
			const editBody =
				typeof content?.body === "string" ? content.body : ev.body;
			deps.setEditingEvent({ ...ev, body: editBody });
		} else {
			deps.setEditingEvent(ev);
		}
		deps.setReplyTo(null);
	};

	return {
		onReact,
		onDelete,
		onRetry,
		cancelPending,
		onRetryRedaction,
		abortPendingRedaction,
		onRetryReaction,
		onDiscardReaction,
		onRetryEdit,
		onDiscardEdit,
		onEdit,
	};
}
