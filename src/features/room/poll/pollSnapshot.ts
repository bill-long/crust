import {
	EventStatus,
	M_POLL_KIND_DISCLOSED,
	M_POLL_RESPONSE,
	type MatrixEvent,
} from "matrix-js-sdk";

/** One selectable poll option, projected to plain data for rendering. */
export interface PollAnswerOption {
	id: string;
	text: string;
}

/**
 * Static poll definition parsed from an `m.poll.start` event. Plain data so
 * the projection/render layers never hold SDK extensible-event instances.
 */
export interface PollStartInfo {
	question: string;
	answers: PollAnswerOption[];
	maxSelections: number;
	/**
	 * Result-visibility kind. Unknown kinds are treated as `undisclosed`
	 * per MSC3381 ("unknown kinds should be treated as undisclosed" - fail
	 * closed on revealing results).
	 */
	kind: "disclosed" | "undisclosed";
}

/**
 * Fully-projected poll view model carried on `TimelineEvent.poll`. Like the
 * media/reply/reaction fields, everything is pre-resolved plain data - the
 * renderer never touches the SDK `Poll` model. Snapshots are computed and
 * cached by `pollWatcher`, which re-projects the owning timeline row
 * whenever the underlying SDK poll state changes.
 */
export interface PollSnapshot {
	/** Poll id == the `m.poll.start` event id. */
	pollId: string;
	question: string;
	kind: "disclosed" | "undisclosed";
	maxSelections: number;
	answers: PollAnswerOption[];
	/**
	 * Vote count per answer id. Always contains a key for every answer in
	 * {@link PollSnapshot.answers} (zero-filled), so renderers can iterate
	 * `answers` and index `counts` without existence checks. Null-prototype
	 * map, consistent with the reaction aggregates.
	 */
	counts: Record<string, number>;
	/** Number of users with a currently-valid (non-spoiled) ballot. */
	totalVotes: number;
	/** The local user's currently-valid answer ids (empty when not voted). */
	myAnswers: string[];
	isEnded: boolean;
	/**
	 * Count of response relations that failed to decrypt. Non-zero means the
	 * tallies may be incomplete; the renderer surfaces a warning.
	 */
	undecryptableCount: number;
	/**
	 * True while the SDK is still fetching the response relations (or before
	 * the first page has been tallied), so the renderer can distinguish
	 * "0 votes" from "votes not loaded yet" without a layout change.
	 */
	loadingResults: boolean;
}

export interface PollTally {
	counts: Record<string, number>;
	totalVotes: number;
	myAnswers: string[];
}

/**
 * Parse the static poll definition from an `m.poll.start` MatrixEvent via
 * the SDK's extensible-event parse (`event.unstableExtensibleEvent`).
 *
 * The parse returns a matrix-events-sdk class instance whose identity
 * differs from matrix-js-sdk's own `PollStartEvent` re-implementation, so
 * this duck-types the fields it needs instead of `instanceof` (the js-sdk's
 * `Poll.pollEvent` does the same cast internally). Returns null when the
 * event isn't a parseable poll start (malformed content, redacted) - the
 * parse itself is exception-safe and yields undefined for invalid events.
 */
export function parsePollStart(event: MatrixEvent): PollStartInfo | null {
	if (event.isRedacted()) return null;
	const ext = event.unstableExtensibleEvent as unknown as
		| {
				question?: { text?: unknown };
				answers?: unknown;
				maxSelections?: unknown;
				rawKind?: unknown;
		  }
		| undefined;
	if (!ext) return null;
	const question = ext.question?.text;
	if (typeof question !== "string" || question.trim().length === 0) {
		return null;
	}
	if (!Array.isArray(ext.answers)) return null;
	const answers: PollAnswerOption[] = [];
	for (const answer of ext.answers as { id?: unknown; text?: unknown }[]) {
		if (typeof answer?.id !== "string" || typeof answer?.text !== "string") {
			return null;
		}
		answers.push({ id: answer.id, text: answer.text });
	}
	if (answers.length === 0) return null;
	const rawMax = ext.maxSelections;
	const maxSelections =
		typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
			? Math.floor(rawMax)
			: 1;
	const kind =
		typeof ext.rawKind === "string" &&
		M_POLL_KIND_DISCLOSED.matches(ext.rawKind)
			? "disclosed"
			: "undisclosed";
	return { question, answers, maxSelections, kind };
}

/**
 * Parse and validate one `m.poll.response` event's ballot against the poll
 * definition, mirroring matrix-js-sdk's `PollResponseEvent.validateAgainst`
 * (re-implemented on raw content to avoid constructing cross-package
 * extensible-event instances):
 * - missing / non-array / empty / non-string answers -> spoiled
 * - any unknown answer id -> the whole ballot is spoiled
 * - otherwise truncated to `maxSelections`
 *
 * On top of the SDK's validation, repeated answer ids are deduplicated
 * before truncation - the SDK does not, and a ballot like ["a", "a"] would
 * otherwise count one voter twice for the same option, pushing the
 * per-option percentage past 100%.
 *
 * Returns the valid answer ids, or null for a spoiled ballot (which
 * retracts the sender's vote).
 */
function parseBallot(
	content: Record<string, unknown>,
	start: PollStartInfo,
): string[] | null {
	const response = M_POLL_RESPONSE.findIn<{ answers?: unknown }>(content);
	const answers = response?.answers;
	if (!Array.isArray(answers) || answers.length === 0) return null;
	if (answers.some((a) => typeof a !== "string")) return null;
	const ids = [...new Set(answers as string[])];
	if (ids.some((id) => !start.answers.some((a) => a.id === id))) return null;
	return ids.slice(0, start.maxSelections);
}

/**
 * Tally poll responses into per-answer counts. Response events are expected
 * to come from the SDK `Poll` model's relations, which already filters to
 * poll-response types and drops votes cast after the poll ended.
 *
 * App-side rules on top (per MSC3381):
 * - one ballot per sender: latest by origin_server_ts wins, with the event
 *   id as a deterministic tiebreaker for identical timestamps
 * - failed (NOT_SENT) and cancelled local echoes are ignored, matching the
 *   reaction aggregation policy
 * - spoiled ballots (see {@link parseBallot}) retract the sender's vote
 */
export function computePollTally(
	responseEvents: readonly MatrixEvent[],
	start: PollStartInfo,
	myUserId: string | null,
): PollTally {
	const bestBySender = new Map<
		string,
		{ ts: number; eventId: string; answers: string[] | null }
	>();
	for (const event of responseEvents) {
		const status = event.status;
		if (status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED) {
			continue;
		}
		const sender = event.getSender();
		if (!sender) continue;
		const eventId = event.getId() ?? "";
		const ts = event.getTs();
		const current = bestBySender.get(sender);
		const isNewer =
			!current ||
			ts > current.ts ||
			(ts === current.ts && eventId > current.eventId);
		if (!isNewer) continue;
		bestBySender.set(sender, {
			ts,
			eventId,
			answers: parseBallot(event.getContent(), start),
		});
	}

	const counts = Object.create(null) as Record<string, number>;
	for (const answer of start.answers) counts[answer.id] = 0;
	let totalVotes = 0;
	let myAnswers: string[] = [];
	for (const [sender, ballot] of bestBySender) {
		if (ballot.answers === null) continue;
		totalVotes++;
		for (const id of ballot.answers) counts[id]++;
		if (myUserId && sender === myUserId) myAnswers = ballot.answers;
	}
	return { counts, totalVotes, myAnswers };
}

/**
 * Assemble a {@link PollSnapshot} from the static definition plus the
 * current tally and SDK poll state. `tally: null` builds the provisional
 * (zero-count) snapshot used before responses have been fetched - e.g. on
 * first projection of a poll row, or for a poll whose SDK model doesn't
 * exist yet (pending local echo, start event still decrypting).
 */
export function buildPollSnapshot(args: {
	pollId: string;
	start: PollStartInfo;
	tally: PollTally | null;
	isEnded: boolean;
	undecryptableCount: number;
	loadingResults: boolean;
}): PollSnapshot {
	// Normalize counts at the boundary so the documented PollSnapshot.counts
	// invariant (null-prototype, a zero-filled key for exactly every answer
	// id) holds regardless of what the caller's tally object looks like -
	// this also drops counts for answer ids that no longer exist after a
	// poll edit.
	const counts = Object.create(null) as Record<string, number>;
	for (const answer of args.start.answers) {
		counts[answer.id] = args.tally?.counts[answer.id] ?? 0;
	}
	return {
		pollId: args.pollId,
		question: args.start.question,
		kind: args.start.kind,
		maxSelections: args.start.maxSelections,
		answers: args.start.answers,
		counts,
		totalVotes: args.tally?.totalVotes ?? 0,
		myAnswers: args.tally?.myAnswers ?? [],
		isEnded: args.isEnded,
		undecryptableCount: args.undecryptableCount,
		loadingResults: args.loadingResults,
	};
}
