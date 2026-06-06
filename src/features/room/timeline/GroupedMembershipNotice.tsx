import { type Component, createMemo, For, Show } from "solid-js";
import { userSettings } from "../../../stores/settings";
import { formatFullDateTime, formatTime } from "./dateFormatting";
import { summarizeMembershipGroup } from "./membershipGrouping";
import { StateNoticeIcon } from "./StateNoticeIcon";
import {
	iconForTransitionKind,
	type MembershipTransitionKind,
} from "./stateNotice";

export interface GroupedMember {
	userId: string;
	name: string;
	avatarUrl: string | null;
}

interface GroupedMembershipNoticeProps {
	/** One entry per event in the run, in order (may contain duplicates). */
	members: readonly GroupedMember[];
	kind: MembershipTransitionKind;
	/** Event ID of the run's first event — kept as the row's jump anchor. */
	leaderEventId: string;
	/** Timestamp (ms) of the run's first event, shown on hover. */
	timestamp: number;
	/** Expand the group to show each individual notice. */
	onExpand: () => void;
}

const MAX_STACK = 3;

function initialOf(name: string): string {
	const trimmed = name.replace(/^@/, "").trim();
	return trimmed.charAt(0).toUpperCase() || "?";
}

/**
 * Collapsed summary row for a run of consecutive same-kind membership
 * transitions, e.g. "Alice, Bob and 3 others joined" with a Discord-style
 * stack of overlapping avatars. Clicking expands the run to the individual
 * notices. Styled to match the single-event state-notice one-liner.
 */
const GroupedMembershipNotice: Component<GroupedMembershipNoticeProps> = (
	props,
) => {
	const uniqueMembers = createMemo<GroupedMember[]>(() => {
		const seen = new Set<string>();
		const out: GroupedMember[] = [];
		for (const m of props.members) {
			if (!seen.has(m.userId)) {
				seen.add(m.userId);
				out.push(m);
			}
		}
		return out;
	});

	const summary = createMemo(() =>
		summarizeMembershipGroup(props.members, props.kind),
	);

	const stack = createMemo(() => uniqueMembers().slice(0, MAX_STACK));

	const formattedTime = createMemo(() =>
		formatTime(props.timestamp, userSettings().timeFormat),
	);
	const fullDateTime = createMemo(() =>
		formatFullDateTime(props.timestamp, userSettings().timeFormat),
	);

	return (
		<div
			data-event-id={props.leaderEventId}
			class="group flex items-center gap-3 px-4 py-0.5 hover:bg-surface-1/50"
			role="note"
		>
			<div class="flex w-8 shrink-0 justify-center text-text-faint">
				<StateNoticeIcon variant={iconForTransitionKind(props.kind)} />
			</div>
			<button
				type="button"
				onClick={() => props.onExpand()}
				aria-expanded="false"
				class="group/btn flex min-w-0 flex-1 items-center gap-2 rounded text-left text-xs text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:min-h-11"
			>
				<span class="flex shrink-0 -space-x-1.5" aria-hidden="true">
					<For each={stack()}>
						{(m) => (
							<Show
								when={m.avatarUrl}
								fallback={
									<span class="flex h-4 w-4 items-center justify-center rounded-full bg-surface-3 text-[8px] font-semibold text-text-secondary ring-2 ring-surface-0">
										{initialOf(m.name)}
									</span>
								}
							>
								{(url) => (
									<img
										src={url()}
										alt=""
										class="h-4 w-4 rounded-full object-cover ring-2 ring-surface-0"
									/>
								)}
							</Show>
						)}
					</For>
				</span>
				<span class="min-w-0 truncate">{summary()}</span>
				<svg
					class="h-3 w-3 shrink-0 transition-transform group-hover/btn:translate-y-px"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>
			<span
				class="shrink-0 text-[10px] text-text-faint opacity-0 transition-opacity select-none group-hover:opacity-100 group-focus-within:opacity-100"
				title={fullDateTime()}
				aria-hidden="true"
			>
				{formattedTime()}
			</span>
			<span class="sr-only"> • {fullDateTime()}</span>
		</div>
	);
};

export { GroupedMembershipNotice };
