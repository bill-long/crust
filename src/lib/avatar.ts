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
 * Initial letter for an avatar's fallback circle: first character of the
 * name with any leading Matrix sigil stripped - @user, #alias, !room - so
 * "@alice:hs" renders "A", not "@"; uppercased; "?" when nothing usable
 * remains.
 */
export function avatarInitial(name: string): string {
	// Trim on both sides of the sigil strip: "  @alice" needs the leading
	// trim for the anchor to match, and "@ alice" needs the trailing trim so
	// the first character isn't the space the strip exposed.
	const trimmed = name
		.trim()
		.replace(/^[@#!]/, "")
		.trim();
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
