import { useLocation, useNavigate } from "@solidjs/router";
import { RoomStateEvent, UserEvent } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	lazy,
	onCleanup,
	onMount,
	Show,
	Suspense,
	untrack,
} from "solid-js";
import { logOutAccount } from "../client/accountLogout";
import { useClient } from "../client/client";
import { clearCryptoStores } from "../client/cryptoRecovery";
import {
	canMarkRoomUnread,
	markRoomUnread,
	useMarkedUnreadConsumer,
} from "../client/markedUnread";
import { getSpaceRooms } from "../client/summaries-selectors";
import {
	clamp,
	DEFAULT_MEMBERS,
	DEFAULT_THREAD,
	MAX_MEMBERS,
	MAX_THREAD,
	MIN_MEMBERS,
	MIN_THREAD,
	ResizableLayout,
} from "../components/ResizableLayout";
import { UserBar } from "../components/UserBar";
import type { LoginState } from "../features/auth/returnTo";
import { useWebPushSync } from "../features/notifications/useWebPushSync";
import { disableWebPush } from "../features/notifications/webPush";
import { CopyLinkFallbackDialog } from "../features/room/CopyLinkFallbackDialog";
import { CallStatusPanel } from "../features/room/call/rtc/CallStatusPanel";
import {
	endActiveCall,
	endCallForRoomLeave,
} from "../features/room/call/rtc/endCall";
import { ExploreDialog } from "../features/room/ExploreDialog";
import { InviteDialog } from "../features/room/InviteDialog";
import { InvitePane } from "../features/room/invites/InvitePane";
import { JoinRoomDialogHost } from "../features/room/JoinRoomDialogHost";
import { KnockPane } from "../features/room/knocks/KnockPane";
import { closeNotificationSound } from "../features/room/notificationSound";
import { PermalinkRouting } from "../features/room/PermalinkRouting";
import { ProfileCardHost } from "../features/room/profile/ProfileCardHost";
import { RoomList } from "../features/room/RoomList";
import { buildRoomLinkUrl } from "../features/room/roomLink";
import { ConfirmDialog } from "../features/room/settings/ConfirmDialog";
import type { RoomSettingsTab } from "../features/room/settings/RoomSettingsOverlay";
import { createCopyLink } from "../features/room/useCopyLink";
import { useNotifications } from "../features/room/useNotifications";
import { GlobalSearchPane } from "../features/search/GlobalSearchPane";
import { type SettingsTab, tabMeta } from "../features/settings/settingsTabs";
import {
	buildPartialLeaveMessage,
	leaveChildRooms,
} from "../features/space/leaveSpaceChildren";
import { SpacesSidebar } from "../features/space/SpacesSidebar";
import { useGlobalMicHotkey } from "../features/voice/useGlobalMicHotkey";
import { useNativeMicHotkey } from "../features/voice/useNativeMicHotkey";
import { avatarHttpUrl, avatarInitial } from "../lib/avatar";
import { cryptoActionLabel, deriveCryptoAction } from "../lib/cryptoAction";
import { loadPersisted, savePersisted } from "../lib/persistedSignal";
import { reportError } from "../lib/reportError";
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "../lib/storageKeys";
import { activeCallRoomId, setActiveCallRoomId } from "../stores/activeCall";
import { triggerCryptoAction } from "../stores/cryptoActions";
import { closeExploreDialog, exploreDialogOpen } from "../stores/exploreDialog";
import { cleanupIgnoredUsers, initIgnoredUsers } from "../stores/ignoredUsers";
import { setLastChannel } from "../stores/lastChannel";
import { getLastRoom, setLastRoom } from "../stores/lastRoom";
import { membersPaneVisible, toggleMembersPane } from "../stores/layout";
import { pushNotice } from "../stores/notices";
import {
	accounts,
	clearSession,
	loadSessions,
	MAX_ACCOUNTS,
	rememberAccountDisplayName,
} from "../stores/session";
import { updateSetting, userSettings } from "../stores/settings";
import { isMobile } from "../stores/viewport";
import type { CryptoAction } from "../types/crypto";
import {
	endSessionForAccountExit,
	finishAccountLogout,
	switchToAccount,
} from "./accountSwitch";
import { basePrefix, stripBasePath } from "./basePath";
import { useConfig } from "./ConfigProvider";
import { dmCanonicalTarget } from "./dmRoute";
import { RoomPane } from "./RoomPane";
import { useDecodedParams } from "./useDecodedParams";

// Code splitting (#307): the settings overlays and the full-screen call
// overlay are heavy subtrees that most sessions open rarely (settings) or
// never (calls). They mount only behind user action, so they load on demand.
// Each Suspense fallback matches the mounted component's outer box so the
// swap causes no layout shift (AGENTS.md rule 3).
const SettingsOverlay = lazy(() =>
	import("../features/settings/SettingsOverlay").then((m) => ({
		default: m.SettingsOverlay,
	})),
);
const RoomSettingsOverlay = lazy(() =>
	import("../features/room/settings/RoomSettingsOverlay").then((m) => ({
		default: m.RoomSettingsOverlay,
	})),
);
const FullCallOverlay = lazy(() =>
	import("../features/room/call/rtc/FullCallOverlay").then((m) => ({
		default: m.FullCallOverlay,
	})),
);

function loadMembersWidth(): number {
	const stored = loadPersisted<number | null>(
		STORAGE_KEYS.membersWidth,
		(raw) =>
			typeof raw === "number" && Number.isFinite(raw)
				? clamp(raw, MIN_MEMBERS, MAX_MEMBERS)
				: null,
		null,
		{ legacyKey: LEGACY_STORAGE_KEYS.membersWidth },
	);
	if (stored !== null) return stored;
	// Even older layouts stored the members width inside the combined pane-widths
	// object, before it was split into its own key. Recover it through the same
	// helper (so JSON parsing/migration stays centralized) by reading `members`
	// from wherever the pane-widths value now lives - the migrated
	// `crust:pane-widths` (whose raw value still carries the stale `members`
	// field) or the not-yet-migrated `crust_pane_widths` - then promote it.
	const fromCombined = loadPersisted<number | null>(
		STORAGE_KEYS.paneWidths,
		(raw) => {
			const members =
				typeof raw === "object" && raw !== null
					? (raw as { members?: unknown }).members
					: undefined;
			return typeof members === "number" && Number.isFinite(members)
				? clamp(members, MIN_MEMBERS, MAX_MEMBERS)
				: null;
		},
		null,
		{ legacyKey: LEGACY_STORAGE_KEYS.paneWidths },
	);
	if (fromCombined !== null) {
		saveMembersWidth(fromCombined);
		return fromCombined;
	}
	return DEFAULT_MEMBERS;
}

function saveMembersWidth(w: number): void {
	savePersisted(STORAGE_KEYS.membersWidth, w);
}

function loadThreadWidth(): number {
	return loadPersisted<number>(
		STORAGE_KEYS.threadWidth,
		(raw) =>
			typeof raw === "number" && Number.isFinite(raw)
				? clamp(raw, MIN_THREAD, MAX_THREAD)
				: DEFAULT_THREAD,
		DEFAULT_THREAD,
		{ legacyKey: LEGACY_STORAGE_KEYS.threadWidth },
	);
}

function saveThreadWidth(w: number): void {
	savePersisted(STORAGE_KEYS.threadWidth, w);
}

/**
 * True while a logout is running. MODULE scope, deliberately: `Layout` is
 * re-created whenever the app crosses a route-definition boundary, and
 * `/settings/*` is its own `Route`, so a component-local signal is reset by
 * merely closing the settings overlay — which is exactly what a user does when
 * a slow logout looks like nothing happened. The guard has to outlive the
 * component for the same reason `activeCallRoomId` does.
 */
const [loggingOut, setLoggingOut] = createSignal(false);

/**
 * True while an account switch or a background account log-out is running,
 * module scope for the same reason as {@link loggingOut}. The two interlock:
 * either one running blocks the other, so a switch can never race a logout for
 * the same client (two `endActiveCall` teardowns, or a reload landing on top of
 * a half-finished logout).
 */
const [accountBusy, setAccountBusy] = createSignal(false);

/** True while ANY account transition is in flight. */
const accountTransitionInFlight = (): boolean => loggingOut() || accountBusy();

const Layout: Component = () => {
	const clientCtx = useClient();
	const {
		client,
		session,
		summaries,
		cryptoStatus,
		syncState,
		optimisticallyMarkLeft,
		forgetRoomLocally,
	} = clientCtx;
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
	const [threadWidth, setThreadWidth] = createSignal(loadThreadWidth());
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
	// `location.search` is forwarded so deep-link params (`?event=` permalink
	// jumps, `?thread=` notification opens) survive the canonicalization
	// instead of being silently dropped for DM rooms.
	createEffect(() => {
		const roomId = params.roomId;
		const target = dmCanonicalTarget(
			relativePath(),
			roomId,
			roomId ? summaries[roomId]?.isDirect : undefined,
			location.search,
		);
		if (target) navigate(target, { replace: true });
	});

	const handleLogout = async (): Promise<void> => {
		// Single-flight. The call teardown below makes logout a multi-second
		// operation (bounded, but not instant), so without this a second
		// click would run this whole body concurrently: two `client.logout`
		// calls (the loser 401s) and — the real hazard — two overlapping
		// `clearCryptoStores`, whose `deleteDatabase` can be blocked by the
		// other's open connection. That await has no timeout, so the user
		// would be stranded on the app UI holding an invalidated token.
		if (accountTransitionInFlight()) return;
		setLoggingOut(true);
		try {
			await runLogout();
		} finally {
			setLoggingOut(false);
		}
	};

	/** Switch to another account: reloads the app, so nothing after it runs. */
	const handleSwitchAccount = async (targetUserId: string): Promise<void> => {
		if (accountTransitionInFlight()) return;
		setAccountBusy(true);
		try {
			const result = await switchToAccount(targetUserId);
			if (result === "unknown-account") {
				// The row was stale (the account was removed elsewhere). Say so rather
				// than leaving a menu that silently does nothing.
				pushNotice("That account is no longer signed in.", "error");
			} else if (result === "failed") {
				pushNotice("Could not switch accounts.", "error");
			}
		} catch (e) {
			reportError(e, {
				userMessage: "Could not switch accounts.",
				logLabel: "Account switch failed",
			});
		} finally {
			setAccountBusy(false);
		}
	};

	const handleAddAccount = async (): Promise<void> => {
		if (accountTransitionInFlight()) return;
		setAccountBusy(true);
		try {
			// Leaving for /login unmounts the provider (stopping the client) and the
			// flow ends in a reload, either of which would kill a MatrixRTC
			// withdrawal in flight. This is a third exit from a live session and
			// owes the server the same teardown as a switch or a logout (#474).
			await endSessionForAccountExit();
			// Router state, not a query param: a crafted link must not be able to
			// put the login page into add-account mode and quietly append a second
			// token.
			navigate("/login", { state: { addAccount: true } satisfies LoginState });
		} finally {
			setAccountBusy(false);
		}
	};

	/**
	 * Log an account out from the switcher. The active account goes through the
	 * full teardown (its client is running and owes the server a call withdrawal
	 * and a pusher removal); any other account is revoked with a throwaway client
	 * so the one on screen is never disturbed.
	 */
	const handleLogOutAccount = async (targetUserId: string): Promise<void> => {
		if (accountTransitionInFlight()) return;
		if (targetUserId === userId()) {
			await handleLogout();
			return;
		}
		// Storage, not the per-tab mirror: if another tab logged this account out
		// and back in, the mirror holds the dead token and the revoke below would
		// 401 while the live session survives on the server.
		const target = loadSessions().find((a) => a.userId === targetUserId);
		if (!target) return;
		setAccountBusy(true);
		try {
			await logOutAccount(target);
		} catch (e) {
			reportError(e, {
				userMessage: "Could not log that account out.",
				logLabel: "Background account logout failed",
			});
		} finally {
			setAccountBusy(false);
		}
	};

	const runLogout = async (): Promise<void> => {
		// Stop the chime first, as this did before the teardown await was
		// introduced. It is not a mute: `playNotificationSound` builds a fresh
		// AudioContext on demand, so a message arriving during the teardown
		// still chimes. Restoring the old ordering is the point.
		closeNotificationSound();
		// End a call hosted anywhere BEFORE logging out, and await it: the
		// MatrixRTC withdrawal has to reach the server while our token is
		// still valid, exactly as for a room leave (#474). Dropping the
		// signal alone only *schedules* the withdrawal, which then races
		// `client.logout()` and 401s whenever it loses.
		await endActiveCall();
		// Restore the unconditional guarantee the plain `setActiveCallRoomId`
		// used to give: `endActiveCall` clears the signal only for
		// the room it tore down, so a call started (or switched to) during
		// the teardown would otherwise survive into the logged-out state and
		// be picked up by the NEXT account to log in on this tab —
		// `activeCallRoomId` is module-global and never reset on login.
		setActiveCallRoomId(null);
		// Best-effort: remove this account's Web Push pusher and unsubscribe
		// before the session is invalidated, so a logged-out (or switched)
		// account doesn't keep receiving background notifications.
		if (userSettings().backgroundNotifications) {
			try {
				await disableWebPush(client, pushConfig);
			} catch {
				// Non-fatal; proceed with logout regardless.
			}
			// Clear this account's preference now that its pusher is gone, so a
			// later login as the same account doesn't read "background push on"
			// with no pusher registered. Settings are per-account (#532), so this
			// write must happen BEFORE clearSession() below - once the account is
			// gone there is no key left to file it under.
			updateSetting("backgroundNotifications", false);
		}
		try {
			await client.logout(true);
		} catch {
			client.stopClient();
		}
		await finishAccountLogout(
			clearSession,
			async () => {
				try {
					await clearCryptoStores(client, session);
				} catch (e) {
					console.warn("Failed to clear stores on logout:", e);
				}
			},
			() => navigate("/login", { replace: true }),
		);
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
	const initial = () => avatarInitial(displayName());

	const avatarUrl = (): string | null =>
		avatarHttpUrl(client, profileAvatarMxc(), 80);

	// Rows for the switcher. Only the ACTIVE account gets an avatar URL:
	// authenticated media is fetched with the owning account's token and only one
	// account's token is live, so the others show their initial (#533).
	const accountSummaries = createMemo(() =>
		accounts().map((account) => {
			const isActive = account.userId === userId();
			const name = isActive
				? displayName()
				: (account.displayName?.trim() ??
					(account.userId.split(":")[0]?.replace("@", "").trim() ||
						account.userId));
			return {
				userId: account.userId,
				displayName: name,
				initial: avatarInitial(name),
				avatarUrl: isActive ? avatarUrl() : null,
			};
		}),
	);

	// Keep the switcher's label for THIS account current while it is the one
	// running: an account whose client is not started has no profile to read, so
	// the last name it was seen under is all a row can show (#533). The store
	// ignores an unchanged value, so this does not write on every sync.
	createEffect(() => {
		const uid = userId();
		if (!uid) return;
		rememberAccountDisplayName(uid, profileName()?.trim() || undefined);
	});

	const cryptoAction = createMemo(
		(): CryptoAction =>
			deriveCryptoAction({
				crossSigningReady: cryptoStatus.crossSigningReady(),
				thisDeviceVerified: cryptoStatus.thisDeviceVerified(),
				backupVersion: cryptoStatus.backupVersion(),
				backupOnServer: cryptoStatus.backupOnServer(),
				crossSigningStatus: cryptoStatus.crossSigningStatus(),
			}),
	);

	const needsCryptoAttention = () => {
		const a = cryptoAction();
		return (
			a === "setup-cross-signing" ||
			a === "verify-session" ||
			a === "setup-backup" ||
			a === "unlock-backup" ||
			a === "reset-encryption"
		);
	};

	const handleCryptoClick = (): void => {
		const action = cryptoAction();
		if (action !== "hidden" && action !== "loading") {
			triggerCryptoAction(action);
		}
	};

	const roomId = () => params.roomId;

	// Mobile single-pane "back" — drop the room from the route so the
	// sidebar/room-list pane becomes visible again. Space rooms return to
	// their space; home rooms and DMs return to the home list.
	const backToList = (): void => {
		const sid = params.spaceId;
		if (sid) navigate(`/space/${encodeURIComponent(sid)}`);
		else navigate("/home");
	};

	// The members pane behaves differently per breakpoint, so its open state is
	// split in two: on desktop it's the persisted inline-column preference
	// (`membersPaneVisible`, saved to localStorage); on mobile it's an
	// ephemeral slide-over drawer that must not touch — or be driven by — that
	// persisted preference. `mobileMembersOpen` is reset whenever the room
	// changes (so a drawer left open can't occlude the next room's timeline)
	// and whenever the breakpoint flips (so a drawer opened on mobile, then
	// crossed to desktop and back, doesn't silently auto-reopen).
	const [mobileMembersOpen, setMobileMembersOpen] = createSignal(false);
	const membersVisible = (): boolean =>
		isMobile() ? mobileMembersOpen() : membersPaneVisible();
	const handleToggleMembers = (): void => {
		if (isMobile()) setMobileMembersOpen((v) => !v);
		else toggleMembersPane();
	};
	createEffect(() => {
		roomId();
		isMobile();
		setMobileMembersOpen(false);
	});

	// Remember the last-viewed channel per space so re-selecting that space
	// in the sidebar re-opens this channel (Discord/Cinny parity, issue #226).
	createEffect(() => {
		const sid = params.spaceId;
		const rid = roomId();
		if (sid && rid) setLastChannel(sid, rid);
	});

	// Remember the last room the user had open, across every section
	// (home / space / DM), so the next cold launch reopens it instead of the
	// empty home list (see restore-on-launch onMount below). Stored structurally
	// (room + its space, if any) rather than as a raw route so the route can be
	// rebuilt and re-validated against the live store on launch.
	createEffect(() => {
		const rid = roomId();
		if (rid) setLastRoom(rid, params.spaceId);
	});

	// Opening a room consumes its marked-unread flag (MSC2867), so the
	// sidebar dot disappears the moment the room is viewed. The hook owns
	// the "what counts as opening" policy - see useMarkedUnreadConsumer.
	useMarkedUnreadConsumer(clientCtx, roomId);

	// Restore the last room on a cold launch. The app boots on the bare root
	// path ("/") with no room selected; reopen the room the user last had open
	// so they resume where they left off rather than landing on the empty home
	// list. Guards:
	//   • Only acts at the root path, so deliberately navigating to "/home"
	//     (the sidebar Home button) — or any other route — is never hijacked.
	//   • Only restores a room that is still joined; a left/stale room is
	//     skipped so we don't open a timeline the user can no longer see.
	//   • Reopens under the original space only while that space still lists the
	//     room as a joined child (mirrors SpacesSidebar.openSpace); otherwise
	//     falls back to the section-agnostic home/DM route so a left space can't
	//     strand the room under an empty room list / unhighlighted sidebar.
	// Layout only mounts once SyncGate lets it through (syncState past
	// "initial"), so `summaries` is populated by the time this runs.
	onMount(() => {
		if (relativePath() !== "/") return;
		const last = getLastRoom();
		if (!last) return;
		const summary = summaries[last.roomId];
		if (summary?.membership !== "join") return;
		const sid = last.spaceId;
		if (
			sid &&
			getSpaceRooms(summaries, sid).some((r) => r.roomId === last.roomId)
		) {
			navigate(
				`/space/${encodeURIComponent(sid)}/${encodeURIComponent(last.roomId)}`,
				{ replace: true },
			);
			return;
		}
		navigate(
			summary.isDirect
				? `/dm/${encodeURIComponent(last.roomId)}`
				: `/home/${encodeURIComponent(last.roomId)}`,
			{ replace: true },
		);
	});

	// Reset Copy-link feedback whenever the active room changes so a "Copied!"
	// (or fallback dialog) from room A doesn't leak into room B's header.
	createEffect(() => {
		roomId();
		copyLink.reset();
	});

	// Bind the ignored-users store to this session's client (member-list
	// Block/Unblock + timeline sender collapsing). Layout lives for the
	// whole authenticated session, so init once here and clean up on unmount.
	onMount(() => {
		initIgnoredUsers(client);
	});
	onCleanup(() => {
		cleanupIgnoredUsers();
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
		// Snapshot route params BEFORE the async work below so a router
		// update during an await (e.g., the SDK forcing us out of the
		// room first) doesn't push the post-leave navigation into the
		// wrong space.
		const spaceId = params.spaceId;
		markLeaving(rid, true);
		try {
			// End a call hosted here BEFORE leaving, and await it: the
			// MatrixRTC withdrawal has to reach the server while we are
			// still joined. See endCallForRoomLeave for the full rule.
			await endCallForRoomLeave(rid);
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
				// Same teardown-before-leave rule as performLeave, applied to
				// the space itself; the child rooms below get it via
				// leaveChildRooms' onBeforeRoomLeave hook.
				await endCallForRoomLeave(sid);
				await client.leave(sid);
				// Remove the space avatar from the sidebar immediately rather than
				// waiting for the leave-membership sync event (see #180).
				optimisticallyMarkLeft(sid);
			}

			if (childRooms.length > 0) {
				const outcome = await leaveChildRooms(client, childRooms, {
					currentRoomId,
					// End a call hosted in a child before that child's leave is
					// issued, so the RTC withdrawal is accepted (see
					// endCallForRoomLeave). At most one child can host the
					// active call, so this is a no-op for all the others.
					onBeforeRoomLeave: endCallForRoomLeave,
					// Hide each child from the sidebar the moment its own leave
					// resolves, rather than waiting for the whole batch. A
					// child whose leave failed never reaches this callback.
					onRoomLeft: optimisticallyMarkLeft,
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
			{/* Document-level matrix.to / matrix: permalink routing (renders nothing) */}
			<PermalinkRouting />
			{/* Session-long join-room dialog host (store-driven open; renders
				the dialog only while open) */}
			<JoinRoomDialogHost client={client} />
			{/* Session-long profile card host (store-driven open; anchored to
				whichever member row / message header / pill requested it) */}
			<ProfileCardHost />
			{/* Public room directory (store-driven open, session-long host) */}
			<ExploreDialog open={exploreDialogOpen} onClose={closeExploreDialog} />
			{/* Resizable layout with user bar spanning left sidebar */}
			<ResizableLayout
				showMainOnMobile={() => roomId() !== undefined}
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
					// The search pane wraps the list rather than sitting beside
					// it: a query replaces the list with its results, and the
					// list comes back when the search is cleared.
					<GlobalSearchPane>
						<RoomList
							onOpenSpaceSettings={(sid) =>
								setRoomSettings({ roomId: sid, tab: "general" })
							}
						/>
					</GlobalSearchPane>
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
						accounts={accountSummaries()}
						canAddAccount={accounts().length < MAX_ACCOUNTS}
						maxAccounts={MAX_ACCOUNTS}
						accountBusy={accountTransitionInFlight()}
						onSwitchAccount={handleSwitchAccount}
						onAddAccount={handleAddAccount}
						onLogOutAccount={handleLogOutAccount}
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
						{/*
						 * `keyed` is load-bearing, not a perf tweak: it REMOUNTS the
						 * room subtree (RoomPane -> Composer/TimelineView) on every room
						 * switch, so each room gets fresh component state. Composer
						 * relies on this for room isolation - it has no in-place
						 * room-switch guards (#382). Do NOT drop `keyed` without
						 * restoring those guards; Composer.roomIsolation.test.ts fails
						 * loudly if you do.
						 */}
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
								// A room the user is only invited to gets the
								// accept/decline pane: the timeline isn't readable
								// and the composer can't send, so none of RoomPane
								// applies (#438). Accepting flips the summary
								// membership to "join", which swaps in the real
								// RoomPane right here without a route change.
								// A pending knock gets the same treatment with a
								// status/cancel pane (#442).
								<Show
									when={
										summaries[rid]?.membership !== "invite" &&
										summaries[rid]?.membership !== "knock"
									}
									fallback={
										<Show
											when={summaries[rid]?.membership === "invite"}
											fallback={
												<KnockPane
													rid={rid}
													roomName={roomName()}
													onBack={backToList}
													onCancelled={backToList}
												/>
											}
										>
											<InvitePane
												rid={rid}
												roomName={roomName()}
												onBack={backToList}
												onDeclined={backToList}
											/>
										</Show>
									}
								>
									<RoomPane
										client={client}
										rid={rid}
										roomName={roomName()}
										onBack={backToList}
										callActive={callActive}
										copyState={copyLink.copyState}
										onCopyLink={() => handleCopyRoomLink(rid)}
										canInvite={canInviteHere}
										onInvite={() => setInviteTarget({ id: rid, kind: "room" })}
										onMarkUnread={() => markRoomUnread(clientCtx, rid)}
										canMarkUnread={() => canMarkRoomUnread(summaries[rid])}
										leaving={() => isLeaving(rid)}
										onLeave={handleLeave}
										onOpenSettings={() =>
											setRoomSettings({ roomId: rid, tab: "general" })
										}
										membersVisible={membersVisible}
										onToggleMembers={handleToggleMembers}
										membersWidth={membersWidth}
										onMembersWidthChange={(next) => setMembersWidth(next)}
										onMembersWidthCommit={() =>
											saveMembersWidth(membersWidth())
										}
										threadWidth={threadWidth}
										onThreadWidthChange={(next) => setThreadWidth(next)}
										onThreadWidthCommit={() => saveThreadWidth(threadWidth())}
									/>
								</Show>
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
							{/* Fallback matches the overlay's outer box (absolute
							    inset-0 bg-surface-0) so joining a call never shifts
							    layout while the chunk loads. */}
							<Suspense
								fallback={<div class="absolute inset-0 z-30 bg-surface-0" />}
							>
								<FullCallOverlay />
							</Suspense>
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
						text={url()}
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
							// Shared by Leave and Forget: the room is gone from the
							// user's list either way, so close the overlay and
							// navigate somewhere that still exists.
							const handleRoomGone = (goneRid: string): void => {
								setRoomSettings(null);
								// If the user just left the space they were
								// viewing, navigate to /home instead of trying
								// to navigate back into the just-left space.
								const leftCurrentSpace =
									spaceIdAtOpen !== undefined && goneRid === spaceIdAtOpen;
								if (spaceIdAtOpen && !leftCurrentSpace) {
									navigate(`/space/${encodeURIComponent(spaceIdAtOpen)}`);
								} else {
									navigate("/home");
								}
							};
							return (
								// Fallback matches the overlay's outer box (fixed
								// inset-0 with the same backdrop) so opening room
								// settings never shifts layout while the chunk loads.
								<Suspense
									fallback={
										<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/60" />
									}
								>
									<RoomSettingsOverlay
										client={client}
										roomId={rid}
										isSpace={isSpaceTarget}
										activeTab={target().tab}
										onTabChange={(tab) => setRoomSettings({ roomId: rid, tab })}
										onClose={() => setRoomSettings(null)}
										onLeft={(leftRid) => {
											// Hide the room from all lists immediately, matching
											// the header-leave path; idempotent with the eventual
											// MyMembership sync event.
											optimisticallyMarkLeft(leftRid);
											handleRoomGone(leftRid);
										}}
										onForgot={(forgotRid) => {
											// Navigate away first, then drop local state:
											// deleting the routed room's store entries
											// before leaving it would render the room
											// view in a deleted state (see
											// forgetRoomLocally). solid-router defers the
											// route swap to a microtask (startTransition),
											// so the purge is queued behind it rather than
											// run synchronously.
											handleRoomGone(forgotRid);
											queueMicrotask(() => forgetRoomLocally(forgotRid));
										}}
									/>
								</Suspense>
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
				{/* Same fixed inset-0 backdrop fallback as RoomSettingsOverlay. */}
				<Suspense
					fallback={
						<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/60" />
					}
				>
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
						loggingOut={loggingOut}
					/>
				</Suspense>
			</Show>
		</div>
	);
};

export { Layout };
