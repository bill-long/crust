import { useNavigate, useParams } from "@solidjs/router";
import { type Component, createMemo, For, Show } from "solid-js";
import { useClient } from "../../client/client";
import type { RoomSummary } from "../../client/summaries";
import {
	getDmRooms,
	getOrphanRooms,
	getSpaceRooms,
} from "../../client/summaries-selectors";

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
						{props.room.name || "Unnamed room"}
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
		<aside class="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/50">
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
					<Show when={spaceRooms().length === 0}>
						<p class="px-3 py-4 text-center text-xs text-neutral-600">
							No rooms in this space
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
