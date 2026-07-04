import type { Component } from "solid-js";

interface FormattingToolbarProps {
	/** Wrap the current selection in `marker` on each side (bold `**`, italic
	 *  `*`, strikethrough `~~`, inline code `` ` ``). */
	onWrap: (marker: string) => void;
	/** Insert a `[label](url)` link template. */
	onLink: () => void;
	/** Prefix every line the selection touches with `prefix` (list `- `,
	 *  quote `> `). */
	onPrefix: (prefix: string) => void;
	/** Whether the live preview panel is currently open. */
	previewOpen: boolean;
	/** Toggle the live preview panel. */
	onTogglePreview: () => void;
	/** Make the toolbar inert (e.g. while the recording bar overlays the
	 *  composer, a toolbar action would silently edit hidden text). */
	inert?: boolean;
}

/**
 * Formatting button row above the composer input: bold, italic, strikethrough,
 * inline code, link, bulleted list, quote, and the preview toggle. Purely
 * presentational - every button calls back into the composer, which owns the
 * textarea and text state.
 *
 * `preventDefault` on mousedown keeps focus (and thus the selection) on the
 * textarea when a button is pressed, so the wrap helpers read a live selection
 * and the textarea's blur side effects don't fire.
 */
const FormattingToolbar: Component<FormattingToolbarProps> = (props) => {
	return (
		<div
			role="toolbar"
			aria-label="Text formatting"
			class="mb-1.5 flex items-center gap-0.5 text-text-disabled"
			inert={props.inert || undefined}
			onMouseDown={(e) => e.preventDefault()}
		>
			<button
				type="button"
				class="h-7 w-7 rounded font-bold transition-colors hover:bg-surface-3 hover:text-text-secondary"
				aria-label="Bold (Ctrl/Cmd+B)"
				title="Bold (Ctrl/Cmd+B)"
				onClick={() => props.onWrap("**")}
			>
				B
			</button>
			<button
				type="button"
				class="h-7 w-7 rounded italic transition-colors hover:bg-surface-3 hover:text-text-secondary"
				aria-label="Italic (Ctrl/Cmd+I)"
				title="Italic (Ctrl/Cmd+I)"
				onClick={() => props.onWrap("*")}
			>
				I
			</button>
			<button
				type="button"
				class="h-7 w-7 rounded line-through transition-colors hover:bg-surface-3 hover:text-text-secondary"
				aria-label="Strikethrough (Ctrl/Cmd+Shift+X)"
				title="Strikethrough (Ctrl/Cmd+Shift+X)"
				onClick={() => props.onWrap("~~")}
			>
				S
			</button>
			<button
				type="button"
				class="h-7 w-7 rounded font-mono text-xs transition-colors hover:bg-surface-3 hover:text-text-secondary"
				aria-label="Inline code (Ctrl/Cmd+E)"
				title="Inline code (Ctrl/Cmd+E)"
				onClick={() => props.onWrap("`")}
			>
				{"<>"}
			</button>
			<button
				type="button"
				class="h-7 w-7 rounded transition-colors hover:bg-surface-3 hover:text-text-secondary"
				aria-label="Link"
				title="Link"
				onClick={() => props.onLink()}
			>
				🔗
			</button>
			<button
				type="button"
				class="h-7 w-7 rounded transition-colors hover:bg-surface-3 hover:text-text-secondary"
				aria-label="Bulleted list"
				title="Bulleted list"
				onClick={() => props.onPrefix("- ")}
			>
				☰
			</button>
			<button
				type="button"
				class="h-7 w-7 rounded transition-colors hover:bg-surface-3 hover:text-text-secondary"
				aria-label="Quote"
				title="Quote"
				onClick={() => props.onPrefix("> ")}
			>
				❝
			</button>
			{/* Toggle a live render of the draft through the receive-side pipeline.
			    Stable accessible name + aria-pressed (not a changing label) so
			    screen readers announce the on/off state once. */}
			<button
				type="button"
				class="ml-auto h-7 rounded px-2 text-xs transition-colors hover:bg-surface-3 hover:text-text-secondary"
				classList={{
					"bg-surface-3": props.previewOpen,
					"text-text-secondary": props.previewOpen,
				}}
				aria-label="Preview"
				aria-pressed={props.previewOpen}
				title="Preview formatted message"
				onClick={() => props.onTogglePreview()}
			>
				Preview
			</button>
		</div>
	);
};

export { FormattingToolbar };
