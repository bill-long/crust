import { useNavigate } from "@solidjs/router";
import { ClientEvent, type MatrixEvent } from "matrix-js-sdk";
import {
	type Component,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { useDecodedParams } from "../../app/useDecodedParams";
import { useClient } from "../../client/client";
import type { RoomSummary } from "../../client/summaries";
import {
	getDmRooms,
	getOrphanRooms,
	getSpaceRooms,
} from "../../client/summaries-selectors";
import {
	type DiscoverableRoom,
	type JoinState,
	useSpaceHierarchy,
} from "../space/useSpaceHierarchy";

/** Small bell-off icon for muted rooms. */
const BellOffBadge: Component = () => (
	<svg
		aria-label="Muted"
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0 text-text-disabled"
	>
		<path d="M6 13a2 2 0 0 0 4 0" />
		<path d="M12.5 10.5c-.7-.7-1.5-1.2-1.5-4.5a3 3 0 0 0-6 0c0 3.3-.8 3.8-1.5 4.5h9Z" />
		<line x1="2" y1="2" x2="14" y2="14" />
	</svg>
);

const RoomEntry: Component<{
	room: RoomSummary;
	isSelected: boolean;
	isMuted: boolean;
	onClick: () => void;
}> = (props) => {
	return (
		<button
			type="button"
			onClick={props.onClick}
			class={`flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors ${
				props.isSelected
					? "bg-surface-3 text-text-primary"
					: "text-text-secondary hover:bg-surface-2"
			}`}
			aria-current={props.isSelected ? "true" : undefined}
		>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1">
					<Show when={props.room.isEncrypted}>
						<span
							class="text-xs text-success-text"
							role="img"
							aria-label="Encrypted"
						>
							🔒
						</span>
					</Show>
					<span
						class="truncate text-sm font-medium"
						classList={{
							"text-text-disabled": props.isMuted && !props.isSelected,
						}}
					>
						{props.room.name.trim() || "Unnamed room"}
					</span>
					<Show when={props.isMuted}>
						<BellOffBadge />
					</Show>
				</div>
				<Show when={props.room.lastMessage}>
					<p class="truncate text-xs text-text-disabled">
						{props.room.lastMessage?.body}
					</p>
				</Show>
			</div>

			{/* Unread badge — hidden when muted */}
			<Show when={props.room.unreadCount > 0 && !props.isMuted}>
				<span
					class={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-text-primary ${
						props.room.highlightCount > 0 ? "bg-danger" : "bg-indicator"
					}`}
					role="status"
					aria-label={`${props.room.unreadCount} unread${props.room.highlightCount > 0 ? `, ${props.room.highlightCount} highlighted` : ""}`}
				>
					{props.room.unreadCount > 99 ? "99+" : props.room.unreadCount}
				</span>
			</Show>
		</button>
	);
};

const DiscoverEntry: Component<{
	room: DiscoverableRoom;
	joinState: JoinState;
	onJoin: () => void;
}> = (props) => {
	const isJoining = () => props.joinState === "joining";
	const isJoined = () => props.joinState === "joined";
	const isError = () => props.joinState === "error";

	return (
		<div class="flex w-full items-center gap-2 rounded px-3 py-2 text-text-muted">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1">
					<span class="truncate text-sm font-medium text-text-secondary">
						{props.room.name}
					</span>
					<span class="shrink-0 text-[10px] text-text-faint">
						{props.room.memberCount} members
					</span>
				</div>
				<Show when={props.room.topic}>
					<p class="truncate text-xs text-text-faint">{props.room.topic}</p>
				</Show>
			</div>

			<Show
				when={props.room.canJoin}
				fallback={
					<span
						class="shrink-0 text-[10px] text-text-faint"
						title="This room requires an invitation"
					>
						Invite only
					</span>
				}
			>
				<button
					type="button"
					onClick={props.onJoin}
					disabled={isJoining() || isJoined()}
					aria-label={
						isJoined()
							? `Joined ${props.room.name}`
							: isJoining()
								? `Joining ${props.room.name}`
								: isError()
									? `Retry joining ${props.room.name}`
									: `Join ${props.room.name}`
					}
					class={`shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors ${
						isJoined()
							? "bg-success-bg/50 text-success-text"
							: isError()
								? "bg-danger-bg/50 text-danger-text hover:bg-danger-strong/50"
								: isJoining()
									? "cursor-wait bg-surface-3 text-text-muted"
									: "bg-accent/80 text-text-primary hover:bg-accent"
					}`}
				>
					{isJoined()
						? "Joined"
						: isJoining()
							? "Joining…"
							: isError()
								? "Retry"
								: "Join"}
				</button>
			</Show>
		</div>
	);
};

const RoomList: Component = () => {
	const { client, summaries } = useClient();
	const params = useDecodedParams<{ spaceId?: string; roomId?: string }>();
	const navigate = useNavigate();

	// Tick signal that increments when push rules change, so mutedRooms recomputes
	const [pushRulesTick, setPushRulesTick] = createSignal(0);
	const onAccountData = (event: MatrixEvent): void => {
		if (event.getType() === "m.push_rules") {
			setPushRulesTick((n) => n + 1);
		}
	};
	client.on(ClientEvent.AccountData, onAccountData);
	onCleanup(() => {
		client.off(ClientEvent.AccountData, onAccountData);
	});

	// Precompute muted room set for O(1) lookups per room entry
	const mutedRooms = createMemo(() => {
		pushRulesTick();
		const muted = new Set<string>();
		const rules = client.pushRules;
		if (!rules) return muted;
		const overrides = rules.global?.override;
		if (overrides) {
			for (const r of overrides) {
				if (r.enabled === false) continue;
				if (
					r.rule_id.startsWith("crust.mute.") &&
					r.actions.some((a) => a === "dont_notify")
				) {
					muted.add(r.rule_id.slice("crust.mute.".length));
				}
			}
		}
		return muted;
	});

	const isMuted = (roomId: string): boolean => mutedRooms().has(roomId);

	const isHome = () => !params.spaceId;
	const selectedRoomId = () => params.roomId;

	const spaceRooms = createMemo(() => {
		if (isHome() || !params.spaceId) return [];
		return getSpaceRooms(summaries, params.spaceId);
	});

	const dmRooms = createMemo(() => getDmRooms(summaries));
	const orphanRooms = createMemo(() => getOrphanRooms(summaries));

	const spaceName = createMemo(() => {
		if (isHome() || !params.spaceId) return "Home";
		const name = summaries[params.spaceId]?.name;
		return name?.trim() ? name : "Space";
	});

	const hierarchy = useSpaceHierarchy(() => params.spaceId);

	const navigateToRoom = (roomId: string): void => {
		const room = summaries[roomId];
		if (!room) return;

		if (isHome()) {
			if (room.isDirect) {
				navigate(`/dm/${encodeURIComponent(roomId)}`);
			} else {
				navigate(`/home/${encodeURIComponent(roomId)}`);
			}
		} else if (params.spaceId) {
			navigate(
				`/space/${encodeURIComponent(params.spaceId)}/${encodeURIComponent(roomId)}`,
			);
		}
	};

	return (
		<aside class="flex h-full flex-col border-r border-border-subtle bg-surface-1/50">
			<div class="border-b border-border-subtle px-4 py-3">
				<span class="text-sm font-semibold text-text-secondary">
					{spaceName()}
				</span>
			</div>

			<div class="flex-1 overflow-y-auto p-1">
				<Show when={!isHome()}>
					<For each={spaceRooms()}>
						{(room) => (
							<RoomEntry
								room={room}
								isSelected={selectedRoomId() === room.roomId}
								isMuted={isMuted(room.roomId)}
								onClick={() => navigateToRoom(room.roomId)}
							/>
						)}
					</For>
					<Show
						when={
							spaceRooms().length === 0 &&
							!hierarchy.loading &&
							!hierarchy.error &&
							hierarchy.discoverableRooms.length === 0 &&
							!hierarchy.truncated
						}
					>
						<p class="px-3 py-4 text-center text-xs text-text-faint">
							No rooms in this space
						</p>
					</Show>

					{/* Discoverable rooms section */}
					<Show when={hierarchy.loading}>
						<div class="px-3 pb-1 pt-3">
							<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
								Discover
							</span>
						</div>
						<div class="flex items-center justify-center py-4">
							<div class="h-4 w-4 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
						</div>
					</Show>

					<Show
						when={!hierarchy.loading && hierarchy.discoverableRooms.length > 0}
					>
						<div class="px-3 pb-1 pt-3">
							<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
								Discover
							</span>
						</div>
						<For each={hierarchy.discoverableRooms}>
							{(room) => (
								<DiscoverEntry
									room={room}
									joinState={hierarchy.joinState(room.roomId)}
									onJoin={() => hierarchy.joinRoom(room.roomId)}
								/>
							)}
						</For>
					</Show>

					<Show when={!hierarchy.loading && hierarchy.truncated}>
						<div class="flex justify-center py-2">
							<button
								type="button"
								onClick={() => hierarchy.loadMore()}
								disabled={hierarchy.loadingMore}
								class="rounded px-3 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis disabled:cursor-wait disabled:opacity-50"
							>
								{hierarchy.loadingMore ? "Loading…" : "Load more rooms"}
							</button>
						</div>
					</Show>

					<Show when={!hierarchy.loading && hierarchy.error}>
						<p class="px-3 py-2 text-center text-xs text-danger-text/70">
							Could not load discoverable rooms
						</p>
					</Show>
				</Show>

				<Show when={isHome()}>
					{/* DMs section */}
					<Show when={dmRooms().length > 0}>
						<div class="px-3 pb-1 pt-2">
							<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
								Direct Messages
							</span>
						</div>
						<For each={dmRooms()}>
							{(room) => (
								<RoomEntry
									room={room}
									isSelected={selectedRoomId() === room.roomId}
									isMuted={isMuted(room.roomId)}
									onClick={() => navigateToRoom(room.roomId)}
								/>
							)}
						</For>
					</Show>

					{/* Orphan rooms section */}
					<Show when={orphanRooms().length > 0}>
						<div class="px-3 pb-1 pt-2">
							<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
								Rooms
							</span>
						</div>
						<For each={orphanRooms()}>
							{(room) => (
								<RoomEntry
									room={room}
									isSelected={selectedRoomId() === room.roomId}
									isMuted={isMuted(room.roomId)}
									onClick={() => navigateToRoom(room.roomId)}
								/>
							)}
						</For>
					</Show>

					<Show when={dmRooms().length === 0 && orphanRooms().length === 0}>
						<p class="px-3 py-4 text-center text-xs text-text-faint">
							No rooms yet
						</p>
					</Show>
				</Show>
			</div>
		</aside>
	);
};

export { RoomList };
