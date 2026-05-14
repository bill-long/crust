import { useLocation, useNavigate } from "@solidjs/router";
import { UserEvent } from "matrix-js-sdk";
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
import { MemberList } from "../features/room/MemberList";
import { RoomList } from "../features/room/RoomList";
import { RoomNotificationMenu } from "../features/room/RoomNotificationMenu";
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

	// Settings overlay is driven by the /settings/* route
	const isSettingsRoute = () =>
		location.pathname === "/settings" ||
		location.pathname.startsWith("/settings/");

	const settingsTab = (): SettingsTab => {
		const seg = location.pathname.split("/")[2];
		return tabMeta.some((t) => t.id === seg) ? (seg as SettingsTab) : "general";
	};

	const handleSettingsClose = (): void => {
		const state = location.state as { returnTo?: string } | undefined;
		if (state?.returnTo) {
			// Came from an in-app page — pop the settings history entry
			navigate(-1);
		} else {
			// Deep link with no prior context
			navigate("/home", { replace: true });
		}
	};

	useNotifications(client, summaries, () => params.roomId);

	const handleLogout = async (): Promise<void> => {
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
								state: { returnTo: location.pathname },
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
