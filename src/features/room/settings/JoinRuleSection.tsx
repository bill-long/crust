import {
	EventType,
	JoinRule,
	type MatrixClient,
	type MatrixEvent,
	RestrictedAllowType,
	RoomStateEvent,
} from "matrix-js-sdk";
import {
	type Component,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { Tooltip } from "../../../components/Tooltip";
import { FieldStatus } from "./FieldStatus";
import { getParentSpaceCandidates } from "./restrictedAllowCandidates";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

type JoinRuleValue = JoinRule;

interface AllowEntry {
	room_id: string;
	type: RestrictedAllowType;
}

interface JoinRulesContent {
	join_rule?: string;
	allow?: AllowEntry[];
}

interface JoinRulesValue {
	rule: JoinRuleValue;
	allow: AllowEntry[];
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
 * Compare allow lists by their multiset of room IDs. Sorting (rather than a
 * Set) keeps the comparison correct even when an entry's `room_id` is
 * duplicated, so the optimistic-state equality check can't mistake
 * `[a, a]` for `[a, b]` and miss a real server update.
 */
function sameAllow(
	a: readonly AllowEntry[],
	b: readonly AllowEntry[],
): boolean {
	if (a.length !== b.length) return false;
	const ax = a.map((e) => e.room_id).sort();
	const bx = b.map((e) => e.room_id).sort();
	return ax.every((id, i) => id === bx[i]);
}

/**
 * Normalize the raw `allow` array from room state into well-formed entries.
 * The content comes from other clients/servers and can be malformed (null
 * entries, non-objects, missing/non-string `room_id`); drop those so the
 * editor never renders or writes a bad entry. A missing or unrecognized
 * `type` defaults to `m.room_membership` (validated against the spec's
 * allow types) so writes always carry a valid type. Duplicate `room_id`s
 * are collapsed to the first occurrence so the editor shows one row per
 * space and Remove can't delete several entries at once.
 */
const VALID_ALLOW_TYPES = new Set<string>(Object.values(RestrictedAllowType));

function normalizeAllow(raw: unknown): AllowEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: AllowEntry[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const roomId = (entry as { room_id?: unknown }).room_id;
		if (typeof roomId !== "string" || roomId.length === 0) continue;
		if (seen.has(roomId)) continue;
		seen.add(roomId);
		const type = (entry as { type?: unknown }).type;
		out.push({
			room_id: roomId,
			type:
				typeof type === "string" && VALID_ALLOW_TYPES.has(type)
					? (type as RestrictedAllowType)
					: RestrictedAllowType.RoomMembership,
		});
	}
	return out;
}

/**
 * Join-rule control (Public / Invite only / Knock / Restricted) with
 * optimistic write + permission gating. When Restricted is selected, an
 * allow-list editor lets the admin choose which parent space(s) whose
 * members may join (the `m.room.join_rules` `allow` list). Extracted from
 * AdvancedTab so it can be shared between the Advanced tab (regular rooms)
 * and the space-only Visibility tab.
 */
const JoinRuleSection: Component<JoinRuleSectionProps> = (props) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);

	const joinRules = useRoomStateContent<JoinRulesContent>(
		props.client,
		roomId,
		"m.room.join_rules",
	);
	const serverValue = createMemo<JoinRulesValue>(() => {
		const content = joinRules();
		return {
			rule: (content?.join_rule as JoinRuleValue) ?? JoinRule.Invite,
			allow: normalizeAllow(content?.allow),
		};
	});
	const joinOpt = useOptimisticState<JoinRulesValue>({
		serverValue,
		equals: (a, b) => a.rule === b.rule && sameAllow(a.allow, b.allow),
	});

	const effectiveRule = (): JoinRuleValue => joinOpt.value().rule;
	const effectiveAllow = (): AllowEntry[] => joinOpt.value().allow;

	const writeJoinRules = async (
		rule: JoinRuleValue,
		allow: AllowEntry[],
	): Promise<void> => {
		await joinOpt.apply({ rule, allow }, async () => {
			const content: { join_rule: JoinRuleValue; allow?: AllowEntry[] } = {
				join_rule: rule,
			};
			if (allow.length > 0) content.allow = allow;
			await props.client.sendStateEvent(
				props.roomId,
				EventType.RoomJoinRules,
				content,
				"",
			);
		});
	};

	const setJoinRule = (next: JoinRuleValue): void => {
		void writeJoinRules(next, effectiveAllow());
	};

	const addAllowSpace = (spaceId: string): void => {
		if (effectiveAllow().some((e) => e.room_id === spaceId)) return;
		const next: AllowEntry[] = [
			...effectiveAllow(),
			{ room_id: spaceId, type: RestrictedAllowType.RoomMembership },
		];
		void writeJoinRules(JoinRule.Restricted, next);
	};

	const removeAllowSpace = (spaceId: string): void => {
		const next = effectiveAllow().filter((e) => e.room_id !== spaceId);
		void writeJoinRules(effectiveRule(), next);
	};

	// The parent-space relationship lives in room state that can arrive or
	// change after this panel mounts (spaces still syncing, or the room
	// linked into a space while open). Recompute candidates when a relevant
	// space-relationship state event lands, mirroring useRoomStateContent.
	const [spaceTick, setSpaceTick] = createSignal(0);
	const onSpaceState = (event: MatrixEvent): void => {
		const type = event.getType();
		// Only react to relationship changes involving this room: a parent
		// link declared on this room, or a space whose child link points at
		// this room. Avoids O(rooms) recomputes on unrelated space edits.
		if (
			(type === "m.space.parent" && event.getRoomId() === roomId()) ||
			(type === "m.space.child" && event.getStateKey?.() === roomId())
		) {
			setSpaceTick((n) => n + 1);
		}
	};
	props.client.on(RoomStateEvent.Events, onSpaceState);
	onCleanup(() => {
		props.client.off(RoomStateEvent.Events, onSpaceState);
	});

	const candidates = createMemo(() => {
		spaceTick();
		return getParentSpaceCandidates(props.client, roomId());
	});
	const availableToAdd = createMemo(() => {
		const allowed = new Set(effectiveAllow().map((e) => e.room_id));
		return candidates().filter((c) => !allowed.has(c.roomId));
	});

	const spaceName = (id: string): string =>
		props.client.getRoom(id)?.name?.trim() || id;

	const joinState = (): "idle" | "saving" | "error" => {
		if (joinOpt.pending()) return "saving";
		if (joinOpt.lastError()) return "error";
		return "idle";
	};

	const joinTooltip = (): string =>
		perms.canSetJoinRules()
			? ""
			: "You don't have permission to change join rules.";

	return (
		<section>
			<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
				Join rule
			</h3>
			<Tooltip content={joinTooltip()} disabled={perms.canSetJoinRules()}>
				<div class="inline-flex flex-wrap gap-1 rounded border border-border-subtle p-1">
					<For each={JOIN_RULE_OPTIONS}>
						{(opt) => {
							const disabled = (): boolean => !perms.canSetJoinRules();
							return (
								<button
									type="button"
									aria-pressed={effectiveRule() === opt.value}
									aria-disabled={disabled() ? "true" : undefined}
									onClick={() => {
										if (!disabled() && effectiveRule() !== opt.value)
											setJoinRule(opt.value);
									}}
									class="rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									classList={{
										"bg-accent text-text-primary":
											effectiveRule() === opt.value,
										"text-text-secondary hover:bg-surface-2":
											effectiveRule() !== opt.value && !disabled(),
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

			<Show when={effectiveRule() === JoinRule.Restricted}>
				<div class="mt-3">
					<h4 class="mb-1 text-xs font-medium text-text-secondary">
						Spaces whose members can join
					</h4>
					<Show
						when={effectiveAllow().length > 0}
						fallback={
							<p class="mb-2 text-xs text-text-muted">
								<Show
									when={perms.canSetJoinRules()}
									fallback="No spaces are allowed to join."
								>
									No spaces selected yet. Members can only join by invite until
									you add a space below.
								</Show>
							</p>
						}
					>
						<ul class="mb-2 flex flex-col gap-1">
							<For each={effectiveAllow()}>
								{(entry) => (
									<li class="flex items-center justify-between gap-2 rounded bg-surface-2 px-2 py-1 text-xs text-text-primary">
										<span class="truncate">{spaceName(entry.room_id)}</span>
										<Show when={perms.canSetJoinRules()}>
											<button
												type="button"
												onClick={() => removeAllowSpace(entry.room_id)}
												aria-label={`Remove ${spaceName(entry.room_id)}`}
												class="shrink-0 rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-surface-3 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
											>
												Remove
											</button>
										</Show>
									</li>
								)}
							</For>
						</ul>
					</Show>

					<Show when={perms.canSetJoinRules()}>
						<Show
							when={availableToAdd().length > 0}
							fallback={
								<p class="text-xs text-text-muted">
									No parent spaces available to add. Add this room to a space
									first (Rooms tab on the space).
								</p>
							}
						>
							<div class="flex flex-wrap gap-1">
								<For each={availableToAdd()}>
									{(candidate) => (
										<button
											type="button"
											onClick={() => addAllowSpace(candidate.roomId)}
											class="rounded border border-border-subtle px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
										>
											+ {candidate.name}
										</button>
									)}
								</For>
							</div>
						</Show>
					</Show>
				</div>
			</Show>

			<FieldStatus
				state={joinState()}
				error={joinOpt.lastError()}
				onDismiss={() => joinOpt.clearError()}
			/>
		</section>
	);
};

export { JoinRuleSection, normalizeAllow, sameAllow };
