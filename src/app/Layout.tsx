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
import { clearCryptoStores } from "../client/cryptoRecovery";
import { getSpaceRooms } from "../client/summaries-selectors";
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
import { useWebPushSync } from "../features/notifications/useWebPushSync";
import { disableWebPush } from "../features/notifications/webPush";
import { CopyLinkFallbackDialog } from "../features/room/CopyLinkFallbackDialog";
import { CallButton } from "../features/room/call/CallButton";
import { CallStatusPanel } from "../features/room/call/rtc/CallStatusPanel";
import { FullCallOverlay } from "../features/room/call/rtc/FullCallOverlay";
import { InviteDialog } from "../features/room/InviteDialog";
import { MemberList } from "../features/room/MemberList";
import { closeNotificationSound } from "../features/room/notificationSound";
import { PinnedMessagesPanel } from "../features/room/pinned/PinnedMessagesPanel";
import { usePinnedEvents } from "../features/room/pinned/usePinnedEvents";
import { RoomList } from "../features/room/RoomList";
import { RoomNotificationMenu } from "../features/room/RoomNotificationMenu";
import { buildRoomLinkUrl } from "../features/room/roomLink";
import { SearchPanel } from "../features/room/search/SearchPanel";
import { ConfirmDialog } from "../features/room/settings/ConfirmDialog";
import {
	RoomSettingsOverlay,
	type RoomSettingsTab,
} from "../features/room/settings/RoomSettingsOverlay";
import { TimelineView } from "../features/room/timeline/TimelineView";
import { createCopyLink } from "../features/room/useCopyLink";
import { useNotifications } from "../features/room/useNotifications";
import {
	SettingsOverlay,
	type SettingsTab,
	tabMeta,
} from "../features/settings/SettingsOverlay";
import {
	buildPartialLeaveMessage,
	leaveChildRooms,
} from "../features/space/leaveSpaceChildren";
import { SpacesSidebar } from "../features/space/SpacesSidebar";
import { useGlobalMicHotkey } from "../features/voice/useGlobalMicHotkey";
import { useNativeMicHotkey } from "../features/voice/useNativeMicHotkey";
import { activeCallRoomId, setActiveCallRoomId } from "../stores/activeCall";
import { triggerCryptoAction } from "../stores/cryptoActions";
import { setLastChannel } from "../stores/lastChannel";
import { membersPaneVisible, toggleMembersPane } from "../stores/layout";
import { clearSession } from "../stores/session";
import { updateSetting, userSettings } from "../stores/settings";
import type { CryptoAction } from "../types/crypto";
import { stripBasePath } from "./basePath";
import { useConfig } from "./ConfigProvider";
import { dmCanonicalTarget } from "./dmRoute";
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

	return (
		<div class="relative flex h-full flex-col">
			<div class="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-4">
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
	const { client, summaries, cryptoStatus, syncState, optimisticallyMarkLeft } =
		useClient();
	// Mount the global PTT/PTM hotkey listener once at the app shell. The
	// hook attaches no listeners until the user enables a non-default
	// `micMode` AND binds a hotkey, so the default path stays zero-cost.
	useGlobalMicHotkey();
	// Desktop shell only: drive the held state from an OS-level keyboard hook so
	// push-to-talk/mute works while a game is focused. No-ops in a browser.
	useNativeMicHotkey();
	const params = useDecodedParams<{ roomId?: string; spaceId?: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [membersWidth, setMembersWidth] = createSignal(loadMembersWidth());
	const [leavingIds, setLeavingIds] = createSignal<ReadonlySet<string>>(
		new Set(),
	);
	const isLeaving = (id: string | null | undefined): boolean =>
		id != null && leavingIds().has(id);
	const markLeaving = (id: string, on: boolean): void => {
		const next = new Set(leavingIds());
		if (on) next.add(id);
		else next.delete(id);
		setLeavingIds(next);
	};
	const [leaveConfirmRoomId, setLeaveConfirmRoomId] = createSignal<
		string | null
	>(null);
	const [leaveSpaceConfirmId, setLeaveSpaceConfirmId] = createSignal<
		string | null
	>(null);
	// "Also leave child rooms" checkbox state for the leave-space dialog.
	// Reset to false each time the dialog opens (see onLeaveSpace handler).
	const [leaveSpaceAlsoChildren, setLeaveSpaceAlsoChildren] =
		createSignal(false);
	// Snapshot of the joined child rooms (and whether any child subspaces
	// exist) taken when the leave-space dialog opens. Snapshotting keeps the
	// dialog's checkbox/count stable after the space is optimistically marked
	// "left" — at which point getSpaceRooms(summaries, sid) would return [].
	const [leaveSpaceChildren, setLeaveSpaceChildren] = createSignal<
		ReturnType<typeof getSpaceRooms>
	>([]);
	const [leaveSpaceHasSubspaces, setLeaveSpaceHasSubspaces] =
		createSignal(false);
	// The snapshot children that are still joined (pruned live against the
	// store). Drives BOTH the dialog count and the actual leave set, so the
	// displayed count stays consistent with the aggregate result message —
	// including on a retry after a partial failure, where already-left
	// children have flipped to membership "leave". (Pruning by each child's
	// membership — not the space's — is why this doesn't regress to [] when
	// the space itself is optimistically marked left.)
	const leaveSpaceJoinedChildren = createMemo(() =>
		leaveSpaceChildren().filter(
			(r) => summaries[r.roomId]?.membership === "join",
		),
	);
	const [roomSettings, setRoomSettings] = createSignal<{
		roomId: string;
		tab: RoomSettingsTab;
	} | null>(null);
	const [inviteTarget, setInviteTarget] = createSignal<{
		id: string;
		kind: "room" | "space";
	} | null>(null);
	const copyLink = createCopyLink();

	const handleCopyRoomLink = (rid: string): void => {
		// During initial sync or on deep links the Room object may not be
		// loaded yet; buildRoomLinkUrl falls back to an ID link seeded with our
		// homeserver so the button doesn't silently produce a weaker link.
		void copyLink.copy(buildRoomLinkUrl(client, rid));
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

	useNotifications(client, summaries, activeRoomId, syncState);
	const pushConfig = useConfig().push;
	useWebPushSync(client, pushConfig);

	// Canonicalize `/home/<dmId>` to `/dm/<dmId>` once summaries know the room
	// is a direct message. In-app navigation already routes DMs to `/dm/`
	// (RoomList.navigateToRoom), but deep links and service-worker push opens
	// (src/sw.ts always builds `/home/<roomId>`, since the push payload carries
	// no is-DM hint) can land on the non-canonical `/home/` route. `isDirect`
	// may be false/undefined before sync, so this runs as an effect and
	// re-canonicalizes when the store learns the room is direct. `replace: true`
	// avoids leaving a `/home/<dmId>` entry in history. After redirecting, the
	// path starts with `/dm/`, so dmCanonicalTarget returns null (no loop).
	createEffect(() => {
		const roomId = params.roomId;
		const target = dmCanonicalTarget(
			relativePath(),
			roomId,
			roomId ? summaries[roomId]?.isDirect : undefined,
		);
		if (target) navigate(target, { replace: true });
	});

	const handleLogout = async (): Promise<void> => {
		// Tear down any active call BEFORE logging out so the controller's
		// onCleanup runs against a still-authenticated client (rather than
		// firing leave/disconnect after `client.logout()` has invalidated
		// the session). Per rubber-duck #2 on Phase 7B.
		setActiveCallRoomId(null);
		closeNotificationSound();
		// Best-effort: remove this account's Web Push pusher and unsubscribe
		// before the session is invalidated, so a logged-out (or switched)
		// account doesn't keep receiving background notifications.
		if (userSettings().backgroundNotifications) {
			try {
				await disableWebPush(client, pushConfig);
			} catch {
				// Non-fatal; proceed with logout regardless.
			}
			// Clear the per-device preference so the next account to log in on
			// this browser doesn't silently inherit background push (settings
			// are shared across accounts in localStorage). The new account must
			// opt in explicitly.
			updateSetting("backgroundNotifications", false);
		}
		try {
			await client.logout(true);
		} catch {
			client.stopClient();
		}
		try {
			await clearCryptoStores(client);
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

	// Remember the last-viewed channel per space so re-selecting that space
	// in the sidebar re-opens this channel (Discord/Cinny parity, issue #226).
	createEffect(() => {
		const sid = params.spaceId;
		const rid = roomId();
		if (sid && rid) setLastChannel(sid, rid);
	});

	// Reset Copy-link feedback whenever the active room changes so a "Copied!"
	// (or fallback dialog) from room A doesn't leak into room B's header.
	createEffect(() => {
		roomId();
		copyLink.reset();
	});

	const roomName = () => {
		const rid = roomId();
		if (!rid) return "";
		const s = summaries[rid];
		return s?.name?.trim() || "Room";
	};

	const callActive = (): boolean => {
		const rid = roomId();
		if (!rid) return false;
		return summaries[rid]?.callActive ?? false;
	};

	const handleLeave = (): void => {
		const rid = roomId();
		if (!rid || isLeaving(rid)) return;
		setLeaveConfirmRoomId(rid);
	};

	const performLeave = async (rid: string): Promise<void> => {
		if (isLeaving(rid)) return;
		// If the user is leaving the room that hosts the active call, tear
		// the call down first so the controller doesn't outlive its room
		// (otherwise the mini-widget / overlay would point at a room the
		// client no longer participates in). Per rubber-duck #3 on Phase 7B.
		if (activeCallRoomId() === rid) {
			setActiveCallRoomId(null);
		}
		// Snapshot route params BEFORE the async leave call so a router
		// update during the await (e.g., the SDK forcing us out of the
		// room first) doesn't push the post-leave navigation into the
		// wrong space.
		const spaceId = params.spaceId;
		markLeaving(rid, true);
		try {
			await client.leave(rid);
			// Hide the room from all lists now; `client.leave()` has resolved
			// so the server processed the leave, but the local MyMembership
			// sync event can lag a tick. Idempotent with the eventual sync.
			optimisticallyMarkLeft(rid);
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
			markLeaving(rid, false);
		}
	};

	const leaveConfirmRoomName = createMemo(() => {
		const rid = leaveConfirmRoomId();
		if (!rid) return "";
		return summaries[rid]?.name?.trim() || "this room";
	});

	const performLeaveSpace = async (
		sid: string,
		alsoLeaveChildren = false,
	): Promise<void> => {
		if (isLeaving(sid)) return;
		// Snapshot the current space param BEFORE the async leave call so a
		// router update during the await doesn't push the post-leave
		// navigation into the wrong place.
		const wasCurrentSpace = params.spaceId === sid;
		const currentRoomId = params.roomId;
		// Use the still-joined children from the open-time snapshot (see
		// onLeaveSpace + leaveSpaceJoinedChildren) rather than recomputing
		// getSpaceRooms here: by this point the space may already be marked
		// "left" (e.g. on a retry after a partial failure), at which point
		// getSpaceRooms returns []. Pruning to still-joined children also means
		// a retry re-attempts only the ones that previously failed.
		const childRooms = alsoLeaveChildren ? leaveSpaceJoinedChildren() : [];

		let leftCount = 0;
		let failedNames: string[] = [];
		let routeRoomLeft = false;

		markLeaving(sid, true);
		try {
			// Leaving the space itself is the only step that can hard-fail the
			// operation; the child leaves below use allSettled and never throw.
			// Guard on still being joined so a retry after a partial child
			// failure (where the space was already left on the first attempt)
			// skips straight to re-leaving the remaining children instead of
			// re-issuing a leave on a space we're no longer in.
			if (summaries[sid]?.membership === "join") {
				await client.leave(sid);
				// Remove the space avatar from the sidebar immediately rather than
				// waiting for the leave-membership sync event (see #180).
				optimisticallyMarkLeft(sid);
				// Tear down the active call only AFTER the leave succeeded, so a
				// failed leave doesn't needlessly end a call in a room we're still
				// in. The same success-gated rule is applied to child rooms below.
				if (activeCallRoomId() === sid) {
					setActiveCallRoomId(null);
				}
			}

			if (childRooms.length > 0) {
				const outcome = await leaveChildRooms(client, childRooms, {
					currentRoomId,
					// Apply per-room side effects the moment each child's leave
					// resolves: hide it from the sidebar and, if it hosts the
					// active call, tear the call down immediately so the
					// controller never outlives its room during the batch. A
					// child whose leave failed never reaches this callback.
					onRoomLeft: (id) => {
						optimisticallyMarkLeft(id);
						if (activeCallRoomId() === id) setActiveCallRoomId(null);
					},
				});
				leftCount = outcome.leftRoomIds.length;
				failedNames = outcome.failedNames;
				routeRoomLeft = outcome.routeRoomLeft;
			}

			if (roomSettings()?.roomId === sid) setRoomSettings(null);
			// Navigate away if we were viewing the space, or a child room we
			// just left was the active route.
			if (wasCurrentSpace || routeRoomLeft) {
				navigate("/home");
			}
		} catch (err) {
			console.error("Failed to leave space:", err);
			throw err;
		} finally {
			markLeaving(sid, false);
		}

		// The space was left successfully. If some children failed, keep the
		// dialog open and surface aggregate feedback via its body (ConfirmDialog
		// keeps the dialog open and shows the message when onConfirm throws).
		if (failedNames.length > 0) {
			throw new Error(buildPartialLeaveMessage(leftCount, failedNames));
		}
		setLeaveSpaceConfirmId(null);
	};

	const leaveSpaceConfirmName = createMemo(() => {
		const sid = leaveSpaceConfirmId();
		if (!sid) return "";
		return summaries[sid]?.name?.trim() || "this space";
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
				spaces={
					<SpacesSidebar
						onOpenSpaceSettings={(sid) =>
							setRoomSettings({ roomId: sid, tab: "general" })
						}
						onLeaveSpace={(sid) => {
							setLeaveSpaceAlsoChildren(false);
							// Snapshot the joined children + subspace flag now, while
							// the space is still joined (getSpaceRooms requires it).
							setLeaveSpaceChildren(getSpaceRooms(summaries, sid));
							setLeaveSpaceHasSubspaces(
								(summaries[sid]?.children ?? []).some(
									(cid) => summaries[cid]?.isSpace === true,
								),
							);
							setLeaveSpaceConfirmId(sid);
						}}
						onInviteSpace={(sid) => setInviteTarget({ id: sid, kind: "space" })}
					/>
				}
				roomList={
					<RoomList
						onOpenSpaceSettings={(sid) =>
							setRoomSettings({ roomId: sid, tab: "general" })
						}
					/>
				}
				callStatus={<CallStatusPanel summaries={summaries} />}
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
					<div class="relative flex h-full min-h-0 flex-col">
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
									callActive={callActive}
									copyState={copyLink.copyState}
									onCopyLink={() => handleCopyRoomLink(rid)}
									canInvite={canInviteHere}
									onInvite={() => setInviteTarget({ id: rid, kind: "room" })}
									leaving={() => isLeaving(rid)}
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
						{/* Full-overlay chrome for the active call, scoped to the
							main pane so the sidebars stay clickable. The
							CallSessionController is mounted ABOVE this Layout
							(see `PersistentCallSurface` in App.tsx) so the
							call survives the RoomPane / Layout remount that
							happens on route-shape changes — the overlay is
							pure chrome over `currentCallSession()` and is
							safe to remount. */}
						<Show
							when={
								activeCallRoomId() !== null &&
								activeCallRoomId() === (roomId() ?? null)
							}
						>
							<FullCallOverlay />
						</Show>
					</div>
				}
			/>

			{/* Invite dialog — target (id + kind) is snapshotted at open time so an
				in-flight invite still targets the original room/space if the user
				navigates away, and the dialog header copy can't drift mid-dialog. */}
			<Show when={inviteTarget()}>
				{(target) => (
					<InviteDialog
						client={client}
						roomId={target().id}
						kind={target().kind}
						open={() => inviteTarget() !== null}
						onClose={() => setInviteTarget(null)}
					/>
				)}
			</Show>

			{/* Clipboard-unavailable fallback for "Copy room link". The URL is
				captured at open time so it survives subsequent room switches. */}
			<Show when={copyLink.fallbackLink()}>
				{(url) => (
					<CopyLinkFallbackDialog
						url={url()}
						open={() => copyLink.fallbackLink() !== null}
						onClose={() => copyLink.clearFallback()}
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
							// Snapshot whether the overlay's target is itself a
							// space — read once at open time from summaries so
							// the label survives even if the room object hasn't
							// fully synced. Falls back to room.isSpaceRoom().
							const isSpaceTarget = untrack(
								() =>
									summaries[rid]?.isSpace ??
									client.getRoom(rid)?.isSpaceRoom() ??
									false,
							);
							return (
								<RoomSettingsOverlay
									client={client}
									roomId={rid}
									isSpace={isSpaceTarget}
									activeTab={target().tab}
									onTabChange={(tab) => setRoomSettings({ roomId: rid, tab })}
									onClose={() => setRoomSettings(null)}
									onLeft={(leftRid) => {
										setRoomSettings(null);
										// If the user just left the space they were
										// viewing, navigate to /home instead of trying
										// to navigate back into the just-left space.
										const leftCurrentSpace =
											spaceIdAtOpen !== undefined && leftRid === spaceIdAtOpen;
										if (spaceIdAtOpen && !leftCurrentSpace) {
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

			{/* Leave-space confirm — opened from the SpacesSidebar context
				menu. The Settings → Advanced "Leave space" path goes through
				AdvancedTab's own confirm and is routed via onLeft. */}
			<ConfirmDialog
				open={() => leaveSpaceConfirmId() !== null}
				onClose={() => setLeaveSpaceConfirmId(null)}
				title={`Leave ${leaveSpaceConfirmName()}?`}
				body={
					<div class="space-y-3">
						<p>
							You will stop seeing this space and its curated room list in the
							sidebar. Rooms inside the space that you have already joined
							remain joined and reachable directly. You may lose access to rooms
							in the space that you have not joined — especially private ones —
							since you will no longer see them in the space's room list.
						</p>
						<Show when={leaveSpaceJoinedChildren().length > 0}>
							<label class="flex items-start gap-2 text-text-secondary">
								<input
									type="checkbox"
									class="mt-0.5"
									checked={leaveSpaceAlsoChildren()}
									onChange={(e) =>
										setLeaveSpaceAlsoChildren(e.currentTarget.checked)
									}
								/>
								<span>
									Also leave the {leaveSpaceJoinedChildren().length} room
									{leaveSpaceJoinedChildren().length === 1 ? "" : "s"} I've
									joined in this space.
								</span>
							</label>
						</Show>
						<Show when={leaveSpaceHasSubspaces()}>
							<p class="text-xs text-text-muted">
								Child spaces are not affected — leave those separately.
							</p>
						</Show>
					</div>
				}
				confirmLabel="Leave"
				destructive
				pendingLabel="Leaving…"
				onConfirm={async () => {
					const sid = leaveSpaceConfirmId();
					if (!sid) return;
					await performLeaveSpace(sid, leaveSpaceAlsoChildren());
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
