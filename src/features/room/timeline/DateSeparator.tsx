import type { Component } from "solid-js";
import { Show } from "solid-js";

/**
 * Day-boundary marker rendered between messages sent on different days.
 *
 * Normally a bare rule: the date lives inline in each message group header
 * (see `formatHeaderTimestamp`), so labelling the boundary too would be
 * redundant - and the label was the expensive part, costing ~24px of
 * padding plus a text row at every boundary.
 *
 * `showLabel` restores the visible label for the boundaries where the row
 * below cannot state its own date - state notices, emotes, collapsed
 * membership runs and blocked senders. `dateSeparatorMode` owns that
 * decision; see the invariant documented there.
 *
 * The label is always present for screen readers, since the rows that do
 * carry a date announce it as part of a longer header string that is easy
 * to miss when skimming by boundary.
 */
const DateSeparator: Component<{ label: string; showLabel: boolean }> = (
	props,
) => (
	<Show
		when={props.showLabel}
		fallback={
			<div class="px-4 py-2 select-none">
				<div class="h-px bg-border-default" aria-hidden="true" />
				<span class="sr-only">{props.label}</span>
			</div>
		}
	>
		<div class="flex items-center gap-3 px-4 py-2 text-[11px] font-semibold text-text-muted select-none">
			<div class="h-px flex-1 bg-border-default" aria-hidden="true" />
			<span>{props.label}</span>
			<div class="h-px flex-1 bg-border-default" aria-hidden="true" />
		</div>
	</Show>
);

export { DateSeparator };
