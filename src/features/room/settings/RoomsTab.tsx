import { EventType, type MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	on,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";

interface RoomsTabProps {
	client: MatrixClient;
	roomId: string;
}

/** Order-insensitive set equality for two arrays of room IDs. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	for (const id of b) if (!set.has(id)) return false;
	return true;
}

interface ChildDisplay {
	roomId: string;
	name: string;
	avatarUrl: string | null;
}

const RoomsTab: Component<RoomsTabProps> = (props) => {
	const { summaries } = useClient();
	const perms = useRoomPermissions(props.client, () => props.roomId);

	const filterId = createUniqueId();

	const [filter, setFilter] = createSignal("");
	// Room currently being added/removed, for per-row pending labels. Only one
	// write runs at a time (writes are serialized + buttons disabled while
	// pending), so a single id is sufficient.
	const [pendingRoomId, setPendingRoomId] = createSignal<string | null>(null);

	// Authoritative child room IDs from the summaries store (updates on the
	// m.space.child state-event echo). The optimistic overlay below keeps the
	// list responsive between a write and its eventual sync echo.
	const serverChildren = (): string[] =>
		summaries[props.roomId]?.children ?? [];
	const childrenState = useOptimisticState<string[]>({
		serverValue: serverChildren,
		equals: sameIdSet,
		fallbackError: "Could not update the space.",
	});

	// Reset the overlay/error when the settings target changes (the overlay
	// component instance may be reused across rooms).
	createEffect(
		on(
			() => props.roomId,
			() => {
				childrenState.reset();
				setPendingRoomId(null);
				setFilter("");
			},
			{ defer: true },
		),
	);

	const childIds = childrenState.value;

	const baseUrl = props.client.getHomeserverUrl();

	const resolveChild = (id: string): ChildDisplay => {
		const summary = summaries[id];
		if (summary) {
			return {
				roomId: id,
				name: summary.name.trim() || id,
				avatarUrl: summary.avatarUrl,
			};
		}
		const room = props.client.getRoom(id);
		return {
			roomId: id,
			name: room?.name?.trim() || id,
			avatarUrl: room?.getAvatarUrl(baseUrl, 48, 48, "crop") ?? null,
		};
	};

	const children = createMemo<ChildDisplay[]>(() =>
		childIds()
			.map(resolveChild)
			.sort((a, b) => a.name.localeCompare(b.name)),
	);

	// Base candidate set — joined, non-space, non-DM rooms not already in this
	// space (spaces and 1:1 DMs are not addable as child rooms here). Depends
	// on the store + current children only, NOT the search box, so typing in
	// the filter re-runs only the cheap text match below rather than rescanning
	// and re-sorting the whole store on every keystroke.
	const baseCandidates = createMemo<ChildDisplay[]>(() => {
		const childSet = new Set(childIds());
		return Object.values(summaries)
			.filter(
				(s) =>
					s.membership === "join" &&
					!s.isSpace &&
					!s.isDirect &&
					s.roomId !== props.roomId &&
					!childSet.has(s.roomId),
			)
			.map((s) => ({
				roomId: s.roomId,
				name: s.name.trim() || s.roomId,
				avatarUrl: s.avatarUrl,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	});

	const candidates = createMemo<ChildDisplay[]>(() => {
		const q = filter().trim().toLowerCase();
		if (q === "") return baseCandidates();
		return baseCandidates().filter((c) => c.name.toLowerCase().includes(q));
	});

	const canManage = (): boolean => perms.canSetSpaceChild();

	const addRoom = (roomId: string): void => {
		if (!canManage() || childrenState.pending()) return;
		const via = props.client.getDomain();
		setPendingRoomId(roomId);
		void childrenState
			.apply([...childIds(), roomId], async () => {
				await props.client.sendStateEvent(
					props.roomId,
					EventType.SpaceChild,
					{ via: via ? [via] : [], suggested: false },
					roomId,
				);
			})
			.finally(() => setPendingRoomId(null));
	};

	const removeRoom = (roomId: string): void => {
		if (!canManage() || childrenState.pending()) return;
		setPendingRoomId(roomId);
		void childrenState
			.apply(
				childIds().filter((id) => id !== roomId),
				async () => {
					// Empty content removes the m.space.child relationship.
					await props.client.sendStateEvent(
						props.roomId,
						EventType.SpaceChild,
						{},
						roomId,
					);
				},
			)
			.finally(() => setPendingRoomId(null));
	};

	const initial = (name: string): string =>
		name.trim().charAt(0).toUpperCase() || "?";

	return (
		<div class="space-y-8">
			<Show when={childrenState.lastError()}>
				<p
					class="rounded bg-danger-bg/30 px-3 py-1.5 text-xs text-danger-text"
					role="alert"
				>
					{childrenState.lastError()}
				</p>
			</Show>

			{/* Current rooms */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Rooms in this space ({children().length})
				</h3>
				<Show
					when={children().length > 0}
					fallback={
						<p class="text-sm text-text-muted">This space has no rooms yet.</p>
					}
				>
					<ul class="space-y-2">
						<For each={children()}>
							{(child) => (
								<li class="flex items-center justify-between gap-3 rounded bg-surface-1 px-3 py-2">
									<div class="flex min-w-0 items-center gap-3">
										<div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-xs font-semibold text-text-secondary">
											<Show
												when={child.avatarUrl}
												fallback={<span>{initial(child.name)}</span>}
											>
												<img
													src={child.avatarUrl ?? ""}
													alt=""
													class="h-full w-full object-cover"
												/>
											</Show>
										</div>
										<div class="min-w-0">
											<div class="truncate text-sm text-text-primary">
												{child.name}
											</div>
											<div class="truncate font-mono text-xs text-text-muted">
												{child.roomId}
											</div>
										</div>
									</div>
									<Show when={canManage()}>
										<button
											type="button"
											onClick={() => removeRoom(child.roomId)}
											disabled={childrenState.pending()}
											class="shrink-0 rounded px-2 py-1 text-xs font-medium text-danger-text hover:bg-danger-bg/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text disabled:cursor-not-allowed disabled:opacity-60"
											aria-label={`Remove ${child.name} from this space`}
										>
											{pendingRoomId() === child.roomId
												? "Removing…"
												: "Remove"}
										</button>
									</Show>
								</li>
							)}
						</For>
					</ul>
				</Show>
			</section>

			{/* Add room */}
			<Show
				when={canManage()}
				fallback={
					<p class="text-sm text-text-muted">
						You don't have permission to manage this space's rooms.
					</p>
				}
			>
				<section>
					<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
						Add a room
					</h3>
					<label class="mb-2 block text-sm">
						<span class="sr-only" id={filterId}>
							Filter your rooms
						</span>
						<input
							type="text"
							value={filter()}
							onInput={(e) => setFilter(e.currentTarget.value)}
							aria-labelledby={filterId}
							placeholder="Search your rooms…"
							class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						/>
					</label>
					<Show
						when={candidates().length > 0}
						fallback={
							<p class="text-sm text-text-muted">
								{filter().trim()
									? "No matching rooms."
									: "All your rooms are already in this space."}
							</p>
						}
					>
						<ul class="max-h-[40vh] space-y-2 overflow-y-auto">
							<For each={candidates()}>
								{(room) => (
									<li class="flex items-center justify-between gap-3 rounded bg-surface-1 px-3 py-2">
										<div class="flex min-w-0 items-center gap-3">
											<div class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-xs font-semibold text-text-secondary">
												<Show
													when={room.avatarUrl}
													fallback={<span>{initial(room.name)}</span>}
												>
													<img
														src={room.avatarUrl ?? ""}
														alt=""
														class="h-full w-full object-cover"
													/>
												</Show>
											</div>
											<div class="min-w-0">
												<div class="truncate text-sm text-text-primary">
													{room.name}
												</div>
												<div class="truncate font-mono text-xs text-text-muted">
													{room.roomId}
												</div>
											</div>
										</div>
										<button
											type="button"
											onClick={() => addRoom(room.roomId)}
											disabled={childrenState.pending()}
											class="shrink-0 rounded bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
											aria-label={`Add ${room.name} to this space`}
										>
											{pendingRoomId() === room.roomId ? "Adding…" : "Add"}
										</button>
									</li>
								)}
							</For>
						</ul>
					</Show>
				</section>
			</Show>
		</div>
	);
};

export { RoomsTab };
