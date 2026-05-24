import { useLocation, useNavigate } from "@solidjs/router";
import { RoomStateEvent, UserEvent } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
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
import { CopyLinkFallbackDialog } from "../features/room/CopyLinkFallbackDialog";
import { InviteDialog } from "../features/room/InviteDialog";
import { MemberList } from "../features/room/MemberList";
import { closeNotificationSound } from "../features/room/notificationSound";
import { RoomList } from "../features/room/RoomList";
import { RoomNotificationMenu } from "../features/room/RoomNotificationMenu";
import { buildRoomLink, buildRoomLinkById } from "../features/room/roomLink";
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

const Layout: Component = () => {
	const { client, summaries, cryptoStatus, syncState } = useClient();
	const params = useDecodedParams<{ roomId?: string; spaceId?: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [membersWidth, setMembersWidth] = createSignal(loadMembersWidth());
	const [leaving, setLeaving] = createSignal(false);
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

	const handleLeave = async (): Promise<void> => {
		const rid = roomId();
		if (!rid || leaving()) return;
		setLeaving(true);
		try {
			await client.leave(rid);
			if (params.spaceId) {
				navigate(`/space/${encodeURIComponent(params.spaceId)}`);
			} else {
				navigate("/home");
			}
		} catch (err) {
			console.error("Failed to leave room:", err);
		} finally {
			setLeaving(false);
		}
	};

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
							<div class="flex h-full flex-col">
								{/* Room header — spans full width above timeline + members */}
								<div class="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle px-4">
									<span class="text-sm font-semibold text-text-emphasis">
										{roomName()}
									</span>
									<div class="flex items-center gap-1">
										<RoomNotificationMenu client={client} roomId={rid()} />
										<Show when={canInviteHere()}>
											<button
												type="button"
												onClick={() => setInviteRoomId(rid())}
												class="rounded px-2 py-1 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
												title="Invite a user to this room"
											>
												Invite
											</button>
										</Show>
										<button
											type="button"
											onClick={() => handleCopyRoomLink(rid())}
											class="rounded px-2 py-1 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
											title="Copy a shareable link to this room"
										>
											{copyState() === "copied"
												? "Copied!"
												: copyState() === "error"
													? "Copy failed"
													: "Copy link"}
										</button>
										<span aria-live="polite" role="status" class="sr-only">
											{copyState() === "copied"
												? "Room link copied to clipboard"
												: copyState() === "error"
													? "Failed to copy room link"
													: ""}
										</span>
										<button
											type="button"
											onClick={toggleMembersPane}
											class="rounded px-2 py-1 text-xs transition-colors"
											classList={{
												"bg-surface-3 text-text-emphasis": membersPaneVisible(),
												"text-text-disabled hover:bg-surface-2 hover:text-text-secondary":
													!membersPaneVisible(),
											}}
											title={
												membersPaneVisible()
													? "Hide member list"
													: "Show member list"
											}
											aria-pressed={membersPaneVisible()}
										>
											Members
										</button>
										<button
											type="button"
											onClick={handleLeave}
											disabled={leaving()}
											class="rounded px-2 py-1 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-danger-text"
											title="Leave room"
										>
											{leaving() ? "Leaving…" : "Leave"}
										</button>
									</div>
								</div>

								{/* Timeline + optional members panel side by side */}
								<div class="flex min-h-0 flex-1">
									<div class="min-w-0 flex-1">
										<TimelineView roomId={rid()} />
									</div>
									<Show when={membersPaneVisible()}>
										<ResizeDivider
											onDrag={(d) =>
												setMembersWidth((w) =>
													clamp(w - d, MIN_MEMBERS, MAX_MEMBERS),
												)
											}
											onDragEnd={() => saveMembersWidth(membersWidth())}
											value={membersWidth()}
											min={MIN_MEMBERS}
											max={MAX_MEMBERS}
											label="Resize members panel"
										/>
										<div
											style={{ width: `${membersWidth()}px` }}
											class="shrink-0 overflow-hidden"
										>
											<MemberList roomId={rid()} />
										</div>
									</Show>
								</div>
							</div>
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
