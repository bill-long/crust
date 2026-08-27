import type { Component } from "solid-js";
import { buildSnippetHtml } from "../lib/highlightSnippet";
import type { SearchHit } from "../lib/searchHit";

function formatHitTime(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) {
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	return d.toLocaleDateString([], {
		month: "short",
		day: "numeric",
		year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
}

const SearchResultRow: Component<{
	hit: SearchHit;
	terms: string[];
	focused: boolean;
	rowId: string;
	/** `true` when activated from the keyboard, so callers can decide
	 *  whether focus needs to be placed somewhere afterwards. */
	onJump: (viaKeyboard: boolean) => void;
	onFocus: () => void;
	rowRef?: (el: HTMLElement | null) => void;
	/**
	 * Extra context folded into the accessible name - the room, for global
	 * results. A listbox may only contain options, so a visual grouping
	 * heading is invisible to assistive tech; saying it per option is what
	 * makes the grouping audible.
	 */
	contextLabel?: string;
}> = (props) => {
	return (
		<div
			id={props.rowId}
			role="option"
			aria-selected={props.focused}
			tabIndex={props.focused ? 0 : -1}
			ref={(el) => props.rowRef?.(el)}
			onClick={() => props.onJump(false)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					e.stopPropagation();
					props.onJump(true);
				}
			}}
			onFocus={() => props.onFocus()}
			class="group flex w-full cursor-pointer flex-col gap-1 rounded-md border border-transparent bg-surface-2/40 px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
		>
			{/* The hint names both keys the handler accepts. Saying only
			    Enter told a screen-reader user that Space would not work,
			    which is the one group that has nothing else to go on. */}
			<span class="sr-only">
				Search result
				{props.contextLabel ? ` in ${props.contextLabel}` : ""}, press Enter or
				Space to jump to message:{" "}
			</span>
			<div class="flex items-baseline gap-2">
				<span class="truncate text-xs font-semibold text-text-emphasis">
					{props.hit.senderName}
				</span>
				<span class="shrink-0 text-[11px] text-text-disabled">
					{formatHitTime(props.hit.timestamp)}
				</span>
			</div>
			<div
				class="line-clamp-3 text-xs text-text-secondary [&_mark]:rounded-sm [&_mark]:bg-accent/30 [&_mark]:px-0.5 [&_mark]:text-text-emphasis"
				innerHTML={buildSnippetHtml(props.hit.body, props.terms)}
			/>
		</div>
	);
};

export { SearchResultRow };
