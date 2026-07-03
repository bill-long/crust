import { Dialog } from "@kobalte/core/dialog";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { useSearchParams } from "@solidjs/router";
import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	on,
	Show,
} from "solid-js";
import {
	clamp,
	MAX_MEMBERS,
	MIN_MEMBERS,
	ResizeDivider,
} from "../components/ResizableLayout";
import {
	buildShortcodeLookup,
	useImagePacks,
} from "../features/emoji/useImagePacks";
import { CallButton } from "../features/room/call/CallButton";
import { MemberList } from "../features/room/MemberList";
import { PinnedMessagesPanel } from "../features/room/pinned/PinnedMessagesPanel";
import { usePinnedEvents } from "../features/room/pinned/usePinnedEvents";
import { RoomNotificationMenu } from "../features/room/RoomNotificationMenu";
import { SearchPanel } from "../features/room/search/SearchPanel";
import { ThreadPanel } from "../features/room/threads/ThreadPanel";
import { TimelineView } from "../features/room/timeline/TimelineView";
import { setActiveCallRoomId } from "../stores/activeCall";
import { isMobile } from "../stores/viewport";

const RoomOverflowMenu: Component<{
	canInvite: () => boolean;
	onInvite: () => void;
	onOpenSettings: () => void;
	onCopyLink: () => void;
	leaving: () => boolean;
	onLeave: () => void;
}> = (props) => {
	const itemClass =
		"flex min-h-11 w-full cursor-pointer items-center gap-3 rounded px-3 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none";
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
				title="More actions"
				aria-label="More actions"
			>
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="currentColor"
					aria-hidden="true"
				>
					<circle cx="5" cy="12" r="2" />
					<circle cx="12" cy="12" r="2" />
					<circle cx="19" cy="12" r="2" />
				</svg>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content class="z-50 min-w-[200px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg">
					<Show when={props.canInvite()}>
						<DropdownMenu.Item
							class={itemClass}
							onSelect={() => props.onInvite()}
						>
							<svg
								class="h-4 w-4 shrink-0 text-text-muted"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
								<circle cx="9" cy="7" r="4" />
								<line x1="19" y1="8" x2="19" y2="14" />
								<line x1="22" y1="11" x2="16" y2="11" />
							</svg>
							Invite people
						</DropdownMenu.Item>
					</Show>
					<DropdownMenu.Item
						class={itemClass}
						onSelect={() => props.onOpenSettings()}
					>
						<svg
							class="h-4 w-4 shrink-0 text-text-muted"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
						Room settings
					</DropdownMenu.Item>
					<DropdownMenu.Item
						class={itemClass}
						onSelect={() => props.onCopyLink()}
					>
						<svg
							class="h-4 w-4 shrink-0 text-text-muted"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
							<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
						</svg>
						Copy room link
					</DropdownMenu.Item>
					<DropdownMenu.Item
						class={`${itemClass} text-danger-text hover:bg-danger-bg/20 focus-visible:bg-danger-bg/20`}
						disabled={props.leaving()}
						onSelect={() => props.onLeave()}
					>
						<svg
							class="h-4 w-4 shrink-0"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
							<polyline points="16 17 21 12 16 7" />
							<line x1="21" y1="12" x2="9" y2="12" />
						</svg>
						{props.leaving() ? "Leaving…" : "Leave room"}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu>
	);
};

const RoomPane: Component<{
	client: MatrixClient;
	rid: string;
	roomName: string;
	onBack: () => void;
	callActive: () => boolean;
	copyState: () => "idle" | "copied" | "error";
	onCopyLink: () => void;
	canInvite: () => boolean;
	onInvite: () => void;
	leaving: () => boolean;
	onLeave: () => void;
	onOpenSettings: () => void;
	membersVisible: () => boolean;
	onToggleMembers: () => void;
	membersWidth: () => number;
	onMembersWidthChange: (next: number) => void;
	onMembersWidthCommit: () => void;
}> = (props) => {
	const pins = usePinnedEvents(props.client, () => props.rid);
	const packs = useImagePacks(props.client, () => props.rid);
	const shortcodeLookup = createMemo(() => buildShortcodeLookup(packs()));

	const [jumpRequest, setJumpRequest] = createSignal<string | null>(null);

	// Open thread (root event id) shown in the right-hand panel; closed on
	// room switch so a thread never renders under another room's header.
	const [openThreadId, setOpenThreadId] = createSignal<string | null>(null);
	createEffect(
		on(
			() => props.rid,
			() => setOpenThreadId(null),
			{ defer: true },
		),
	);

	// Deep-link: a notification click navigates to `?thread=<rootId>` to open
	// that thread's panel. Consume the param (open the panel, then strip it so
	// a later manual close, room switch, or reload doesn't reopen it). Reading
	// happens in an effect so it also fires when a notification arrives while
	// the room is already open.
	const [searchParams, setSearchParams] = useSearchParams();
	createEffect(() => {
		const requested = searchParams.thread;
		if (typeof requested === "string" && requested) {
			setOpenThreadId(requested);
			setSearchParams({ thread: undefined }, { replace: true });
		}
	});

	// Ref to the members toggle so the mobile members dialog can return focus
	// to it on close (Kobalte can't auto-restore for an externally-controlled
	// dialog that has no Dialog.Trigger).
	let membersToggleEl: HTMLButtonElement | undefined;

	return (
		<div class="relative flex h-full flex-col">
			<div class="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-4">
				<Show when={isMobile()}>
					<button
						type="button"
						onClick={() => props.onBack()}
						class="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
						title="Back to room list"
						aria-label="Back to room list"
					>
						<svg
							class="h-5 w-5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<polyline points="15 18 9 12 15 6" />
						</svg>
					</button>
				</Show>
				<span class="min-w-0 truncate text-sm font-semibold text-text-emphasis">
					{props.roomName}
				</span>
				<div class="flex min-w-0 items-center gap-1 overflow-x-auto [&>*]:shrink-0">
					<CallButton
						roomId={props.rid}
						callActive={props.callActive}
						onStart={() => setActiveCallRoomId(props.rid)}
					/>
					<RoomNotificationMenu client={props.client} roomId={props.rid} />
					{/* Secondary actions render inline on desktop; on mobile they
						collapse into the overflow menu below so the toolbar fits. */}
					<Show when={!isMobile()}>
						<Show when={props.canInvite()}>
							<button
								type="button"
								onClick={() => props.onInvite()}
								class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
								title="Invite a user to this room"
								aria-label="Invite a user to this room"
							>
								<svg
									class="h-4 w-4"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
									<circle cx="9" cy="7" r="4" />
									<line x1="19" y1="8" x2="19" y2="14" />
									<line x1="22" y1="11" x2="16" y2="11" />
								</svg>
							</button>
						</Show>
						<button
							type="button"
							onClick={() => props.onOpenSettings()}
							class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
							title="Room settings"
							aria-label="Room settings"
						>
							<svg
								class="h-4 w-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<circle cx="12" cy="12" r="3" />
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
							</svg>
						</button>
						<button
							type="button"
							onClick={() => props.onCopyLink()}
							class="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
							classList={{
								"text-success-text": props.copyState() === "copied",
								"text-danger-text": props.copyState() === "error",
								"text-text-disabled hover:text-text-primary":
									props.copyState() === "idle",
							}}
							title={
								props.copyState() === "copied"
									? "Copied!"
									: props.copyState() === "error"
										? "Copy failed"
										: "Copy a shareable link to this room"
							}
							aria-label={
								props.copyState() === "copied"
									? "Room link copied"
									: props.copyState() === "error"
										? "Failed to copy room link"
										: "Copy a shareable link to this room"
							}
						>
							<Show
								when={props.copyState() === "copied"}
								fallback={
									<svg
										class="h-4 w-4"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
										<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
									</svg>
								}
							>
								<svg
									class="h-4 w-4"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<polyline points="20 6 9 17 4 12" />
								</svg>
							</Show>
						</button>
					</Show>
					<span aria-live="polite" role="status" class="sr-only">
						{props.copyState() === "copied"
							? "Room link copied to clipboard"
							: props.copyState() === "error"
								? "Failed to copy room link"
								: ""}
					</span>
					<PinnedMessagesPanel
						client={props.client}
						pins={pins}
						shortcodeLookup={shortcodeLookup()}
						onJump={(eventId) => setJumpRequest(eventId)}
					/>
					<SearchPanel
						client={props.client}
						roomId={props.rid}
						onJump={(eventId) => setJumpRequest(eventId)}
					/>
					<button
						type="button"
						ref={membersToggleEl}
						onClick={() => props.onToggleMembers()}
						class="inline-flex h-8 w-8 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
						classList={{
							"bg-surface-3 text-text-emphasis": props.membersVisible(),
							"text-text-disabled hover:bg-surface-2 hover:text-text-primary":
								!props.membersVisible(),
						}}
						title={
							props.membersVisible() ? "Hide member list" : "Show member list"
						}
						aria-label={
							props.membersVisible() ? "Hide member list" : "Show member list"
						}
						aria-pressed={props.membersVisible()}
					>
						<svg
							class="h-4 w-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
							<circle cx="9" cy="7" r="4" />
							<path d="M23 21v-2a4 4 0 0 0-3-3.87" />
							<path d="M16 3.13a4 4 0 0 1 0 7.75" />
						</svg>
					</button>
					<Show when={!isMobile()}>
						<button
							type="button"
							onClick={() => props.onLeave()}
							disabled={props.leaving()}
							aria-busy={props.leaving()}
							class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-50 any-pointer-coarse:h-11 any-pointer-coarse:w-11"
							title={props.leaving() ? "Leaving…" : "Leave room"}
							aria-label={props.leaving() ? "Leaving room" : "Leave room"}
						>
							<svg
								class="h-4 w-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
								<polyline points="16 17 21 12 16 7" />
								<line x1="21" y1="12" x2="9" y2="12" />
							</svg>
						</button>
					</Show>
					{/* Mobile overflow menu — holds the secondary actions that
						don't fit in the narrow toolbar (invite, settings, copy
						link, leave). */}
					<Show when={isMobile()}>
						<RoomOverflowMenu
							canInvite={props.canInvite}
							onInvite={props.onInvite}
							onOpenSettings={props.onOpenSettings}
							onCopyLink={props.onCopyLink}
							leaving={props.leaving}
							onLeave={props.onLeave}
						/>
					</Show>
				</div>
			</div>

			<div class="flex min-h-0 flex-1">
				<div class="min-w-0 flex-1">
					<TimelineView
						roomId={props.rid}
						canPin={pins.canPin()}
						isPinned={(id) => pins.isPinned(id)}
						onTogglePin={(id) => {
							if (pins.isPinned(id)) void pins.unpin(id);
							else void pins.pin(id);
						}}
						jumpRequest={jumpRequest}
						onJumpHandled={() => setJumpRequest(null)}
						packs={packs}
						onOpenThread={(threadId) => setOpenThreadId(threadId)}
					/>
				</div>
				{/* Desktop: inline thread panel column. Keyed so switching to
					another thread remounts the panel: mount-time focus capture,
					focus-into-panel (live Escape), and restore target all track
					the thread the user actually opened. */}
				<Show when={!isMobile() && openThreadId()} keyed>
					{(threadId) => (
						<div class="w-96 min-w-60 max-w-[45%] shrink overflow-hidden border-l border-border-subtle">
							<ThreadPanel
								roomId={props.rid}
								threadId={threadId}
								onClose={() => setOpenThreadId(null)}
							/>
						</div>
					)}
				</Show>
				{/* Desktop: inline resizable members column */}
				<Show when={!isMobile() && props.membersVisible()}>
					<ResizeDivider
						onDrag={(d) =>
							props.onMembersWidthChange(
								clamp(props.membersWidth() - d, MIN_MEMBERS, MAX_MEMBERS),
							)
						}
						onDragEnd={() => props.onMembersWidthCommit()}
						value={props.membersWidth()}
						min={MIN_MEMBERS}
						max={MAX_MEMBERS}
						label="Resize members panel"
					/>
					<div
						style={{ width: `${props.membersWidth()}px` }}
						class="shrink-0 overflow-hidden"
					>
						<MemberList roomId={props.rid} />
					</div>
				</Show>
			</div>
			{/* Mobile: thread panel as a focus-trapped slide-over dialog
				(Escape-to-close, focus return, aria-modal for free). */}
			<Dialog
				open={isMobile() && openThreadId() !== null}
				onOpenChange={(open) => {
					if (!open) setOpenThreadId(null);
				}}
			>
				<Dialog.Portal>
					<Dialog.Overlay class="fixed inset-0 z-30 bg-black/60" />
					<Dialog.Content class="fixed inset-y-0 right-0 z-30 flex w-96 max-w-[92%] flex-col overflow-hidden border-l border-border-subtle bg-surface-1 shadow-xl">
						<Dialog.Title class="sr-only">Thread</Dialog.Title>
						{/* Keyed for the same per-thread remount as the desktop
							column (fresh focus capture per thread switch). */}
						<Show when={openThreadId()} keyed>
							{(threadId) => (
								<ThreadPanel
									roomId={props.rid}
									threadId={threadId}
									onClose={() => setOpenThreadId(null)}
								/>
							)}
						</Show>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
			{/* Mobile: members list as a focus-trapped slide-over dialog so it
				gets Escape-to-close, focus return, and aria-modal for free. */}
			<Dialog
				open={isMobile() && props.membersVisible()}
				onOpenChange={(open) => {
					if (!open && props.membersVisible()) {
						props.onToggleMembers();
						// Return focus to the toggle that opened the drawer.
						// Deferred so it runs after Kobalte's own focus handling.
						// Guard against the room pane unmounting between schedule
						// and microtask (e.g. a route change while closing).
						const el = membersToggleEl;
						if (el)
							queueMicrotask(() => {
								if (!document.body.contains(el)) return;
								// Only restore when focus dropped to the body
								// (Kobalte's default on close) or was cleared —
								// never override a control the user focused during
								// the close transition. Mirrors ThreadPanel /
								// Composer focus-restore guards.
								const active = document.activeElement;
								if (!active || active === document.body) el.focus();
							});
					}
				}}
			>
				<Dialog.Portal>
					<Dialog.Overlay class="fixed inset-0 z-30 bg-black/60" />
					<Dialog.Content class="fixed inset-y-0 right-0 z-30 flex w-72 max-w-[85%] flex-col overflow-hidden border-l border-border-subtle bg-surface-1 shadow-xl">
						<Dialog.Title class="sr-only">Member list</Dialog.Title>
						<MemberList roomId={props.rid} />
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
		</div>
	);
};

export { RoomPane };
