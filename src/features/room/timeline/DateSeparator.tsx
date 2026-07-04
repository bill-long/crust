import type { Component } from "solid-js";

/**
 * Date separator row rendered between messages sent on different days. Purely
 * presentational - the timeline computes the human label (relative "Today" /
 * "Yesterday" or an absolute date) and passes it in.
 */
const DateSeparator: Component<{ label: string }> = (props) => (
	<div class="flex items-center gap-3 px-4 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-text-muted uppercase select-none">
		<div class="h-px flex-1 bg-border-default" aria-hidden="true" />
		<span>{props.label}</span>
		<div class="h-px flex-1 bg-border-default" aria-hidden="true" />
	</div>
);

export { DateSeparator };
