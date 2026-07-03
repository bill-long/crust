import { useNavigate } from "@solidjs/router";
import {
	ClientEvent,
	type MatrixEvent,
	PushRuleActionName,
} from "matrix-js-sdk";
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
import { SpaceDiscoverList } from "../space/SpaceDiscoverList";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { NewDmDialog } from "./NewDmDialog";

/** Small bell-off icon for muted rooms. */
const BellOffBadge: Component = () => (
	<svg
		aria-hidden="true"
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

/** Channel-type icon: # for text rooms, speaker for voice/video rooms. */
const ChannelTypeIcon: Component<{ kind: "text" | "voice" }> = (props) => (
	<Show
		when={props.kind === "voice"}
		fallback={
			<svg
				aria-label="Text channel"
				role="img"
				width="14"
				height="14"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="shrink-0 text-text-muted"
			>
				<line x1="2" y1="6" x2="14" y2="6" />
				<line x1="2" y1="10" x2="14" y2="10" />
				<line x1="6.5" y1="2" x2="4.5" y2="14" />
				<line x1="11.5" y1="2" x2="9.5" y2="14" />
			</svg>
		}
	>
		<svg
			aria-label="Voice channel"
			role="img"
			width="14"
			height="14"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="shrink-0 text-text-muted"
		>
			<path d="M3 6h2.5L9 3v10L5.5 10H3Z" />
			<line x1="11.5" y1="6" x2="11.5" y2="10" />
			<line x1="13.5" y1="4.5" x2="13.5" y2="11.5" />
		</svg>
	</Show>
);

/** Person icon used as the leading slot for direct-message rooms so DMs and
    channel rooms share a consistent name x-position. */
const DmTypeIcon: Component = () => (
	<svg
		aria-label="Direct message"
		role="img"
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0 text-text-muted"
	>
		<circle cx="8" cy="5.5" r="2.5" />
		<path d="M3 13.5c0-2.5 2.5-4 5-4s5 1.5 5 4" />
	</svg>
);

/** Small lock badge for encrypted rooms. Rendered after the name as a status
    indicator so the name x-position stays stable across encrypted and
    non-encrypted rows. */
const EncryptedBadge: Component = () => (
	<svg
		aria-label="Encrypted"
		role="img"
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0 text-success-text"
	>
		<rect x="3.5" y="7.5" width="9" height="6" rx="1" />
		<path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
	</svg>
);

/** Static green dot indicating an in-progress call in this room. */
const ActiveCallDot: Component = () => (
	<span
		role="img"
		aria-label="Call in progress"
		title="Call in progress"
		class="inline-block h-2 w-2 shrink-0 rounded-full bg-success"
	/>
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
				<div class="flex items-center gap-2">
					<Show when={!props.room.isDirect} fallback={<DmTypeIcon />}>
						<ChannelTypeIcon kind={props.room.kind} />
					</Show>
					<span
						class="min-w-0 flex-1 truncate text-sm font-medium"
						classList={{
							"text-text-disabled": props.isMuted && !props.isSelected,
						}}
					>
						{props.room.name.trim() || "Unnamed room"}
					</span>
					<Show when={props.room.isEncrypted}>
						<EncryptedBadge />
					</Show>
					<Show when={props.room.callActive}>
						<ActiveCallDot />
					</Show>
					<Show when={props.isMuted}>
						<BellOffBadge />
					</Show>
				</div>
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

interface RoomListProps {
	/**
	 * Called when the user clicks the gear button in the header while
	 * viewing a space. Receives the space's room ID.
	 */
	onOpenSpaceSettings?: (spaceId: string) => void;
}

const RoomList: Component<RoomListProps> = (props) => {
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
					r.actions.some((a) => a === PushRuleActionName.DontNotify)
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

	const [createOpen, setCreateOpen] = createSignal(false);
	const openCreate = (): void => {
		setCreateOpen(true);
	};
	const closeCreate = (): void => {
		setCreateOpen(false);
	};

	const [newDmOpen, setNewDmOpen] = createSignal(false);
	const openNewDm = (): void => {
		setNewDmOpen(true);
	};
	const closeNewDm = (): void => {
		setNewDmOpen(false);
	};

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
			<div class="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
				<span class="min-w-0 flex-1 truncate text-sm font-semibold text-text-secondary">
					{spaceName()}
				</span>
				<Show when={!isHome() && props.onOpenSpaceSettings && params.spaceId}>
					{(spaceId) => (
						<button
							type="button"
							onClick={() => props.onOpenSpaceSettings?.(spaceId())}
							aria-label="Space settings"
							title="Space settings"
							class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
						>
							<svg
								aria-hidden="true"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<circle cx="12" cy="12" r="3" />
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
							</svg>
						</button>
					)}
				</Show>
				<Show when={isHome()}>
					<button
						type="button"
						onClick={openNewDm}
						aria-label="New direct message"
						title="New direct message"
						class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
					>
						<svg
							aria-hidden="true"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
						</svg>
					</button>
				</Show>
				<button
					type="button"
					onClick={openCreate}
					aria-label="Create room"
					title="Create room"
					class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
				>
					<svg
						aria-hidden="true"
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
					>
						<line x1="8" y1="3" x2="8" y2="13" />
						<line x1="3" y1="8" x2="13" y2="8" />
					</svg>
				</button>
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
					<SpaceDiscoverList
						spaceId={() => params.spaceId}
						hasJoinedRooms={() => spaceRooms().length > 0}
					/>
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

			<CreateRoomDialog
				client={client}
				open={createOpen}
				onClose={closeCreate}
				spaceId={params.spaceId}
			/>
			<NewDmDialog client={client} open={newDmOpen} onClose={closeNewDm} />
		</aside>
	);
};

export { RoomList };
