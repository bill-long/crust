import { type Component, For, Show } from "solid-js";
import { useClient } from "../../client/client";
import {
	type MemberEntry,
	type MemberGroup,
	useMemberList,
} from "./useMemberList";

/** Placeholder avatar for members without a profile image. */
const AvatarFallback: Component<{ name: string }> = (props) => {
	const initial = (): string => {
		const ch = props.name.replace(/^@/, "").charAt(0).toUpperCase();
		return ch || "?";
	};
	return (
		<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-text-secondary">
			{initial()}
		</div>
	);
};

const MemberRow: Component<{ member: MemberEntry }> = (props) => {
	return (
		<div class="flex items-center gap-2 px-3 py-1.5 text-text-secondary hover:bg-surface-2/50">
			<Show
				when={props.member.avatarUrl}
				fallback={<AvatarFallback name={props.member.displayName} />}
			>
				{(url) => (
					<img
						src={url()}
						alt=""
						class="h-8 w-8 shrink-0 rounded-full object-cover"
						loading="lazy"
					/>
				)}
			</Show>
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm">{props.member.displayName}</div>
				<Show when={props.member.isTyping}>
					<div class="text-xs text-text-disabled">typing…</div>
				</Show>
			</div>
		</div>
	);
};

const RoleGroupSection: Component<{ group: MemberGroup }> = (props) => {
	return (
		<div>
			<div class="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-text-disabled">
				{props.group.role} — {props.group.members.length}
			</div>
			<For each={props.group.members}>
				{(member) => <MemberRow member={member} />}
			</For>
		</div>
	);
};

const MemberList: Component<{ roomId: string }> = (props) => {
	const { client } = useClient();
	const { groups, memberCount, loading } = useMemberList(
		client,
		() => props.roomId,
	);

	return (
		<aside
			class="flex h-full flex-col bg-surface-1/50"
			aria-label="Room members"
		>
			{/* Header */}
			<div class="flex h-12 shrink-0 items-center border-b border-border-subtle px-4">
				<span class="text-sm font-semibold text-text-secondary">
					Members
					<Show when={!loading()}>
						<span class="ml-1 text-text-disabled">({memberCount()})</span>
					</Show>
				</span>
			</div>

			{/* Member list */}
			<div class="flex-1 overflow-y-auto">
				<Show
					when={!loading()}
					fallback={
						<div class="flex items-center justify-center py-8">
							<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
						</div>
					}
				>
					<For each={groups()}>
						{(group) => <RoleGroupSection group={group} />}
					</For>
					<Show when={memberCount() === 0}>
						<div class="px-3 py-4 text-sm text-text-disabled">
							No members found
						</div>
					</Show>
				</Show>
			</div>
		</aside>
	);
};

export { MemberList };
