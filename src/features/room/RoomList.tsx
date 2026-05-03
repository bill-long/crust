import { useNavigate, useParams } from "@solidjs/router";
import { type Component, createMemo, For, Show } from "solid-js";
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

const RoomEntry: Component<{
	room: RoomSummary;
	isSelected: boolean;
	onClick: () => void;
}> = (props) => {
	return (
		<button
			type="button"
			onClick={props.onClick}
			class={`flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors ${
				props.isSelected
					? "bg-neutral-700 text-white"
					: "text-neutral-300 hover:bg-neutral-800"
			}`}
			aria-current={props.isSelected ? "true" : undefined}
		>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1">
					<Show when={props.room.isEncrypted}>
						<span
							class="text-xs text-green-500"
							role="img"
							aria-label="Encrypted"
						>
							🔒
						</span>
					</Show>
					<span class="truncate text-sm font-medium">
						{props.room.name.trim() || "Unnamed room"}
					</span>
				</div>
				<Show when={props.room.lastMessage}>
					<p class="truncate text-xs text-neutral-500">
						{props.room.lastMessage?.body}
					</p>
				</Show>
			</div>

			{/* Unread badge */}
			<Show when={props.room.unreadCount > 0}>
				<span
					class={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ${
						props.room.highlightCount > 0 ? "bg-red-500" : "bg-neutral-500"
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
		<div class="flex w-full items-center gap-2 rounded px-3 py-2 text-neutral-400">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1">
					<span class="truncate text-sm font-medium text-neutral-300">
						{props.room.name}
					</span>
					<span class="shrink-0 text-[10px] text-neutral-600">
						{props.room.memberCount} members
					</span>
				</div>
				<Show when={props.room.topic}>
					<p class="truncate text-xs text-neutral-600">{props.room.topic}</p>
				</Show>
			</div>

			<Show
				when={props.room.canJoin}
				fallback={
					<span
						class="shrink-0 text-[10px] text-neutral-600"
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
								: `Join ${props.room.name}`
					}
					class={`shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors ${
						isJoined()
							? "bg-green-900/50 text-green-400"
							: isError()
								? "bg-red-900/50 text-red-400 hover:bg-red-800/50"
								: isJoining()
									? "cursor-wait bg-neutral-700 text-neutral-400"
									: "bg-pink-600/80 text-white hover:bg-pink-600"
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
	const { summaries } = useClient();
	const params = useParams<{ spaceId?: string; roomId?: string }>();
	const navigate = useNavigate();

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
		<aside class="flex h-full flex-col border-r border-neutral-800 bg-neutral-900/50">
			<div class="border-b border-neutral-800 px-4 py-3">
				<span class="text-sm font-semibold text-neutral-300">
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
						<p class="px-3 py-4 text-center text-xs text-neutral-600">
							No rooms in this space
						</p>
					</Show>

					{/* Discoverable rooms section */}
					<Show when={hierarchy.loading}>
						<div class="px-3 pb-1 pt-3">
							<span class="text-xs font-semibold uppercase tracking-wider text-neutral-500">
								Discover
							</span>
						</div>
						<div class="flex items-center justify-center py-4">
							<div class="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-pink-500" />
						</div>
					</Show>

					<Show
						when={!hierarchy.loading && hierarchy.discoverableRooms.length > 0}
					>
						<div class="px-3 pb-1 pt-3">
							<span class="text-xs font-semibold uppercase tracking-wider text-neutral-500">
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
						<p class="px-3 py-2 text-center text-[10px] text-neutral-600">
							Some rooms not shown
						</p>
					</Show>

					<Show when={!hierarchy.loading && hierarchy.error}>
						<p class="px-3 py-2 text-center text-xs text-red-400/70">
							Could not load discoverable rooms
						</p>
					</Show>
				</Show>

				<Show when={isHome()}>
					{/* DMs section */}
					<Show when={dmRooms().length > 0}>
						<div class="px-3 pb-1 pt-2">
							<span class="text-xs font-semibold uppercase tracking-wider text-neutral-500">
								Direct Messages
							</span>
						</div>
						<For each={dmRooms()}>
							{(room) => (
								<RoomEntry
									room={room}
									isSelected={selectedRoomId() === room.roomId}
									onClick={() => navigateToRoom(room.roomId)}
								/>
							)}
						</For>
					</Show>

					{/* Orphan rooms section */}
					<Show when={orphanRooms().length > 0}>
						<div class="px-3 pb-1 pt-2">
							<span class="text-xs font-semibold uppercase tracking-wider text-neutral-500">
								Rooms
							</span>
						</div>
						<For each={orphanRooms()}>
							{(room) => (
								<RoomEntry
									room={room}
									isSelected={selectedRoomId() === room.roomId}
									onClick={() => navigateToRoom(room.roomId)}
								/>
							)}
						</For>
					</Show>

					<Show when={dmRooms().length === 0 && orphanRooms().length === 0}>
						<p class="px-3 py-4 text-center text-xs text-neutral-600">
							No rooms yet
						</p>
					</Show>
				</Show>
			</div>
		</aside>
	);
};

export default RoomList;
