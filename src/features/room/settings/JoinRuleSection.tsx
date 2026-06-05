import {
	EventType,
	JoinRule,
	type MatrixClient,
	type RestrictedAllowType,
} from "matrix-js-sdk";
import { type Component, createMemo, For } from "solid-js";
import { Tooltip } from "../../../components/Tooltip";
import { FieldStatus } from "./FieldStatus";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

type JoinRuleValue = JoinRule;

interface JoinRulesContent {
	join_rule?: string;
	allow?: { room_id: string; type: RestrictedAllowType }[];
}

const JOIN_RULE_OPTIONS: { value: JoinRuleValue; label: string }[] = [
	{ value: JoinRule.Public, label: "Public" },
	{ value: JoinRule.Invite, label: "Invite only" },
	{ value: JoinRule.Knock, label: "Knock" },
	{ value: JoinRule.Restricted, label: "Restricted (space)" },
];

interface JoinRuleSectionProps {
	client: MatrixClient;
	roomId: string;
}

/**
 * Join-rule control (Public / Invite only / Knock / Restricted) with
 * optimistic write + permission gating. Extracted from AdvancedTab so it can
 * be shared between the Advanced tab (regular rooms) and the space-only
 * Visibility tab.
 */
const JoinRuleSection: Component<JoinRuleSectionProps> = (props) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);

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

	const joinTooltip = (): string =>
		perms.canSetJoinRules()
			? ""
			: "You don't have permission to change join rules.";
	const restrictedTooltip = (): string =>
		"Restricted joins require a space allow list, not yet configurable here.";

	return (
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
								if (opt.value === JoinRule.Restricted && !canSelectRestricted())
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
	);
};

export { JoinRuleSection };
