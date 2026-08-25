import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { Virtualizer } from "virtua/solid";
import { RowAvatar } from "../../../components/RowAvatar";
import { avatarInitial } from "../../../lib/avatar";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { createFailedImageUrls } from "../../../lib/imageFallback";
import { useMemberList } from "../useMemberList";
import { ConfirmDialog } from "./ConfirmDialog";
import { InviteByUserIdForm } from "./InviteByUserIdForm";
import {
	type MemberAction,
	useModerationActions,
} from "./useModerationActions";
import { usePendingInvites } from "./usePendingInvites";
import { usePendingKnocks } from "./usePendingKnocks";

interface MembersTabProps {
	client: MatrixClient;
	roomId: string;
}

const MembersTab: Component<MembersTabProps> = (props) => {
	const roomId = () => props.roomId;
	// Shared across the three lists below: useMemberList and the pending-invite
	// hooks rebuild their entries on any member event, so <For> remounts the
	// rows and per-row error state would re-paint the broken image (#457).
	const brokenAvatars = createFailedImageUrls();
	const moderation = useModerationActions(props.client, roomId);
	const { perms, actionError, pendingAction, setPendingAction } = moderation;
	const memberList = useMemberList(props.client, roomId);
	const invites = usePendingInvites(props.client, roomId);
	const knocks = usePendingKnocks(props.client, roomId);

	const [openMenuFor, setOpenMenuFor] = createSignal<string | null>(null);
	const [revokeError, setRevokeError] = createSignal<{
		userId: string;
		message: string;
	} | null>(null);
	const [revoking, setRevoking] = createSignal<string | null>(null);

	// Groups from useMemberList are pre-bucketed Admin > Moderator > Member
	// and alphabetized within each role. Sort by power level descending so
	// that within a role bucket (e.g. two Moderators at PL 80 vs PL 50) the
	// higher-privilege user appears first; ties keep the alphabetical
	// ordering from useMemberList because Array.prototype.sort is stable.
	const allMembers = createMemo(() => {
		const flat = memberList.groups().flatMap((g) => g.members);
		return [...flat].sort((a, b) => b.powerLevel - a.powerLevel);
	});

	let scrollRef!: HTMLDivElement;

	// The moderation state and writes live in useModerationActions (shared
	// with the profile card); this wrapper just closes the row menu first.
	const requestAction = (action: MemberAction): void => {
		setOpenMenuFor(null);
		moderation.requestAction(action);
	};

	const revokeInvite = async (userId: string): Promise<void> => {
		setRevokeError(null);
		setRevoking(userId);
		try {
			await props.client.kick(props.roomId, userId);
		} catch (e) {
			setRevokeError({
				userId,
				message: e instanceof Error ? e.message : "Could not revoke invite.",
			});
		} finally {
			setRevoking(null);
		}
	};

	const [knockPending, setKnockPending] = createSignal<{
		userId: string;
		action: "approve" | "decline";
	} | null>(null);
	const [knockError, setKnockError] = createSignal<{
		userId: string;
		message: string;
	} | null>(null);

	/** Approve (invite) or decline (kick) a pending join request (#442). */
	const resolveKnock = async (
		userId: string,
		action: "approve" | "decline",
	): Promise<void> => {
		if (knockPending()) return;
		setKnockError(null);
		setKnockPending({ userId, action });
		try {
			if (action === "approve") {
				await props.client.invite(props.roomId, userId);
			} else {
				await props.client.kick(props.roomId, userId);
			}
		} catch (e) {
			setKnockError({
				userId,
				message: userFacingErrorMessage(
					e,
					action === "approve"
						? "Could not approve the request."
						: "Could not decline the request.",
				),
			});
		} finally {
			setKnockPending(null);
		}
	};

	return (
		<div class="space-y-8">
			{/* Invite */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Invite by user ID
				</h3>
				<Show
					when={perms.canInvite()}
					fallback={
						<p class="text-sm text-text-muted">
							You don't have permission to invite users.
						</p>
					}
				>
					<InviteByUserIdForm
						client={props.client}
						roomId={props.roomId}
						submitLabel="Invite"
					/>
				</Show>
			</section>

			{/* Pending invites */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Pending invites ({invites().length})
				</h3>
				<Show
					when={invites().length > 0}
					fallback={<p class="text-sm text-text-muted">No pending invites.</p>}
				>
					<ul class="space-y-2">
						<For each={invites()}>
							{(inv) => (
								<li class="flex items-center justify-between gap-3 rounded bg-surface-1 px-3 py-2">
									<div class="flex min-w-0 items-center gap-3">
										<RowAvatar
											url={inv.avatarUrl}
											initial={avatarInitial(inv.displayName)}
											broken={brokenAvatars}
										/>
										<div class="min-w-0">
											<div class="truncate text-sm text-text-primary">
												{inv.displayName}
											</div>
											<div class="truncate font-mono text-xs text-text-muted">
												{inv.userId}
											</div>
										</div>
									</div>
									<div class="flex shrink-0 items-center gap-2">
										<Show when={revokeError()?.userId === inv.userId}>
											<span class="text-xs text-danger-text" role="alert">
												{revokeError()?.message}
											</span>
										</Show>
										<button
											type="button"
											onClick={() => revokeInvite(inv.userId)}
											disabled={
												revoking() === inv.userId ||
												!perms.canKickTarget(inv.userId)
											}
											class="rounded px-2 py-1 text-xs font-medium text-danger-text hover:bg-danger-bg/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-danger-text disabled:cursor-not-allowed disabled:opacity-60"
										>
											{revoking() === inv.userId ? "Revoking…" : "Revoke"}
										</button>
									</div>
								</li>
							)}
						</For>
					</ul>
				</Show>
			</section>

			{/* Pending join requests (knocks) */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Pending join requests ({knocks().length})
				</h3>
				<Show
					when={knocks().length > 0}
					fallback={
						<p class="text-sm text-text-muted">No pending join requests.</p>
					}
				>
					<ul class="space-y-2">
						<For each={knocks()}>
							{(k) => (
								<li class="flex items-center justify-between gap-3 rounded bg-surface-1 px-3 py-2">
									<div class="flex min-w-0 items-center gap-3">
										<RowAvatar
											url={k.avatarUrl}
											initial={avatarInitial(k.displayName)}
											broken={brokenAvatars}
										/>
										<div class="min-w-0">
											<div class="truncate text-sm text-text-primary">
												{k.displayName}
											</div>
											<div class="truncate font-mono text-xs text-text-muted">
												{k.userId}
											</div>
											<Show when={k.reason}>
												{(reason) => (
													<div class="truncate text-xs italic text-text-muted">
														{reason()}
													</div>
												)}
											</Show>
										</div>
									</div>
									<div class="flex shrink-0 items-center gap-2">
										<Show when={knockError()?.userId === k.userId}>
											<span class="text-xs text-danger-text" role="alert">
												{knockError()?.message}
											</span>
										</Show>
										<button
											type="button"
											onClick={() => void resolveKnock(k.userId, "approve")}
											disabled={knockPending() !== null || !perms.canInvite()}
											class="rounded px-2 py-1 text-xs font-medium text-success-text hover:bg-success-bg/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-success-text disabled:cursor-not-allowed disabled:opacity-60"
										>
											{knockPending()?.userId === k.userId &&
											knockPending()?.action === "approve"
												? "Approving…"
												: "Approve"}
										</button>
										<button
											type="button"
											onClick={() => void resolveKnock(k.userId, "decline")}
											disabled={
												knockPending() !== null ||
												!perms.canKickTarget(k.userId)
											}
											class="rounded px-2 py-1 text-xs font-medium text-danger-text hover:bg-danger-bg/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-danger-text disabled:cursor-not-allowed disabled:opacity-60"
										>
											{knockPending()?.userId === k.userId &&
											knockPending()?.action === "decline"
												? "Declining…"
												: "Decline"}
										</button>
									</div>
								</li>
							)}
						</For>
					</ul>
				</Show>
			</section>

			{/* Members */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Members ({memberList.memberCount()})
				</h3>
				<Show when={actionError()}>
					<p
						class="mb-2 rounded bg-danger-bg/30 px-3 py-1.5 text-xs text-danger-text"
						role="alert"
					>
						{actionError()}
					</p>
				</Show>
				{/* biome-ignore lint/a11y/useSemanticElements: virtua's Virtualizer emits a <div> wrapper, so we cannot use a real <ul>/<li> structure here; ARIA role keeps list semantics for assistive tech. */}
				<div
					ref={scrollRef}
					role="list"
					class="max-h-[60vh] min-h-[200px] overflow-y-auto rounded border border-border-subtle"
				>
					<Virtualizer scrollRef={scrollRef} data={allMembers()}>
						{(m) => {
							const canPromoteMod = createMemo(() =>
								moderation.canPromoteMod(m.userId),
							);
							const canPromoteAdmin = createMemo(() =>
								moderation.canPromoteAdmin(m.userId),
							);
							const canDemote = createMemo(() =>
								moderation.canDemote(m.userId, m.powerLevel),
							);
							const canKickTarget = createMemo(() =>
								perms.canKickTarget(m.userId),
							);
							const canBanTarget = createMemo(() =>
								perms.canBanTarget(m.userId),
							);
							const hasAnyAction = createMemo(
								() =>
									canPromoteMod() ||
									canPromoteAdmin() ||
									canDemote() ||
									canKickTarget() ||
									canBanTarget(),
							);
							return (
								// biome-ignore lint/a11y/useSemanticElements: parent uses role="list" on a <div> for the same Virtualizer reason; matching <li> isn't usable here.
								<div
									role="listitem"
									class="flex items-center justify-between gap-3 px-2 py-1.5 hover:bg-surface-1"
								>
									<div class="flex min-w-0 items-center gap-3">
										<RowAvatar
											url={m.avatarUrl}
											initial={avatarInitial(m.displayName)}
											broken={brokenAvatars}
										/>
										<div class="min-w-0">
											<div class="truncate text-sm text-text-primary">
												{m.displayName}
											</div>
											<div class="truncate font-mono text-xs text-text-muted">
												{m.userId} · PL {m.powerLevel}
											</div>
										</div>
									</div>
									<Show when={hasAnyAction()}>
										<DropdownMenu
											open={openMenuFor() === m.userId}
											onOpenChange={(open) =>
												setOpenMenuFor(open ? m.userId : null)
											}
										>
											<DropdownMenu.Trigger
												class="rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
												aria-label={`Member actions for ${m.displayName}`}
											>
												⋯
											</DropdownMenu.Trigger>
											<DropdownMenu.Portal>
												<DropdownMenu.Content class="portal-scale z-50 min-w-[200px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg">
													<Show when={canPromoteMod()}>
														<DropdownMenu.Item
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 focus-visible:outline-hidden focus-visible:bg-surface-2"
															onSelect={() =>
																requestAction({
																	kind: "promote-mod",
																	userId: m.userId,
																	displayName: m.displayName,
																})
															}
														>
															Promote to Moderator
														</DropdownMenu.Item>
													</Show>
													<Show when={canPromoteAdmin()}>
														<DropdownMenu.Item
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 focus-visible:outline-hidden focus-visible:bg-surface-2"
															onSelect={() =>
																requestAction({
																	kind: "promote-admin",
																	userId: m.userId,
																	displayName: m.displayName,
																})
															}
														>
															Promote to Admin
														</DropdownMenu.Item>
													</Show>
													<Show when={canDemote()}>
														<DropdownMenu.Item
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 focus-visible:outline-hidden focus-visible:bg-surface-2"
															onSelect={() =>
																requestAction({
																	kind: "demote",
																	userId: m.userId,
																	displayName: m.displayName,
																})
															}
														>
															Demote to Member
														</DropdownMenu.Item>
													</Show>
													<Show when={canKickTarget()}>
														<DropdownMenu.Item
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-danger-text hover:bg-danger-bg/30 focus-visible:outline-hidden focus-visible:bg-danger-bg/30"
															onSelect={() =>
																requestAction({
																	kind: "kick",
																	userId: m.userId,
																	displayName: m.displayName,
																})
															}
														>
															Kick…
														</DropdownMenu.Item>
													</Show>
													<Show when={canBanTarget()}>
														<DropdownMenu.Item
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-danger-text hover:bg-danger-bg/30 focus-visible:outline-hidden focus-visible:bg-danger-bg/30"
															onSelect={() =>
																requestAction({
																	kind: "ban",
																	userId: m.userId,
																	displayName: m.displayName,
																})
															}
														>
															Ban…
														</DropdownMenu.Item>
													</Show>
												</DropdownMenu.Content>
											</DropdownMenu.Portal>
										</DropdownMenu>
									</Show>
								</div>
							);
						}}
					</Virtualizer>
				</div>
			</section>

			<ConfirmDialog
				open={() => pendingAction() !== null}
				onClose={() => setPendingAction(null)}
				title={
					pendingAction()?.kind === "ban"
						? `Ban ${pendingAction()?.displayName}?`
						: `Kick ${pendingAction()?.displayName}?`
				}
				body={
					<p>
						{pendingAction()?.kind === "ban"
							? "They won't be able to rejoin unless unbanned."
							: "They can rejoin if the room is public or someone re-invites them."}
					</p>
				}
				confirmLabel={pendingAction()?.kind === "ban" ? "Ban" : "Kick"}
				destructive
				onConfirm={async () => {
					const a = pendingAction();
					if (!a) return;
					await moderation.performKickOrBan(a);
					setPendingAction(null);
				}}
			/>
		</div>
	);
};

export { MembersTab };
