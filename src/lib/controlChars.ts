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

export { isControlCharCode };
