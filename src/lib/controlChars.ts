/**
 * The single definition of "control character" for user-controlled strings
 * that flow into UI labels.
 *
 * ASCII C0 range (0x00-0x1F) plus DEL (0x7F). Both the reject path
 * (`hasControlChar`) and the sanitize path (`stripControlChars`) key off this
 * one predicate, so the policy cannot drift between them - and it lives in
 * `lib/` because the rule is not specific to any feature: the timeline, the
 * poll watcher, presence status messages, and the login return-to path all
 * need the same answer.
 */
function isControlCharCode(code: number): boolean {
	return code < 0x20 || code === 0x7f;
}

/**
 * Whether a string contains any control character.
 *
 * Use to reject a user-controlled string wholesale - filenames, download
 * attributes, redirect targets - where a CR/LF/NUL could corrupt rendering or
 * mislead a downstream consumer.
 */
export function hasControlChar(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (isControlCharCode(s.charCodeAt(i))) return true;
	}
	return false;
}

/**
 * Remove control characters from a single-line string destined for a UI label,
 * leaving the rest intact.
 *
 * Unlike {@link hasControlChar}, which rejects wholesale, this keeps the
 * surrounding text readable. Newlines are control characters and so are
 * removed: callers that want to keep them use the timeline's
 * `sanitizeMultiline`, which shares this predicate.
 */
export function stripControlChars(s: string): string {
	return replaceControlChars(s, "");
}

/**
 * Replace control characters with `replacement`.
 *
 * Dropping them outright is right for a filename, and wrong for prose: a
 * newline between two words vanishes and glues them together. Callers
 * rendering user sentences substitute a space and collapse whitespace
 * afterwards.
 */
export function replaceControlChars(s: string, replacement: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		out += isControlCharCode(s.charCodeAt(i)) ? replacement : s[i];
	}
	return out;
}

/**
 * Longest display name worth rendering.
 *
 * `displayname` is server-controlled and unbounded on the wire - Synapse caps
 * it at 256 characters, but a federated or self-hosted server need not - and
 * names are re-checked for every member on every membership or typing event.
 * Far past any name worth showing in a row that truncates anyway.
 */
const MAX_NAME_LENGTH = 1024;

/**
 * A display name to render, or `fallback` when the supplied one would corrupt
 * the line it is rendered on.
 *
 * Rejects wholesale rather than cleaning up, which is the rule the timeline
 * and the poll watcher already follow. Cleaning is not safe here:
 * `RoomMember.name` is disambiguated by the SDK against the *raw* displayname
 * map, so a member calling themselves `A<NUL>dmin` is not seen as a duplicate
 * of the real `Admin` and gets no user-ID suffix - and stripping the control
 * character would then render exactly `Admin`. Falling back to the user ID
 * fails closed.
 *
 * Trimmed before it is judged, because `String.trim` removes tab, newline and
 * friends, which are themselves control characters: testing first would
 * reject a pasted `"Ann Smith` + `\n"` outright and show the bare MXID for a
 * name that is perfectly good once trimmed. The impersonation case is about
 * *interior* characters and survives the reordering.
 *
 * This covers what corrupts *rendering*, and is not a general defence against
 * names that merely look alike - Cyrillic `A` is a different character that
 * renders identically, which no character filter resolves. Invisible and
 * bidirectional characters are a real gap here and are tracked separately;
 * this matches the policy already in the codebase rather than adding a
 * second one.
 */
export function displayNameOr(
	raw: string | null | undefined,
	fallback: string,
): string {
	if (!raw) return fallback;
	if (raw.length > MAX_NAME_LENGTH) return fallback;
	const name = raw.trim();
	if (!name) return fallback;
	return hasControlChar(name) ? fallback : name;
}

export { isControlCharCode };
