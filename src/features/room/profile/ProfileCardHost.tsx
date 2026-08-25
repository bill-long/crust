import { Popover } from "@kobalte/core/popover";
import { useNavigate } from "@solidjs/router";
import {
	type Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { avatarHttpUrl, avatarInitial } from "../../../lib/avatar";
import { createImageFallback } from "../../../lib/imageFallback";
import { requestMention } from "../../../stores/composerIntents";
import { isUserIgnored, setUserIgnored } from "../../../stores/ignoredUsers";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { effectiveUsersDefault } from "../settings/powerLevelPresets";
import {
	type ModerationActions,
	useModerationActions,
} from "../settings/useModerationActions";
import { findExistingDmRoom, readDirectMap, startDm } from "../startDm";
import { roleForPowerLevel } from "../useMemberList";
import {
	closeProfileCard,
	type ProfileCardRequest,
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
	moderation: ModerationActions;
}> = (props) => {
	const { client, optimisticallyMarkJoined } = useClient();
	const navigate = useNavigate();
	const req = props.request;
	const isSelf = () => client.getUserId() === req.userId;

	const member = createMemo(() =>
		req.roomId
			? (client.getRoom(req.roomId)?.getMember(req.userId) ?? null)
			: null,
	);
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
		const m = member();
		if (m?.name?.trim()) return m.name.trim();
		return fetchedProfile()?.displayname?.trim() || req.userId;
	});
	const avatarUrl = createMemo(() => {
		const mxc = member()?.getMxcAvatarUrl() ?? fetchedProfile()?.avatar_url;
		return avatarHttpUrl(client, mxc, 96);
	});
	const avatar = createImageFallback(avatarUrl);

	// Role from the live power-level content (not the member snapshot) so a
	// promote/demote fired from this card updates the label in place.
	const targetPowerLevel = createMemo<number | null>(() => {
		if (!req.roomId || !member()) return null;
		const pl = props.moderation.plContent();
		const raw = pl?.users?.[req.userId];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
		return effectiveUsersDefault(pl);
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
			optimisticallyMarkJoined(roomId, {
				name: displayName(),
				avatarUrl: avatarUrl(),
				isDirect: true,
			});
			navigate(`/dm/${encodeURIComponent(roomId)}`);
			closeProfileCard();
		} catch (err) {
			setActionErrorLocal(
				err instanceof Error
					? err.message
					: "Couldn't start the conversation. Please try again.",
			);
		} finally {
			setDmPending(false);
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
			closeProfileCard();
		} catch {
			setActionErrorLocal(
				ignoring
					? `Couldn't block ${displayName()}. Try again.`
					: `Couldn't unblock ${displayName()}. Try again.`,
			);
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
		const promoteMod = props.moderation.canPromoteMod(req.userId);
		const promoteAdmin = props.moderation.canPromoteAdmin(req.userId);
		const demote = props.moderation.canDemote(
			req.userId,
			targetPowerLevel() ?? 0,
		);
		const kick = props.moderation.perms.canKickTarget(req.userId);
		const ban = props.moderation.perms.canBanTarget(req.userId);
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
		props.moderation.requestAction({
			kind,
			userId: req.userId,
			displayName: displayName(),
		});
		// Kick/Ban continue in the host's ConfirmDialog; the popover
		// closes so the two focus traps never coexist.
		if (kind === "kick" || kind === "ban") closeProfileCard();
	};

	return (
		<Popover
			open
			onOpenChange={(open) => {
				if (!open) closeProfileCard();
			}}
			anchorRef={() => req.anchor}
			placement="right-start"
			gutter={8}
		>
			<Popover.Portal>
				<Popover.Content class="portal-scale z-50 w-72 rounded-lg border border-border-subtle bg-surface-2 shadow-lg focus:outline-hidden">
					<div class="flex items-center gap-3 border-b border-border-subtle p-4">
						<div
							class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-xl font-semibold text-text-secondary"
							aria-hidden="true"
						>
							<Show
								when={!avatar.failed() && avatarUrl()}
								fallback={<span>{avatarInitial(displayName())}</span>}
							>
								{(url) => (
									<img
										ref={avatar.ref}
										src={url()}
										alt=""
										class="h-full w-full object-cover"
										onError={avatar.onError}
										onLoad={avatar.onLoad}
									/>
								)}
							</Show>
						</div>
						<div class="min-w-0">
							<Popover.Title class="truncate text-base font-semibold text-text-emphasis">
								{displayName()}
							</Popover.Title>
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

					<Show when={actionErrorLocal() ?? props.moderation.actionError()}>
						{(message) => (
							<p
								class="border-b border-border-subtle bg-danger-bg/30 px-4 py-2 text-xs text-danger-text"
								role="alert"
							>
								{message()}
							</p>
						)}
					</Show>

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
									isUserIgnored(req.userId) ? ACTION_CLASS : DANGER_ACTION_CLASS
								}
								onClick={() => void handleToggleIgnore()}
							>
								{isUserIgnored(req.userId) ? "Unblock" : "Block"}
							</button>
						</Show>
					</div>

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
	// The moderation room latches (never clears) so a kick/ban confirmed
	// AFTER the card closed still targets the room the card was opened in.
	const [moderationRoomId, setModerationRoomId] = createSignal("");
	createEffect(() => {
		const roomId = profileCardRequest()?.roomId;
		if (roomId) setModerationRoomId(roomId);
	});
	const moderation = useModerationActions(client, moderationRoomId);

	return (
		<>
			<Show when={profileCardRequest()} keyed>
				{(request) => (
					<ProfileCardPopover request={request} moderation={moderation} />
				)}
			</Show>
			<ConfirmDialog
				open={() => moderation.pendingAction() !== null}
				onClose={() => moderation.setPendingAction(null)}
				title={
					moderation.pendingAction()?.kind === "ban"
						? `Ban ${moderation.pendingAction()?.displayName}?`
						: `Kick ${moderation.pendingAction()?.displayName}?`
				}
				body={
					<p>
						{moderation.pendingAction()?.kind === "ban"
							? "They won't be able to rejoin unless unbanned."
							: "They can rejoin if the room is public or someone re-invites them."}
					</p>
				}
				confirmLabel={
					moderation.pendingAction()?.kind === "ban" ? "Ban" : "Kick"
				}
				destructive
				onConfirm={async () => {
					const action = moderation.pendingAction();
					if (!action) return;
					await moderation.performKickOrBan(action);
					moderation.setPendingAction(null);
				}}
			/>
		</>
	);
};

export { ProfileCardHost };
