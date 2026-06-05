import { EventType, type MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { Tooltip } from "../../../components/Tooltip";
import { ConfirmDialog } from "./ConfirmDialog";
import { FieldStatus } from "./FieldStatus";
import {
	effectiveLevel,
	eventOverrideCount,
	type GatedKey,
	type PowerLevelContent,
	PRESET_LEVELS,
	type Preset,
	presetForLevel,
	requiresStateDefaultConfirm,
	withPreset,
} from "./powerLevelPresets";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

interface PermissionsTabProps {
	client: MatrixClient;
	roomId: string;
}

interface Row {
	key: GatedKey;
	label: string;
	description: string;
}

const ROWS: Row[] = [
	{
		key: "events_default",
		label: "Send messages",
		description: "Default for unspecified message events.",
	},
	{
		key: "state_default",
		label: "Change room settings",
		description: "Default for unspecified state events.",
	},
	{ key: "invite", label: "Invite users", description: "" },
	{ key: "kick", label: "Kick users", description: "" },
	{ key: "ban", label: "Ban users", description: "" },
	{ key: "redact", label: "Redact messages", description: "" },
];

const PRESET_OPTIONS: { value: Exclude<Preset, "custom">; label: string }[] = [
	{ value: "anyone", label: "Anyone" },
	{ value: "moderators", label: "Moderators only" },
];

const PermissionsTab: Component<PermissionsTabProps> = (props) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);
	const plContent = useRoomStateContent<PowerLevelContent>(
		props.client,
		roomId,
		"m.room.power_levels",
	);
	const serverPl = createMemo<PowerLevelContent>(() => plContent() ?? {});

	const opt = useOptimisticState<PowerLevelContent>({
		serverValue: serverPl,
		equals: (a, b) => {
			// Compare only the gated top-level keys for echo matching.
			// effectiveLevel reads the specific gated key (events_default,
			// state_default, invite, redact, kick, ban) or falls back to its
			// spec default. The per-user `users` map and per-type `events`
			// map are preserved verbatim on write but are orthogonal to the
			// preset-driven rows shown here.
			for (const r of ROWS) {
				if (effectiveLevel(a, r.key) !== effectiveLevel(b, r.key)) return false;
			}
			return true;
		},
	});

	const [pendingConfirm, setPendingConfirm] = createSignal<{
		key: GatedKey;
		preset: Exclude<Preset, "custom">;
	} | null>(null);

	const writePreset = async (
		key: GatedKey,
		preset: Exclude<Preset, "custom">,
	): Promise<void> => {
		const current = opt.value();
		const next = withPreset(current, key, preset);
		await opt.apply(next, async () => {
			await props.client.sendStateEvent(
				props.roomId,
				EventType.RoomPowerLevels,
				next as unknown as Record<string, unknown>,
				"",
			);
		});
	};

	const handleSelect = (
		key: GatedKey,
		preset: Exclude<Preset, "custom">,
	): void => {
		const current = opt.value();
		const nextLevel = PRESET_LEVELS[preset];
		if (requiresStateDefaultConfirm(current, key, nextLevel)) {
			setPendingConfirm({ key, preset });
			return;
		}
		void writePreset(key, preset);
	};

	const confirmStateDefault = async (): Promise<void> => {
		const target = pendingConfirm();
		if (!target) return;
		await writePreset(target.key, target.preset);
		setPendingConfirm(null);
	};

	const state = (): "idle" | "saving" | "error" => {
		if (opt.pending()) return "saving";
		if (opt.lastError()) return "error";
		return "idle";
	};

	const gatedTooltip = (): string =>
		perms.canSetPowerLevels()
			? ""
			: "You don't have permission to change power levels.";

	return (
		<div class="space-y-6">
			<p class="text-sm text-text-secondary">
				Choose who can perform each action. These presets write the room-wide
				defaults; per-user and per-event overrides are preserved.
			</p>

			<div class="space-y-5">
				<For each={ROWS}>
					{(row) => {
						const level = createMemo<number>(() =>
							effectiveLevel(opt.value(), row.key),
						);
						const current = createMemo<Preset>(() => presetForLevel(level()));
						const overrides = createMemo<number>(() =>
							row.key === "events_default" || row.key === "state_default"
								? eventOverrideCount(opt.value())
								: 0,
						);
						return (
							<div class="border-b border-border-subtle pb-4 last:border-0">
								<div class="mb-1 text-sm font-medium text-text-primary">
									{row.label}
								</div>
								<Show when={row.description}>
									<p class="mb-2 text-xs text-text-muted">{row.description}</p>
								</Show>
								<Tooltip
									content={gatedTooltip()}
									disabled={perms.canSetPowerLevels()}
								>
									<div class="inline-flex overflow-hidden rounded border border-border-subtle">
										<For each={PRESET_OPTIONS}>
											{(opt2) => (
												<button
													type="button"
													aria-pressed={current() === opt2.value}
													aria-disabled={
														perms.canSetPowerLevels() ? undefined : "true"
													}
													onClick={() => {
														if (perms.canSetPowerLevels())
															handleSelect(row.key, opt2.value);
													}}
													class="px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
													classList={{
														"bg-accent text-text-primary":
															current() === opt2.value,
														"bg-surface-2 text-text-secondary hover:bg-surface-3":
															current() !== opt2.value,
														"opacity-60 cursor-not-allowed":
															!perms.canSetPowerLevels(),
													}}
												>
													{opt2.label}
												</button>
											)}
										</For>
										<Show when={current() === "custom"}>
											<span class="bg-surface-3 px-3 py-1.5 text-xs font-medium text-text-muted">
												Custom ({level()})
											</span>
										</Show>
									</div>
								</Tooltip>
								<Show when={overrides() > 0}>
									<p class="mt-1 text-xs text-text-muted">
										{overrides()} per-event override
										{overrides() === 1 ? "" : "s"} preserved.
									</p>
								</Show>
							</div>
						);
					}}
				</For>
			</div>

			<FieldStatus
				state={state()}
				error={opt.lastError()}
				onDismiss={() => opt.clearError()}
			/>

			<ConfirmDialog
				open={() => pendingConfirm() !== null}
				onClose={() => setPendingConfirm(null)}
				title="Lower the bar for state changes?"
				body={
					<p>
						Setting <strong>“Change room settings”</strong> to{" "}
						<strong>Anyone</strong> will let any member in this room change the
						topic, avatar, join rules, and other state — unless protected by a
						per-event override.
					</p>
				}
				confirmLabel="Yes, allow anyone"
				destructive
				onConfirm={confirmStateDefault}
			/>
		</div>
	);
};

export { PermissionsTab };
