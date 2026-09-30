import { EventType, type MatrixClient } from "matrix-js-sdk";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { ConfirmDialog } from "./ConfirmDialog";
import { FieldStatus } from "./FieldStatus";
import { PermissionLevelControl } from "./PermissionLevelControl";
import {
	explicitPermission,
	inheritedPermission,
	PERMISSION_ACTIONS,
	type PermissionSection,
	type PermissionTarget,
	permissionEditError,
	permissionValue,
	withPermission,
} from "./permissionEditor";
import type { PowerLevelContent } from "./powerLevelPresets";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

interface PermissionsTabProps {
	client: MatrixClient;
	roomId: string;
}

export function PermissionsTab(props: PermissionsTabProps) {
	let generation = 0;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
		generation++;
	});
	const perms = useRoomPermissions(props.client, () => props.roomId);
	const content = useRoomStateContent<PowerLevelContent>(
		props.client,
		() => props.roomId,
		EventType.RoomPowerLevels,
	);
	let activeTarget: PermissionTarget | null = null;
	const opt = useOptimisticState<PowerLevelContent>({
		serverValue: () => content() ?? {},
		// Each write changes exactly one property. Its echo confirms that
		// property; take the entire server document, including unrelated edits
		// incorporated by the fresh read, even before the HTTP response returns.
		equals: (server, optimistic) =>
			activeTarget !== null &&
			explicitPermission(server, activeTarget) ===
				explicitPermission(optimistic, activeTarget),
	});
	const [error, setError] = createSignal<string | null>(null);
	const [confirmation, setConfirmation] = createSignal<{
		target: PermissionTarget;
		level: number | null;
	} | null>(null);
	const [section, setSection] =
		createSignal<Exclude<PermissionSection, "defaults">>("events");
	const [key, setKey] = createSignal("");
	const [page, setPage] = createSignal(0);
	const [search, setSearch] = createSignal("");
	const disabled = () => !perms.canSetPowerLevels() || opt.pending();
	const overrides = createMemo(() =>
		Object.keys(opt.value()[section()] ?? {})
			.filter((k) => k.toLowerCase().includes(search().toLowerCase()))
			.sort(),
	);
	const lastPage = () => Math.max(0, Math.ceil(overrides().length / 20) - 1);
	createEffect(() => {
		if (page() > lastPage()) setPage(lastPage());
	});
	createEffect(
		on(
			() => props.roomId,
			() => {
				generation++;
				opt.reset();
				setConfirmation(null);
				setError(null);
			},
			{ defer: true },
		),
	);
	createEffect(
		on(perms.canSetPowerLevels, () => setConfirmation(null), { defer: true }),
	);
	const editError = (target: PermissionTarget, level: number | null) =>
		permissionEditError(
			opt.value(),
			target,
			level,
			props.client.getUserId() ?? "",
			perms.myPowerLevel(),
			target.section === "users" &&
				props.client.getRoom(props.roomId)?.getMember(target.key)
					?.powerLevel === Infinity,
		);
	const save = async (target: PermissionTarget, level: number | null) => {
		if (disabled()) return;
		const invalid = editError(target, level);
		if (invalid) {
			setError(invalid);
			return;
		}
		setError(null);
		const roomId = props.roomId;
		const operation = generation;
		const original = opt.value();
		const next = withPermission(original, target, level);
		activeTarget = target;
		await opt.apply(next, async () => {
			if (
				disposed ||
				operation !== generation ||
				roomId !== props.roomId ||
				!perms.canSetPowerLevels()
			)
				throw new Error("You no longer have permission to change this room.");
			try {
				// State writes replace the whole document. Refresh it so another
				// moderator's unrelated changes are not overwritten by our cache.
				const latest = (await props.client
					.getStateEvent(roomId, EventType.RoomPowerLevels, "")
					.catch((error: unknown) => {
						if (
							error &&
							typeof error === "object" &&
							"errcode" in error &&
							error.errcode === "M_NOT_FOUND"
						)
							return {};
						throw error;
					})) as PowerLevelContent;
				if (
					disposed ||
					operation !== generation ||
					roomId !== props.roomId ||
					!perms.canSetPowerLevels()
				)
					throw new Error("You no longer have permission to change this room.");
				if (
					permissionValue(latest, target) !==
						permissionValue(original, target) ||
					explicitPermission(latest, target) !==
						explicitPermission(original, target) ||
					(level === null &&
						inheritedPermission(latest, target) !==
							inheritedPermission(original, target)) ||
					(level === null &&
						target.section === "events" &&
						inheritedPermission(original, target) === undefined &&
						(latest.state_default !== original.state_default ||
							latest.events_default !== original.events_default))
				)
					throw new Error(
						"This permission changed in another session. Reopen permissions and try again.",
					);
				const actor = props.client.getUserId() ?? "";
				const latestError = permissionEditError(
					latest,
					target,
					level,
					actor,
					perms.myPowerLevel(),
					target.section === "users" &&
						props.client.getRoom(roomId)?.getMember(target.key)?.powerLevel ===
							Infinity,
				);
				if (latestError) throw new Error(latestError);
				await props.client.sendStateEvent(
					roomId,
					EventType.RoomPowerLevels,
					withPermission(latest, target, level),
					"",
				);
			} catch (e) {
				throw new Error(
					userFacingErrorMessage(e, "Could not save room permissions."),
				);
			}
		});
	};
	const change = (target: PermissionTarget, level: number | null) => {
		if (disabled()) return;
		const invalid = editError(target, level);
		if (invalid) {
			setError(invalid);
			return;
		}
		const next = level ?? inheritedPermission(opt.value(), target);
		if (
			(target.section === "defaults" &&
				(target.key === "state_default" || target.key === "users_default")) ||
			(target.section === "events" && target.key === "m.room.power_levels") ||
			(target.section === "users" &&
				target.key === props.client.getUserId() &&
				next !== undefined &&
				next < perms.myPowerLevel())
		) {
			setConfirmation({ target, level });
		} else void save(target, level);
	};
	const row = (target: PermissionTarget, label: string) => (
		<PermissionLevelControl
			label={label}
			value={permissionValue(opt.value(), target)}
			inherited={inheritedPermission(opt.value(), target)}
			explicit={explicitPermission(opt.value(), target) !== undefined}
			disabled={disabled()}
			onChange={(level) => change(target, level)}
		/>
	);
	return (
		<div class="space-y-5">
			<p class="text-sm text-text-secondary">
				Choose the minimum level for each action. Members normally have level 0,
				moderators 50, and admins 100. Room creators in newer room versions have
				permanent privileges above these levels.
			</p>
			<Show when={!perms.canSetPowerLevels()}>
				<p class="text-sm text-text-muted">
					You don't have permission to change power levels.
				</p>
			</Show>
			<Show when={error()}>
				<p role="alert" class="text-sm text-danger-text">
					{error()}
				</p>
			</Show>
			<FieldStatus
				state={opt.pending() ? "saving" : opt.lastError() ? "error" : "idle"}
				error={opt.lastError()}
				onDismiss={() => opt.clearError()}
			/>
			<For each={PERMISSION_ACTIONS}>
				{(action) => row(action, action.label)}
			</For>
			<section aria-label="Advanced permission overrides" class="space-y-3">
				<h3 class="text-sm font-semibold text-text-primary">
					All permission overrides
				</h3>
				<p class="text-xs text-text-muted">
					Inspect or edit individual event, member, and notification levels,
					including settings from other clients. Reset removes an override.
					Unknown event types inherit the message or state default according to
					how they are sent.
				</p>
				<select
					aria-label="Override type"
					value={section()}
					onChange={(e) => {
						setSection(
							e.currentTarget.value as Exclude<PermissionSection, "defaults">,
						);
						setPage(0);
						setKey("");
					}}
					class="rounded bg-surface-2 p-2 text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
				>
					<option value="events">Event permissions</option>
					<option value="users">Member levels</option>
					<option value="notifications">Notification permissions</option>
				</select>
				<input
					aria-label="Filter overrides"
					placeholder="Filter overrides"
					value={search()}
					onInput={(e) => {
						setSearch(e.currentTarget.value);
						setPage(0);
					}}
					class="ml-2 rounded bg-surface-2 p-2 text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
				/>
				<Show when={section()} keyed>
					{(activeSection) => (
						<>
							<For each={overrides().slice(page() * 20, page() * 20 + 20)}>
								{(name) => row({ section: activeSection, key: name }, name)}
							</For>
							<Show when={overrides().length === 0}>
								<p class="text-xs text-text-muted">No matching overrides.</p>
							</Show>
							<div class="flex items-center gap-3 text-sm text-text-secondary">
								<button
									type="button"
									disabled={page() === 0}
									onClick={() => setPage((p) => p - 1)}
									class="rounded px-2 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
								>
									Previous
								</button>
								<span>
									Page {page() + 1} of {lastPage() + 1}
								</span>
								<button
									type="button"
									disabled={page() === lastPage()}
									onClick={() => setPage((p) => p + 1)}
									class="rounded px-2 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
								>
									Next
								</button>
							</div>
							<label class="block text-sm text-text-secondary">
								Add or edit an override
								<input
									aria-label="Override identifier"
									placeholder={
										section() === "users"
											? "@user:server"
											: "Event or notification type"
									}
									value={key()}
									onInput={(e) => setKey(e.currentTarget.value)}
									class="mt-1 block w-full rounded bg-surface-2 p-2 text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
								/>
							</label>
							<Show when={key().trim()} keyed>
								{(name) =>
									row(
										{ section: activeSection, key: name.trim() },
										`New override: ${name.trim()}`,
									)
								}
							</Show>
						</>
					)}
				</Show>
			</section>
			<ConfirmDialog
				open={() => confirmation() !== null}
				onClose={() => setConfirmation(null)}
				title="Change room authority?"
				body={
					<p>
						This changes who can manage the room or member privileges. Lowering
						your own level may prevent you from restoring it. Existing unrelated
						overrides will be preserved.
					</p>
				}
				confirmLabel="Save permission"
				destructive
				onConfirm={() => {
					const pending = confirmation();
					setConfirmation(null);
					if (pending) void save(pending.target, pending.level);
				}}
			/>
		</div>
	);
}
