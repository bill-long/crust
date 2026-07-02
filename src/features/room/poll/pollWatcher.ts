import {
	type MatrixClient,
	type MatrixEvent,
	MatrixEventEvent,
	type Poll,
	PollEvent,
	type Relations,
	RelationsEvent,
	type Room,
} from "matrix-js-sdk";
import {
	buildPollSnapshot,
	computePollTally,
	type PollSnapshot,
	type PollStartInfo,
	parsePollStart,
} from "./pollSnapshot";

export interface PollWatcher {
	/**
	 * Point the watcher at a room. Subsequent SDK `PollEvent.New` emissions
	 * from this room upgrade provisional snapshots to live-tallied ones.
	 * Switching rooms drops all per-poll subscriptions and cached snapshots
	 * from the previous room; calling again with the same room is a no-op
	 * (existing watches and their fetched responses are kept).
	 */
	watchRoom(room: Room): void;
	/**
	 * Synchronously resolve the current {@link PollSnapshot} for an
	 * `m.poll.start` event, for use inside the timeline projector.
	 *
	 * Cache hit returns the latest computed snapshot. On miss this builds a
	 * provisional zero-count snapshot and - when the SDK `Poll` model exists -
	 * starts watching it, kicking off the (async, paginated) response fetch;
	 * each response page then recomputes the snapshot and re-projects the row
	 * via `onUpdate`. Returns null when the event isn't a parseable poll
	 * start.
	 */
	getSnapshot(startEvent: MatrixEvent, room: Room): PollSnapshot | null;
	/** Remove every SDK listener and drop all cached state. */
	dispose(): void;
}

interface WatchedPoll {
	poll: Poll;
	start: PollStartInfo;
	/** Response relations, once the first fetch/emission has delivered them. */
	relations: Relations | null;
	/** True when the initial response fetch rejected (tallies stay at the
	 *  provisional zero state, but the loading indicator must not spin
	 *  forever). */
	fetchFailed: boolean;
	detach(): void;
}

/**
 * Owns all SDK poll subscriptions for the timeline and converts them into
 * plain {@link PollSnapshot} data plus `onUpdate(pollId)` callbacks.
 *
 * This is the live-update seam for polls: votes and poll ends arrive as
 * `m.reference` relations, which the timeline's event handlers deliberately
 * don't display, so without these subscriptions a poll row would never
 * re-render. Mirrors the reaction pattern where relation changes re-project
 * the *target* row - `onUpdate` is expected to re-run the projection for
 * the poll's own timeline row.
 *
 * Note: the SDK's `Poll.onNewRelation` drops live relations until
 * `getResponses()` has initialised the relations set, so every watched poll
 * eagerly calls it exactly once.
 */
export function createPollWatcher(
	client: MatrixClient,
	onUpdate: (pollId: string) => void,
): PollWatcher {
	let watchedRoom: Room | null = null;
	const watched = new Map<string, WatchedPoll>();
	const snapshots = new Map<string, PollSnapshot>();

	function recompute(pollId: string): void {
		const entry = watched.get(pollId);
		if (!entry) return;
		const tally = entry.relations
			? computePollTally(
					entry.relations.getRelations(),
					entry.start,
					client.getUserId(),
				)
			: null;
		const loadingResults = entry.relations
			? entry.poll.isFetchingResponses
			: !entry.fetchFailed;
		snapshots.set(
			pollId,
			buildPollSnapshot({
				pollId,
				start: entry.start,
				tally,
				isEnded: entry.poll.isEnded,
				undecryptableCount: entry.poll.undecryptableRelationsCount,
				loadingResults,
			}),
		);
		onUpdate(pollId);
	}

	function startWatching(poll: Poll, start: PollStartInfo): void {
		const pollId = poll.pollId;
		if (watched.has(pollId)) return;

		const relationsListeners = {
			attached: null as Relations | null,
			onChange: (_event: MatrixEvent) => recompute(pollId),
		};
		function attachRelations(relations: Relations): void {
			if (relationsListeners.attached === relations) return;
			detachRelations();
			relationsListeners.attached = relations;
			relations.on(RelationsEvent.Remove, relationsListeners.onChange);
			relations.on(RelationsEvent.Redaction, relationsListeners.onChange);
		}
		function detachRelations(): void {
			const prev = relationsListeners.attached;
			if (!prev) return;
			prev.off(RelationsEvent.Remove, relationsListeners.onChange);
			prev.off(RelationsEvent.Redaction, relationsListeners.onChange);
			relationsListeners.attached = null;
		}

		const onResponses = (relations: Relations): void => {
			const entry = watched.get(pollId);
			if (!entry) return;
			entry.relations = relations;
			attachRelations(relations);
			recompute(pollId);
		};
		const onEnd = (): void => recompute(pollId);
		const onUndecryptable = (_count: number): void => recompute(pollId);
		// The SDK removes the poll from `room.polls` when its start event is
		// redacted (same hook); the timeline row is removed by the redaction
		// path, so only the watcher-side state needs cleanup here.
		const onBeforeRedaction = (): void => {
			const entry = watched.get(pollId);
			if (entry) {
				entry.detach();
				watched.delete(pollId);
			}
			snapshots.delete(pollId);
		};

		poll.on(PollEvent.Responses, onResponses);
		poll.on(PollEvent.End, onEnd);
		poll.on(PollEvent.UndecryptableRelations, onUndecryptable);
		poll.rootEvent.once(MatrixEventEvent.BeforeRedaction, onBeforeRedaction);

		const entry: WatchedPoll = {
			poll,
			start,
			relations: null,
			fetchFailed: false,
			detach() {
				poll.off(PollEvent.Responses, onResponses);
				poll.off(PollEvent.End, onEnd);
				poll.off(PollEvent.UndecryptableRelations, onUndecryptable);
				poll.rootEvent.off(MatrixEventEvent.BeforeRedaction, onBeforeRedaction);
				detachRelations();
			},
		};
		watched.set(pollId, entry);

		// Eagerly initialise the response relations: the SDK silently drops
		// live vote relations until this has run. During a real fetch,
		// tallies stream in through onResponses (the SDK emits
		// PollEvent.Responses per fetched page and once more on completion).
		// The resolved value must be consumed too: when the poll was fetched
		// before (re-watching a room), getResponses resolves from the SDK's
		// cache WITHOUT any emission, and the relations would otherwise
		// never attach.
		poll.getResponses().then(
			(relations) => {
				const current = watched.get(pollId);
				// Stale if the poll was unwatched (room switch / redaction).
				if (!current || current.poll !== poll) return;
				if (relations && current.relations !== relations) {
					onResponses(relations);
				}
			},
			(e: unknown) => {
				const current = watched.get(pollId);
				if (!current || current.poll !== poll) return;
				current.fetchFailed = true;
				console.error("Poll response fetch failed:", e);
				recompute(pollId);
			},
		);
	}

	function onPollNew(poll: Poll): void {
		// Only polls that have actually been projected into the timeline get
		// watched - `snapshots` holds exactly those. Others start watching
		// lazily on their first getSnapshot.
		if (!snapshots.has(poll.pollId) || watched.has(poll.pollId)) return;
		const start = parsePollStart(poll.rootEvent);
		if (!start) return;
		startWatching(poll, start);
		recompute(poll.pollId);
	}

	function unwatchAll(): void {
		for (const entry of watched.values()) entry.detach();
		watched.clear();
		snapshots.clear();
	}

	return {
		watchRoom(room: Room): void {
			if (watchedRoom?.roomId === room.roomId) return;
			watchedRoom?.off(PollEvent.New, onPollNew);
			unwatchAll();
			watchedRoom = room;
			room.on(PollEvent.New, onPollNew);
		},

		getSnapshot(startEvent: MatrixEvent, room: Room): PollSnapshot | null {
			const pollId = startEvent.getId();
			if (!pollId) return null;
			// A projection for a room other than the watched one (transient
			// during room switches) gets a throwaway snapshot: caching or
			// subscribing would leak state across rooms.
			const isWatchedRoom = watchedRoom?.roomId === room.roomId;
			if (isWatchedRoom) {
				const cached = snapshots.get(pollId);
				if (cached) return cached;
			}
			const start = parsePollStart(startEvent);
			if (!start) return null;
			const poll = room.polls.get(pollId);
			const snapshot = buildPollSnapshot({
				pollId,
				start,
				tally: null,
				isEnded: poll?.isEnded ?? false,
				undecryptableCount: poll?.undecryptableRelationsCount ?? 0,
				// When the SDK model exists, watching (below) kicks off the
				// response fetch, so results are genuinely loading. Without
				// it (pending local echo, start event still decrypting)
				// there is nothing to load yet.
				loadingResults: isWatchedRoom && poll !== undefined,
			});
			if (!isWatchedRoom) return snapshot;
			snapshots.set(pollId, snapshot);
			if (poll) startWatching(poll, start);
			return snapshot;
		},

		dispose(): void {
			watchedRoom?.off(PollEvent.New, onPollNew);
			watchedRoom = null;
			unwatchAll();
		},
	};
}
