/**
 * True when `target` is (or sits inside) a text-editing surface — an
 * `<input>`, `<textarea>`, `<select>`, or an editable `contenteditable`
 * ancestor. Used by the push-to-talk/mute hotkey paths so a bound key never
 * hijacks the mic while the user is typing (e.g. in the composer).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	// Match any "editable" contenteditable ancestor. Listing the editable
	// values explicitly (rather than `[contenteditable]` alone) is critical
	// for nested cases like rich-editor widgets: a `contenteditable="false"`
	// island inside a `contenteditable="true"` host must NOT shadow the
	// editable host above it — bare `[contenteditable]` followed by
	// `closest()` would stop at the `false` element and incorrectly report
	// the target as non-typing.
	if (
		target.closest(
			'[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
		)
	) {
		return true;
	}
	return false;
}
