import { ContextMenu } from "@kobalte/core/context-menu";
import { useNavigate } from "@solidjs/router";
import {
	type Component,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useDecodedParams } from "../../app/useDecodedParams";
import { useClient } from "../../client/client";
import { canMarkRoomUnread, markRoomUnread } from "../../client/markedUnread";
import { type PresenceStatus, presenceOf } from "../../client/presence";
import {
	FAVOURITE_TAG,
	LOW_PRIORITY_TAG,
	toggleRoomTag,
} from "../../client/roomTags";
import type { RoomSummary } from "../../client/summaries";
import {
	getDmRooms,
	getFavoriteRooms,
	getInvitedRooms,
	getKnockedRooms,
	getLowPriorityHomeRooms,
	getOrphanRooms,
	getSpaceInvitedRooms,
	getSpaceKnockedRooms,
	getSpaceRooms,
	getSpaceSubspaces,
	getSpaceUnreadRollup,
	type UnreadRollup,
} from "../../client/summaries-selectors";
import {
	menuContentClass,
	menuItemClass,
	menuItemDisabledClass,
} from "../../components/menuStyles";
import { SpaceIcon } from "../../components/SpaceIcon";
import { UnreadBadge } from "../../components/UnreadBadge";
import { VirtualList } from "../../components/VirtualList";
import { spaceLandingPath } from "../../lib/spaceLanding";
import { requestExploreDialog } from "../../stores/exploreDialog";
import { requestJoinDialog } from "../../stores/joinDialog";
import { SpaceDiscoverList } from "../space/SpaceDiscoverList";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { ExportDialog } from "./export/ExportDialog";
import { SpaceInvitePanel } from "./invites/SpaceInvitePanel";
import { NewDmDialog } from "./NewDmDialog";

/**
 * Home row pitch in px. RoomEntry rows (py-2 + text-sm line) and section headers
 * (h-9) are both exactly 2.25rem tall, so derive the pitch from the root font
 * size - a hard-coded px would drift if the browser's default font size (an
 * accessibility setting, distinct from the app's zoom) isn't 16px.
 */
function homeRowHeight(): number {
	const rem =
		Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
		16;
	return rem * 2.25;
}
/** Only window the Home list once it's long enough to matter (cf. PinnedMessagesPanel). */
const VIRTUALIZE_THRESHOLD = 50;

/** A flattened Home-list entry: a section header, a room row, or a
    pending-invite / pending-knock row. */
type HomeItem =
	| { readonly type: "header"; readonly label: string }
	| { readonly type: "room" | "invite" | "knock"; readonly room: RoomSummary };

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

/**
 * Presence of the person on the other side of a DM, or `unknown` for a room
 * that is not a DM or whose peer `m.direct` does not name.
 */
function dmPresence(room: { dmUserId: string | null }): PresenceStatus {
	return room.dmUserId ? presenceOf(room.dmUserId).status : "unknown";
}

/** Presence colours for the DM glyph. The row's leading slot is 14px, too
    small to carry a dot overlay legibly, so the person icon itself takes the
    colour and the label carries the word. */
const DM_PRESENCE_CLASS: Record<PresenceStatus, string> = {
	online: "text-success-text",
	idle: "text-warning-text",
	offline: "text-text-muted",
	unknown: "text-text-muted",
};

const DM_PRESENCE_LABEL: Record<PresenceStatus, string> = {
	online: "Direct message, online",
	idle: "Direct message, idle",
	offline: "Direct message, offline",
	// No claim: the server has never mentioned this person.
	unknown: "Direct message",
};

/** Person icon used as the leading slot for direct-message rooms so DMs and
    channel rooms share a consistent name x-position. */
const DmTypeIcon: Component<{ presence?: PresenceStatus }> = (props) => (
	<svg
		aria-label={DM_PRESENCE_LABEL[props.presence ?? "unknown"]}
		role="img"
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class={`shrink-0 ${DM_PRESENCE_CLASS[props.presence ?? "unknown"]}`}
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

/** Check mark shown by the context menu's tag toggles when set. */
const TagCheckIcon: Component = () => (
	<svg
		aria-hidden="true"
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0 text-accent"
	>
		<polyline points="20 6 9 17 4 12" />
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
	onClick: () => void;
}> = (props) => {
	return (
		<button
			type="button"
			onClick={props.onClick}
			data-room-id={props.room.roomId}
			class={`flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover ${
				props.isSelected
					? "bg-surface-3 text-text-primary"
					: "text-text-secondary hover:bg-surface-2"
			}`}
			aria-current={props.isSelected ? "true" : undefined}
		>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<Show
						when={!props.room.isDirect}
						fallback={<DmTypeIcon presence={dmPresence(props.room)} />}
					>
						<ChannelTypeIcon kind={props.room.kind} />
					</Show>
					<span
						class="min-w-0 flex-1 truncate text-sm font-medium"
						classList={{
							"text-text-disabled": props.room.isMuted && !props.isSelected,
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
					<Show when={props.room.isMuted}>
						<BellOffBadge />
					</Show>
				</div>
			</div>

			{/* Numeric badge hidden when muted; the marked-unread dot still
				shows - it's an explicit user action, not room noise. */}
			<UnreadBadge
				unread={props.room.isMuted ? 0 : props.room.unreadCount}
				highlight={props.room.isMuted ? 0 : props.room.highlightCount}
				markedUnread={props.room.markedUnread}
				class="shrink-0"
			/>
		</button>
	);
};

/** Row for a room the user has a pending invite to. Same 2.25rem pitch as
    RoomEntry (px-3 py-2 + a text-sm line) so the two row kinds share the
    virtualized list's fixed row height. Clicking opens the room, where the
    invite view offers Accept/Decline (#438). */
const InviteEntry: Component<{
	room: RoomSummary;
	isSelected: boolean;
	onClick: () => void;
}> = (props) => {
	return (
		<button
			type="button"
			onClick={props.onClick}
			class={`flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover ${
				props.isSelected
					? "bg-surface-3 text-text-primary"
					: "text-text-secondary hover:bg-surface-2"
			}`}
			aria-current={props.isSelected ? "true" : undefined}
		>
			<div class="flex min-w-0 flex-1 items-center gap-2">
				<Show
					when={!props.room.isDirect}
					fallback={<DmTypeIcon presence={dmPresence(props.room)} />}
				>
					<ChannelTypeIcon kind={props.room.kind} />
				</Show>
				<span class="min-w-0 flex-1 truncate text-sm font-medium">
					{props.room.name.trim() || "Unnamed room"}
				</span>
				<Show when={props.room.isEncrypted}>
					<EncryptedBadge />
				</Show>
			</div>
			<span class="flex h-5 shrink-0 items-center rounded-full bg-accent px-2 text-[10px] font-bold text-accent-foreground">
				Invite
			</span>
		</button>
	);
};

/** Row for a room the user has a pending join request (knock) in. Same
    2.25rem pitch as InviteEntry/RoomEntry. The muted "Requested" pill is
    deliberately quieter than the accent Invite pill: a knock needs no
    action from the viewer, it's just waiting on a moderator (#442).
    Clicking opens the room, where the knock view offers cancellation. */
const KnockEntry: Component<{
	room: RoomSummary;
	isSelected: boolean;
	onClick: () => void;
}> = (props) => {
	return (
		<button
			type="button"
			onClick={props.onClick}
			class={`flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover ${
				props.isSelected
					? "bg-surface-3 text-text-primary"
					: "text-text-secondary hover:bg-surface-2"
			}`}
			aria-current={props.isSelected ? "true" : undefined}
		>
			<div class="flex min-w-0 flex-1 items-center gap-2">
				<Show
					when={!props.room.isDirect}
					fallback={<DmTypeIcon presence={dmPresence(props.room)} />}
				>
					<ChannelTypeIcon kind={props.room.kind} />
				</Show>
				<span class="min-w-0 flex-1 truncate text-sm font-medium">
					{props.room.name.trim() || "Unnamed room"}
				</span>
				<Show when={props.room.isEncrypted}>
					<EncryptedBadge />
				</Show>
			</div>
			<span class="flex h-5 shrink-0 items-center rounded-full bg-surface-3 px-2 text-[10px] font-bold text-text-muted">
				Requested
			</span>
		</button>
	);
};

/** Row for a joined subspace of the viewed space (#443). Same 2.25rem
    pitch as RoomEntry. Clicking navigates into the subspace's own space
    view; the unread badge rolls up the subspace's whole room subtree.
    Unlike its RoomEntry siblings it carries no isSelected/aria-current
    state: selecting it navigates AWAY to the subspace's view (which
    re-renders this list for the subspace), it never stays selected in
    the current list. */
const SubspaceEntry: Component<{
	space: RoomSummary;
	unreadRollup: () => UnreadRollup;
	onClick: () => void;
}> = (props) => {
	// Memoized so the subtree walk runs once per summaries change, not
	// once per JSX expression that reads it (mirrors SpaceTile).
	const rollup = createMemo(() => props.unreadRollup());
	return (
		<button
			type="button"
			onClick={props.onClick}
			class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-text-secondary transition-colors hover:bg-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
		>
			<div class="flex min-w-0 flex-1 items-center gap-2">
				<SpaceIcon />
				<span class="min-w-0 flex-1 truncate text-sm font-medium">
					{props.space.name.trim() || "Unnamed space"}
				</span>
			</div>
			<UnreadBadge
				unread={rollup().unread}
				highlight={rollup().highlight}
				markedUnread={rollup().markedUnread}
				class="shrink-0"
			/>
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
	const clientCtx = useClient();
	const { client, summaries } = clientCtx;
	const params = useDecodedParams<{ spaceId?: string; roomId?: string }>();
	const navigate = useNavigate();

	// Muted state lives on RoomSummary (summaries store parses the
	// crust.mute push rules once per change), so rows, badges, and the
	// mark-as-unread gate share one definition.

	const isHome = () => !params.spaceId;
	const selectedRoomId = () => params.roomId;

	const spaceRooms = createMemo(() => {
		if (isHome() || !params.spaceId) return [];
		return getSpaceRooms(summaries, params.spaceId);
	});

	// Joined subspaces of the viewed space, rendered as rows above its
	// rooms (#443). Clicking one navigates into the subspace's own view.
	const spaceSubspaces = createMemo(() => {
		if (isHome() || !params.spaceId) return [];
		return getSpaceSubspaces(summaries, params.spaceId);
	});

	const dmRooms = createMemo(() => getDmRooms(summaries));
	const orphanRooms = createMemo(() => getOrphanRooms(summaries));
	const favoriteRooms = createMemo(() => getFavoriteRooms(summaries));
	const lowPriorityRooms = createMemo(() => getLowPriorityHomeRooms(summaries));
	const invitedRooms = createMemo(() => getInvitedRooms(summaries));
	const knockedRooms = createMemo(() => getKnockedRooms(summaries));
	const spaceInvites = createMemo(() => {
		if (isHome() || !params.spaceId) return [];
		return getSpaceInvitedRooms(summaries, params.spaceId);
	});
	const spaceKnocks = createMemo(() => {
		if (isHome() || !params.spaceId) return [];
		return getSpaceKnockedRooms(summaries, params.spaceId);
	});
	// The selected space's own membership: "join" renders the normal
	// rooms + Discover view; "invite" renders the accept/decline panel and
	// hides the joined-space-only header actions (settings, create room).
	const spaceMembership = createMemo(() => {
		if (isHome() || !params.spaceId) return null;
		return summaries[params.spaceId]?.membership ?? null;
	});

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

	const openJoin = (): void => {
		// The dialog lives in JoinRoomDialogHost (Layout-mounted, so it also
		// works on mobile where this list unmounts); ask for a blank open.
		requestJoinDialog();
	};

	const openExplore = (): void => {
		// Same Layout-hosted pattern as the join dialog (see openJoin).
		requestExploreDialog();
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

	// Stable header refs + a per-row wrapper cache, so building homeItems() on a
	// summary change (e.g. an unread bump) doesn't hand VirtualList's
	// reference-keyed <For> brand-new items and remount every visible row.
	// Keyed by kind + roomId: the same room re-wraps when it moves between the
	// invite and room sections (accepting an invite), and each wrapper's type
	// must match its section.
	const INVITES_HEADER: HomeItem = { type: "header", label: "Invites" };
	const REQUESTS_HEADER: HomeItem = { type: "header", label: "Requests" };
	const FAVORITES_HEADER: HomeItem = { type: "header", label: "Favorites" };
	const DM_HEADER: HomeItem = { type: "header", label: "Direct Messages" };
	const ROOMS_HEADER: HomeItem = { type: "header", label: "Rooms" };
	const LOW_PRIORITY_HEADER: HomeItem = {
		type: "header",
		label: "Low priority",
	};
	const roomItems = new Map<string, { room: RoomSummary; item: HomeItem }>();
	const roomItem = (
		room: RoomSummary,
		type: "room" | "invite" | "knock",
	): HomeItem => {
		const key = `${type}:${room.roomId}`;
		const cached = roomItems.get(key);
		if (cached && cached.room === room) return cached.item;
		const item: HomeItem = { type, room };
		roomItems.set(key, { room, item });
		return item;
	};

	// Flattened Home list: [Invites?, Requests?, Favorites?, DMs?, Rooms?,
	// Low priority?] - tagged rooms render in the Favorites / Low priority
	// sections and are excluded from DMs / Rooms by the selectors (#449).
	const homeItems = createMemo<HomeItem[]>(() => {
		const out: HomeItem[] = [];
		const invites = invitedRooms();
		const knocks = knockedRooms();
		const favorites = favoriteRooms();
		const dms = dmRooms();
		const orphans = orphanRooms();
		const lowPriority = lowPriorityRooms();
		if (invites.length > 0) {
			out.push(INVITES_HEADER);
			for (const room of invites) out.push(roomItem(room, "invite"));
		}
		if (knocks.length > 0) {
			out.push(REQUESTS_HEADER);
			for (const room of knocks) out.push(roomItem(room, "knock"));
		}
		if (favorites.length > 0) {
			out.push(FAVORITES_HEADER);
			for (const room of favorites) out.push(roomItem(room, "room"));
		}
		if (dms.length > 0) {
			out.push(DM_HEADER);
			for (const room of dms) out.push(roomItem(room, "room"));
		}
		if (orphans.length > 0) {
			out.push(ROOMS_HEADER);
			for (const room of orphans) out.push(roomItem(room, "room"));
		}
		if (lowPriority.length > 0) {
			out.push(LOW_PRIORITY_HEADER);
			for (const room of lowPriority) out.push(roomItem(room, "room"));
		}
		// Drop cached wrappers for rows that are no longer present so the map
		// doesn't retain every room ever seen this session.
		const liveCount =
			invites.length +
			knocks.length +
			favorites.length +
			dms.length +
			orphans.length +
			lowPriority.length;
		if (roomItems.size > liveCount) {
			const live = new Set<string>();
			for (const room of invites) live.add(`invite:${room.roomId}`);
			for (const room of knocks) live.add(`knock:${room.roomId}`);
			for (const room of favorites) live.add(`room:${room.roomId}`);
			for (const room of dms) live.add(`room:${room.roomId}`);
			for (const room of orphans) live.add(`room:${room.roomId}`);
			for (const room of lowPriority) live.add(`room:${room.roomId}`);
			for (const key of roomItems.keys()) {
				if (!live.has(key)) roomItems.delete(key);
			}
		}
		return out;
	});

	// Single hoisted context menu for every room row (one Kobalte menu
	// instance instead of one per row - per-row menus cost ~30 reactive
	// nodes each, against the repo's 16ms interaction budget in a
	// several-hundred-room space). The capture listener below aims it at
	// the pressed row; a press outside any room row disables the trigger,
	// falling through to the NATIVE context menu. On a room row the menu
	// always opens - non-actionable items render disabled (Discord's
	// grayed-out treatment), which keeps the trigger logic item-agnostic
	// as more row actions arrive.
	const [menuTarget, setMenuTarget] = createSignal<string | null>(null);
	// Room being exported via the context menu's "Export chat…" (#530);
	// null = dialog closed.
	const [exportTarget, setExportTarget] = createSignal<string | null>(null);
	const menuDisabled = (): boolean => menuTarget() === null;
	// One capture-phase listener aims the menu: it runs before Kobalte's
	// trigger logic reads `disabled`, and covers every path that can open
	// the menu (mouse right-click and touch long-press start at
	// pointerdown; the keyboard Menu key fires contextmenu with no
	// preceding pointerdown). A press outside any room row aims at null.
	// Manual listeners because Solid JSX has no capture modifier that
	// survives Kobalte's polymorphic prop spread.
	let menuRegionEl: HTMLElement | undefined;
	onMount(() => {
		const el = menuRegionEl;
		if (!el) return;
		const aim = (e: Event): void => {
			const row = (e.target as Element | null)?.closest?.("[data-room-id]");
			setMenuTarget(row?.getAttribute("data-room-id") ?? null);
		};
		// Mouse opens via the contextmenu path, so pointerdown aiming is
		// only needed for touch/pen long-press - skip the closest() walk on
		// every ordinary left-click.
		const aimPress = (e: PointerEvent): void => {
			if (e.pointerType !== "mouse") aim(e);
		};
		el.addEventListener("pointerdown", aimPress, true);
		el.addEventListener("contextmenu", aim, true);
		onCleanup(() => {
			el.removeEventListener("pointerdown", aimPress, true);
			el.removeEventListener("contextmenu", aim, true);
		});
	});

	const renderRoom = (room: RoomSummary): JSX.Element => (
		<RoomEntry
			room={room}
			isSelected={selectedRoomId() === room.roomId}
			onClick={() => navigateToRoom(room.roomId)}
		/>
	);

	const renderInvite = (room: RoomSummary): JSX.Element => (
		<InviteEntry
			room={room}
			isSelected={selectedRoomId() === room.roomId}
			onClick={() => navigateToRoom(room.roomId)}
		/>
	);

	const renderKnock = (room: RoomSummary): JSX.Element => (
		<KnockEntry
			room={room}
			isSelected={selectedRoomId() === room.roomId}
			onClick={() => navigateToRoom(room.roomId)}
		/>
	);

	const renderSubspace = (space: RoomSummary): JSX.Element => (
		<SubspaceEntry
			space={space}
			unreadRollup={() => getSpaceUnreadRollup(summaries, space.roomId)}
			onClick={() => navigate(spaceLandingPath(summaries, space.roomId))}
		/>
	);

	const renderHomeItem = (item: HomeItem): JSX.Element =>
		item.type === "header" ? (
			// h-9 pins the header to 2.25rem so it matches the room pitch exactly
			// regardless of inherited line-height (its natural height already is
			// 2.25rem: 0.75rem padding + a 1.5rem line box), a visual no-op.
			<div class="h-9 px-3 pb-1 pt-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
					{item.label}
				</span>
			</div>
		) : item.type === "invite" ? (
			renderInvite(item.room)
		) : item.type === "knock" ? (
			renderKnock(item.room)
		) : (
			renderRoom(item.room)
		);

	return (
		// The pane's surface and right divider belong to the wrapper
		// (`GlobalSearchPane`), which also hosts the search field above this
		// list - painting them here would inset both behind that field.
		<aside class="flex h-full flex-col">
			<div class="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
				<span class="min-w-0 flex-1 truncate text-sm font-semibold text-text-secondary">
					{spaceName()}
				</span>
				<Show
					when={
						spaceMembership() === "join" &&
						props.onOpenSpaceSettings &&
						params.spaceId
					}
				>
					{(spaceId) => (
						<button
							type="button"
							onClick={() => props.onOpenSpaceSettings?.(spaceId())}
							aria-label="Space settings"
							title="Space settings"
							class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
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
						class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
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
				{/* Join-by-address lands the room under Home regardless of the
					current space (it doesn't add the room to a space), so like
					New DM it's Home-only (#440). */}
				<Show when={isHome()}>
					<button
						type="button"
						onClick={openJoin}
						aria-label="Join a room"
						title="Join a room"
						class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
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
							<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
							<polyline points="10 17 15 12 10 7" />
							<line x1="15" y1="12" x2="3" y2="12" />
						</svg>
					</button>
				</Show>
				{/* Directory browse is Home-only for the same reason as
				    join-by-address above: a directory join lands under
				    Home regardless of the current space (#440). */}
				<Show when={isHome()}>
					<button
						type="button"
						onClick={openExplore}
						aria-label="Explore public rooms"
						title="Explore public rooms"
						class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
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
							<circle cx="12" cy="12" r="10" />
							<polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
						</svg>
					</button>
				</Show>
				{/* Create-room targets the current space, so it needs a joined
					space (or Home). An invited space would 403 the create /
					m.space.child write. */}
				<Show when={isHome() || spaceMembership() === "join"}>
					<button
						type="button"
						onClick={openCreate}
						aria-label="Create room"
						title="Create room"
						class="inline-flex h-8 w-8 min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover sm:min-h-0 sm:min-w-0"
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
				</Show>
			</div>

			{/* Home mode above the threshold windows the flattened list. Space
				mode stays plain: it's bounded by one space's rooms and its
				SpaceDiscoverList tail can't share VirtualList's scroll container.
				Crossing the threshold swaps scroll containers, so scroll position
				resets - an accepted edge (it only happens at exactly the boundary
				count, and VirtualList must own its scroller). */}
			<ContextMenu>
				{/* A press outside a room row leaves the target null (the
					capture-phase reset above) and the disabled trigger falls
					through to the NATIVE context menu - Kobalte skips
					preventDefault when disabled. */}
				<ContextMenu.Trigger
					ref={(el: HTMLElement) => {
						menuRegionEl = el;
					}}
					class="flex min-h-0 flex-1 flex-col"
					disabled={menuDisabled()}
				>
					<Show
						when={isHome() && homeItems().length > VIRTUALIZE_THRESHOLD}
						fallback={
							<div class="flex-1 overflow-y-auto p-1">
								{/* Space the user is only invited to: no authoritative
									child list exists, so show the accept/decline panel
									instead of rooms + Discover. Keyed so in-flight/error
									state can't leak across a switch between two invited
									spaces. */}
								<Show when={!isHome() && spaceMembership() === "invite"}>
									<Show when={params.spaceId} keyed>
										{(sid) => (
											<SpaceInvitePanel
												spaceId={sid}
												onDeclined={() => navigate("/home")}
											/>
										)}
									</Show>
								</Show>

								<Show when={!isHome() && spaceMembership() !== "invite"}>
									<Show when={spaceInvites().length > 0}>
										<div class="h-9 px-3 pb-1 pt-2">
											<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
												Invites
											</span>
										</div>
										<For each={spaceInvites()}>
											{(room) => renderInvite(room)}
										</For>
									</Show>
									<Show when={spaceKnocks().length > 0}>
										<div class="h-9 px-3 pb-1 pt-2">
											<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
												Requests
											</span>
										</div>
										<For each={spaceKnocks()}>
											{(room) => renderKnock(room)}
										</For>
									</Show>
									<For each={spaceSubspaces()}>
										{(space) => renderSubspace(space)}
									</For>
									<For each={spaceRooms()}>{(room) => renderRoom(room)}</For>
									<SpaceDiscoverList
										spaceId={() => params.spaceId}
										hasListedRooms={() =>
											spaceRooms().length > 0 ||
											spaceSubspaces().length > 0 ||
											spaceInvites().length > 0 ||
											spaceKnocks().length > 0
										}
									/>
								</Show>

								<Show when={isHome()}>
									<For each={homeItems()}>{(item) => renderHomeItem(item)}</For>
									<Show when={homeItems().length === 0}>
										<p class="px-3 py-4 text-center text-xs text-text-faint">
											No rooms yet
										</p>
									</Show>
								</Show>
							</div>
						}
					>
						<VirtualList
							each={homeItems()}
							rowHeight={homeRowHeight()}
							class="flex-1 overflow-y-auto p-1"
						>
							{(item) => renderHomeItem(item)}
						</VirtualList>
					</Show>
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Content class={menuContentClass}>
						<ContextMenu.Item
							class={`${menuItemClass} ${menuItemDisabledClass}`}
							disabled={(() => {
								const target = menuTarget();
								return !target || !canMarkRoomUnread(summaries[target]);
							})()}
							onSelect={() => {
								const target = menuTarget();
								if (target) markRoomUnread(clientCtx, target);
							}}
						>
							Mark as unread
						</ContextMenu.Item>
						<ContextMenu.Separator class="mx-1 my-1 h-px bg-border-subtle" />
						{/* closeOnSelect={false} would let the user toggle both tags
							in one visit, but Kobalte re-anchors on the next open
							anyway and single-toggle-and-close matches the Mark item
							above - keep the default. */}
						<ContextMenu.CheckboxItem
							class={`${menuItemClass} justify-between gap-2`}
							checked={(() => {
								const target = menuTarget();
								return !!target && summaries[target]?.isFavourite === true;
							})()}
							onChange={() => {
								const target = menuTarget();
								if (target) toggleRoomTag(clientCtx, target, FAVOURITE_TAG);
							}}
						>
							Favorite
							<ContextMenu.ItemIndicator>
								<TagCheckIcon />
							</ContextMenu.ItemIndicator>
						</ContextMenu.CheckboxItem>
						<ContextMenu.CheckboxItem
							class={`${menuItemClass} justify-between gap-2`}
							checked={(() => {
								const target = menuTarget();
								return !!target && summaries[target]?.isLowPriority === true;
							})()}
							onChange={() => {
								const target = menuTarget();
								if (target) toggleRoomTag(clientCtx, target, LOW_PRIORITY_TAG);
							}}
						>
							Low priority
							<ContextMenu.ItemIndicator>
								<TagCheckIcon />
							</ContextMenu.ItemIndicator>
						</ContextMenu.CheckboxItem>
						<ContextMenu.Separator class="mx-1 my-1 h-px bg-border-subtle" />
						<ContextMenu.Item
							class={`${menuItemClass} ${menuItemDisabledClass}`}
							disabled={menuDisabled()}
							onSelect={() => setExportTarget(menuTarget())}
						>
							Export chat…
						</ContextMenu.Item>
					</ContextMenu.Content>
				</ContextMenu.Portal>
			</ContextMenu>

			<CreateRoomDialog
				client={client}
				open={createOpen}
				onClose={closeCreate}
				spaceId={params.spaceId}
			/>
			<NewDmDialog client={client} open={newDmOpen} onClose={closeNewDm} />
			<Show when={exportTarget()} keyed>
				{(roomId) => (
					<ExportDialog
						client={client}
						roomId={roomId}
						onClose={() => setExportTarget(null)}
					/>
				)}
			</Show>
		</aside>
	);
};

export { RoomList };
