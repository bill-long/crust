/**
 * Poll copy helpers shared by the in-app notification builder, the room-list
 * summary previews, and the service-worker push copy.
 *
 * Deliberately dependency-free (no matrix-js-sdk import): `pushCopy.ts` is
 * bundled into the service worker, so anything it pulls in must stay
 * SDK-free. Event-type matching is done with plain string comparison against
 * both the stable and the unstable (org.matrix.msc3381.*) prefixes instead
 * of the SDK's `M_POLL_START.matches`.
 */

/** MSC3381 poll-start event types: unstable prefix first (what Element and
 *  the SDK's PollStartEvent serializer put on the wire today), stable
 *  second. */
export const POLL_START_EVENT_TYPES = [
	"org.matrix.msc3381.poll.start",
	"m.poll.start",
] as const;

export function isPollStartType(type: string): boolean {
	return (POLL_START_EVENT_TYPES as readonly string[]).includes(type);
}

/** The MSC3381 poll-start payload block from event content, unstable key
 *  first (matching the wire order of {@link POLL_START_EVENT_TYPES}). */
function pollStartBlock(content: unknown): Record<string, unknown> | null {
	if (typeof content !== "object" || content === null) return null;
	const record = content as Record<string, unknown>;
	const start =
		record["org.matrix.msc3381.poll.start"] ?? record["m.poll.start"];
	if (typeof start !== "object" || start === null) return null;
	return start as Record<string, unknown>;
}

/** Raw text of an extensible-event text node (`org.matrix.msc1767.text` /
 *  `m.text` / legacy `body`), or null when unreadable. */
function textNode(node: unknown): string | null {
	if (typeof node !== "object" || node === null) return null;
	const n = node as Record<string, unknown>;
	const raw = n["org.matrix.msc1767.text"] ?? n["m.text"] ?? n.body;
	return typeof raw === "string" ? raw : null;
}

/**
 * Extract the poll question from `m.poll.start` event content. The question
 * is an extensible-event text node (see {@link textNode}).
 *
 * Returns the first non-empty line, trimmed, so the result is safe for
 * one-line surfaces (room-list preview, notification body). Null when the
 * content has no readable question (malformed or redacted poll).
 */
export function pollQuestionFromContent(content: unknown): string | null {
	const raw = textNode(pollStartBlock(content)?.question);
	if (raw === null) return null;
	const firstLine = raw.split("\n").find((line) => line.trim().length > 0);
	const trimmed = firstLine?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * SDK-free shape check that poll-start content would render as a poll row:
 * a readable question plus a non-empty answers array whose entries each
 * carry a string id and a readable text node. Approximates the timeline's
 * `parsePollStart` gate (which runs the SDK extensible-event parse) closely
 * enough that previews/notifications and the timeline can't disagree on
 * realistically malformed polls - e.g. a poll with a question but no
 * answers must neither notify nor preview, since the timeline drops it.
 */
export function isRenderablePollContent(content: unknown): boolean {
	if (pollQuestionFromContent(content) === null) return false;
	const answers = pollStartBlock(content)?.answers;
	if (!Array.isArray(answers) || answers.length === 0) return false;
	return answers.every(
		(answer) =>
			typeof (answer as Record<string, unknown>)?.id === "string" &&
			textNode(answer) !== null,
	);
}

/**
 * One-line "Poll: <question>" preview for the room list and notifications.
 * Null when the content isn't a readable poll start (callers then fall back
 * to their existing generic copy).
 */
export function pollPreviewText(content: unknown): string | null {
	const question = pollQuestionFromContent(content);
	return question ? `Poll: ${question}` : null;
}

/**
 * Notification-body copy for a poll start: the preview when the question is
 * readable, a plain "Poll" label otherwise. Shared by the in-app and
 * background-push notification builders so their fallback can't drift.
 */
export function pollNotificationBody(content: unknown): string {
	return pollPreviewText(content) ?? "Poll";
}

/** Cap on names spelled out in a voter-list label; longer lists truncate
 *  to "… and N more". Also the poll snapshot's per-answer voter-array cap:
 *  it is exactly what the UI can ever display (6 avatars + this label). */
export const MAX_VOTER_NAMES = 10;

/**
 * Comma-joined voter names for the event-card RSVP stack tooltip and its
 * sr-only text (#418). `names` is the (already capped) resolved voter list;
 * `total` is the true voter count for the answer - when it exceeds
 * {@link MAX_VOTER_NAMES} the label truncates to the first ten names plus
 * "and N more", so a large room can't build an unbounded label.
 */
export function formatVoterNames(
	names: readonly string[],
	total: number = names.length,
): string {
	if (total <= MAX_VOTER_NAMES) return names.join(", ");
	return `${names.slice(0, MAX_VOTER_NAMES).join(", ")} and ${total - MAX_VOTER_NAMES} more`;
}
