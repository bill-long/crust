import { useNavigate } from "@solidjs/router";
import type { IPublicRoomsChunkRoom } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createSignal,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { Virtualizer } from "virtua/solid";
import { useClient } from "../../client/client";
import { Avatar } from "../../components/Avatar";
import { avatarHttpUrl, avatarInitial } from "../../lib/avatar";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";
import { createFailedImageUrls } from "../../lib/imageFallback";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { requestJoinDialog } from "../../stores/joinDialog";
import { trackAppModalOpen } from "../../stores/modalStack";

/** Page size for each `/publicRooms` request. */
const DIRECTORY_PAGE_LIMIT = 20;

/** Space glyph for directory results that are spaces. */
const DirectorySpaceIcon: Component = () => (
	<svg
		aria-label="Space"
		role="img"
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0 text-text-muted"
	>
		<rect x="2" y="2" width="12" height="12" rx="3" />
		<circle cx="8" cy="8" r="2.5" />
	</svg>
);

/** Display name for a directory result: room name, else alias, else ID. */
function directoryRoomName(room: IPublicRoomsChunkRoom): string {
	return room.name?.trim() || room.canonical_alias || room.room_id;
}

interface ExploreDialogProps {
	open: () => boolean;
	onClose: () => void;
}

/**
 * Public room directory browse: search `/publicRooms` (own server by
 * default, optional remote server), paginate with Load more, and join
 * straight from the result rows. A 403 on join delegates to the join
 * dialog with the knock offer engaged (the reason input lives there) -
 * the same hand-off space discovery uses.
 */
const ExploreDialog: Component<ExploreDialogProps> = (props) => {
	const { client, summaries, optimisticallyMarkJoined } = useClient();
	// Fail-closed avatars, keyed by URL at the dialog level: virtua recycles
	// the result rows, so per-row error state would be lost on scroll (#457).
	const brokenAvatars = createFailedImageUrls();
	const navigate = useNavigate();
	trackAppModalOpen(props.open);

	let overlayRef!: HTMLDivElement;
	let inputRef: HTMLInputElement | undefined;
	let scrollRef: HTMLDivElement | undefined;
	let previousFocus: HTMLElement | null = null;
	let mounted = true;
	onCleanup(() => {
		mounted = false;
	});

	const titleId = createUniqueId();
	const inputId = createUniqueId();
	const serverId = createUniqueId();
	const errorId = createUniqueId();

	const [query, setQuery] = createSignal("");
	const [server, setServer] = createSignal("");
	const [results, setResults] = createSignal<IPublicRoomsChunkRoom[]>([]);
	const [nextBatch, setNextBatch] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [loadingMore, setLoadingMore] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	/** Per-row join progress, keyed by room_id. */
	const [joinStates, setJoinStates] = createSignal<
		Record<string, "joining" | "joined" | "error">
	>({});

	// Bumped on every open and every new search; an in-flight response
	// captures the value and bails if the dialog closed or a newer search
	// superseded it (stale responses must never overwrite fresh results).
	let requestGeneration = 0;

	function reset(): void {
		requestGeneration++;
		setQuery("");
		setServer("");
		setResults([]);
		setNextBatch(null);
		setLoading(false);
		setLoadingMore(false);
		setError(null);
		setJoinStates({});
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				reset();
				queueMicrotask(() => inputRef?.focus());
				// Initial browse: the server's default listing, no filter.
				void search();
			} else if (!isOpen && wasOpen) {
				if (previousFocus && document.body.contains(previousFocus)) {
					previousFocus.focus();
				}
				previousFocus = null;
			}
		}),
	);

	onCleanup(() => {
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
		previousFocus = null;
	});

	const directoryOptions = () => {
		const term = query().trim();
		const serverName = server().trim();
		return {
			...(serverName ? { server: serverName } : {}),
			limit: DIRECTORY_PAGE_LIMIT,
			...(term ? { filter: { generic_search_term: term } } : {}),
		};
	};

	const search = async (): Promise<void> => {
		const myGeneration = ++requestGeneration;
		setLoading(true);
		// A superseding search also cancels any in-flight load-more; its
		// continuation skips the flag reset on generation mismatch, so
		// clear it here or the button would stick on "Loading…".
		setLoadingMore(false);
		setError(null);
		setResults([]);
		setNextBatch(null);
		// The results replacement also abandons any in-flight row join: its
		// continuation bails on the generation bump, so without this the
		// row's "Joining…" state would leak into the fresh result set.
		setJoinStates({});
		try {
			const res = await client.publicRooms(directoryOptions());
			if (!mounted || myGeneration !== requestGeneration) return;
			setResults(res.chunk);
			setNextBatch(res.next_batch ?? null);
		} catch (err) {
			if (!mounted || myGeneration !== requestGeneration) return;
			console.error("Failed to load the room directory:", err);
			setError(
				userFacingErrorMessage(
					err,
					"Couldn't load the room directory. Please try again.",
				),
			);
		} finally {
			if (mounted && myGeneration === requestGeneration) setLoading(false);
		}
	};

	const loadMore = async (): Promise<void> => {
		const token = nextBatch();
		if (!token || loadingMore()) return;
		const myGeneration = requestGeneration;
		setLoadingMore(true);
		try {
			const res = await client.publicRooms({
				...directoryOptions(),
				since: token,
			});
			if (!mounted || myGeneration !== requestGeneration) return;
			setResults((prev) => [...prev, ...res.chunk]);
			setNextBatch(res.next_batch ?? null);
		} catch (err) {
			if (!mounted || myGeneration !== requestGeneration) return;
			console.error("Failed to load more directory rooms:", err);
			setError(
				userFacingErrorMessage(
					err,
					"Couldn't load more rooms. Please try again.",
				),
			);
		} finally {
			if (mounted && myGeneration === requestGeneration) setLoadingMore(false);
		}
	};

	const handleJoin = async (room: IPublicRoomsChunkRoom): Promise<void> => {
		const roomId = room.room_id;
		const state = joinStates()[roomId];
		if (state === "joining" || state === "joined") return;
		// Stale-continuation guard: the dialog is hosted session-long, so
		// `mounted` never flips on close. Capture the generation (bumped by
		// reset on every open and by every search) and re-check it - plus
		// the dialog still being open - after the await, so an Escape /
		// backdrop close mid-join can't navigate the user into the room or
		// pop the knock hand-off after they've dismissed the dialog.
		const myGeneration = requestGeneration;
		setJoinStates((prev) => ({ ...prev, [roomId]: "joining" }));
		const stillCurrent = (): boolean =>
			mounted && props.open() && myGeneration === requestGeneration;
		// Join by alias when the directory entry has one (aliases
		// self-resolve); a bare room ID joins THROUGH the server whose
		// directory listed the room - it's necessarily participating, so
		// it's a valid via server. Without this a room found by browsing a
		// remote server's directory can never be joined.
		const idOrAlias = room.canonical_alias ?? roomId;
		const viaServers = room.canonical_alias
			? []
			: [server().trim() || client.getDomain() || ""].filter(Boolean);
		try {
			await client.joinRoom(idOrAlias, { viaServers });
			if (!stillCurrent()) return;
			// joinRoom resolves before /sync delivers the room's state, so
			// stub the summary entry to surface the room immediately - the
			// same reconciliation space discovery and the join dialog use.
			const isSpace = room.room_type === "m.space";
			optimisticallyMarkJoined(roomId, {
				name: directoryRoomName(room),
				// mxcUrlToHttp returns "" for non-mxc input - normalize to the
				// null the summary contract expects (#418 sentinel class).
				avatarUrl: room.avatar_url
					? client.mxcUrlToHttp(room.avatar_url) || null
					: null,
				isSpace,
			});
			props.onClose();
			navigate(
				isSpace
					? `/space/${encodeURIComponent(roomId)}`
					: `/home/${encodeURIComponent(roomId)}`,
			);
		} catch (err) {
			if (!stillCurrent()) return;
			const code =
				err && typeof err === "object" && "errcode" in err
					? (err as { errcode?: unknown }).errcode
					: undefined;
			if (code === "M_FORBIDDEN") {
				// Knock-rule or invite-only: hand off to the join dialog with
				// the knock offer engaged (the reason input lives there). The
				// directory row's own error state stays clean for a reopen.
				setJoinStates((prev) => {
					const next = { ...prev };
					delete next[roomId];
					return next;
				});
				props.onClose();
				// Note: no isSpace hint here - the join dialog's isSpace
				// prefill flag is #443 work; without it a knocked space
				// stubs as a room until /sync delivers the create event.
				requestJoinDialog({ idOrAlias, viaServers }, { knockOffered: true });
				return;
			}
			console.error(`Failed to join room ${roomId}:`, err);
			setJoinStates((prev) => ({ ...prev, [roomId]: "error" }));
		}
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			props.onClose();
			return;
		}
		if (e.key === "Tab") {
			trapTabKey(overlayRef, e);
		}
	};

	return (
		<Show when={props.open()}>
			<div
				ref={overlayRef}
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				inert={cryptoDialogOpen() || undefined}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				onClick={(e) => {
					if (e.target === e.currentTarget) props.onClose();
				}}
			>
				<div class="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg bg-surface-1 p-6 shadow-xl">
					<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
						Explore public rooms
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						Browse and join rooms published in a server's public directory.
					</p>

					<form
						onSubmit={(e) => {
							e.preventDefault();
							void search();
						}}
						class="mb-2 flex gap-2"
					>
						<div class="min-w-0 flex-1">
							<label for={inputId} class="sr-only">
								Search the room directory
							</label>
							<input
								id={inputId}
								ref={(el) => {
									inputRef = el;
								}}
								type="text"
								value={query()}
								onInput={(e) => setQuery(e.currentTarget.value)}
								placeholder="Search rooms"
								autocomplete="off"
								spellcheck={false}
								aria-describedby={error() ? errorId : undefined}
								class="w-full rounded bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							/>
						</div>
						<div class="w-36 shrink-0">
							<label for={serverId} class="sr-only">
								Server to search (optional)
							</label>
							<input
								id={serverId}
								type="text"
								value={server()}
								onInput={(e) => setServer(e.currentTarget.value)}
								placeholder="Server (optional)"
								autocomplete="off"
								spellcheck={false}
								class="w-full rounded bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							/>
						</div>
						<button
							type="submit"
							disabled={loading()}
							class="shrink-0 rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							Search
						</button>
					</form>

					<Show when={error()}>
						<p id={errorId} class="mb-2 text-sm text-danger-text" role="alert">
							{error()}
						</p>
					</Show>

					<div ref={scrollRef} class="min-h-0 flex-1 overflow-y-auto">
						<Show
							when={!loading()}
							fallback={
								<div class="flex items-center justify-center py-8">
									<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
								</div>
							}
						>
							<Show
								when={results().length > 0}
								fallback={
									<div class="px-1 py-6 text-center text-sm text-text-disabled">
										No rooms found
									</div>
								}
							>
								{/* Virtualized: Load-more pages accumulate results
								    unboundedly, so this list crosses the ~50-item
								    virtualization threshold after three pages. */}
								<Virtualizer
									{...(scrollRef ? { scrollRef } : {})}
									data={results()}
								>
									{(room) => {
										const joinState = () => joinStates()[room.room_id];
										const alreadyJoined = () =>
											summaries[room.room_id]?.membership === "join";
										return (
											<div class="flex w-full items-center gap-2 rounded px-2 py-2 text-text-muted hover:bg-surface-2/50">
												<Avatar
													url={avatarHttpUrl(client, room.avatar_url, 64)}
													initial={avatarInitial(directoryRoomName(room))}
													loading="lazy"
													broken={brokenAvatars}
												/>
												<div class="min-w-0 flex-1">
													<div class="flex items-center gap-1">
														<Show when={room.room_type === "m.space"}>
															<DirectorySpaceIcon />
														</Show>
														<span class="truncate text-sm font-medium text-text-secondary">
															{directoryRoomName(room)}
														</span>
														<span class="shrink-0 text-[10px] text-text-faint">
															{room.num_joined_members} members
														</span>
													</div>
													<Show
														when={
															room.canonical_alias &&
															room.canonical_alias !== directoryRoomName(room)
														}
													>
														<p class="truncate text-xs text-text-faint">
															{room.canonical_alias}
														</p>
													</Show>
													<Show when={room.topic}>
														<p class="truncate text-xs text-text-faint">
															{room.topic}
														</p>
													</Show>
												</div>
												<Show
													when={!alreadyJoined() && joinState() !== "joined"}
													fallback={
														<span class="shrink-0 px-2 text-xs text-text-faint">
															Joined
														</span>
													}
												>
													<button
														type="button"
														onClick={() => void handleJoin(room)}
														disabled={joinState() === "joining"}
														aria-label={`Join ${directoryRoomName(room)}`}
														class={`shrink-0 rounded px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-hidden focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
															joinState() === "error"
																? "bg-danger-bg/40 text-danger-text hover:bg-danger-bg/60 focus-visible:ring-danger"
																: "bg-accent text-text-primary hover:bg-accent-hover focus-visible:ring-accent-hover"
														}`}
													>
														{joinState() === "joining"
															? "Joining…"
															: joinState() === "error"
																? "Retry"
																: "Join"}
													</button>
												</Show>
											</div>
										);
									}}
								</Virtualizer>
								<Show when={nextBatch()}>
									<div class="flex justify-center py-2">
										<button
											type="button"
											onClick={() => void loadMore()}
											disabled={loadingMore()}
											class="rounded px-3 py-1.5 text-sm text-accent-text transition-colors hover:bg-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
										>
											{loadingMore() ? "Loading…" : "Load more rooms"}
										</button>
									</div>
								</Show>
							</Show>
						</Show>
					</div>

					<div class="mt-4 flex justify-end">
						<button
							type="button"
							onClick={props.onClose}
							class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
						>
							Close
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export { ExploreDialog };
