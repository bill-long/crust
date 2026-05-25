import { useLocation, useNavigate } from "@solidjs/router";
import type { MatrixClient } from "matrix-js-sdk";
import { RoomStateEvent, UserEvent } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import { useClient } from "../client/client";
import {
	clamp,
	DEFAULT_MEMBERS,
	MAX_MEMBERS,
	MIN_MEMBERS,
	ResizableLayout,
	ResizeDivider,
} from "../components/ResizableLayout";
import { UserBar } from "../components/UserBar";
import {
	cryptoActionLabel,
	deriveCryptoAction,
} from "../features/crypto/CryptoStatusBanner";
import {
	buildShortcodeLookup,
	useImagePacks,
} from "../features/emoji/useImagePacks";
import { CopyLinkFallbackDialog } from "../features/room/CopyLinkFallbackDialog";
import { InviteDialog } from "../features/room/InviteDialog";
import { MemberList } from "../features/room/MemberList";
import { closeNotificationSound } from "../features/room/notificationSound";
import { PinnedMessagesPanel } from "../features/room/pinned/PinnedMessagesPanel";
import { usePinnedEvents } from "../features/room/pinned/usePinnedEvents";
import { RoomList } from "../features/room/RoomList";
import { RoomNotificationMenu } from "../features/room/RoomNotificationMenu";
import { buildRoomLink, buildRoomLinkById } from "../features/room/roomLink";
import { SearchPanel } from "../features/room/search/SearchPanel";
import { ConfirmDialog } from "../features/room/settings/ConfirmDialog";
import {
	RoomSettingsOverlay,
	type RoomSettingsTab,
} from "../features/room/settings/RoomSettingsOverlay";
import { TimelineView } from "../features/room/timeline/TimelineView";
import { useNotifications } from "../features/room/useNotifications";
import {
	SettingsOverlay,
	type SettingsTab,
	tabMeta,
} from "../features/settings/SettingsOverlay";
import { SpacesSidebar } from "../features/space/SpacesSidebar";
import { triggerCryptoAction } from "../stores/cryptoActions";
import { membersPaneVisible, toggleMembersPane } from "../stores/layout";
import { clearSession } from "../stores/session";
import type { CryptoAction } from "../types/crypto";
import { stripBasePath } from "./basePath";
import { useDecodedParams } from "./useDecodedParams";

const MEMBERS_WIDTH_KEY = "crust_members_width";

function loadMembersWidth(): number {
	try {
		const raw = localStorage.getItem(MEMBERS_WIDTH_KEY);
		if (raw) {
			const n = Number(raw);
			if (Number.isFinite(n)) return clamp(n, MIN_MEMBERS, MAX_MEMBERS);
		}
		// Migrate from old combined storage key
		const legacy = localStorage.getItem("crust_pane_widths");
		if (legacy) {
			const parsed = JSON.parse(legacy);
			if (typeof parsed.members === "number") {
				const w = clamp(parsed.members, MIN_MEMBERS, MAX_MEMBERS);
				saveMembersWidth(w);
				return w;
			}
		}
	} catch {
		// ignore
	}
	return DEFAULT_MEMBERS;
}

function saveMembersWidth(w: number): void {
	try {
		localStorage.setItem(MEMBERS_WIDTH_KEY, String(w));
	} catch {
		// ignore
	}
}

const RoomPane: Component<{
	client: MatrixClient;
	rid: string;
	roomName: string;
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

	return (
		<div class="flex h-full flex-col">
			<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-4">
				<span class="min-w-0 truncate text-sm font-semibold text-text-emphasis">
					{props.roomName}
				</span>
				<div class="flex shrink-0 items-center gap-1">
					<RoomNotificationMenu client={props.client} roomId={props.rid} />
					<Show when={props.canInvite()}>
						<button
							type="button"
							onClick={() => props.onInvite()}
							class="rounded px-2 py-1 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							title="Invite a user to this room"
						>
							Invite
						</button>
					</Show>
					<button
						type="button"
						onClick={() => props.onOpenSettings()}
						class="rounded px-2 py-1 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
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
						class="rounded px-2 py-1 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						title="Copy a shareable link to this room"
					>
						{props.copyState() === "copied"
							? "Copied!"
							: props.copyState() === "error"
								? "Copy failed"
								: "Copy link"}
					</button>
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
						onClick={() => props.onToggleMembers()}
						class="rounded px-2 py-1 text-xs transition-colors"
						classList={{
							"bg-surface-3 text-text-emphasis": props.membersVisible(),
							"text-text-disabled hover:bg-surface-2 hover:text-text-secondary":
								!props.membersVisible(),
						}}
						title={
							props.membersVisible() ? "Hide member list" : "Show member list"
						}
						aria-pressed={props.membersVisible()}
					>
						Members
					</button>
					<button
						type="button"
						onClick={() => props.onLeave()}
						disabled={props.leaving()}
						class="rounded px-2 py-1 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-danger-text"
						title="Leave room"
					>
						{props.leaving() ? "Leaving…" : "Leave"}
					</button>
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
					/>
				</div>
				<Show when={props.membersVisible()}>
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
		</div>
	);
};

const Layout: Component = () => {
	const { client, summaries, cryptoStatus, syncState } = useClient();
	const params = useDecodedParams<{ roomId?: string; spaceId?: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [membersWidth, setMembersWidth] = createSignal(loadMembersWidth());
	const [leaving, setLeaving] = createSignal(false);
	const [leaveConfirmRoomId, setLeaveConfirmRoomId] = createSignal<
		string | null
	>(null);
	const [roomSettings, setRoomSettings] = createSignal<{
		roomId: string;
		tab: RoomSettingsTab;
	} | null>(null);
	const [inviteRoomId, setInviteRoomId] = createSignal<string | null>(null);
	const [copyState, setCopyState] = createSignal<"idle" | "copied" | "error">(
		"idle",
	);
	const [fallbackLink, setFallbackLink] = createSignal<string | null>(null);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
	// Monotonic generation counter for copy operations. Each click bumps it;
	// awaited results (and the auto-reset timer they schedule) must verify
	// they are still the current generation before mutating state. Without
	// this guard a slow first request could overwrite the result of a faster
	// second request, or an unmount could leave the success continuation
	// scheduling a timer that outlives the component.
	let copyGen = 0;
	let copyDisposed = false;
	onCleanup(() => {
		copyDisposed = true;
		copyGen++;
		if (copyResetTimer !== undefined) {
			clearTimeout(copyResetTimer);
			copyResetTimer = undefined;
		}
	});

	const handleCopyRoomLink = async (rid: string): Promise<void> => {
		const room = client.getRoom(rid);
		// During initial sync or on deep links the Room object may not be
		// loaded yet. Fall back to a minimal matrix.to link built from the
		// route param so the button doesn't silently no-op.
		const { url } = room ? buildRoomLink(room) : buildRoomLinkById(rid);

		const gen = ++copyGen;
		if (copyResetTimer !== undefined) {
			clearTimeout(copyResetTimer);
			copyResetTimer = undefined;
		}

		// Schedule the 2s auto-reset that returns the button label back to
		// the neutral "Copy link" state. Used by both the success and the
		// error paths so the visible status doesn't strand indefinitely.
		const scheduleReset = (): void => {
			copyResetTimer = setTimeout(() => {
				copyResetTimer = undefined;
				if (copyDisposed || gen !== copyGen) return;
				setCopyState("idle");
			}, 2000);
		};

		const clipboard =
			typeof navigator !== "undefined" ? navigator.clipboard : undefined;
		if (!clipboard?.writeText) {
			// Force an aria-live re-announcement when the prior state was
			// already "error": two synchronous setCopyState calls in the
			// same event handler batch collapse to a single render, leaving
			// the polite region silent. setTimeout(..., 0) lets the browser
			// commit the "idle" render before the "error" render lands.
			setCopyState("idle");
			setTimeout(() => {
				if (copyDisposed || gen !== copyGen) return;
				setCopyState("error");
				scheduleReset();
			}, 0);
			setFallbackLink(url);
			return;
		}
		// Reset to idle synchronously so any prior "Copied!"/"Copy failed"
		// label and aria-live announcement clear before the async clipboard
		// result lands.
		setCopyState("idle");
		try {
			await clipboard.writeText(url);
			if (copyDisposed || gen !== copyGen) return;
			setCopyState("copied");
			// If a prior failed attempt left the fallback dialog open and the
			// retry succeeded, close it so the user isn't asked to copy by hand.
			setFallbackLink(null);
			scheduleReset();
		} catch {
			if (copyDisposed || gen !== copyGen) return;
			setCopyState("error");
			setFallbackLink(url);
			scheduleReset();
		}
	};

	// `location.pathname` is the full URL pathname including any Vite base
	// (e.g. `/crust/settings/account`). Strip the base before comparing
	// against route patterns the app defines.
	const basePrefix = import.meta.env.BASE_URL.replace(/\/$/, "");
	const relativePath = (): string =>
		stripBasePath(location.pathname, basePrefix);

	// Settings overlay is driven by the /settings/* route
	const isSettingsRoute = () => {
		const p = relativePath();
		return p === "/settings" || p.startsWith("/settings/");
	};

	const settingsTab = (): SettingsTab => {
		const seg = relativePath().split("/")[2];
		return tabMeta.some((t) => t.id === seg) ? (seg as SettingsTab) : "general";
	};

	type SettingsState = { returnTo?: string; activeRoomId?: string };

	const handleSettingsClose = (): void => {
		const state = location.state as SettingsState | undefined;
		if (state?.returnTo) {
			// Came from an in-app page — pop the settings history entry
			navigate(-1);
		} else {
			// Deep link with no prior context
			navigate("/home", { replace: true });
		}
	};

	// Preserve notification suppression for the room the user was viewing
	// before opening settings (settings route clears params.roomId)
	const activeRoomId = (): string | undefined => {
		if (isSettingsRoute()) {
			return (location.state as SettingsState | undefined)?.activeRoomId;
		}
		return params.roomId;
	};

	useNotifications(client, summaries, activeRoomId);

	const handleLogout = async (): Promise<void> => {
		closeNotificationSound();
		try {
			await client.logout(true);
		} catch {
			client.stopClient();
		}
		try {
			await client.clearStores();
		} catch (e) {
			console.warn("Failed to clear stores on logout:", e);
		}
		clearSession();
		navigate("/login", { replace: true });
	};

	const userId = () => client.getUserId() ?? "";

	// Current user profile — reactive via SDK events.
	// Uses createEffect (not onMount) so that if getUser() returns null
	// on the first attempt, the subscription retries when syncState changes.
	const [profileName, setProfileName] = createSignal<string | undefined>();
	const [profileAvatarMxc, setProfileAvatarMxc] = createSignal<
		string | undefined
	>();

	createEffect(() => {
		const state = syncState();
		if (state !== "live" && state !== "catching-up" && state !== "stopped")
			return;

		const uid = client.getUserId();
		if (!uid) return;
		const user = client.getUser(uid);
		if (!user) return;

		setProfileName(user.displayName ?? undefined);
		setProfileAvatarMxc(user.avatarUrl ?? undefined);

		const onName = (): void => {
			setProfileName(user.displayName ?? undefined);
		};
		const onAvatar = (): void => {
			setProfileAvatarMxc(user.avatarUrl ?? undefined);
		};

		user.on(UserEvent.DisplayName, onName);
		user.on(UserEvent.AvatarUrl, onAvatar);

		onCleanup(() => {
			user.removeListener(UserEvent.DisplayName, onName);
			user.removeListener(UserEvent.AvatarUrl, onAvatar);
		});
	});

	const displayName = () => {
		const name = profileName();
		if (name?.trim()) return name.trim();
		const uid = userId();
		const localpart = uid.split(":")[0]?.replace("@", "").trim();
		return localpart || uid || "User";
	};
	const initial = () => (displayName().trim() || "?").charAt(0).toUpperCase();

	const avatarUrl = (): string | null => {
		const mxc = profileAvatarMxc();
		if (!mxc) return null;
		return client.mxcUrlToHttp(mxc, 80, 80, "crop") ?? null;
	};

	const cryptoAction = createMemo(
		(): CryptoAction =>
			deriveCryptoAction(
				cryptoStatus.crossSigningReady(),
				cryptoStatus.thisDeviceVerified(),
				cryptoStatus.backupVersion(),
			),
	);

	const needsCryptoAttention = () => {
		const a = cryptoAction();
		return (
			a === "setup-cross-signing" ||
			a === "verify-session" ||
			a === "setup-backup"
		);
	};

	const handleCryptoClick = (): void => {
		const action = cryptoAction();
		if (action !== "hidden" && action !== "loading") {
			triggerCryptoAction(action);
		}
	};

	const roomId = () => params.roomId;

	// Reset Copy-link feedback whenever the active room changes so a "Copied!"
	// (or fallback dialog) from room A doesn't leak into room B's header.
	createEffect(() => {
		roomId();
		copyGen++;
		if (copyResetTimer !== undefined) {
			clearTimeout(copyResetTimer);
			copyResetTimer = undefined;
		}
		setCopyState("idle");
		setFallbackLink(null);
	});

	const roomName = () => {
		const rid = roomId();
		if (!rid) return "";
		const s = summaries[rid];
		return s?.name?.trim() || "Room";
	};

	const handleLeave = (): void => {
		const rid = roomId();
		if (!rid || leaving()) return;
		setLeaveConfirmRoomId(rid);
	};

	const performLeave = async (rid: string): Promise<void> => {
		if (leaving()) return;
		// Snapshot route params BEFORE the async leave call so a router
		// update during the await (e.g., the SDK forcing us out of the
		// room first) doesn't push the post-leave navigation into the
		// wrong space.
		const spaceId = params.spaceId;
		setLeaving(true);
		try {
			await client.leave(rid);
			// Close any open overlays that target this room.
			if (roomSettings()?.roomId === rid) setRoomSettings(null);
			setLeaveConfirmRoomId(null);
			if (spaceId) {
				navigate(`/space/${encodeURIComponent(spaceId)}`);
			} else {
				navigate("/home");
			}
		} catch (err) {
			console.error("Failed to leave room:", err);
			throw err;
		} finally {
			setLeaving(false);
		}
	};

	const leaveConfirmRoomName = createMemo(() => {
		const rid = leaveConfirmRoomId();
		if (!rid) return "";
		return summaries[rid]?.name?.trim() || "this room";
	});

	// Reactive "can the current user invite to the active room?"
	// Recomputed when roomId changes OR when room state events fire (power
	// levels / membership / join rules can affect canInvite).
	const [canInviteBump, setCanInviteBump] = createSignal(0);
	createEffect(() => {
		// Track syncState so this effect retries once the SDK has loaded
		// rooms (e.g. deep link before initial sync completes).
		syncState();
		const rid = roomId();
		if (!rid) return;
		const room = client.getRoom(rid);
		if (!room) return;
		const onStateUpdate = (): void => {
			setCanInviteBump((n) => n + 1);
		};
		room.on(RoomStateEvent.Update, onStateUpdate);
		onCleanup(() => {
			room.removeListener(RoomStateEvent.Update, onStateUpdate);
		});
	});
	const canInviteHere = createMemo(() => {
		canInviteBump();
		syncState();
		const rid = roomId();
		if (!rid) return false;
		const room = client.getRoom(rid);
		const uid = client.getUserId();
		if (!room || !uid) return false;
		return room.canInvite(uid);
	});

	return (
		<div class="flex min-h-0 flex-1 bg-surface-0 text-text-primary">
			{/* Resizable layout with user bar spanning left sidebar */}
			<ResizableLayout
				spaces={<SpacesSidebar />}
				roomList={<RoomList />}
				userBar={
					<UserBar
						displayName={displayName()}
						userId={userId()}
						initial={initial()}
						avatarUrl={avatarUrl()}
						syncStatus={(() => {
							const s = syncState();
							return s === "catching-up" || s === "stopped" ? s : "live";
						})()}
						needsCryptoAttention={needsCryptoAttention()}
						cryptoLabel={cryptoActionLabel(cryptoAction())}
						onCryptoClick={handleCryptoClick}
						onSettingsClick={() =>
							navigate("/settings", {
								state: {
									returnTo: location.pathname + location.search + location.hash,
									activeRoomId: params.roomId,
								} satisfies SettingsState,
							})
						}
					/>
				}
				main={
					<Show
						when={roomId()}
						keyed
						fallback={
							<main class="flex h-full flex-col">
								<div class="flex flex-1 items-center justify-center">
									<p class="text-text-disabled">
										Select a room to start chatting
									</p>
								</div>
							</main>
						}
					>
						{(rid) => (
							<RoomPane
								client={client}
								rid={rid}
								roomName={roomName()}
								copyState={copyState}
								onCopyLink={() => handleCopyRoomLink(rid)}
								canInvite={canInviteHere}
								onInvite={() => setInviteRoomId(rid)}
								leaving={leaving}
								onLeave={handleLeave}
								onOpenSettings={() =>
									setRoomSettings({ roomId: rid, tab: "general" })
								}
								membersVisible={membersPaneVisible}
								onToggleMembers={toggleMembersPane}
								membersWidth={membersWidth}
								onMembersWidthChange={(next) => setMembersWidth(next)}
								onMembersWidthCommit={() => saveMembersWidth(membersWidth())}
							/>
						)}
					</Show>
				}
			/>

			{/* Invite dialog — roomId is snapshotted at open time so an
				in-flight invite still targets the original room if the user
				navigates away. */}
			<Show when={inviteRoomId()}>
				{(rid) => (
					<InviteDialog
						client={client}
						roomId={rid()}
						open={() => inviteRoomId() !== null}
						onClose={() => setInviteRoomId(null)}
					/>
				)}
			</Show>

			{/* Clipboard-unavailable fallback for "Copy room link". The URL is
				captured at open time so it survives subsequent room switches. */}
			<Show when={fallbackLink()}>
				{(url) => (
					<CopyLinkFallbackDialog
						url={url()}
						open={() => fallbackLink() !== null}
						onClose={() => {
							setFallbackLink(null);
							setCopyState("idle");
						}}
					/>
				)}
			</Show>

			{/* Room settings overlay (per-room). The inner keyed <Show>
				remounts the overlay when the target roomId changes so
				per-tab local edit state (drafts, errors, in-flight
				writes) cannot leak between rooms. */}
			<Show when={roomSettings()}>
				{(target) => (
					<Show when={target().roomId} keyed>
						{(rid) => {
							// Snapshot the route's spaceId at the moment the
							// overlay is rendered (and re-snapshot whenever
							// roomId changes, via the keyed Show). Read via
							// untrack so subsequent router updates to
							// params.spaceId during the async leave cannot
							// re-run this child and overwrite the snapshot.
							const spaceIdAtOpen = untrack(() => params.spaceId);
							return (
								<RoomSettingsOverlay
									client={client}
									roomId={rid}
									activeTab={target().tab}
									onTabChange={(tab) => setRoomSettings({ roomId: rid, tab })}
									onClose={() => setRoomSettings(null)}
									onLeft={() => {
										setRoomSettings(null);
										if (spaceIdAtOpen) {
											navigate(`/space/${encodeURIComponent(spaceIdAtOpen)}`);
										} else {
											navigate("/home");
										}
									}}
								/>
							);
						}}
					</Show>
				)}
			</Show>

			{/* Header "Leave" confirm — routed through the same modal as the
				Advanced tab's Leave so both entry points are consistent. */}
			<ConfirmDialog
				open={() => leaveConfirmRoomId() !== null}
				onClose={() => setLeaveConfirmRoomId(null)}
				title={`Leave ${leaveConfirmRoomName()}?`}
				body="You will stop receiving messages from this room. If the room is invite-only you may not be able to rejoin without a new invite."
				confirmLabel="Leave"
				destructive
				pendingLabel="Leaving…"
				onConfirm={async () => {
					const rid = leaveConfirmRoomId();
					if (!rid) return;
					await performLeave(rid);
				}}
			/>

			{/* Settings overlay */}
			<Show when={isSettingsRoute()}>
				<SettingsOverlay
					activeTab={settingsTab()}
					onTabChange={(tab) =>
						navigate(`/settings/${tab}`, {
							replace: true,
							state: location.state,
						})
					}
					onClose={handleSettingsClose}
					onLogout={handleLogout}
				/>
			</Show>
		</div>
	);
};

export { Layout };
