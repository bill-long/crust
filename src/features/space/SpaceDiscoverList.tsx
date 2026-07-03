import { type Component, For, Show } from "solid-js";
import {
	type DiscoverableRoom,
	type JoinState,
	useSpaceHierarchy,
} from "./useSpaceHierarchy";

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

/**
 * The "Discover" section shown under a space's joined-room list: fetches the
 * space hierarchy and renders the discoverable (not-yet-joined) rooms with
 * inline Join buttons. Owns {@link useSpaceHierarchy} so the room feature can
 * compose this as a plain component instead of reaching into a space-feature
 * hook.
 *
 * Also owns the combined "No rooms in this space" empty state, which depends on
 * BOTH the caller's joined-room count (`hasJoinedRooms`) and this component's
 * discoverable state — so it renders only when the space has nothing to show at
 * all.
 */
export const SpaceDiscoverList: Component<{
	/** The space whose hierarchy to fetch (undefined = nothing to show). */
	spaceId: () => string | undefined;
	/** Whether the caller is already rendering joined rooms for this space. */
	hasJoinedRooms: () => boolean;
}> = (props) => {
	const hierarchy = useSpaceHierarchy(props.spaceId);

	return (
		<>
			<Show
				when={
					!props.hasJoinedRooms() &&
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

			<Show when={!hierarchy.loading && hierarchy.discoverableRooms.length > 0}>
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
		</>
	);
};
