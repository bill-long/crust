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
import { threadJumpTarget } from "../../../lib/threadEvents";
import { hasControlChar } from "../timeline/timelineHelpers";
import { type EventInfo, parseEventBlock } from "./eventBlock";
import {
	PollEndEvent,
	PollResponseEvent,
	sendSerializedPollEvent,
} from "./pollSdk";
import {
	buildPollSnapshot,
	computePollTally,
	MAX_VOTER_NAME_LENGTH,
	type PollSnapshot,
	type PollStartInfo,
	type PollVoter,
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
	 * A watched poll returns its latest computed snapshot from the cache.
	 * Otherwise this builds a fresh provisional zero-count snapshot from the
	 * event content (so edits are always reflected) and - when the SDK
	 * `Poll` model exists - starts watching it, kicking off the (async,
	 * paginated) response fetch; each response page then recomputes the
	 * snapshot and re-projects the row via `onUpdate`. Returns null when the
	 * event isn't a parseable poll start.
	 */
	getSnapshot(startEvent: MatrixEvent, room: Room): PollSnapshot | null;
	/**
	 * Cast (or change) the local user's vote. Optimistic: the snapshot
	 * reflects the new ballot immediately; the pending overlay clears when
	 * the sent response event arrives back through the poll's relations. On
	 * send failure the tally reverts and the snapshot carries
	 * `failedAnswers` for a Retry affordance. An empty `answerIds` array
	 * sends a spoiled ballot - the MSC3381 vote retraction.
	 */
	votePoll(pollId: string, answerIds: string[]): Promise<void>;
	/**
	 * Close the poll (creator only - see PollSnapshot.canEnd). Optimistic
	 * only to the "Ending..." state: undisclosed results are not revealed
	 * until the confirmed end event flips `isEnded`, so a failed send never
	 * flashes results that must stay hidden.
	 */
	endPoll(pollId: string): Promise<void>;
	/** Remove every SDK listener and drop all cached state. */
	dispose(): void;
}

interface WatchedPoll {
	poll: Poll;
	start: PollStartInfo;
	/** Validated event-card block from the start event's content; refreshed
	 *  alongside `start` on edits. */
	event: EventInfo | null;
	/** Response relations, once the first fetch/emission has delivered them.
	 *  Single source of truth for which Relations object the change
	 *  listeners are attached to. */
	relations: Relations | null;
	/** True when the initial response fetch rejected (tallies stay at the
	 *  provisional zero state, but the loading indicator must not spin
	 *  forever). */
	fetchFailed: boolean;
	/**
	 * Voter-id → resolved voter cache. Resolution (member lookup, name
	 * normalization, avatar URL building) happens once per voter instead
	 * of on every recompute (recomputes fire per fetched relation page
	 * during the initial fetch), and the identity-stable objects let the
	 * renderer's <For> reuse avatar DOM instead of remounting it. Never
	 * invalidated: name/avatar changes already wait for the next tally
	 * event (the reaction aggregation's point-in-time policy), so a stale
	 * cache entry is no staler than an uncached recompute would be.
	 */
	voterCache: Map<string, PollVoter>;
	/**
	 * In-flight optimistic vote. `sentEventId` is filled once the send
	 * resolves; the overlay clears when that exact event id shows up in the
	 * poll's relations (the remote echo round-tripped) - id-matched, not
	 * timestamp-heuristic, so clock skew can't mis-clear it. Object
	 * identity guards against rapid re-votes: each votePoll installs a new
	 * object and only mutates/clears its own.
	 */
	pendingVote: { answers: string[]; sentEventId: string | null } | null;
	/**
	 * The last failed vote send, for the Retry affordance. `baseline` is
	 * the confirmed ballot at failure time: when the confirmed ballot later
	 * changes (e.g. the user voted successfully from another device), the
	 * failure is obsolete and clears, so its Retry can never stomp a newer
	 * cross-device vote.
	 */
	failedVote: { answers: string[]; baseline: string[] } | null;
	endPending: boolean;
	endFailed: boolean;
	detach(): void;
}

/** Ballots are sets: different devices/serializers can emit the same
 *  selections in a different order, so compare order-insensitively (ids are
 *  already deduped by the ballot validation). */
function sameBallot(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id) => b.includes(id));
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
	/** Latest computed snapshot per WATCHED poll. Only recompute() writes
	 *  here: unwatched polls (pending local echo, start event still
	 *  decrypting) are re-derived from event content on every projection so
	 *  edits and redactions are always reflected. */
	const snapshots = new Map<string, PollSnapshot>();
	/** Poll ids that have been projected into the timeline at least once.
	 *  Gates onPollNew so only polls with a visible row get watched. */
	const projectedPolls = new Set<string>();

	function recompute(pollId: string): void {
		const entry = watched.get(pollId);
		if (!entry) return;
		const relationEvents = entry.relations?.getRelations() ?? null;
		// The optimistic vote overlay retires once its own response event is
		// visible in the relations - from then on the confirmed tally
		// already contains the ballot.
		if (
			entry.pendingVote?.sentEventId &&
			relationEvents?.some((e) => e.getId() === entry.pendingVote?.sentEventId)
		) {
			entry.pendingVote = null;
		}
		// A confirmed end retires ALL optimistic/failure vote state: the SDK
		// filters post-end responses out of the relations, so an in-flight
		// overlay could otherwise never clear (permanently corrupting the
		// displayed final tally), and a vote-failure Retry / end-failure
		// Retry can no longer accomplish anything.
		if (entry.poll.isEnded) {
			entry.endPending = false;
			entry.endFailed = false;
			entry.pendingVote = null;
			entry.failedVote = null;
		}
		// With a pending vote but no fetched relations yet, tally over an
		// empty response set so the optimistic ballot still shows; the real
		// counts merge in when the fetch lands.
		const tally =
			relationEvents || entry.pendingVote
				? computePollTally(
						relationEvents ?? [],
						entry.start,
						client.getUserId(),
						entry.pendingVote?.answers,
					)
				: null;
		// A vote failure is obsolete once the confirmed ballot moved past
		// its baseline (a newer vote landed, e.g. from another device).
		if (
			entry.failedVote &&
			!entry.pendingVote &&
			tally &&
			!sameBallot(tally.myAnswers, entry.failedVote.baseline)
		) {
			entry.failedVote = null;
		}
		const loadingResults = entry.relations
			? entry.poll.isFetchingResponses
			: !entry.fetchFailed;
		// Resolve voter ids to display names/avatars from the watched room's
		// membership (the watcher is the SDK seam; the snapshot stays plain
		// data). Same name policy as the reaction aggregation: trimmed
		// display name, control chars rejected, user id as fallback; wire
		// names are additionally length-capped so a 10-name tooltip label
		// stays bounded. Results are cached per voter (see
		// WatchedPoll.voterCache) so a recompute is tally + sort only.
		const resolveVoter = (userId: string): PollVoter => {
			const cached = entry.voterCache.get(userId);
			if (cached) return cached;
			const member = watchedRoom?.getMember(userId);
			const rawName = member?.name?.trim().slice(0, MAX_VOTER_NAME_LENGTH);
			const mxc = member?.getMxcAvatarUrl();
			const voter: PollVoter = {
				userId,
				name: rawName && !hasControlChar(rawName) ? rawName : userId,
				// || (not ??): mxcUrlToHttp returns "" for non-mxc input, and
				// the PollVoter contract is null-or-URL.
				avatarUrl: mxc
					? client.mxcUrlToHttp(mxc, 32, 32, "crop") || null
					: null,
			};
			entry.voterCache.set(userId, voter);
			return voter;
		};
		snapshots.set(
			pollId,
			buildPollSnapshot({
				pollId,
				start: entry.start,
				tally,
				isEnded: entry.poll.isEnded,
				undecryptableCount: entry.poll.undecryptableRelationsCount,
				loadingResults,
				event: entry.event,
				resolveVoter,
				interaction: {
					canVote: !entry.poll.isEnded && !entry.endPending,
					hasPendingVote: entry.pendingVote !== null,
					failedAnswers: entry.failedVote?.answers ?? null,
					endPending: entry.endPending,
					endFailed: entry.endFailed,
					canEnd:
						!entry.poll.isEnded &&
						client.getUserId() === entry.poll.rootEvent.getSender(),
				},
			}),
		);
		onUpdate(pollId);
	}

	function unwatch(pollId: string): void {
		const entry = watched.get(pollId);
		if (entry) {
			entry.detach();
			watched.delete(pollId);
		}
		snapshots.delete(pollId);
	}

	function startWatching(poll: Poll, start: PollStartInfo): void {
		const pollId = poll.pollId;
		if (watched.has(pollId)) return;

		const onRelationsChange = (_event: MatrixEvent): void => recompute(pollId);
		function attachRelations(entry: WatchedPoll, relations: Relations): void {
			if (entry.relations === relations) return;
			detachRelations(entry);
			entry.relations = relations;
			relations.on(RelationsEvent.Remove, onRelationsChange);
			relations.on(RelationsEvent.Redaction, onRelationsChange);
		}
		function detachRelations(entry: WatchedPoll): void {
			const prev = entry.relations;
			if (!prev) return;
			prev.off(RelationsEvent.Remove, onRelationsChange);
			prev.off(RelationsEvent.Redaction, onRelationsChange);
			entry.relations = null;
		}

		const onResponses = (relations: Relations): void => {
			const entry = watched.get(pollId);
			if (!entry) return;
			attachRelations(entry, relations);
			recompute(pollId);
		};
		const onEnd = (): void => recompute(pollId);
		const onUndecryptable = (_count: number): void => recompute(pollId);
		// Poll start edited (m.replace): the SDK has already applied the
		// replacement to getContent() and invalidated the extensible-event
		// parse cache, so re-derive the static definition and re-tally -
		// existing ballots are validated against the NEW answer ids, matching
		// what a fresh projection would compute.
		const onReplaced = (): void => {
			const entry = watched.get(pollId);
			if (!entry) return;
			const newStart = parsePollStart(poll.rootEvent);
			if (newStart) {
				entry.start = newStart;
				entry.event = parseEventBlock(poll.rootEvent.getContent());
				recompute(pollId);
			} else {
				// The edit made the poll unparseable; drop the stale snapshot
				// and let the row re-project (isDisplayable filters it out).
				unwatch(pollId);
				onUpdate(pollId);
			}
		};
		// Fires both for a pending local redaction (markLocallyRedacted, with
		// the SENDING/QUEUED redaction echo) and for a confirmed one
		// (makeRedacted, with a server-confirmed status-null redaction).
		// Only tear down on the confirmed form: dropping the watch for a
		// pending redaction that later fails would freeze the poll at a
		// zero-vote provisional snapshot for the rest of the session.
		const onBeforeRedaction = (
			_event: MatrixEvent,
			redactionEvent: MatrixEvent,
		): void => {
			if (redactionEvent.status != null) return;
			// The timeline row is removed by the redaction path; only the
			// watcher-side state needs cleanup here (the SDK deletes the poll
			// from room.polls via its own listener on the same emission).
			unwatch(pollId);
		};

		poll.on(PollEvent.Responses, onResponses);
		poll.on(PollEvent.End, onEnd);
		poll.on(PollEvent.UndecryptableRelations, onUndecryptable);
		poll.rootEvent.on(MatrixEventEvent.Replaced, onReplaced);
		poll.rootEvent.on(MatrixEventEvent.BeforeRedaction, onBeforeRedaction);

		const entry: WatchedPoll = {
			poll,
			start,
			event: parseEventBlock(poll.rootEvent.getContent()),
			relations: null,
			fetchFailed: false,
			voterCache: new Map(),
			pendingVote: null,
			failedVote: null,
			endPending: false,
			endFailed: false,
			detach() {
				poll.off(PollEvent.Responses, onResponses);
				poll.off(PollEvent.End, onEnd);
				poll.off(PollEvent.UndecryptableRelations, onUndecryptable);
				poll.rootEvent.off(MatrixEventEvent.Replaced, onReplaced);
				poll.rootEvent.off(MatrixEventEvent.BeforeRedaction, onBeforeRedaction);
				detachRelations(entry);
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
				console.error(
					`Poll response fetch failed for ${pollId} in ${poll.roomId}:`,
					e,
				);
				recompute(pollId);
			},
		);
	}

	function onPollNew(poll: Poll): void {
		// Only polls that have actually been projected into the timeline get
		// watched. Others start watching lazily on their first getSnapshot.
		if (!projectedPolls.has(poll.pollId) || watched.has(poll.pollId)) return;
		const start = parsePollStart(poll.rootEvent);
		if (!start) return;
		startWatching(poll, start);
		recompute(poll.pollId);
	}

	function unwatchAll(): void {
		for (const entry of watched.values()) entry.detach();
		watched.clear();
		snapshots.clear();
		projectedPolls.clear();
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
				projectedPolls.add(pollId);
				const cached = snapshots.get(pollId);
				if (cached) return cached;
			}
			const start = parsePollStart(startEvent);
			if (!start) return null;
			const poll = room.polls.get(pollId);
			if (isWatchedRoom && poll) {
				// First projection of a poll with an SDK model: subscribe and
				// kick off the response fetch. recompute() populates the
				// cache asynchronously; until then fall through to a fresh
				// provisional snapshot below.
				startWatching(poll, start);
			}
			return buildPollSnapshot({
				pollId,
				start,
				tally: null,
				isEnded: poll?.isEnded ?? false,
				undecryptableCount: poll?.undecryptableRelationsCount ?? 0,
				// When the SDK model exists, the watch kicked off the
				// response fetch, so results are genuinely loading. Without
				// it (pending local echo, start event still decrypting)
				// there is nothing to load yet.
				loadingResults: isWatchedRoom && poll !== undefined,
				event: parseEventBlock(startEvent.getContent()),
			});
		},

		async votePoll(pollId: string, answerIds: string[]): Promise<void> {
			const entry = watched.get(pollId);
			const room = watchedRoom;
			// Voting needs a watched poll (an SDK model behind it) that is
			// still open: the SDK filters post-end responses out of the
			// relations, so a vote sent after (or racing) the end would
			// install an overlay that can never clear. The renderer disables
			// options in all of these states (snapshot.canVote); this is the
			// fail-closed backstop.
			if (!entry || !room || entry.poll.isEnded || entry.endPending) return;
			entry.failedVote = null;
			const pending = {
				answers: answerIds,
				sentEventId: null as string | null,
			};
			entry.pendingVote = pending;
			recompute(pollId);
			try {
				const res = await sendSerializedPollEvent(
					client,
					room.roomId,
					PollResponseEvent.from(answerIds, pollId),
					// A poll living IN a thread gets its responses sent via the
					// SDK's thread overload (issue #332): the m.reference
					// relation is untouched, but the local echo routes into the
					// thread's timeline instead of the room's pending list.
					// threadJumpTarget (not rootEvent.threadRootId): the getter
					// returns a thread ROOT's own id once someone opens a thread
					// on the poll message, and a main-timeline poll's votes must
					// keep null routing regardless.
					{ threadId: threadJumpTarget(entry.poll.rootEvent) ?? null },
				);
				const current = watched.get(pollId);
				// Stale if unwatched meanwhile, or superseded by a newer vote.
				if (!current || current.pendingVote !== pending) return;
				pending.sentEventId = res.event_id;
				// The remote echo may already have arrived; recompute applies
				// the id-matched clear either way.
				recompute(pollId);
			} catch (e) {
				const current = watched.get(pollId);
				if (!current || current.pendingVote !== pending) return;
				current.pendingVote = null;
				// Baseline = the confirmed ballot right now; if it changes
				// later (a newer vote landed, e.g. from another device), the
				// failure is obsolete and recompute clears it.
				current.failedVote = {
					answers: answerIds,
					baseline: current.relations
						? computePollTally(
								current.relations.getRelations(),
								current.start,
								client.getUserId(),
							).myAnswers
						: [],
				};
				console.error(`Poll vote failed for ${pollId} in ${room.roomId}:`, e);
				recompute(pollId);
			}
		},

		async endPoll(pollId: string): Promise<void> {
			const entry = watched.get(pollId);
			const room = watchedRoom;
			if (!entry || !room || entry.poll.isEnded || entry.endPending) return;
			// Fail-closed mirror of PollSnapshot.canEnd: only the creator may
			// close, even if a UI bug or future caller invokes this directly
			// (the homeserver would accept the event; other clients would
			// rightly ignore it and disagree with ours).
			if (client.getUserId() !== entry.poll.rootEvent.getSender()) return;
			entry.endFailed = false;
			entry.endPending = true;
			recompute(pollId);
			try {
				await sendSerializedPollEvent(
					client,
					room.roomId,
					PollEndEvent.from(pollId, "The poll has ended."),
					// Same thread routing as votePoll (issue #332).
					{ threadId: threadJumpTarget(entry.poll.rootEvent) ?? null },
				);
				// endPending intentionally stays set: it clears when the
				// confirmed end event round-trips (PollEvent.End ->
				// recompute sees poll.isEnded), so undisclosed results only
				// reveal on a server-confirmed close.
			} catch (e) {
				const current = watched.get(pollId);
				if (!current) return;
				current.endPending = false;
				current.endFailed = true;
				console.error(`Poll end failed for ${pollId} in ${room.roomId}:`, e);
				recompute(pollId);
			}
		},

		dispose(): void {
			watchedRoom?.off(PollEvent.New, onPollNew);
			watchedRoom = null;
			unwatchAll();
		},
	};
}
