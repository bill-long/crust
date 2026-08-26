import { ContextMenu } from "@kobalte/core/context-menu";
import { useNavigate } from "@solidjs/router";
import {
	type Accessor,
	type Component,
	createMemo,
	createSignal,
	For,
	type JSX,
	Show,
} from "solid-js";
import { useDecodedParams } from "../../app/useDecodedParams";
import { useClient } from "../../client/client";
import { moveRootSpace } from "../../client/spaceOrder";
import type { RoomSummary } from "../../client/summaries";
import {
	flattenSpaceTree,
	getHomeUnreadRollup,
	getInvitedRoomCount,
	getInvitedSpaces,
	getKnockedSpaces,
	getSpaceTree,
	getSpaceUnreadRollup,
} from "../../client/summaries-selectors";
import {
	menuContentClass,
	menuItemClass,
	menuItemDangerClass,
	menuItemDisabledClass,
} from "../../components/menuStyles";
import { UnreadBadge } from "../../components/UnreadBadge";
import { avatarInitial } from "../../lib/avatar";
import {
	createFailedImageUrls,
	createImageFallback,
	type FailedImageUrls,
} from "../../lib/imageFallback";
import { spaceLandingPath } from "../../lib/spaceLanding";
import { CreateSpaceDialog } from "./CreateSpaceDialog";

/** Nesting indent per sidebar depth tier (static strings so Tailwind's
    scanner picks them up; depth is capped by MAX_SIDEBAR_SPACE_DEPTH). */
const DEPTH_INDENT_CLASSES = ["", "pl-4", "pl-8"] as const;

interface SidebarItemProps {
	selected: Accessor<boolean>;
	/** Nesting depth in the space tree (0 = root tile). */
	depth?: Accessor<number>;
	children: JSX.Element;
}

const SidebarItem: Component<SidebarItemProps> = (props) => {
	const depth = () => props.depth?.() ?? 0;
	return (
		<div
			class={`relative flex justify-center ${DEPTH_INDENT_CLASSES[Math.min(depth(), DEPTH_INDENT_CLASSES.length - 1)]}`}
		>
			{props.children}
			<div
				class={`pointer-events-none absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-text-primary transition-all duration-150 ${
					props.selected()
						? depth() > 0
							? "h-8"
							: "h-10"
						: "h-0 peer-hover:h-5"
				}`}
			/>
		</div>
	);
};

interface SpaceTileProps {
	/** The space this tile represents. */
	space: RoomSummary;
	/** Nesting depth in the sidebar tree (0 = root tile). Accessor so a
	    tree restructure re-indents the row without remounting it. */
	depth: Accessor<number>;
	onOpenSpaceSettings?: (spaceId: string) => void;
	onLeaveSpace?: (spaceId: string) => void;
	onInviteSpace?: (spaceId: string) => void;
	/**
	 * This tile's position among the rail's ROOT tiles, or null for a
	 * nested subspace tile. Root ordering is the user's manual m.space_order
	 * arrangement; subspace order comes from the parent's m.space.child
	 * state, so only roots offer Move up/down.
	 */
	rootPosition?: Accessor<{ index: number; count: number } | null>;
	/** Move this root space one slot up (-1) or down (+1) in the rail. */
	onMoveSpace?: (spaceId: string, delta: -1 | 1) => void;
	/** Fail-closed avatar state, shared with the rest of the rail. */
	brokenAvatars: FailedImageUrls;
}

/**
 * One joined-space tile in the sidebar rail: avatar button with unread
 * badge, right-click context menu, and the selected/hover rail pill (via
 * SidebarItem). Nested subspace tiles render smaller and indented (#443).
 */
const SpaceTile: Component<SpaceTileProps> = (props) => {
	const { client, summaries } = useClient();
	const params = useDecodedParams<{ spaceId?: string }>();
	const navigate = useNavigate();

	// Recursive rollup: a parent tile badges unread from its subspaces'
	// rooms too, so nested activity is visible without expanding (#443).
	const rollup = createMemo(() =>
		getSpaceUnreadRollup(summaries, props.space.roomId),
	);
	const isSelected = () => params.spaceId === props.space.roomId;
	const nested = () => props.depth() > 0;

	// Render-time check: hide the Invite item when the local user lacks
	// invite permission in this space, or when the space room isn't yet
	// loaded into the SDK store. This accepts mild staleness (no
	// state-event subscription) — the invite call itself will reject with
	// M_FORBIDDEN if permissions change after the menu opens.
	const canInviteToSpace = (): boolean => {
		if (!props.onInviteSpace) return false;
		const userId = client.getUserId();
		if (!userId) return false;
		const room = client.getRoom(props.space.roomId);
		return !!room?.canInvite(userId);
	};
	// Only meaningful with 2+ roots: a lone root would get a menu of two
	// permanently-disabled items (an empty-feeling popover when no other
	// handler is wired).
	const canMove = (): boolean => {
		if (!props.onMoveSpace) return false;
		const pos = props.rootPosition?.();
		return pos != null && pos.count > 1;
	};
	const hasMenu = (): boolean =>
		!!props.onOpenSpaceSettings ||
		!!props.onLeaveSpace ||
		canInviteToSpace() ||
		canMove();

	const openSpace = (): void => {
		navigate(spaceLandingPath(summaries, props.space.roomId));
	};

	const sizeClass = () => (nested() ? "h-8 w-8" : "h-10 w-10");
	const roundingClass = () =>
		isSelected()
			? nested()
				? "rounded-lg"
				: "rounded-xl"
			: nested()
				? "rounded-xl hover:rounded-lg"
				: "rounded-2xl hover:rounded-xl";

	// Fail-closed avatar: a 404/decode failure falls back to the initial
	// instead of the browser's broken-image icon. Shares the rail's registry,
	// so one broken URL is recorded once for the whole sidebar; a synced-in
	// avatar arrives under a new URL, which no block covers.
	const avatar = createImageFallback(
		() => props.space.avatarUrl,
		props.brokenAvatars,
	);

	const triggerInner = (
		<>
			<button
				type="button"
				onClick={openSpace}
				class={`relative flex items-center justify-center transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover ${sizeClass()} ${roundingClass()} ${
					isSelected()
						? "bg-surface-2 text-text-primary"
						: "bg-surface-3 text-text-secondary hover:bg-surface-4"
				}`}
				title={props.space.name.trim() || "Unnamed space"}
				aria-label={props.space.name.trim() || "Unnamed space"}
				aria-current={isSelected() ? "page" : undefined}
			>
				<Show
					when={!avatar.failed() && props.space.avatarUrl}
					fallback={
						<span class={`font-semibold ${nested() ? "text-xs" : "text-sm"}`}>
							{avatarInitial(props.space.name)}
						</span>
					}
				>
					{(url) => (
						<img
							ref={avatar.ref}
							src={url()}
							alt={props.space.name.trim() || "Space"}
							class={`${sizeClass()} rounded-[inherit] object-cover transition-[border-radius]`}
							onError={avatar.onError}
							onLoad={avatar.onLoad}
						/>
					)}
				</Show>

				{/* Unread badge */}
				<UnreadBadge
					unread={rollup().unread}
					highlight={rollup().highlight}
					markedUnread={rollup().markedUnread}
					size="sm"
					class="absolute -right-1 -top-1"
				/>
			</button>
		</>
	);

	return (
		<SidebarItem selected={isSelected} depth={props.depth}>
			{/* Only mount the ContextMenu when at least one menu item will
			    render — otherwise right-clicking would open an empty
			    popover. When no handlers are wired, render the avatar block
			    in a plain wrapper that preserves the `peer` hook. */}
			<Show
				when={hasMenu()}
				fallback={<div class="peer relative">{triggerInner}</div>}
			>
				<ContextMenu>
					<ContextMenu.Trigger class="peer relative">
						{triggerInner}
					</ContextMenu.Trigger>

					<ContextMenu.Portal>
						<ContextMenu.Content class={menuContentClass}>
							<Show when={props.onOpenSpaceSettings}>
								<ContextMenu.Item
									class={menuItemClass}
									onSelect={() =>
										props.onOpenSpaceSettings?.(props.space.roomId)
									}
								>
									Space settings
								</ContextMenu.Item>
							</Show>
							<Show when={canInviteToSpace()}>
								<ContextMenu.Item
									class={menuItemClass}
									onSelect={() => props.onInviteSpace?.(props.space.roomId)}
								>
									Invite people
								</ContextMenu.Item>
							</Show>
							{/* Keyboard-accessible alternative to drag-reorder: only
							    for ROOT tiles - subspace order is the parent's
							    m.space.child state, not the user's account data. */}
							<Show when={canMove()}>
								<ContextMenu.Item
									class={`${menuItemClass} ${menuItemDisabledClass}`}
									disabled={props.rootPosition?.()?.index === 0}
									onSelect={() => props.onMoveSpace?.(props.space.roomId, -1)}
								>
									Move up
								</ContextMenu.Item>
								<ContextMenu.Item
									class={`${menuItemClass} ${menuItemDisabledClass}`}
									disabled={(() => {
										const pos = props.rootPosition?.();
										return !pos || pos.index >= pos.count - 1;
									})()}
									onSelect={() => props.onMoveSpace?.(props.space.roomId, 1)}
								>
									Move down
								</ContextMenu.Item>
							</Show>
							<Show when={props.onLeaveSpace}>
								<ContextMenu.Item
									class={menuItemDangerClass}
									onSelect={() => props.onLeaveSpace?.(props.space.roomId)}
								>
									Leave space
								</ContextMenu.Item>
							</Show>
						</ContextMenu.Content>
					</ContextMenu.Portal>
				</ContextMenu>
			</Show>
		</SidebarItem>
	);
};

interface SpacesSidebarProps {
	/**
	 * Called when the user opens settings for a space via the right-click
	 * "Space settings" item.
	 */
	onOpenSpaceSettings?: (spaceId: string) => void;
	/**
	 * Called when the user picks the right-click "Leave space" item.
	 * Callers should open the leave confirmation flow.
	 */
	onLeaveSpace?: (spaceId: string) => void;
	/**
	 * Called when the user picks the right-click "Invite people" item.
	 * Only shown when the local user has permission to invite to the
	 * space. Callers should open the invite dialog targeting the space.
	 */
	onInviteSpace?: (spaceId: string) => void;
}

const SpacesSidebar: Component<SpacesSidebarProps> = (props) => {
	const { client, summaries, optimisticallySetSpaceOrder } = useClient();
	const params = useDecodedParams<{ spaceId?: string }>();
	const navigate = useNavigate();
	const [createOpen, setCreateOpen] = createSignal(false);
	// Fail-closed avatars for the whole rail, keyed by URL so the state
	// survives a <For> row remount if a selector re-mints its summaries (#457),
	// and so one broken URL is recorded once rather than per tile.
	const brokenAvatars = createFailedImageUrls();

	// Joined spaces as a nested tree (#443): subspaces render indented
	// under their parent instead of as flat top-level tiles. The flattened
	// form keeps <For> keyed on stable RoomSummary references - the tree
	// nodes are re-minted whenever a structural summaries change (child
	// list, membership, name) re-runs the memo, and re-minted node
	// wrappers would remount every tile (and any open context menu).
	const spaceTree = createMemo(() => flattenSpaceTree(getSpaceTree(summaries)));

	// ----- Manual root ordering (m.space_order, part of #449) -----
	// The rail's root tiles in display order; move targets index into this.
	const rootSpaces = createMemo(() =>
		spaceTree().spaces.filter(
			(s) => (spaceTree().depths.get(s.roomId) ?? 0) === 0,
		),
	);
	// O(1) per-tile index lookups (every tile's menu-item state reads its
	// root position on each tree rebuild - a per-tile findIndex would make
	// that O(roots x spaces)).
	const rootIndexById = createMemo(
		() => new Map(rootSpaces().map((r, i) => [r.roomId, i])),
	);
	const isRootId = (roomId: string): boolean =>
		(spaceTree().depths.get(roomId) ?? 0) === 0;

	const performMove = (fromIndex: number, toIndex: number): void => {
		moveRootSpace(
			{ client, summaries, optimisticallySetSpaceOrder },
			rootSpaces(),
			fromIndex,
			toIndex,
		);
	};

	/** Menu path: move a root space one slot up or down. */
	const moveRoot = (spaceId: string, delta: -1 | 1): void => {
		const from = rootIndexById().get(spaceId) ?? -1;
		const to = from + delta;
		if (from === -1 || to < 0 || to >= rootSpaces().length) return;
		performMove(from, to);
	};

	// Drag-reorder state: which root tile is being dragged, and where the
	// drop would land (an insertion edge on another root tile). Cleared on
	// drop and on dragend (which also covers drags cancelled off-rail).
	// Value-equality on the drop target so a pointer held over one row
	// (dragover fires continuously) doesn't rerun every row's indicator
	// condition per event.
	const [draggedSpaceId, setDraggedSpaceId] = createSignal<string | null>(null);
	const [dropTarget, setDropTarget] = createSignal<{
		roomId: string;
		edge: "before" | "after";
	} | null>(null, {
		equals: (a, b) => a?.roomId === b?.roomId && a?.edge === b?.edge,
	});

	const onRowDragOver = (space: RoomSummary, e: DragEvent): void => {
		const dragged = draggedSpaceId();
		if (!dragged) return;
		if (dragged === space.roomId || !isRootId(space.roomId)) {
			// Not a drop target (the dragged tile itself, or a nested
			// subspace row): clear the indicator instead of leaving it
			// stuck on the last root the pointer crossed.
			setDropTarget(null);
			return;
		}
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const edge = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
		setDropTarget({ roomId: space.roomId, edge });
	};

	// Rail-level dragover/drop (not per-row): the rows sit in a gap-1
	// column, and a release in a gap, on the divider, or below the list
	// would otherwise be silently disallowed while the insertion line
	// still advertises a drop point. The rail accepts the drop wherever
	// it lands and honors the current indicator.
	const onRailDragOver = (e: DragEvent): void => {
		if (!draggedSpaceId() || !dropTarget()) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	};

	const onRailDrop = (e: DragEvent): void => {
		e.preventDefault();
		const dragged = draggedSpaceId();
		const target = dropTarget();
		setDraggedSpaceId(null);
		setDropTarget(null);
		if (!dragged || !target) return;
		const from = rootIndexById().get(dragged) ?? -1;
		const targetIdx = rootIndexById().get(target.roomId) ?? -1;
		if (from === -1 || targetIdx === -1) return;
		// Convert the insertion edge into a post-removal index (moveElement
		// removes the dragged item first, shifting later positions left).
		let to = target.edge === "before" ? targetIdx : targetIdx + 1;
		if (from < to) to -= 1;
		if (to !== from) performMove(from, to);
	};

	const invitedSpaces = createMemo(() => getInvitedSpaces(summaries));
	// Spaces with a pending join request (knock). Surfaced as tiles because
	// no room-level selector includes spaces - without these, a knocked
	// space would be invisible after the authoritative sync (#442).
	const knockedSpaces = createMemo(() => getKnockedSpaces(summaries));
	// Pending room invites (all of them - Home's Invites section lists every
	// invited room, including space children), badged on the Home button so
	// an invite is discoverable without opening any list (#438).
	const homeInviteCount = createMemo(() => getInvitedRoomCount(summaries));
	const homeSelected = () => !params.spaceId;
	const homeRollup = createMemo(() => getHomeUnreadRollup(summaries));
	const neverSelected = () => false;

	return (
		<aside class="flex h-full flex-col items-stretch bg-surface-1 py-3">
			{/* Top: scrolling list of Home + spaces. flex-1 + min-h-0 lets it
			    shrink below content height so the footer stays visible and
			    the inner list scrolls instead of pushing the footer off. */}
			<div
				class="flex min-h-0 flex-1 flex-col items-stretch gap-1 overflow-y-auto"
				on:dragover={onRailDragOver}
				on:drop={onRailDrop}
			>
				{/* Home button */}
				<SidebarItem selected={homeSelected}>
					<button
						type="button"
						onClick={() => navigate("/home")}
						class={`peer relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover ${
							homeSelected()
								? "rounded-xl bg-surface-2 text-text-primary"
								: "bg-surface-3 text-text-secondary hover:rounded-xl hover:bg-surface-4"
						}`}
						title="Home"
						aria-label="Home"
						aria-current={homeSelected() ? "page" : undefined}
					>
						<svg
							class="h-5 w-5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1"
							/>
						</svg>

						{/* Unread badge for DMs / home rooms */}
						<UnreadBadge
							unread={homeRollup().unread}
							highlight={homeRollup().highlight}
							markedUnread={homeRollup().markedUnread}
							size="sm"
							class="absolute -right-1 -top-1"
						/>

						{/* Pending-invite badge - bottom corner so it can coexist
							with the unread badge above. Accent = action needed,
							distinct from unread (indicator) and mention (danger). */}
						<Show when={homeInviteCount() > 0}>
							<span
								class="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground"
								role="status"
								aria-label={`${homeInviteCount()} pending invite${homeInviteCount() === 1 ? "" : "s"}`}
							>
								{homeInviteCount() > 99 ? "99+" : homeInviteCount()}
							</span>
						</Show>
					</button>
				</SidebarItem>

				<div class="mx-auto my-1 h-px w-8 bg-surface-3" />

				{/* Joined spaces, nested: subspaces render indented under their
				    parent (#443). Depth comes from the flattened tree's map so a
				    restructure re-indents without remounting the tile. */}
				<For each={spaceTree().spaces}>
					{(space) => (
						// Root tiles are draggable to reorder (with Move up/down in
						// the context menu as the keyboard path). The wrapper owns
						// the drag plumbing so SpaceTile stays presentation-only;
						// the insertion line renders into the rail's row gap.
						<div
							class="relative"
							draggable={isRootId(space.roomId)}
							on:dragstart={(e: DragEvent) => {
								if (!isRootId(space.roomId)) return;
								setDraggedSpaceId(space.roomId);
								if (e.dataTransfer) {
									e.dataTransfer.effectAllowed = "move";
									// Custom type (drop logic reads the signal, not the
									// payload): some engines need setData for the drag
									// to start, but text/plain would paste the raw room
									// id into any text-accepting surface the user
									// overshoots (composer, inputs).
									e.dataTransfer.setData(
										"application/x-crust-space",
										space.roomId,
									);
								}
							}}
							on:dragover={(e: DragEvent) => onRowDragOver(space, e)}
							on:dragend={() => {
								setDraggedSpaceId(null);
								setDropTarget(null);
							}}
						>
							<Show when={dropTarget()?.roomId === space.roomId}>
								<div
									aria-hidden="true"
									class={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent ${
										dropTarget()?.edge === "before" ? "-top-0.5" : "-bottom-0.5"
									}`}
								/>
							</Show>
							<SpaceTile
								space={space}
								brokenAvatars={brokenAvatars}
								depth={() => spaceTree().depths.get(space.roomId) ?? 0}
								rootPosition={() => {
									const idx = rootIndexById().get(space.roomId);
									return idx === undefined
										? null
										: { index: idx, count: rootSpaces().length };
								}}
								onMoveSpace={moveRoot}
								onOpenSpaceSettings={props.onOpenSpaceSettings}
								onLeaveSpace={props.onLeaveSpace}
								onInviteSpace={props.onInviteSpace}
							/>
						</div>
					)}
				</For>

				{/* Spaces the user has a pending invite to. Clicking opens the
					space route, where RoomList shows the accept/decline panel
					(SpaceInvitePanel). The accent ring + dot mark them apart
					from joined spaces (#438). */}
				<For each={invitedSpaces()}>
					{(space) => {
						const isSelected = () => params.spaceId === space.roomId;
						// Fail-closed avatar: a 404/decode failure falls back to the
						// initial instead of the browser's broken-image icon (#457).
						const avatar = createImageFallback(
							() => space.avatarUrl,
							brokenAvatars,
						);
						return (
							<SidebarItem selected={isSelected}>
								<button
									type="button"
									onClick={() =>
										navigate(`/space/${encodeURIComponent(space.roomId)}`)
									}
									class={`peer relative flex h-10 w-10 items-center justify-center rounded-2xl ring-2 ring-accent transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text-primary ${
										isSelected()
											? "rounded-xl bg-surface-2 text-text-primary"
											: "bg-surface-3 text-text-secondary hover:rounded-xl hover:bg-surface-4"
									}`}
									title={`${space.name.trim() || "Unnamed space"} (invitation pending)`}
									aria-label={`${space.name.trim() || "Unnamed space"} (invitation pending)`}
									aria-current={isSelected() ? "page" : undefined}
								>
									<Show
										when={!avatar.failed() && space.avatarUrl}
										fallback={
											<span class="text-sm font-semibold">
												{avatarInitial(space.name)}
											</span>
										}
									>
										{(url) => (
											<img
												ref={avatar.ref}
												src={url()}
												alt={space.name.trim() || "Space"}
												class="h-10 w-10 rounded-[inherit] object-cover transition-[border-radius]"
												onError={avatar.onError}
												onLoad={avatar.onLoad}
											/>
										)}
									</Show>
									<span
										aria-hidden="true"
										class="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-surface-1 bg-accent"
									/>
								</button>
							</SidebarItem>
						);
					}}
				</For>

				{/* Spaces with a pending join request. Same affordance as the
					invited tiles but muted - a knock needs no action from the
					viewer, it only shows the request is outstanding (#442).
					Clicking opens the space route, where Layout renders the
					KnockPane (status + Cancel request). */}
				<For each={knockedSpaces()}>
					{(space) => {
						const isSelected = () => params.spaceId === space.roomId;
						// Fail-closed avatar: a 404/decode failure falls back to the
						// initial instead of the browser's broken-image icon (#457).
						const avatar = createImageFallback(
							() => space.avatarUrl,
							brokenAvatars,
						);
						return (
							<SidebarItem selected={isSelected}>
								<button
									type="button"
									onClick={() =>
										navigate(`/space/${encodeURIComponent(space.roomId)}`)
									}
									class={`peer relative flex h-10 w-10 items-center justify-center rounded-2xl ring-2 ring-border-strong transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text-primary ${
										isSelected()
											? "rounded-xl bg-surface-2 text-text-primary"
											: "bg-surface-3 text-text-secondary hover:rounded-xl hover:bg-surface-4"
									}`}
									title={`${space.name.trim() || "Unnamed space"} (join request pending)`}
									aria-label={`${space.name.trim() || "Unnamed space"} (join request pending)`}
									aria-current={isSelected() ? "page" : undefined}
								>
									<Show
										when={!avatar.failed() && space.avatarUrl}
										fallback={
											<span class="text-sm font-semibold">
												{avatarInitial(space.name)}
											</span>
										}
									>
										{(url) => (
											<img
												ref={avatar.ref}
												src={url()}
												alt={space.name.trim() || "Space"}
												class="h-10 w-10 rounded-[inherit] object-cover transition-[border-radius]"
												onError={avatar.onError}
												onLoad={avatar.onLoad}
											/>
										)}
									</Show>
									<span
										aria-hidden="true"
										class="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-surface-1 bg-text-disabled"
									/>
								</button>
							</SidebarItem>
						);
					}}
				</For>
			</div>

			{/* Bottom: persistent Create-space button (always visible, never
			    scrolled out of view by a long space list). shrink-0 keeps
			    it from being squeezed by the scrolling list above. */}
			<div class="mt-1 flex shrink-0 flex-col items-stretch gap-1 pt-1">
				<div class="mx-auto h-px w-8 bg-surface-3" />
				<SidebarItem selected={neverSelected}>
					<button
						type="button"
						onClick={() => setCreateOpen(true)}
						class="peer flex h-10 w-10 items-center justify-center rounded-2xl bg-surface-3 text-success-text transition-all hover:rounded-xl hover:bg-success hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
						title="Create space"
						aria-label="Create space"
					>
						<svg
							class="h-5 w-5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M12 5v14M5 12h14"
							/>
						</svg>
					</button>
				</SidebarItem>
			</div>

			<CreateSpaceDialog
				client={client}
				open={createOpen}
				onClose={() => setCreateOpen(false)}
			/>
		</aside>
	);
};

export { SpacesSidebar };
