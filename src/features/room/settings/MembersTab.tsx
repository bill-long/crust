import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { EventType, type MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { useMemberList } from "../useMemberList";
import { ConfirmDialog } from "./ConfirmDialog";
import { InviteByUserIdForm } from "./InviteByUserIdForm";
import {
	levelForDemote,
	type PowerLevelContent,
	withUserLevel,
} from "./powerLevelPresets";
import { usePendingInvites } from "./usePendingInvites";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

interface MembersTabProps {
	client: MatrixClient;
	roomId: string;
}

interface MemberAction {
	kind: "promote-mod" | "promote-admin" | "demote" | "kick" | "ban";
	userId: string;
	displayName: string;
}

const MembersTab: Component<MembersTabProps> = (props) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);
	const memberList = useMemberList(props.client, roomId);
	const invites = usePendingInvites(props.client, roomId);
	const plContent = useRoomStateContent<PowerLevelContent>(
		props.client,
		roomId,
		"m.room.power_levels",
	);

	const [actionError, setActionError] = createSignal<string | null>(null);
	const [pendingAction, setPendingAction] = createSignal<MemberAction | null>(
		null,
	);
	const [openMenuFor, setOpenMenuFor] = createSignal<string | null>(null);
	const [revokeError, setRevokeError] = createSignal<{
		userId: string;
		message: string;
	} | null>(null);
	const [revoking, setRevoking] = createSignal<string | null>(null);

	const allMembers = createMemo(() =>
		memberList
			.groups()
			.flatMap((g) => g.members)
			.sort((a, b) => b.powerLevel - a.powerLevel),
	);

	// Serialize PL writes so rapid consecutive promote/demote actions
	// can't race against each other. The chain not only awaits prior
	// sends but also threads a local "pending PL" snapshot so write N
	// merges against write N-1's changes (the server echo may not have
	// arrived by the time write N reads `plContent()`).
	let plWriteChain: Promise<void> = Promise.resolve();
	let pendingPL: PowerLevelContent | null = null;
	let plWriteSeq = 0;
	const writePowerLevel = (
		userId: string,
		level: number | null,
	): Promise<void> => {
		const mySeq = ++plWriteSeq;
		const run = plWriteChain.then(async () => {
			const base = pendingPL ?? plContent();
			const next = withUserLevel(base, userId, level);
			pendingPL = next;
			try {
				await props.client.sendStateEvent(
					props.roomId,
					EventType.RoomPowerLevels,
					next as unknown as Record<string, unknown>,
					"",
				);
			} finally {
				// Drop the overlay once the most-recent write settles
				// so a later burst rebases on the freshest server snapshot.
				if (mySeq === plWriteSeq) pendingPL = null;
			}
		});
		// Keep the chain alive on failure so one bad write doesn't
		// permanently break serialization.
		plWriteChain = run.catch(() => {});
		return run;
	};

	const performAction = async (action: MemberAction): Promise<void> => {
		setActionError(null);
		try {
			switch (action.kind) {
				case "promote-mod":
					if (!perms.canChangePowerLevel(action.userId, 50)) {
						setActionError("You can't promote above your own power level.");
						return;
					}
					await writePowerLevel(action.userId, 50);
					break;
				case "promote-admin":
					if (!perms.canChangePowerLevel(action.userId, 100)) {
						setActionError("You can't promote above your own power level.");
						return;
					}
					await writePowerLevel(action.userId, 100);
					break;
				case "demote": {
					const demote = levelForDemote(plContent());
					if (!perms.canChangePowerLevel(action.userId, demote.level ?? 0)) {
						setActionError("You can't change this member's power level.");
						return;
					}
					await writePowerLevel(action.userId, demote.level);
					break;
				}
			}
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "Action failed.");
		}
	};

	// Kick/Ban are invoked from inside ConfirmDialog.onConfirm — let the
	// promise reject so the dialog catches and renders the error inline
	// instead of closing first and surfacing the failure elsewhere.
	const performKickOrBan = async (action: MemberAction): Promise<void> => {
		if (action.kind === "kick") {
			await props.client.kick(props.roomId, action.userId);
		} else if (action.kind === "ban") {
			await props.client.ban(props.roomId, action.userId);
		}
	};

	const requestAction = (action: MemberAction): void => {
		setOpenMenuFor(null);
		if (action.kind === "kick" || action.kind === "ban") {
			setPendingAction(action);
			return;
		}
		void performAction(action);
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

	const initial = (name: string): string =>
		name.trim().charAt(0).toUpperCase() || "?";

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
										<div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 text-xs font-semibold text-text-secondary">
											<Show
												when={inv.avatarUrl}
												fallback={<span>{initial(inv.displayName)}</span>}
											>
												<img
													src={inv.avatarUrl ?? ""}
													alt=""
													class="h-full w-full object-cover"
												/>
											</Show>
										</div>
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
											disabled={revoking() === inv.userId || !perms.canKick()}
											class="rounded px-2 py-1 text-xs font-medium text-danger-text hover:bg-danger-bg/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text disabled:cursor-not-allowed disabled:opacity-60"
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
				<ul class="space-y-1">
					<For each={allMembers()}>
						{(m) => {
							const canPromoteMod = createMemo(() =>
								perms.canChangePowerLevel(m.userId, 50),
							);
							const canPromoteAdmin = createMemo(() =>
								perms.canChangePowerLevel(m.userId, 100),
							);
							const canDemote = createMemo(() => {
								const level = levelForDemote(plContent()).level ?? 0;
								return (
									m.powerLevel > 0 && perms.canChangePowerLevel(m.userId, level)
								);
							});
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
								<li class="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-surface-1">
									<div class="flex min-w-0 items-center gap-3">
										<div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 text-xs font-semibold text-text-secondary">
											<Show
												when={m.avatarUrl}
												fallback={<span>{initial(m.displayName)}</span>}
											>
												<img
													src={m.avatarUrl ?? ""}
													alt=""
													class="h-full w-full object-cover"
												/>
											</Show>
										</div>
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
												class="rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
												aria-label={`Member actions for ${m.displayName}`}
											>
												⋯
											</DropdownMenu.Trigger>
											<DropdownMenu.Portal>
												<DropdownMenu.Content class="z-50 min-w-[200px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg">
													<Show when={canPromoteMod()}>
														<DropdownMenu.Item
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:bg-surface-2"
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
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:bg-surface-2"
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
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:bg-surface-2"
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
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-danger-text hover:bg-danger-bg/30 focus-visible:outline-none focus-visible:bg-danger-bg/30"
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
															class="cursor-pointer rounded px-3 py-1.5 text-sm text-danger-text hover:bg-danger-bg/30 focus-visible:outline-none focus-visible:bg-danger-bg/30"
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
								</li>
							);
						}}
					</For>
				</ul>
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
					await performKickOrBan(a);
					setPendingAction(null);
				}}
			/>
		</div>
	);
};

export { MembersTab };
