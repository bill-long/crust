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
		<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-xs font-semibold text-neutral-300">
			{initial()}
		</div>
	);
};

const MemberRow: Component<{ member: MemberEntry }> = (props) => {
	return (
		<div class="flex items-center gap-2 px-3 py-1.5 text-neutral-300 hover:bg-neutral-800/50">
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
					<div class="text-xs text-neutral-500">typing…</div>
				</Show>
			</div>
		</div>
	);
};

const RoleGroupSection: Component<{ group: MemberGroup }> = (props) => {
	return (
		<div>
			<div class="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">
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
			class="flex h-full flex-col bg-neutral-900/50"
			aria-label="Room members"
		>
			{/* Header */}
			<div class="flex h-12 shrink-0 items-center border-b border-neutral-800 px-4">
				<span class="text-sm font-semibold text-neutral-300">
					Members
					<Show when={!loading()}>
						<span class="ml-1 text-neutral-500">({memberCount()})</span>
					</Show>
				</span>
			</div>

			{/* Member list */}
			<div class="flex-1 overflow-y-auto">
				<Show
					when={!loading()}
					fallback={
						<div class="flex items-center justify-center py-8">
							<div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-pink-500" />
						</div>
					}
				>
					<For each={groups()}>
						{(group) => <RoleGroupSection group={group} />}
					</For>
					<Show when={memberCount() === 0}>
						<div class="px-3 py-4 text-sm text-neutral-500">
							No members found
						</div>
					</Show>
				</Show>
			</div>
		</aside>
	);
};

export default MemberList;
