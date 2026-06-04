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
 *
 * `label` is the reaction key (typically an emoji or shortcode). It is
 * user-controlled, so we strip ASCII control characters (CR/LF/NUL/DEL,
 * etc.) and trim before interpolating into the tooltip / aria-label, and
 * fall back to a generic placeholder if the cleaned value is empty.
 */
function sanitizeLabel(label: string): string {
	let cleaned = "";
	for (let i = 0; i < label.length; i++) {
		const c = label.charCodeAt(i);
		if (c >= 0x20 && c !== 0x7f) cleaned += label[i];
	}
	cleaned = cleaned.trim();
	return cleaned || "this reaction";
}

export function formatReactors(
	senders: { userId: string; name: string }[],
	label: string,
): string {
	const safeLabel = sanitizeLabel(label);
	const n = senders.length;
	if (n === 0) return "";
	if (n === 1) return `${senders[0].name} reacted with ${safeLabel}`;
	if (n === 2)
		return `${senders[0].name} and ${senders[1].name} reacted with ${safeLabel}`;
	if (n <= 5) {
		const head = senders
			.slice(0, -1)
			.map((s) => s.name)
			.join(", ");
		return `${head}, and ${senders[n - 1].name} reacted with ${safeLabel}`;
	}
	return `${senders[0].name}, ${senders[1].name}, and ${n - 2} others reacted with ${safeLabel}`;
}
