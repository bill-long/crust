import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { useNavigate } from "@solidjs/router";
import {
	type Component,
	createMemo,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { Virtualizer } from "virtua/solid";
import { useClient } from "../../client/client";
import { Avatar } from "../../components/Avatar";
import { startDm } from "./startDm";
import { type MemberEntry, useMemberList } from "./useMemberList";

type FlatItem =
	| { type: "header"; role: string; count: number }
	| { type: "member"; member: MemberEntry };

/** First letter of a member's name for the avatar fallback. */
function avatarInitial(name: string): string {
	return name.replace(/^@/, "").charAt(0).toUpperCase() || "?";
}

/** Shared visual content for a member row (avatar + name + typing state). */
const MemberRowContent: Component<{ member: MemberEntry }> = (props) => {
	return (
		<>
			<Avatar
				url={props.member.avatarUrl ?? null}
				initial={avatarInitial(props.member.displayName)}
				loading="lazy"
			/>
			<div class="min-w-0 flex-1 text-left">
				<div class="truncate text-sm">{props.member.displayName}</div>
				<Show when={props.member.isTyping}>
					<div class="text-xs text-text-disabled">typing…</div>
				</Show>
			</div>
		</>
	);
};

const MemberRow: Component<{
	member: MemberEntry;
	isSelf: boolean;
	onMessage: (member: MemberEntry) => void;
}> = (props) => {
	const rowClass =
		"flex w-full items-center gap-2 px-3 py-1.5 text-text-secondary hover:bg-surface-2/50";

	return (
		<Show
			when={!props.isSelf}
			fallback={
				<div class={rowClass}>
					<MemberRowContent member={props.member} />
				</div>
			}
		>
			<DropdownMenu>
				<DropdownMenu.Trigger
					class={`${rowClass} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover`}
					aria-label={`Actions for ${props.member.displayName}`}
				>
					<MemberRowContent member={props.member} />
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content class="z-50 min-w-[180px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg">
						<DropdownMenu.Item
							class="cursor-pointer rounded px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
							onSelect={() => props.onMessage(props.member)}
						>
							Message
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu>
		</Show>
	);
};

const MemberList: Component<{ roomId: string }> = (props) => {
	const { client, optimisticallyMarkJoined } = useClient();
	const navigate = useNavigate();
	const { groups, memberCount, loading } = useMemberList(
		client,
		() => props.roomId,
	);

	const selfId = createMemo(() => client.getUserId());
	const [dmError, setDmError] = createSignal<string | null>(null);
	const [startingDm, setStartingDm] = createSignal(false);

	let mounted = true;
	onCleanup(() => {
		mounted = false;
	});

	const handleMessage = async (member: MemberEntry): Promise<void> => {
		if (startingDm()) return;
		setDmError(null);
		setStartingDm(true);
		try {
			const { roomId } = await startDm(client, member.userId);
			if (!mounted) return;
			optimisticallyMarkJoined(roomId, {
				name: member.displayName,
				avatarUrl: member.avatarUrl,
				isDirect: true,
			});
			navigate(`/dm/${encodeURIComponent(roomId)}`);
		} catch (err) {
			if (!mounted) return;
			setDmError(
				err instanceof Error
					? err.message
					: "Couldn't start the conversation. Please try again.",
			);
		} finally {
			if (mounted) setStartingDm(false);
		}
	};

	// Cache flat-item wrappers so item references stay stable across refreshes
	// when the underlying data hasn't changed. Virtua + Solid's <For> keys by
	// reference identity, so without this every typing/membership event would
	// remount every visible row.
	type HeaderItem = FlatItem & { type: "header" };
	type MemberItem = FlatItem & { type: "member" };
	const headerCache = new Map<string, HeaderItem>();
	const memberCache = new Map<string, MemberItem>();

	const flatItems = createMemo(() => {
		const items: FlatItem[] = [];
		const seenHeaders = new Set<string>();
		const seenMembers = new Set<string>();
		for (const group of groups()) {
			seenHeaders.add(group.role);
			let header = headerCache.get(group.role);
			if (!header || header.count !== group.members.length) {
				header = {
					type: "header",
					role: group.role,
					count: group.members.length,
				};
				headerCache.set(group.role, header);
			}
			items.push(header);
			for (const member of group.members) {
				seenMembers.add(member.userId);
				const cached = memberCache.get(member.userId);
				if (
					cached &&
					cached.member.displayName === member.displayName &&
					cached.member.avatarUrl === member.avatarUrl &&
					cached.member.powerLevel === member.powerLevel &&
					cached.member.isTyping === member.isTyping
				) {
					items.push(cached);
				} else {
					const next: MemberItem = { type: "member", member };
					memberCache.set(member.userId, next);
					items.push(next);
				}
			}
		}
		for (const role of headerCache.keys()) {
			if (!seenHeaders.has(role)) headerCache.delete(role);
		}
		for (const id of memberCache.keys()) {
			if (!seenMembers.has(id)) memberCache.delete(id);
		}
		return items;
	});

	let scrollRef: HTMLDivElement | undefined;

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

			<Show when={dmError()}>
				<p
					class="border-b border-border-subtle bg-danger-bg/30 px-4 py-2 text-xs text-danger-text"
					role="alert"
				>
					{dmError()}
				</p>
			</Show>

			{/* Virtualized member list */}
			<div ref={scrollRef} class="flex-1 overflow-y-auto">
				<Show
					when={!loading()}
					fallback={
						<div class="flex items-center justify-center py-8">
							<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
						</div>
					}
				>
					<Show
						when={memberCount() > 0}
						fallback={
							<div class="px-3 py-4 text-sm text-text-disabled">
								No members found
							</div>
						}
					>
						<Virtualizer scrollRef={scrollRef} data={flatItems()}>
							{(item) => (
								<Switch>
									<Match when={item.type === "header" && item}>
										{(h) => (
											<div class="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-text-disabled">
												{h().role} — {h().count}
											</div>
										)}
									</Match>
									<Match when={item.type === "member" && item}>
										{(m) => (
											<MemberRow
												member={m().member}
												isSelf={m().member.userId === selfId()}
												onMessage={(member) => void handleMessage(member)}
											/>
										)}
									</Match>
								</Switch>
							)}
						</Virtualizer>
					</Show>
				</Show>
			</div>
		</aside>
	);
};

export { MemberList };
