import { createVirtualizer } from "@tanstack/solid-virtual";
import {
	type Component,
	For,
	Match,
	Show,
	Switch,
	createMemo,
} from "solid-js";
import { useClient } from "../../client/client";
import { type MemberEntry, useMemberList } from "./useMemberList";

type FlatItem =
	| { type: "header"; role: string; count: number }
	| { type: "member"; member: MemberEntry };

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

const MemberList: Component<{ roomId: string }> = (props) => {
	const { client } = useClient();
	const { groups, memberCount, loading } = useMemberList(
		client,
		() => props.roomId,
	);

	const flatItems = createMemo(() => {
		const items: FlatItem[] = [];
		for (const group of groups()) {
			items.push({
				type: "header",
				role: group.role,
				count: group.members.length,
			});
			for (const member of group.members) {
				items.push({ type: "member", member });
			}
		}
		return items;
	});

	let scrollRef: HTMLDivElement | undefined;

	const virtualizer = createVirtualizer({
		get count() {
			return flatItems().length;
		},
		getScrollElement: () => scrollRef ?? null,
		estimateSize: (index: number) => {
			const item = flatItems()[index];
			return item?.type === "header" ? 30 : 44;
		},
		overscan: 10,
		getItemKey: (index: number) => {
			const item = flatItems()[index];
			if (!item) return index;
			return item.type === "header"
				? `header:${item.role}`
				: `member:${item.member.userId}`;
		},
	});

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
					<div
						style={{
							height: `${virtualizer.getTotalSize()}px`,
							position: "relative",
						}}
					>
						<For each={virtualizer.getVirtualItems()}>
							{(vItem) => {
								const item = () => flatItems()[vItem.index];
								return (
									<Show when={item()}>
										{(current) => (
											<div
												data-index={vItem.index}
												ref={(el) => virtualizer.measureElement(el)}
												style={{
													position: "absolute",
													top: `${vItem.start}px`,
													left: 0,
													width: "100%",
												}}
											>
												<Switch>
													<Match
														when={
															current().type === "header" &&
															(current() as FlatItem & { type: "header" })
														}
													>
														{(h) => (
															<div class="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-text-disabled">
																{h().role} — {h().count}
															</div>
														)}
													</Match>
													<Match
														when={
															current().type === "member" &&
															(current() as FlatItem & { type: "member" })
														}
													>
														{(m) => <MemberRow member={m().member} />}
													</Match>
												</Switch>
											</div>
										)}
									</Show>
								);
							}}
						</For>
					</div>
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
