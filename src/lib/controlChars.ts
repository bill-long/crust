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
 * Mandatory line breaks that are not C0 control characters.
 *
 * U+0085 NEL, U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are UAX #14
 * class BK/NL - hard breaks in a browser, exactly like U+000A - but they sit
 * above DEL, so {@link isControlCharCode} does not see them.
 *
 * A code-point test rather than a regex, matching the rest of this module:
 * a `/g` regex is stateful under `.test()` and needs its `lastIndex` reset by
 * hand, which is correct only until someone edits around it.
 */
function isHardBreakCode(code: number): boolean {
	return code === 0x85 || code === 0x2028 || code === 0x2029;
}

/** Whether a string contains a mandatory line break of any kind. */
export function hasLineBreaker(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (isControlCharCode(c) || isHardBreakCode(c)) return true;
	}
	return false;
}

/**
 * Remove everything that can force a line break: control characters, DEL, and
 * the three hard breaks above DEL.
 *
 * The escape for single-line sinks that must keep the text rather than hide
 * it - a plain-text export header, an OS notification title. Distinct from
 * {@link stripControlChars}, which is the filename-shaped rule and stops at
 * DEL: a filename with U+2028 in it is odd but harmless, whereas a heading
 * with one in it silently becomes two lines, the second reading as its own
 * claim.
 *
 * One pass, not `stripControlChars` plus a replace: these are untrusted and
 * can be long, and the intermediate string bought nothing.
 */
export function stripLineBreakers(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (!isControlCharCode(c) && !isHardBreakCode(c)) out += s[i];
	}
	return out;
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
 * Bidi scope controls: the embeddings and overrides U+202A-U+202E and the
 * isolates U+2066-U+2069, initiators and terminators alike.
 *
 * An initiator opens a directional scope that per UAX #9 runs to its
 * terminator or, when unmatched, to the end of the paragraph. Nothing makes
 * a wire string balanced, so an unmatched one reorders whatever is rendered
 * after it: the rest of a "<name> will be signed out" sentence, the tail of
 * an aria-label, the extension of a filename. Element strips only the two
 * overrides (`removeDirectionOverrideChars`); the embeddings and isolates leak
 * the same way, and its pattern predates the isolates (Unicode 6.3), so this
 * is the full set. The terminators are inert on their own and go with their
 * initiators, so a balanced pair is never left half-stripped.
 *
 * Stripping, never rejecting: the string is still the user's. The accepted
 * cost is a BALANCED pair in a genuinely mixed-direction name - with
 * `<RLI>` and `<PDI>` around Hebrew letters followed by `Ltd`, the isolate puts
 * `Ltd` left of the Hebrew and the strip leaves it on the right, because
 * Crust's name slots are LTR blocks. That rendering is wrong but legible and
 * stays inside the name's own box; an unmatched initiator reorders someone
 * else's text. The marks U+200E, U+200F and U+061C carry no scope, are how an
 * RTL run sits correctly beside LTR text, and stay - the SDK's display-name
 * disambiguation rule keys on the first two.
 *
 * Defined here rather than in `displayName.ts` because the filename rule
 * (#574) needs the same set, and two copies of it would drift.
 */
const BIDI_SCOPE_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Remove bidi scope controls, keeping everything else.
 *
 * A regex where the rest of this module loops, deliberately: display names go
 * through this for every member on every typing tick, and `replace` measured
 * at half a scan-and-copy loop's cost on a clean name and a third of it on a
 * 1024-character hostile one. The module's caveat about `/g` is about
 * `lastIndex` under `.test()`; `replace` always starts from zero and resets it.
 */
export function stripBidiControls(s: string): string {
	return s.replace(BIDI_SCOPE_CONTROLS, "");
}

export { isControlCharCode };
