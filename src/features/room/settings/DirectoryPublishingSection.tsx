import { type MatrixClient, Visibility } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createResource,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { FieldStatus } from "./FieldStatus";

interface DirectoryPublishingSectionProps {
	client: MatrixClient;
	roomId: string;
}

/**
 * Toggle for listing the space in the homeserver's public room directory
 * (`/publicRooms`). Unlike the other visibility controls this is NOT a room-
 * state event — it uses the `/directory/list/room/{roomId}` endpoint via
 * `getRoomDirectoryVisibility` / `setRoomDirectoryVisibility`, so it is loaded
 * once (no `RoomStateEvent` reactivity) and written with an optimistic toggle
 * that reverts on failure.
 *
 * There is no `maySendStateEvent` permission for directory listing, so the
 * toggle is not permission-gated: it stays enabled and relies on the server
 * to reject unauthorized writes (the error is surfaced inline). It is only
 * disabled while loading or saving, or when the initial load failed — in the
 * load-failure case a separate Retry is offered, since there is no known
 * current value to toggle from.
 */
const DirectoryPublishingSection: Component<DirectoryPublishingSectionProps> = (
	props,
) => {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	// Operation generation. Bumped on every new toggle and when the target
	// room changes. Combined with the `disposed` flag (set on unmount), this
	// lets any in-flight write that resolves late — after a room switch, a
	// newer toggle, or unmount — be dropped instead of mutating state for the
	// wrong room or clobbering a newer write's saving state.
	let opGen = 0;
	const stale = (gen: number): boolean => disposed || gen !== opGen;

	const [published, { mutate, refetch }] = createResource(
		() => props.roomId,
		async (rid): Promise<boolean> => {
			const res = await props.client.getRoomDirectoryVisibility(rid);
			return res.visibility === Visibility.Public;
		},
	);

	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	// When the room changes, invalidate any in-flight write and clear transient
	// local state so saving/error feedback can't leak across rooms. The
	// resource itself refetches via its `() => props.roomId` source.
	createEffect(
		on(
			() => props.roomId,
			() => {
				opGen++;
				setSaving(false);
				setError(null);
			},
			{ defer: true },
		),
	);

	const state = (): "idle" | "saving" | "error" => {
		if (saving()) return "saving";
		if (error()) return "error";
		return "idle";
	};

	const toggle = async (): Promise<void> => {
		if (saving() || published.loading || published.error) return;
		const current = published() ?? false;
		const next = !current;
		const gen = ++opGen;
		setSaving(true);
		setError(null);
		// Optimistically reflect the new state; revert if the write fails.
		mutate(next);
		try {
			await props.client.setRoomDirectoryVisibility(
				props.roomId,
				next ? Visibility.Public : Visibility.Private,
			);
		} catch (e) {
			// Drop a revert/error that resolves after a room switch (or unmount)
			// so it can't bleed into the new room's state.
			if (stale(gen)) return;
			mutate(current);
			setError(
				e instanceof Error ? e.message : "Failed to update directory listing.",
			);
		} finally {
			if (!stale(gen)) setSaving(false);
		}
	};

	const checked = (): boolean => published() ?? false;
	const disabled = (): boolean =>
		saving() || published.loading || published.error !== undefined;

	return (
		<section>
			<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
				Directory listing
			</h3>
			<label class="flex items-start gap-3 text-sm">
				<input
					type="checkbox"
					checked={checked()}
					disabled={disabled()}
					onChange={() => void toggle()}
					class="mt-0.5 accent-accent disabled:cursor-not-allowed disabled:opacity-60"
				/>
				<span class="text-text-secondary">
					Publish this space to the public room directory so anyone on the
					homeserver can find it.
				</span>
			</label>
			<FieldStatus
				state={state()}
				error={error()}
				onRetry={() => void toggle()}
				onDismiss={() => setError(null)}
			/>
			<Show when={published.error}>
				<p class="mt-1 text-xs text-danger-text" role="alert">
					Couldn't load the current directory listing status.{" "}
					<button
						type="button"
						onClick={() => void refetch()}
						class="font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text"
					>
						Retry
					</button>
				</p>
			</Show>
		</section>
	);
};

export { DirectoryPublishingSection };
