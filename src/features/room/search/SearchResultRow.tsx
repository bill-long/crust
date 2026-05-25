import { type Component, Show } from "solid-js";
import { buildSnippetHtml } from "./highlightSnippet";
import type { SearchHit } from "./useRoomSearch";

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
	onJump: () => void;
	onFocus: () => void;
	rowRef?: (el: HTMLElement | null) => void;
}> = (props) => {
	return (
		<div
			id={props.rowId}
			role="option"
			aria-selected={props.focused}
			tabIndex={props.focused ? 0 : -1}
			ref={(el) => props.rowRef?.(el)}
			onClick={() => props.onJump()}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					e.stopPropagation();
					props.onJump();
				}
			}}
			onFocus={() => props.onFocus()}
			class="group flex w-full cursor-pointer flex-col gap-1 rounded-md border border-transparent bg-surface-2/40 px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
			aria-label={`Search result from ${props.hit.senderName}, jump to message`}
		>
			<div class="flex items-baseline gap-2">
				<span class="truncate text-xs font-semibold text-text-emphasis">
					{props.hit.senderName}
				</span>
				<span class="shrink-0 text-[11px] text-text-disabled">
					{formatHitTime(props.hit.timestamp)}
				</span>
			</div>
			<Show
				when={props.hit.body}
				fallback={
					<span class="italic text-xs text-text-muted">(non-text message)</span>
				}
			>
				<div
					class="line-clamp-3 text-xs text-text-secondary [&_mark]:rounded-sm [&_mark]:bg-accent/30 [&_mark]:px-0.5 [&_mark]:text-text-emphasis"
					innerHTML={buildSnippetHtml(props.hit.body, props.terms)}
				/>
			</Show>
		</div>
	);
};

export { SearchResultRow };
