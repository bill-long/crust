import {
	EventType,
	HistoryVisibility,
	JoinRule,
	type MatrixClient,
	type RestrictedAllowType,
} from "matrix-js-sdk";
import { type Component, createMemo, createSignal, For } from "solid-js";
import { ConfirmDialog } from "./ConfirmDialog";
import { FieldStatus } from "./FieldStatus";
import { Tooltip } from "./Tooltip";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

interface AdvancedTabProps {
	client: MatrixClient;
	roomId: string;
	onLeft?: (roomId: string) => void;
}

type JoinRuleValue = JoinRule;
type HistoryVisValue = HistoryVisibility;

interface JoinRulesContent {
	join_rule?: string;
	allow?: { room_id: string; type: RestrictedAllowType }[];
}

interface HistoryVisContent {
	history_visibility?: string;
}

const JOIN_RULE_OPTIONS: { value: JoinRuleValue; label: string }[] = [
	{ value: JoinRule.Public, label: "Public" },
	{ value: JoinRule.Invite, label: "Invite only" },
	{ value: JoinRule.Knock, label: "Knock" },
	{ value: JoinRule.Restricted, label: "Restricted (space)" },
];

const HISTORY_VIS_OPTIONS: { value: HistoryVisValue; label: string }[] = [
	{ value: HistoryVisibility.WorldReadable, label: "Anyone (world readable)" },
	{ value: HistoryVisibility.Shared, label: "Members (since being added)" },
	{ value: HistoryVisibility.Invited, label: "Members (since being invited)" },
	{ value: HistoryVisibility.Joined, label: "Members (since joining)" },
];

const AdvancedTab: Component<AdvancedTabProps> = (props) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);

	// ----- Join rules -----
	const joinRules = useRoomStateContent<JoinRulesContent>(
		props.client,
		roomId,
		"m.room.join_rules",
	);
	const serverJoin = createMemo<JoinRuleValue>(
		() => (joinRules()?.join_rule as JoinRuleValue) ?? JoinRule.Invite,
	);
	const joinAllowList = createMemo<
		{ room_id: string; type: RestrictedAllowType }[]
	>(() => {
		const a = joinRules()?.allow;
		return Array.isArray(a) ? a : [];
	});
	const joinOpt = useOptimisticState<JoinRuleValue>({
		serverValue: serverJoin,
	});

	const setJoinRule = async (next: JoinRuleValue): Promise<void> => {
		const existingAllow = joinAllowList();
		await joinOpt.apply(next, async () => {
			const content: {
				join_rule: JoinRuleValue;
				allow?: typeof existingAllow;
			} = { join_rule: next };
			if (existingAllow.length > 0) content.allow = existingAllow;
			await props.client.sendStateEvent(
				props.roomId,
				EventType.RoomJoinRules,
				content,
				"",
			);
		});
	};

	const canSelectRestricted = createMemo<boolean>(() => {
		return serverJoin() === JoinRule.Restricted || joinAllowList().length > 0;
	});

	const joinState = (): "idle" | "saving" | "error" => {
		if (joinOpt.pending()) return "saving";
		if (joinOpt.lastError()) return "error";
		return "idle";
	};

	// ----- History visibility -----
	const histContent = useRoomStateContent<HistoryVisContent>(
		props.client,
		roomId,
		"m.room.history_visibility",
	);
	const serverHist = createMemo<HistoryVisValue>(
		() =>
			(histContent()?.history_visibility as HistoryVisValue) ??
			HistoryVisibility.Shared,
	);
	const histOpt = useOptimisticState<HistoryVisValue>({
		serverValue: serverHist,
	});

	const setHistoryVis = async (next: HistoryVisValue): Promise<void> => {
		await histOpt.apply(next, async () => {
			await props.client.sendStateEvent(
				props.roomId,
				EventType.RoomHistoryVisibility,
				{ history_visibility: next },
				"",
			);
		});
	};

	const histState = (): "idle" | "saving" | "error" => {
		if (histOpt.pending()) return "saving";
		if (histOpt.lastError()) return "error";
		return "idle";
	};

	// ----- Leave -----
	const [showLeave, setShowLeave] = createSignal(false);

	const handleLeave = async (): Promise<void> => {
		await props.client.leave(props.roomId);
		props.onLeft?.(props.roomId);
	};

	const joinTooltip = (): string =>
		perms.canSetJoinRules()
			? ""
			: "You don't have permission to change join rules.";
	const histTooltip = (): string =>
		perms.canSetHistoryVisibility()
			? ""
			: "You don't have permission to change history visibility.";
	const restrictedTooltip = (): string =>
		"Restricted joins require a space allow list, not yet configurable here.";

	const roomName = (): string => {
		const r = props.client.getRoom(props.roomId);
		const n = r?.name?.trim();
		return n || props.roomId;
	};

	return (
		<div class="space-y-8">
			{/* Join rules */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Join rule
				</h3>
				<Tooltip content={joinTooltip()} disabled={perms.canSetJoinRules()}>
					<div class="inline-flex flex-wrap gap-1 rounded border border-border-subtle p-1">
						<For each={JOIN_RULE_OPTIONS}>
							{(opt) => {
								const disabled = (): boolean => {
									if (!perms.canSetJoinRules()) return true;
									if (
										opt.value === JoinRule.Restricted &&
										!canSelectRestricted()
									)
										return true;
									return false;
								};
								const tooltipText = (): string => {
									if (
										opt.value === JoinRule.Restricted &&
										!canSelectRestricted() &&
										perms.canSetJoinRules()
									)
										return restrictedTooltip();
									return "";
								};
								return (
									<Tooltip content={tooltipText()} disabled={!tooltipText()}>
										<button
											type="button"
											aria-pressed={joinOpt.value() === opt.value}
											aria-disabled={disabled() ? "true" : undefined}
											onClick={() => {
												if (!disabled() && joinOpt.value() !== opt.value)
													void setJoinRule(opt.value);
											}}
											class="rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
											classList={{
												"bg-accent text-text-primary":
													joinOpt.value() === opt.value,
												"text-text-secondary hover:bg-surface-2":
													joinOpt.value() !== opt.value && !disabled(),
												"opacity-60 cursor-not-allowed": disabled(),
											}}
										>
											{opt.label}
										</button>
									</Tooltip>
								);
							}}
						</For>
					</div>
				</Tooltip>
				<FieldStatus
					state={joinState()}
					error={joinOpt.lastError()}
					onDismiss={() => joinOpt.clearError()}
				/>
			</section>

			{/* History visibility */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					History visibility
				</h3>
				<Tooltip
					content={histTooltip()}
					disabled={perms.canSetHistoryVisibility()}
				>
					<div class="inline-flex flex-wrap gap-1 rounded border border-border-subtle p-1">
						<For each={HISTORY_VIS_OPTIONS}>
							{(opt) => {
								const disabled = (): boolean =>
									!perms.canSetHistoryVisibility();
								return (
									<button
										type="button"
										aria-pressed={histOpt.value() === opt.value}
										aria-disabled={disabled() ? "true" : undefined}
										onClick={() => {
											if (!disabled() && histOpt.value() !== opt.value)
												void setHistoryVis(opt.value);
										}}
										class="rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
										classList={{
											"bg-accent text-text-primary":
												histOpt.value() === opt.value,
											"text-text-secondary hover:bg-surface-2":
												histOpt.value() !== opt.value && !disabled(),
											"opacity-60 cursor-not-allowed": disabled(),
										}}
									>
										{opt.label}
									</button>
								);
							}}
						</For>
					</div>
				</Tooltip>
				<FieldStatus
					state={histState()}
					error={histOpt.lastError()}
					onDismiss={() => histOpt.clearError()}
				/>
			</section>

			{/* Leave */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Danger zone
				</h3>
				<button
					type="button"
					onClick={() => setShowLeave(true)}
					class="rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text"
				>
					Leave room
				</button>
			</section>

			<ConfirmDialog
				open={showLeave}
				onClose={() => setShowLeave(false)}
				title={`Leave ${roomName()}?`}
				body={
					<p>
						You'll stop receiving messages in this room. You can rejoin if the
						room is public or someone re-invites you.
					</p>
				}
				confirmLabel="Leave"
				pendingLabel="Leaving…"
				destructive
				onConfirm={async () => {
					await handleLeave();
					setShowLeave(false);
				}}
			/>
		</div>
	);
};

export { AdvancedTab };
