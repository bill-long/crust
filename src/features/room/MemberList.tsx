import { type Component, createMemo, Match, Show, Switch } from "solid-js";
import { Virtualizer } from "virtua/solid";
import { useClient } from "../../client/client";
import { presenceOf } from "../../client/presence";
import { Avatar } from "../../components/Avatar";
import { avatarInitial } from "../../lib/avatar";
import {
	createFailedImageUrls,
	type FailedImageUrls,
} from "../../lib/imageFallback";
import { openProfileCard, profileAnchorKey } from "./profile/profileCard";
import {
	type MemberEntry,
	memberRowLabel,
	partitionByPresence,
	useMemberList,
} from "./useMemberList";

type FlatItem =
	| { type: "header"; role: string; count: number }
	| { type: "member"; member: MemberEntry };

/** Shared visual content for a member row (avatar + name + typing state). */
const MemberRowContent: Component<{
	member: MemberEntry;
	broken: FailedImageUrls;
}> = (props) => {
	return (
		<>
			<Avatar
				url={props.member.avatarUrl ?? null}
				initial={avatarInitial(props.member.displayName)}
				loading="lazy"
				broken={props.broken}
				presence={presenceOf(props.member.userId).status}
				// The panel is surface-1 at half alpha over the surface-0
				// shell, so an opaque ring reads as a lighter halo against
				// it. The avatar is circular and the dot sits at its
				// bottom-right corner, so most of the ring is over the row
				// rather than the picture - matching the row is what counts.
				presenceRingClass="ring-surface-1/50"
			/>
			<div class="min-w-0 flex-1 text-left">
				<div class="truncate text-sm">{props.member.displayName}</div>
				{/* Typing wins the second line: it is the more immediate
				    signal, and both at once would need a third row. */}
				<Show
					when={props.member.isTyping}
					fallback={
						<Show when={presenceOf(props.member.userId).statusMsg}>
							{(msg) => (
								<div class="truncate text-xs text-text-disabled">{msg()}</div>
							)}
						</Show>
					}
				>
					<div class="text-xs text-text-disabled">typing…</div>
				</Show>
			</div>
		</>
	);
};

const MemberRow: Component<{
	member: MemberEntry;
	roomId: string;
	/** Fail-closed avatar state, owned by the list - a typing notification
	 *  re-mints this member's entry, which remounts the row. */
	broken: FailedImageUrls;
}> = (props) => {
	return (
		<button
			type="button"
			class="flex w-full items-center gap-2 px-3 py-1.5 text-text-secondary hover:bg-surface-2/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
			// An aria-label replaces the button's contents for the accessible
			// name, so the dot and the status line inside it would otherwise
			// never be announced - and the whole point of the section split is
			// inaudible. Fold them in.
			aria-label={memberRowLabel(props.member, presenceOf(props.member.userId))}
			// The open card re-resolves its anchor to the re-minted row by
			// this key (typing/profile events re-mint entries constantly).
			data-profile-anchor={profileAnchorKey(props.roomId, props.member.userId)}
			onClick={(e) =>
				openProfileCard({
					userId: props.member.userId,
					roomId: props.roomId,
					anchor: e.currentTarget,
				})
			}
		>
			<MemberRowContent member={props.member} broken={props.broken} />
		</button>
	);
};

const MemberList: Component<{ roomId: string }> = (props) => {
	const { client } = useClient();
	// Fail-closed avatars, keyed by URL at the list level: a typing
	// notification re-mints that member's entry, so the row remounts and
	// per-row error state would re-paint the broken image (#457).
	const brokenAvatars = createFailedImageUrls();
	const { groups, memberCount, loading } = useMemberList(
		client,
		() => props.roomId,
	);

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
		// Presence is folded in here rather than in useMemberList's refresh,
		// which only runs on member and typing events - a presence change
		// would leave the sections stale. Reading it inside this memo is what
		// makes the split track.
		//
		// Cost, knowingly: this subscribes to every member's presence key, so
		// one person coming online re-runs the partition over the whole list.
		// The caches below keep row identity stable so virtua does not remount
		// anything, leaving an O(n) array rebuild. Membership and typing are
		// rAF-coalesced upstream in useMemberList; presence writes are not, so
		// a very large, very chatty room is where this would first show. Left
		// uncoalesced until it does, rather than adding timing machinery on
		// spec.
		const sections = partitionByPresence(
			groups(),
			(userId) => presenceOf(userId).status,
		);
		for (const group of sections) {
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
												roomId={props.roomId}
												broken={brokenAvatars}
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
