/**
 * Format a list of reaction senders into a Discord-style tooltip string:
 *
 *   1 sender    → "Alice reacted with X"
 *   2 senders   → "Alice and Bob reacted with X"
 *   3-5 senders → "Alice, Bob, and Carol reacted with X"  (Oxford comma)
 *   6+ senders  → "Alice, Bob, and 4 others reacted with X"
 *
 * `senders` are pre-resolved display names from the timeline aggregation
 * pass, so this helper does no member lookups itself.
 */
export function formatReactors(
	senders: { userId: string; name: string }[],
	label: string,
): string {
	const names = senders.map((s) => s.name);
	if (names.length === 0) return "";
	if (names.length === 1) return `${names[0]} reacted with ${label}`;
	if (names.length === 2)
		return `${names[0]} and ${names[1]} reacted with ${label}`;
	if (names.length <= 5) {
		const head = names.slice(0, -1).join(", ");
		return `${head}, and ${names[names.length - 1]} reacted with ${label}`;
	}
	const head = names.slice(0, 2).join(", ");
	return `${head}, and ${names.length - 2} others reacted with ${label}`;
}
