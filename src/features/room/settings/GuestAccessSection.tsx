import { EventType, GuestAccess, type MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, For } from "solid-js";
import { Tooltip } from "../../../components/Tooltip";
import { FieldStatus } from "./FieldStatus";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

type GuestAccessValue = GuestAccess;

interface GuestAccessContent {
	guest_access?: string;
}

const GUEST_ACCESS_OPTIONS: { value: GuestAccessValue; label: string }[] = [
	{ value: GuestAccess.Forbidden, label: "Forbidden" },
	{ value: GuestAccess.CanJoin, label: "Allow guests" },
];

interface GuestAccessSectionProps {
	client: MatrixClient;
	roomId: string;
}

/**
 * Guest-access control (`m.room.guest_access`) with optimistic write and
 * permission gating. Absent state defaults to "forbidden" per the Matrix
 * spec.
 */
const GuestAccessSection: Component<GuestAccessSectionProps> = (props) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);

	const content = useRoomStateContent<GuestAccessContent>(
		props.client,
		roomId,
		"m.room.guest_access",
	);
	const serverValue = createMemo<GuestAccessValue>(
		() =>
			(content()?.guest_access as GuestAccessValue) ?? GuestAccess.Forbidden,
	);
	const opt = useOptimisticState<GuestAccessValue>({
		serverValue,
	});

	const setGuestAccess = async (next: GuestAccessValue): Promise<void> => {
		await opt.apply(next, async () => {
			await props.client.sendStateEvent(
				props.roomId,
				EventType.RoomGuestAccess,
				{ guest_access: next },
				"",
			);
		});
	};

	const state = (): "idle" | "saving" | "error" => {
		if (opt.pending()) return "saving";
		if (opt.lastError()) return "error";
		return "idle";
	};

	const tooltip = (): string =>
		perms.canSetGuestAccess()
			? ""
			: "You don't have permission to change guest access.";

	return (
		<section>
			<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
				Guest access
			</h3>
			<Tooltip content={tooltip()} disabled={perms.canSetGuestAccess()}>
				<div class="inline-flex flex-wrap gap-1 rounded border border-border-subtle p-1">
					<For each={GUEST_ACCESS_OPTIONS}>
						{(o) => {
							const disabled = (): boolean => !perms.canSetGuestAccess();
							return (
								<button
									type="button"
									aria-pressed={opt.value() === o.value}
									aria-disabled={disabled() ? "true" : undefined}
									onClick={() => {
										if (!disabled() && opt.value() !== o.value)
											void setGuestAccess(o.value);
									}}
									class="rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									classList={{
										"bg-accent text-text-primary": opt.value() === o.value,
										"text-text-secondary hover:bg-surface-2":
											opt.value() !== o.value && !disabled(),
										"opacity-60 cursor-not-allowed": disabled(),
									}}
								>
									{o.label}
								</button>
							);
						}}
					</For>
				</div>
			</Tooltip>
			<FieldStatus
				state={state()}
				error={opt.lastError()}
				onDismiss={() => opt.clearError()}
			/>
		</section>
	);
};

export { GuestAccessSection };
