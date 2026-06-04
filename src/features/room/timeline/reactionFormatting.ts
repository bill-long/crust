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
	const n = senders.length;
	if (n === 0) return "";
	if (n === 1) return `${senders[0].name} reacted with ${label}`;
	if (n === 2)
		return `${senders[0].name} and ${senders[1].name} reacted with ${label}`;
	if (n <= 5) {
		const head = senders
			.slice(0, -1)
			.map((s) => s.name)
			.join(", ");
		return `${head}, and ${senders[n - 1].name} reacted with ${label}`;
	}
	return `${senders[0].name}, ${senders[1].name}, and ${n - 2} others reacted with ${label}`;
}
