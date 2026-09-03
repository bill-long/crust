import { Popover } from "@kobalte/core/popover";
import { useNavigate } from "@solidjs/router";
import { type MatrixEvent, RoomStateEvent } from "matrix-js-sdk";
import {
	type Component,
	createMemo,
	createResource,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { presenceOf } from "../../../client/presence";
import { Avatar } from "../../../components/Avatar";
import { avatarHttpUrl, avatarInitial } from "../../../lib/avatar";
import { readDirectMap } from "../../../lib/directMap";
import { displayNameOr } from "../../../lib/displayName";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { reportError } from "../../../lib/reportError";
import { requestMention } from "../../../stores/composerIntents";
import { isUserIgnored, setUserIgnored } from "../../../stores/ignoredUsers";
import { KickBanConfirm } from "../settings/KickBanConfirm";
import {
	type MemberAction,
	performKickOrBan,
	useModerationActions,
} from "../settings/useModerationActions";
import { findExistingDmRoom, startDm } from "../startDm";
import { roleForPowerLevel } from "../useMemberList";
import {
	closeProfileCard,
	type ProfileCardRequest,
	profileAnchorKey,
	profileCardRequest,
} from "./profileCard";

const ACTION_CLASS =
	"w-full rounded px-3 py-1.5 text-left text-sm text-text-primary hover:bg-surface-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover";
const DANGER_ACTION_CLASS =
	"w-full rounded px-3 py-1.5 text-left text-sm text-danger-text hover:bg-danger-bg/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-danger";

/**
 * The profile card popover for one request (#444): avatar, display name,
 * MXID, room role, and the user actions - Message, Mention,
 * Block/Unblock, and permission-gated moderation. Rendered keyed per
 * request by {@link ProfileCardHost}, anchored to the element that was
 * clicked.
 */
const ProfileCardPopover: Component<{
	request: ProfileCardRequest;
	/** Park a kick/ban for the host's confirm dialog (which outlives the
	 *  popover) with the room captured at park time. */
	onKickBan: (action: MemberAction, roomId: string) => void;
}> = (props) => {
	const { client, optimisticallyMarkJoined } = useClient();
	const navigate = useNavigate();
	const req = props.request;
	const isSelf = () => client.getUserId() === req.userId;
	// Scoped to this popover instance (not the session-long host): the
	// PL-write chain, error state, and the client-wide listeners the
	// permission machinery registers all live only while a card for THIS
	// room is open - a fresh card can never see another room's chain or
	// stale error. Kick/Ban park at the host, whose ConfirmDialog
	// outlives this popover (the card closes when the dialog opens so
	// their focus traps never coexist).
	const moderation = useModerationActions(client, () => req.roomId ?? "", {
		parkKickBan: (action) => {
			if (!req.roomId) return;
			props.onKickBan(action, req.roomId);
			closeProfileCard();
		},
	});

	// Async flows below (startDm) may resolve after the keyed popover is
	// disposed (Esc, click-away, room switch). They must not navigate or
	// write state for a card the user already dismissed.
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	// The anchor is a live element in lists that re-mint rows. A member
	// row is re-minted by ANY entry change - typing, and notably the very
	// promote/demote this card fires - so a detached anchor first tries to
	// re-resolve to the re-minted row via its data-profile-anchor marker
	// (keeping the card, its role label, and any error banner alive), and
	// only closes when the row is truly gone (scrolled away, room switch).
	// Re-resolution is scoped to cards OPENED from a marked element:
	// re-anchoring a timeline-header card to the same user's member-list
	// row would teleport it across the screen, so those just close.
	const [anchor, setAnchor] = createSignal(req.anchor);
	const canReanchor = req.anchor.hasAttribute("data-profile-anchor");
	const anchorKey = profileAnchorKey(req.roomId, req.userId);
	const detachWatch = setInterval(() => {
		if (anchor().isConnected) return;
		// Attribute values are compared byte-for-byte instead of being
		// interpolated into a selector - no escaping pitfalls, and only
		// rendered (virtualized) rows carry the attribute.
		const reminted = canReanchor
			? ([
					...document.querySelectorAll<HTMLElement>("[data-profile-anchor]"),
				].find((el) => el.getAttribute("data-profile-anchor") === anchorKey) ??
				null)
			: null;
		if (reminted) {
			setAnchor(reminted);
			// Keep the store's copy live too - openProfileCard's toggle
			// branch compares against it.
			req.anchor = reminted;
		} else {
			closeProfileCard();
		}
	}, 300);
	onCleanup(() => clearInterval(detachWatch));

	// Member state is not reactive on its own: a lazy-loaded member (or a
	// profile change) landing while the card is open must recompute the
	// role and moderation gates, so bump a tick on this user's member
	// events.
	const [memberTick, setMemberTick] = createSignal(0);
	const onMembersChanged = (event: MatrixEvent): void => {
		if (
			event.getRoomId() === req.roomId &&
			event.getStateKey?.() === req.userId
		) {
			setMemberTick((n) => n + 1);
		}
	};
	client.on(RoomStateEvent.Members, onMembersChanged);
	onCleanup(() => client.off(RoomStateEvent.Members, onMembersChanged));

	const member = createMemo(() => {
		memberTick();
		return req.roomId
			? (client.getRoom(req.roomId)?.getMember(req.userId) ?? null)
			: null;
	});
	// Cheap path first: room member state. Only when the user isn't a
	// known member (a pill for a non-member, or no room context) fall
	// back to a lazy profile fetch; a failure just leaves the MXID.
	const [fetchedProfile] = createResource(
		() => (member() ? null : req.userId),
		async (userId) => {
			try {
				return await client.getProfileInfo(userId);
			} catch {
				return null;
			}
		},
	);

	const displayName = createMemo(() => {
		// Both branches, not just the member one: a fetched profile is raw
		// wire data for someone who is not in the room - the stranger case
		// this card exists to help judge.
		const m = member();
		if (m) return displayNameOr(m.name, req.userId);
		return displayNameOr(fetchedProfile()?.displayname, req.userId);
	});
	const avatarUrl = createMemo(() => {
		const mxc = member()?.getMxcAvatarUrl() ?? fetchedProfile()?.avatar_url;
		return avatarHttpUrl(client, mxc, 96);
	});

	// Role from the SAME power-level source the moderation gates read, so
	// the label and the buttons can never disagree; live, so a
	// promote/demote fired from this card updates the label in place.
	const targetPowerLevel = createMemo<number | null>(() => {
		if (!req.roomId || !member()) return null;
		return moderation.perms.targetPowerLevel(req.userId);
	});
	const role = createMemo(() => {
		const pl = targetPowerLevel();
		return pl === null ? null : roleForPowerLevel(pl);
	});

	const [actionErrorLocal, setActionErrorLocal] = createSignal<string | null>(
		null,
	);
	const [dmPending, setDmPending] = createSignal(false);

	const handleMessage = async (): Promise<void> => {
		if (dmPending()) return;
		setActionErrorLocal(null);
		setDmPending(true);
		try {
			// Fast path: an already-joined DM opens with no round-trip.
			const existing = findExistingDmRoom(
				client,
				req.userId,
				readDirectMap(client),
			);
			if (existing && client.getRoom(existing)?.getMyMembership() === "join") {
				navigate(`/dm/${encodeURIComponent(existing)}`);
				closeProfileCard();
				return;
			}
			const { roomId } = await startDm(client, req.userId);
			// A card dismissed mid-flight must not yank the user into the
			// DM they cancelled (the room itself was still created; it
			// surfaces in the DM list via sync).
			if (disposed) return;
			optimisticallyMarkJoined(roomId, {
				name: displayName(),
				avatarUrl: avatarUrl(),
				isDirect: true,
			});
			navigate(`/dm/${encodeURIComponent(roomId)}`);
			closeProfileCard();
		} catch (err) {
			// The card's inline banner is the user surface - unless the card
			// was dismissed mid-flight, where the failure would otherwise be
			// invisible and a toast is the only surface left.
			reportError(err, {
				logLabel: "Start DM from profile card failed",
				userMessage: disposed
					? "Couldn't start the conversation. Please try again."
					: undefined,
			});
			if (disposed) return;
			setActionErrorLocal(
				userFacingErrorMessage(
					err,
					"Couldn't start the conversation. Please try again.",
				),
			);
		} finally {
			if (!disposed) setDmPending(false);
		}
	};

	const handleMention = (): void => {
		if (!req.roomId) return;
		requestMention({
			roomId: req.roomId,
			threadRootId: req.threadRootId,
			userId: req.userId,
			name: displayName(),
		});
		closeProfileCard();
	};

	const handleToggleIgnore = async (): Promise<void> => {
		const ignoring = !isUserIgnored(req.userId);
		setActionErrorLocal(null);
		try {
			await setUserIgnored(client, req.userId, ignoring);
			// A card dismissed mid-flight must not close whichever card the
			// user has since opened.
			if (disposed) return;
			closeProfileCard();
		} catch (err) {
			const message = ignoring
				? `Couldn't block ${displayName()}. Try again.`
				: `Couldn't unblock ${displayName()}. Try again.`;
			// The card's inline banner is the user surface - unless the card
			// was dismissed mid-flight, where the failure would otherwise be
			// invisible and a toast is the only surface left.
			reportError(err, {
				logLabel: "Toggle ignore failed",
				userMessage: disposed ? message : undefined,
			});
			if (disposed) return;
			setActionErrorLocal(message);
		}
	};

	const moderationTargets = createMemo(() => {
		if (!req.roomId || isSelf() || !member()) {
			return {
				promoteMod: false,
				promoteAdmin: false,
				demote: false,
				kick: false,
				ban: false,
				any: false,
			};
		}
		const promoteMod = moderation.canPromoteMod(req.userId);
		const promoteAdmin = moderation.canPromoteAdmin(req.userId);
		const demote = moderation.canDemote(req.userId, targetPowerLevel() ?? 0);
		const kick = moderation.perms.canKickTarget(req.userId);
		const ban = moderation.perms.canBanTarget(req.userId);
		return {
			promoteMod,
			promoteAdmin,
			demote,
			kick,
			ban,
			any: promoteMod || promoteAdmin || demote || kick || ban,
		};
	});

	const moderate = (
		kind: "promote-mod" | "promote-admin" | "demote" | "kick" | "ban",
	): void => {
		if (!req.roomId) return;
		moderation.requestAction({
			kind,
			userId: req.userId,
			displayName: displayName(),
		});
	};

	return (
		<Popover
			open
			onOpenChange={(open) => {
				if (!open) closeProfileCard();
			}}
			anchorRef={anchor}
			placement="right-start"
			gutter={8}
		>
			<Popover.Portal>
				<Popover.Content
					class="portal-scale z-50 w-72 rounded-lg border border-border-subtle bg-surface-2 shadow-lg focus:outline-hidden"
					// An outside-pointerdown landing on the anchor is a
					// toggle-close gesture: keep Kobalte from dismissing here,
					// so the gesture's click reaches openProfileCard as a
					// plain click on an open card and hits its same-anchor
					// toggle branch - no timing heuristics involved.
					onPointerDownOutside={(e) => {
						const target = e.target;
						if (target instanceof Node && anchor().contains(target)) {
							e.preventDefault();
						}
					}}
					// There is no Popover.Trigger (the anchor is an arbitrary
					// clicked element), so Kobalte's default close-focus has
					// nothing to restore to and keyboard focus would drop to
					// the body - send it back to the anchor instead.
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						const el = anchor();
						if (el.isConnected) el.focus();
					}}
				>
					<div class="flex items-center gap-3 border-b border-border-subtle p-4">
						<Avatar
							url={avatarUrl()}
							initial={avatarInitial(displayName())}
							size="xl"
							presence={presenceOf(req.userId).status}
							// The card sits on surface-2, not the list surface.
							presenceRingClass="ring-surface-2"
						/>
						<div class="min-w-0">
							<Popover.Title class="truncate text-base font-semibold text-text-emphasis">
								{displayName()}
							</Popover.Title>
							{/* The card is opened from a row that was already
							    showing this; dropping it here would read as the
							    status having been withdrawn. */}
							<Show when={presenceOf(req.userId).statusMsg}>
								{(msg) => (
									<div class="truncate text-xs text-text-secondary">
										{msg()}
									</div>
								)}
							</Show>
							<div class="truncate font-mono text-xs text-text-muted">
								{req.userId}
							</div>
							<Show when={role()}>
								{(r) => (
									<span class="mt-1 inline-block rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
										{r()}
									</span>
								)}
							</Show>
						</div>
					</div>

					<Show when={actionErrorLocal() ?? moderation.actionError()}>
						{(message) => (
							<p
								class="border-b border-border-subtle bg-danger-bg/30 px-4 py-2 text-xs text-danger-text"
								role="alert"
							>
								{message()}
							</p>
						)}
					</Show>

					{/* Hidden entirely on an own-profile card outside a room,
					    where every action inside would be hidden anyway. */}
					<Show when={!isSelf() || req.roomId}>
						<div class="p-1">
							<Show when={!isSelf()}>
								<button
									type="button"
									class={ACTION_CLASS}
									disabled={dmPending()}
									onClick={() => void handleMessage()}
								>
									{dmPending() ? "Opening…" : "Message"}
								</button>
							</Show>
							<Show when={req.roomId}>
								<button
									type="button"
									class={ACTION_CLASS}
									onClick={handleMention}
								>
									Mention
								</button>
							</Show>
							<Show when={!isSelf()}>
								<button
									type="button"
									class={
										isUserIgnored(req.userId)
											? ACTION_CLASS
											: DANGER_ACTION_CLASS
									}
									onClick={() => void handleToggleIgnore()}
								>
									{isUserIgnored(req.userId) ? "Unblock" : "Block"}
								</button>
							</Show>
						</div>
					</Show>

					<Show when={moderationTargets().any}>
						<div class="border-t border-border-subtle p-1">
							<Show when={moderationTargets().promoteMod}>
								<button
									type="button"
									class={ACTION_CLASS}
									onClick={() => moderate("promote-mod")}
								>
									Promote to Moderator
								</button>
							</Show>
							<Show when={moderationTargets().promoteAdmin}>
								<button
									type="button"
									class={ACTION_CLASS}
									onClick={() => moderate("promote-admin")}
								>
									Promote to Admin
								</button>
							</Show>
							<Show when={moderationTargets().demote}>
								<button
									type="button"
									class={ACTION_CLASS}
									onClick={() => moderate("demote")}
								>
									Demote to Member
								</button>
							</Show>
							<Show when={moderationTargets().kick}>
								<button
									type="button"
									class={DANGER_ACTION_CLASS}
									onClick={() => moderate("kick")}
								>
									Kick…
								</button>
							</Show>
							<Show when={moderationTargets().ban}>
								<button
									type="button"
									class={DANGER_ACTION_CLASS}
									onClick={() => moderate("ban")}
								>
									Ban…
								</button>
							</Show>
						</div>
					</Show>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
};

/**
 * Session-long host for the profile card (#444): one Kobalte popover
 * anchored to whichever element requested it via `openProfileCard`, plus
 * the kick/ban ConfirmDialog, which outlives the popover (the card
 * closes when the dialog opens so their focus traps never coexist).
 */
const ProfileCardHost: Component = () => {
	const { client } = useClient();
	// Kick/Ban parked here with their room captured at park time, so the
	// ConfirmDialog outlives the keyed popover AND can never fire against
	// a different room than the card it came from.
	const [pendingKickBan, setPendingKickBan] = createSignal<{
		action: MemberAction;
		roomId: string;
	} | null>(null);

	return (
		<>
			<Show when={profileCardRequest()} keyed>
				{(request) => (
					<ProfileCardPopover
						request={request}
						onKickBan={(action, roomId) =>
							setPendingKickBan({ action, roomId })
						}
					/>
				)}
			</Show>
			<KickBanConfirm
				action={() => pendingKickBan()?.action ?? null}
				onClose={() => setPendingKickBan(null)}
				onConfirm={async (action) => {
					const pending = pendingKickBan();
					if (!pending) return;
					await performKickOrBan(client, pending.roomId, action);
				}}
			/>
		</>
	);
};

export { ProfileCardHost };
