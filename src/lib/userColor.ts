/**
 * Per-sender name colors, Discord-style: every sender's display name renders
 * in one of a small fixed set of colors so a glance down the timeline
 * separates speakers without reading a single name.
 *
 * The bucket is derived from the sender's **full Matrix ID**, never their
 * display name - a rename must not move someone to a new color, and two users
 * sharing a display name must not share one.
 *
 * Six buckets against thousands of users means collisions are routine and
 * expected. The color is a visual hint only: never treat it as identity, and
 * never let a security or disambiguation decision rest on it.
 */

/** Tailwind classes for `--color-username-1..6` (src/styles/global.css).
 *  Spelled out as literals on purpose - Tailwind scans source text, so a
 *  computed `text-username-${n}` would generate no CSS at all. */
const USER_COLOR_CLASSES = [
	"text-username-1",
	"text-username-2",
	"text-username-3",
	"text-username-4",
	"text-username-5",
	"text-username-6",
] as const;

/**
 * Zero-based color bucket for a Matrix ID, in `[0, USER_COLOR_CLASSES.length)`.
 *
 * The hash is Java's `String.hashCode` (`hash * 31 + charCode`, wrapped to
 * 32 bits), as used by Cinny. Element's own hash is a plain sum of char codes,
 * which is order-insensitive and so collides on anagrams (`@ab:x` / `@ba:x`);
 * this one mixes position in, and the palette below still matches Element's.
 */
export function userColorIndex(userId: string): number {
	let hash = 0;
	for (let i = 0; i < userId.length; i += 1) {
		hash = (hash << 5) - hash + userId.charCodeAt(i);
		// Wrap to a signed 32-bit int, so long IDs can't drift into float
		// territory and lose the low bits the bucket is taken from.
		hash |= 0;
	}
	return Math.abs(hash) % USER_COLOR_CLASSES.length;
}

/**
 * Tailwind text-color class for a sender. Stable for the lifetime of the ID.
 * Callers pass the Matrix ID (`@user:server`), not a display name.
 */
export function userColorClass(userId: string): string {
	return USER_COLOR_CLASSES[userColorIndex(userId)] ?? USER_COLOR_CLASSES[0];
}
