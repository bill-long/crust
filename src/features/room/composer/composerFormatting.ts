import type { Accessor } from "solid-js";

interface ComposerFormattingDeps {
	/** Live getter for the composer textarea (a `let` ref in the caller). */
	getTextarea: () => HTMLTextAreaElement | undefined;
	text: Accessor<string>;
	setText: (value: string) => void;
	autoResize: () => void;
}

/**
 * Formatting-toolbar actions for the composer. Each helper reads the live
 * text() signal and the textarea selection at call time, applies a pure text
 * transform, then restores focus + caret in a rAF (mirroring onEmojiSelect).
 * They mutate only the shared text() signal - no new cross-room state - so they
 * lift out of the composer as a plain factory over the textarea/text deps.
 */
export function createComposerFormatting(deps: ComposerFormattingDeps) {
	/**
	 * Apply a pure text transform to the current selection. `transform` receives
	 * the selected text plus the text before/after it and returns the new full
	 * value with the selection range to restore.
	 */
	const applyFormat = (
		transform: (
			sel: string,
			before: string,
			after: string,
		) => { value: string; selStart: number; selEnd: number },
	): void => {
		const el = deps.getTextarea();
		if (!el) return;
		const value = deps.text();
		const start = el.selectionStart;
		const end = el.selectionEnd;
		const result = transform(
			value.slice(start, end),
			value.slice(0, start),
			value.slice(end),
		);
		deps.setText(result.value);
		deps.autoResize();
		// Don't run mention detection here: formatting never inserts an `@`
		// trigger, and the caret hasn't moved to its new spot yet (that happens
		// in the rAF below), so detecting now would read a stale position.
		requestAnimationFrame(() => {
			const ta = deps.getTextarea();
			if (!ta) return;
			ta.focus();
			ta.setSelectionRange(result.selStart, result.selEnd);
		});
	};

	/** Wrap the selection in `marker` on each side (e.g. `**`, `*`, `` ` ``). */
	const wrapInline = (marker: string): void => {
		applyFormat((sel, before, after) => {
			const inner = before.length + marker.length;
			return {
				value: `${before}${marker}${sel}${marker}${after}`,
				selStart: inner,
				selEnd: inner + sel.length,
			};
		});
	};

	/** Insert a `[label](url)` link template, selecting the `url` placeholder. */
	const insertLink = (): void => {
		applyFormat((sel, before, after) => {
			const label = sel || "text";
			const url = "url";
			const urlStart = before.length + 1 + label.length + 2; // "[" label "]("
			return {
				value: `${before}[${label}](${url})${after}`,
				selStart: urlStart,
				selEnd: urlStart + url.length,
			};
		});
	};

	/** Prefix every line touched by the selection with `prefix` (lists/quotes). */
	const prefixLines = (prefix: string): void => {
		applyFormat((sel, before, after) => {
			const lineStart = before.lastIndexOf("\n") + 1;
			const head = before.slice(0, lineStart);
			const region = before.slice(lineStart) + sel;
			const prefixed = region
				.split("\n")
				.map((l) => `${prefix}${l}`)
				.join("\n");
			const value = `${head}${prefixed}${after}`;
			// With no selection, keep a collapsed caret at its original spot,
			// shifted by the single prefix inserted ahead of it, so the next
			// keystroke continues typing instead of overwriting the line.
			if (sel === "") {
				const caret = before.length + prefix.length;
				return { value, selStart: caret, selEnd: caret };
			}
			return {
				value,
				selStart: head.length,
				selEnd: head.length + prefixed.length,
			};
		});
	};

	return { wrapInline, insertLink, prefixLines };
}
