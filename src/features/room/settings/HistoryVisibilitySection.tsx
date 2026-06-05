import { EventType, HistoryVisibility, type MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, For } from "solid-js";
import { FieldStatus } from "./FieldStatus";
import { Tooltip } from "./Tooltip";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

type HistoryVisValue = HistoryVisibility;

interface HistoryVisContent {
	history_visibility?: string;
}

const HISTORY_VIS_OPTIONS: { value: HistoryVisValue; label: string }[] = [
	{ value: HistoryVisibility.WorldReadable, label: "Anyone (world readable)" },
	{ value: HistoryVisibility.Shared, label: "Members (since being added)" },
	{ value: HistoryVisibility.Invited, label: "Members (since being invited)" },
	{ value: HistoryVisibility.Joined, label: "Members (since joining)" },
];

interface HistoryVisibilitySectionProps {
	client: MatrixClient;
	roomId: string;
}

/**
 * History-visibility control with optimistic write + permission gating.
 * Extracted from AdvancedTab so it can be shared between the Advanced tab
 * (regular rooms) and the space-only Visibility tab.
 */
const HistoryVisibilitySection: Component<HistoryVisibilitySectionProps> = (
	props,
) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);

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

	const histTooltip = (): string =>
		perms.canSetHistoryVisibility()
			? ""
			: "You don't have permission to change history visibility.";

	return (
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
							const disabled = (): boolean => !perms.canSetHistoryVisibility();
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
	);
};

export { HistoryVisibilitySection };
