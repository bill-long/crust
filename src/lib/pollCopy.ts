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
 *  our own sends put on the wire today), stable second. */
export const POLL_START_EVENT_TYPES = [
	"org.matrix.msc3381.poll.start",
	"m.poll.start",
] as const;

export function isPollStartType(type: string): boolean {
	return (POLL_START_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Extract the poll question from `m.poll.start` event content, checking the
 * unstable content key first (matching the wire order of
 * {@link POLL_START_EVENT_TYPES}), then the stable one. The question itself
 * is an extensible-event text node, so its text lives under
 * `org.matrix.msc1767.text` / `m.text` / legacy `body`.
 *
 * Returns the first non-empty line, trimmed, so the result is safe for
 * one-line surfaces (room-list preview, notification body). Null when the
 * content has no readable question (malformed or redacted poll).
 */
export function pollQuestionFromContent(content: unknown): string | null {
	if (typeof content !== "object" || content === null) return null;
	const record = content as Record<string, unknown>;
	const start =
		record["org.matrix.msc3381.poll.start"] ?? record["m.poll.start"];
	if (typeof start !== "object" || start === null) return null;
	const question = (start as Record<string, unknown>).question;
	if (typeof question !== "object" || question === null) return null;
	const q = question as Record<string, unknown>;
	const raw = q["org.matrix.msc1767.text"] ?? q["m.text"] ?? q.body;
	if (typeof raw !== "string") return null;
	const firstLine = raw.split("\n").find((line) => line.trim().length > 0);
	const trimmed = firstLine?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
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
