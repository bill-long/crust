import type { MatrixClient } from "matrix-js-sdk";

/**
 * Square-cropped http thumbnail URL for an avatar mxc URI, or null when
 * there is no mxc. `|| null` (not `??`): mxcUrlToHttp returns "" for
 * non-mxc input, and the avatar contract everywhere is null-or-URL
 * (#418 sentinel class).
 */
export function avatarHttpUrl(
	client: MatrixClient,
	mxc: string | null | undefined,
	size: number,
): string | null {
	if (!mxc) return null;
	return client.mxcUrlToHttp(mxc, size, size, "crop") || null;
}

/**
 * Invisible characters at the START of a name, skipped when picking the
 * initial.
 *
 * `String.trim` does not remove these - U+200B, U+3164 and friends are not
 * whitespace - so a name the display-name policy deliberately KEEPS, like
 * `<ZWSP>Admin`, would otherwise paint an empty circle instead of "A". The
 * policy is right to keep such a name (barring these breaks real ones); the
 * circle just has to look past them for a glyph it can draw.
 *
 * Whitespace is in the class so the skip cannot stall between an invisible
 * and a space: without it, `<ZWSP> <ZWSP>Admin` stops at the space and the
 * initial is a zero-width character again.
 */
const LEADING_INVISIBLES =
	/^[\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}\p{Cf}\p{White_Space}\u2800]+/u;

/**
 * Initial letter for an avatar's fallback circle: first character of the
 * name with any leading Matrix sigil stripped - @user, #alias, !room - so
 * "@alice:hs" renders "A", not "@"; uppercased; "?" when nothing usable
 * remains.
 */
export function avatarInitial(name: string): string {
	// Trim on both sides of the sigil strip: "  @alice" needs the leading
	// trim for the anchor to match, and "@ alice" needs the trailing trim so
	// the first character isn't the space the strip exposed.
	// Invisibles either side of the sigil strip: a leading one would stop
	// `^[@#!]` matching at all, and one sitting between the sigil and the name
	// would become the initial once the sigil is gone. The class includes
	// whitespace, because a single pass over invisibles alone stalls on any
	// mix of the two - `<ZWSP> <ZWSP>Admin` would stop at the space and paint
	// an empty circle, which is the bug this exists to prevent.
	const trimmed = name
		.replace(LEADING_INVISIBLES, "")
		.replace(/^[@#!]/, "")
		.replace(LEADING_INVISIBLES, "")
		.trimEnd();
	// codePointAt reads the full first code point, so an astral character
	// (an emoji-leading display name) stays whole instead of charAt()
	// splitting it into a lone surrogate that paints as a replacement
	// glyph - without allocating the whole string the way Array.from would.
	const cp = trimmed.codePointAt(0);
	if (cp === undefined) return "?";
	// toUpperCase can expand one code point into several ("ß" -> "SS");
	// keep only the first so the circle always holds a single glyph.
	const upper = String.fromCodePoint(cp).toUpperCase();
	const upperCp = upper.codePointAt(0);
	return upperCp === undefined ? "?" : String.fromCodePoint(upperCp);
}
