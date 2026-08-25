/**
 * Validated read of an `m.room.topic` content's plain-text topic.
 *
 * The single place that guards against a malformed (non-string) `topic`
 * payload - and, when MSC3765 rich topics land, the single place to add
 * the `m.topic` fallback. Every topic reader (room header, settings
 * general tab, state notices) goes through this so they can't silently
 * disagree on what counts as a topic.
 *
 * Returns `""` when the content is absent or the topic is not a string.
 */
export function roomTopicText(
	content: Record<string, unknown> | null | undefined,
): string {
	const topic = content?.topic;
	return typeof topic === "string" ? topic : "";
}

/**
 * {@link roomTopicText} normalized to a single display line: whitespace
 * runs (including newlines) collapse to one space, ends trimmed. For
 * one-line surfaces like the room header; pair with the raw text in a
 * tooltip when the line structure matters.
 */
export function roomTopicLine(
	content: Record<string, unknown> | null | undefined,
): string {
	return roomTopicText(content).replace(/\s+/g, " ").trim();
}
