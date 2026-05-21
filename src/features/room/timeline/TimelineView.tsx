import { createVirtualizer } from "@tanstack/solid-virtual";
import {
	EventStatus,
	EventType,
	ReceiptType,
	RelationType,
	RoomEvent,
} from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { EmojiPicker } from "../../emoji/EmojiPicker";
import type { PickerEmoji } from "../../emoji/types";
import {
	buildEmoteLookup,
	buildShortcodeLookup,
	useImagePacks,
} from "../../emoji/useImagePacks";
import { Composer } from "../composer/Composer";
import { TimelineItem } from "./TimelineItem";
import { type TimelineEvent, useTimeline } from "./useTimeline";

const MESSAGE_GROUP_GAP_MS = 7 * 60 * 1000; // 7 minutes

/** Whether a message should show the full header (avatar + name + time). */
function shouldShowHeader(
	events: readonly TimelineEvent[],
	index: number,
): boolean {
	if (index === 0) return true;
	const prev = events[index - 1];
	const curr = events[index];
	if (!prev || !curr) return true;
	if (prev.senderId !== curr.senderId) return true;
	if (curr.timestamp - prev.timestamp > MESSAGE_GROUP_GAP_MS) return true;
	// Break group on day boundary
	const prevDay = new Date(prev.timestamp).toDateString();
	const currDay = new Date(curr.timestamp).toDateString();
	if (prevDay !== currDay) return true;
	return false;
}

interface ReadReceiptEntry {
	userId: string;
	displayName: string;
}

const TimelineView: Component<{ roomId: string }> = (props) => {
	const { client } = useClient();
	const {
		events,
		loading,
		loadingOlder,
		loadingNewer,
		canLoadOlder,
		canLoadNewer,
		loadOlderMessages,
		loadNewerMessages,
		jumpToLive,
		setFollowingLive,
		typingUsers,
		getSourceEvent,
		getWindowEvents,
		pendingRedactions,
	} = useTimeline(client, () => props.roomId);

	// Custom emoji packs for this room
	const packs = useImagePacks(client, () => props.roomId);
	const shortcodeLookup = createMemo(() => buildShortcodeLookup(packs()));
	const emoteLookup = createMemo(() => buildEmoteLookup(packs()));

	let scrollRef: HTMLDivElement | undefined;
	const [atBottom, setAtBottom] = createSignal(true);
	const [replyTo, setReplyTo] = createSignal<TimelineEvent | null>(null);
	const [editingEvent, setEditingEvent] = createSignal<TimelineEvent | null>(
		null,
	);
	const [reactionPickerEventId, setReactionPickerEventId] = createSignal<
		string | null
	>(null);
	const [paginationStatus, setPaginationStatus] = createSignal("");

	// Announce backward pagination state changes for screen readers.
	// Forward pagination has its own aria-live region at the spinner.
	createEffect(
		on(
			() => [loadingOlder(), canLoadOlder(), loading(), events.length] as const,
			([isLoading, canLoad, isInitialLoading, eventCount]) => {
				if (isInitialLoading) {
					setPaginationStatus("");
				} else if (isLoading) {
					setPaginationStatus("Loading older messages…");
				} else if (!canLoad && eventCount > 0) {
					setPaginationStatus("Beginning of conversation reached.");
				} else {
					setPaginationStatus("");
				}
			},
		),
	);

	const myUserId = client.getUserId() ?? "";

	// Initial size estimate per row, used before measureElement has run
	// against the mounted DOM node. The Solid adapter wipes cached sizes
	// when `count` changes (e.g. on initial events arrival, pagination,
	// or room switch), so a realistic per-event estimate dramatically
	// reduces the gap between estimated and final positions and
	// prevents the visual stack-up reported in #67 when image rows
	// are still rendering above the viewport.
	//
	// Intentionally cheaper than `shouldShowHeader`: skips the Date
	// allocation + `toDateString` day-boundary check. Being off by ~28px
	// on day boundaries is negligible for a fallback estimate and keeps
	// this hot path allocation-free.
	const estimateRowSize = (index: number): number => {
		const ev = events[index];
		if (!ev) return 80;
		const prev = index > 0 ? events[index - 1] : null;
		const showsHeader =
			!prev ||
			prev.senderId !== ev.senderId ||
			ev.timestamp - prev.timestamp > MESSAGE_GROUP_GAP_MS;
		const headerExtra = showsHeader ? 28 : 0;
		if (ev.msgtype === "m.image" || ev.type === "m.sticker") {
			return 280 + headerExtra;
		}
		if (ev.formattedBody) {
			return 96 + headerExtra;
		}
		return 48 + headerExtra;
	};

	const virtualizer = createVirtualizer({
		get count() {
			return events.length;
		},
		getScrollElement: () => scrollRef ?? null,
		estimateSize: estimateRowSize,
		overscan: 10,
		getItemKey: (index: number) => events[index]?.eventId ?? index,
		// Defer ResizeObserver callbacks to the next animation frame.
		// Without this, RO fires its initial measurement synchronously
		// during the same tick the element mounts — which often coincides
		// with the auto-scroll-to-bottom kicked off on room entry, at
		// which point virtual-core treats the ResizeObserver fire as
		// "during scroll" and skips the cache update entirely. The RAF
		// wrap pushes the measurement out one frame, by which time the
		// scroll has settled enough for the cache to update reliably.
		useAnimationFrameWithResizeObserver: true,
	});

	// Override `virtualizer.measure()` to preserve `itemSizeCache`.
	// The default behavior replaces it with an empty Map and then
	// calls `notify(false)` — which synchronously runs the Solid
	// adapter's `onChange`, which in turn calls `getVirtualItems`
	// and re-derives positions from whatever sizes are in the cache
	// at that moment. If we capture-then-restore around the default
	// `measure()`, the restore happens *after* the layout has already
	// been computed against an empty cache. So we must reimplement
	// the reset directly: replace the Map reference (memo identity-
	// invalidates so the `getMeasurements` memo re-derives), but
	// seed the new Map with the previous entries.
	//
	// The Solid adapter calls `measure()` inside a createComputed on
	// every reactive option change — including `count` — so without
	// this every pagination prepend / append would wipe all measured
	// row sizes and fall rows back to `estimateSize` (the brief
	// gap/overlap reported in issue #75). Our cache is keyed by event
	// ID via `getItemKey`, so cached measurements stay valid through
	// index shifts.
	//
	// Cast: `itemSizeCache`, `laneAssignments`, and `notify` are
	// marked private in @tanstack/virtual-core but are the only
	// practical hooks for an in-place reset; the field shapes have
	// been stable across recent versions.
	const virtualizerInternal = virtualizer as unknown as {
		itemSizeCache: Map<unknown, number>;
		laneAssignments: Map<number, number>;
		notify: (sync: boolean) => void;
	};
	virtualizer.measure = () => {
		// Prune the preserved cache to only event IDs that are currently
		// in the timeline window. Without this, entries for events
		// evicted from the (bounded) window would accumulate
		// indefinitely during a long session in one room. Pruning each
		// time `measure()` is called keeps the cache size proportional
		// to `events.length` (≤ `WINDOW_LIMIT`).
		const currentIds = new Set<string>();
		for (const ev of events) currentIds.add(ev.eventId);
		const fresh = new Map<unknown, number>();
		for (const [key, size] of virtualizerInternal.itemSizeCache) {
			if (typeof key === "string" && currentIds.has(key)) {
				fresh.set(key, size);
			}
		}
		virtualizerInternal.itemSizeCache = fresh;
		virtualizerInternal.laneAssignments = new Map();
		virtualizerInternal.notify(false);
	};

	// Idempotent helper to remeasure currently rendered rows. With the
	// `measure()` override above, the size cache is preserved across
	// reactive option changes, so this is no longer strictly required
	// for cache correctness. It's still useful as a belt-and-suspenders
	// pass after pagination and similar events where row content may
	// have settled in ways the ResizeObserver could miss.
	const remeasureVisibleItems = (): void => {
		if (!scrollRef) return;
		const els = scrollRef.querySelectorAll<HTMLElement>("[data-index]");
		for (const el of els) {
			virtualizer.measureElement(el);
		}
	};

	// Re-measure after events.length changes (triggers the adapter's measure())
	createEffect(
		on(
			() => events.length,
			() => {
				queueMicrotask(remeasureVisibleItems);
			},
		),
	);

	// --- Read receipts ---
	// Build a map: eventId → list of users who have read up to that event
	// Re-trigger read receipt computation on receipt events for current room
	const [receiptTick, setReceiptTick] = createSignal(0);
	function onReceiptEvent(_event: unknown, room: { roomId: string }): void {
		if (room.roomId === props.roomId) {
			setReceiptTick((n) => n + 1);
		}
	}
	client.on(RoomEvent.Receipt, onReceiptEvent);
	onCleanup(() => client.off(RoomEvent.Receipt, onReceiptEvent));

	// Build a map: eventId → list of users who have read up to that event
	const receipts = createMemo(() => {
		receiptTick(); // track receipt updates for reactivity
		const map = Object.create(null) as Record<string, ReadReceiptEntry[]>;
		const room = client.getRoom(props.roomId);
		if (!room) return map;

		// Build a set of displayable event IDs for quick lookup
		const displayableIds = new Set<string>();
		for (const ev of events) {
			displayableIds.add(ev.eventId);
		}

		const timelineEvents = getWindowEvents();
		// Precompute eventId→index map for O(1) lookup
		const idxById = Object.create(null) as Record<string, number>;
		for (let i = 0; i < timelineEvents.length; i++) {
			const id = timelineEvents[i].getId();
			if (id) idxById[id] = i;
		}

		const members = room.getMembers();
		for (const member of members) {
			if (member.userId === myUserId) continue;
			let readUpToId = room.getEventReadUpTo(member.userId);
			if (!readUpToId) continue;

			// If the receipt points at a non-displayable event (e.g. an edit),
			// walk backwards through the SDK timeline to find the nearest
			// displayable event
			if (!displayableIds.has(readUpToId)) {
				const idx = idxById[readUpToId];
				if (idx === undefined) continue;
				let resolved: string | null = null;
				for (let i = idx; i >= 0; i--) {
					const id = timelineEvents[i].getId();
					if (id && displayableIds.has(id)) {
						resolved = id;
						break;
					}
				}
				if (!resolved) continue;
				readUpToId = resolved;
			}

			if (!map[readUpToId]) map[readUpToId] = [];
			map[readUpToId].push({
				userId: member.userId,
				displayName: member.name?.trim() || member.userId,
			});
		}
		return map;
	});

	// Send read receipt for the latest event when at bottom
	let lastSentReceiptEventId: string | null = null;

	function sendReadReceipt(): void {
		if (!atBottom()) return;
		// Don't send receipts for events the user hasn't scrolled to.
		// When behind live, forward pagination appends events but
		// auto-scroll is suppressed, so atBottom can be stale-true.
		if (canLoadNewer()) return;
		const lastEvent = events[events.length - 1];
		if (!lastEvent || lastEvent.eventId === lastSentReceiptEventId) return;
		const eventId = lastEvent.eventId;
		// Skip local echo events — their temporary ~-prefixed IDs
		// are rejected by the server with 400.
		if (!eventId.startsWith("$")) return;
		const matrixEvent = getSourceEvent(eventId);
		if (!matrixEvent) return;
		client
			.sendReadReceipt(matrixEvent, ReceiptType.Read)
			.then(() => {
				lastSentReceiptEventId = eventId;
			})
			.catch(() => {
				// Best-effort; receipt will retry on next scroll/event
			});
	}

	// Send receipt when new events arrive or last event ID changes
	// (local echo replacement triggers the ID change without a length change)
	createEffect(
		on(
			() => events[events.length - 1]?.eventId,
			() => sendReadReceipt(),
		),
	);

	// Send receipt when user scrolls to bottom
	createEffect(
		on(atBottom, (isAtBottom) => {
			if (isAtBottom) sendReadReceipt();
		}),
	);

	// Send receipt when forward pagination catches up to live.
	// The events.length effect misses the final page because
	// canLoadNewer is still true when events rebuild.
	createEffect(
		on(canLoadNewer, (hasNewer) => {
			if (!hasNewer) sendReadReceipt();
		}),
	);

	// Send receipt when room first opens
	createEffect(
		on(
			() => props.roomId,
			() => {
				lastSentReceiptEventId = null;
				// Defer so events are loaded first
				requestAnimationFrame(() => sendReadReceipt());
			},
		),
	);

	// Reset scroll position and reply/edit state when switching rooms
	createEffect(
		on(
			() => props.roomId,
			() => {
				setAtBottom(true);
				setReplyTo(null);
				setEditingEvent(null);
				setReactionPickerEventId(null);
				// Force the virtualizer to recalculate after the store updates
				requestAnimationFrame(() => {
					virtualizer.measure();
					remeasureVisibleItems();
					const el = scrollRef;
					if (el) el.scrollTo({ top: el.scrollHeight });
				});
			},
		),
	);

	// Auto-scroll to bottom when new messages arrive and user is at bottom.
	// Suppressed when behind live (canLoadNewer) so that forward pagination
	// via "Load newer messages" doesn't jump past the loaded page.
	createEffect(
		on(
			() => events.length,
			() => {
				if (atBottom() && !canLoadNewer() && scrollRef) {
					requestAnimationFrame(() => {
						const el = scrollRef;
						if (el) el.scrollTo({ top: el.scrollHeight });
					});
				}
			},
		),
	);

	// Sync the timeline hook's followingLive state with scroll position.
	// When the user scrolls up, stop extending the window with live events.
	// When they scroll back to bottom AND no newer events are pending,
	// resume live tracking. When behind live at bottom, the user must
	// explicitly click "Load newer" or "Jump to latest" to catch up —
	// auto-jumping would discard their reading position.
	createEffect(
		on(
			() => [atBottom(), canLoadNewer()] as const,
			([isAtBottom, hasNewer]) => {
				if (isAtBottom && !hasNewer) {
					setFollowingLive(true);
				} else if (!isAtBottom) {
					setFollowingLive(false);
				}
			},
		),
	);

	// Auto-paginate when content doesn't fill the viewport (no scrollbar
	// means onScroll never fires, so pagination can't be user-triggered).
	// Capped to prevent runaway fetches if events are non-displayable.
	// Stops scheduling RAFs once content overflows the viewport.
	const MAX_AUTO_PAGES = 10;
	const [autoPageCount, setAutoPageCount] = createSignal(0);
	let hasOverflow = false;
	let autoPagRafPending = false;
	createEffect(
		on(
			() =>
				[props.roomId, events.length, canLoadOlder(), loadingOlder()] as const,
			([roomId, , canLoad, isLoading], prev) => {
				// Reset state on room change
				if (!prev || prev[0] !== roomId) {
					setAutoPageCount(0);
					hasOverflow = false;
					autoPagRafPending = false;
				}
				if (hasOverflow || !canLoad || isLoading || !scrollRef) return;
				if (autoPageCount() >= MAX_AUTO_PAGES) return;
				if (autoPagRafPending) return;
				const currentRef = scrollRef;
				const rafRoomId = roomId;
				autoPagRafPending = true;
				requestAnimationFrame(() => {
					autoPagRafPending = false;
					if (!currentRef || rafRoomId !== props.roomId) return;
					if (currentRef.scrollHeight > currentRef.clientHeight) {
						hasOverflow = true;
						return;
					}
					if (canLoadOlder() && !loadingOlder()) {
						setAutoPageCount((c) => c + 1);
						loadOlderMessages();
					}
				});
			},
		),
	);

	const onScroll = (): void => {
		if (!scrollRef) return;
		const threshold = 50;
		const distFromBottom =
			scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
		setAtBottom(distFromBottom < threshold);

		// Load older messages when scrolled near the top
		if (scrollRef.scrollTop < 200 && canLoadOlder() && !loadingOlder()) {
			const prevHeight = scrollRef.scrollHeight;
			const roomAtRequest = props.roomId;
			loadOlderMessages().then(() => {
				// Preserve scroll position after prepending older messages
				// Only if we're still in the same room
				if (scrollRef && props.roomId === roomAtRequest) {
					requestAnimationFrame(() => {
						virtualizer.measure();
						remeasureVisibleItems();
						if (scrollRef) {
							const newHeight = scrollRef.scrollHeight;
							scrollRef.scrollTop += newHeight - prevHeight;
						}
					});
				}
			});
		}

		// Load newer messages when scrolled near the bottom
		if (distFromBottom < 200 && canLoadNewer() && !loadingNewer()) {
			// Clear stale atBottom so the followingLive and read-receipt
			// effects don't fire prematurely when canLoadNewer flips to
			// false on the final page. Recomputed on next scroll event.
			setAtBottom(false);
			loadNewerMessages();
		}
	};

	const onReact = async (eventId: string, key: string): Promise<void> => {
		const ev = events.find((e) => e.eventId === eventId);
		if (!ev) return;

		const existingId = Object.hasOwn(ev.myReactions, key)
			? ev.myReactions[key]
			: undefined;
		try {
			if (existingId) {
				await client.redactEvent(props.roomId, existingId);
			} else {
				await client.sendEvent(props.roomId, EventType.Reaction, {
					"m.relates_to": {
						rel_type: RelationType.Annotation,
						event_id: eventId,
						key,
					},
				});
			}
		} catch (e) {
			console.error("Reaction failed:", e);
		}
	};

	const onDelete = async (eventId: string): Promise<void> => {
		try {
			await client.redactEvent(props.roomId, eventId);
		} catch (e) {
			console.error("Delete failed:", e);
		}
	};

	/**
	 * Move keyboard focus to the room's composer textarea. Used after
	 * Retry / Discard / Cancel since the failed- or pending-banner
	 * button the user activated disappears and would otherwise strand
	 * focus on `document.body`.
	 *
	 * Re-checks the room ID inside the deferred callback because RAF
	 * runs a frame later; a room switch between the caller's guard and
	 * the actual focus call would otherwise steal focus into the wrong
	 * room.
	 */
	const focusComposer = (expectedRoomId: string): void => {
		requestAnimationFrame(() => {
			if (props.roomId !== expectedRoomId) return;
			const textarea = document.querySelector<HTMLTextAreaElement>(
				"textarea[data-composer-textarea]",
			);
			textarea?.focus();
		});
	};

	/**
	 * Resend a failed local echo through the SDK's pending-event queue.
	 * The SDK will transition the event back to SENDING and re-fire
	 * `LocalEchoUpdated`, which `useTimeline` picks up to update status.
	 */
	const onRetry = async (eventId: string): Promise<void> => {
		const originalRoomId = props.roomId;
		const room = client.getRoom(originalRoomId);
		if (!room) return;
		const matrixEvent = getSourceEvent(eventId);
		if (!matrixEvent) return;
		try {
			await client.resendEvent(matrixEvent, room);
		} catch (e) {
			console.error("Resend failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Cancel a local echo. Used for both Discard (on `NOT_SENT` failed
	 * sends) and Cancel (on in-flight `SENDING` / `QUEUED` / `ENCRYPTING`
	 * sends). In both cases the SDK fires a removed-Timeline event
	 * followed by `LocalEchoUpdated(CANCELLED)`; both paths drop the
	 * event from the store idempotently.
	 */
	const cancelPending = (eventId: string): void => {
		const matrixEvent = getSourceEvent(eventId);
		if (!matrixEvent) return;
		const originalRoomId = props.roomId;
		try {
			client.cancelPendingEvent(matrixEvent);
		} catch (e) {
			console.error("cancelPendingEvent failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Retry a failed redaction. The pending-redactions map is keyed by
	 * the *target* event ID and stores the redaction `MatrixEvent`
	 * directly, so Retry works even when the user has scrolled away
	 * from live (where the redaction echo lives).
	 * Re-checks the event's status because a concurrent retry from
	 * another path (or a quick succession of clicks) could have already
	 * moved the event back to SENDING.
	 */
	const onRetryRedaction = async (targetId: string): Promise<void> => {
		const pending = pendingRedactions[targetId];
		if (!pending) return;
		const room = client.getRoom(props.roomId);
		if (!room) return;
		if (pending.redactionEvent.status !== EventStatus.NOT_SENT) return;
		const originalRoomId = props.roomId;
		try {
			await client.resendEvent(pending.redactionEvent, room);
		} catch (e) {
			console.error("resendEvent (redaction) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Discard a failed redaction (target restores to normal). Cancelling
	 * fires removed-Timeline on the redaction event, which the
	 * useTimeline handler picks up to clear the pending-redaction entry.
	 */
	const onDiscardRedaction = (targetId: string): void => {
		const pending = pendingRedactions[targetId];
		if (!pending) return;
		const originalRoomId = props.roomId;
		try {
			client.cancelPendingEvent(pending.redactionEvent);
		} catch (e) {
			console.error("cancelPendingEvent (redaction) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	const onReactionPickerSelect = (
		eventId: string,
		item: PickerEmoji,
		itemRef: HTMLDivElement | undefined,
	): void => {
		const key = item.kind === "custom" ? item.emote.mxcUrl : item.emoji.unicode;
		onReact(eventId, key);
		setReactionPickerEventId(null);
		requestAnimationFrame(() => {
			if (itemRef) virtualizer.measureElement(itemRef);
		});
	};

	const onEdit = (ev: TimelineEvent): void => {
		// Get current body from SDK event for accurate prefill
		// Use getContent() (includes edits) not getOriginalContent()
		const sourceEvent = getSourceEvent(ev.eventId);
		if (sourceEvent) {
			const content = sourceEvent.getContent();
			const editBody =
				typeof content?.body === "string" ? content.body : ev.body;
			setEditingEvent({ ...ev, body: editBody });
		} else {
			setEditingEvent(ev);
		}
		setReplyTo(null);
	};

	// Typing indicator text
	const typingText = createMemo(() => {
		const users = typingUsers();
		if (users.length === 0) return null;
		if (users.length === 1) return `${users[0].displayName} is typing…`;
		if (users.length === 2)
			return `${users[0].displayName} and ${users[1].displayName} are typing…`;
		return "Several people are typing…";
	});

	return (
		<main class="flex h-full flex-col">
			{/* Timeline */}
			<Show
				when={!loading() || events.length > 0}
				fallback={
					<div class="flex flex-1 items-center justify-center">
						<div class="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
					</div>
				}
			>
				<div class="relative min-h-0 flex-1">
					{/* Screen reader announcement for pagination */}
					<div aria-live="polite" role="status" class="sr-only">
						{paginationStatus()}
					</div>
					<div
						ref={scrollRef}
						class="absolute inset-0 overflow-y-auto"
						style={{ "overflow-anchor": "none" }}
						onScroll={onScroll}
						tabIndex={-1}
					>
						{/* Loading older messages indicator */}
						<Show when={loadingOlder()}>
							<div class="flex justify-center py-3">
								<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							</div>
						</Show>
						{/* Manual load button when auto-pagination exhausted */}
						<Show
							when={
								!loadingOlder() &&
								canLoadOlder() &&
								autoPageCount() >= MAX_AUTO_PAGES
							}
						>
							<div class="flex justify-center py-3">
								<button
									type="button"
									class="rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis"
									onClick={() => loadOlderMessages()}
								>
									Load older messages
								</button>
							</div>
						</Show>
						<Show when={!loading() && !canLoadOlder() && events.length > 0}>
							<div class="py-3 text-center text-xs text-text-faint">
								Beginning of conversation
							</div>
						</Show>
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								position: "relative",
								width: "100%",
							}}
						>
							<For each={virtualizer.getVirtualItems()}>
								{(vItem) => {
									// `vItem` may briefly be undefined during the
									// reconcile that fires when `events.length`
									// changes (room switch, pagination) before
									// Solid's For finishes disposing the old
									// child; `events[vItem.index]` may also be
									// undefined when the new events array is
									// shorter than the old virtual-items array.
									// The outer Show guards rendering against
									// both; inside its callback we get a stable
									// non-null accessor for the row's event.
									let itemRef: HTMLDivElement | undefined;
									return (
										<Show when={vItem ? events[vItem.index] : undefined}>
											{(event) => (
												<div
													style={{
														position: "absolute",
														top: 0,
														left: 0,
														width: "100%",
														transform: `translateY(${vItem.start}px)`,
													}}
													data-index={vItem.index}
													ref={(el) => {
														itemRef = el;
														// In Solid the JSX `data-index={vItem.index}`
														// attribute is set via a reactive effect that
														// runs *after* this ref callback, so at this
														// point the element has no `data-index` yet.
														// virtual-core's `indexFromElement` then
														// returns -1 (silently) and every row in the
														// same render batch collides on key=-1 in
														// `elementsCache`, cascade-unobserving each
														// other. Set the attribute synchronously here
														// so `measureElement` reads the right index
														// before invoking `observer.observe(el)`.
														el.setAttribute("data-index", String(vItem.index));
														virtualizer.measureElement(el);
													}}
												>
													<TimelineItem
														event={event()}
														showHeader={shouldShowHeader(events, vItem.index)}
														isOwnMessage={event().senderId === myUserId}
														onReact={(key) => onReact(event().eventId, key)}
														onReply={() => setReplyTo(event())}
														onEdit={() => onEdit(event())}
														onDelete={() => onDelete(event().eventId)}
														onRetry={() => onRetry(event().eventId)}
														onDiscard={() => cancelPending(event().eventId)}
														onCancel={() => cancelPending(event().eventId)}
														onRetryRedaction={() =>
															onRetryRedaction(event().eventId)
														}
														onDiscardRedaction={() =>
															onDiscardRedaction(event().eventId)
														}
														pendingRedactionStatus={
															pendingRedactions[event().eventId]?.status
														}
														onImageLoad={() => {
															if (itemRef) virtualizer.measureElement(itemRef);
														}}
														readReceipts={receipts()[event().eventId]}
														client={client}
														shortcodeLookup={shortcodeLookup()}
														emoteLookup={emoteLookup()}
														onOpenReactionPicker={() => {
															setReactionPickerEventId(event().eventId);
															requestAnimationFrame(() => {
																if (itemRef)
																	virtualizer.measureElement(itemRef);
															});
														}}
													/>
													<Show
														when={reactionPickerEventId() === event().eventId}
													>
														<div class="ml-11 mt-1 mb-1">
															<EmojiPicker
																packs={packs()}
																onSelect={(item) =>
																	onReactionPickerSelect(
																		event().eventId,
																		item,
																		itemRef,
																	)
																}
																onClose={() => {
																	setReactionPickerEventId(null);
																	requestAnimationFrame(() => {
																		if (itemRef)
																			virtualizer.measureElement(itemRef);
																		scrollRef?.focus();
																	});
																}}
															/>
														</div>
													</Show>
												</div>
											)}
										</Show>
									);
								}}
							</For>
						</div>
						{/* Loading newer messages indicator */}
						<Show when={loadingNewer()}>
							<div
								class="flex justify-center py-3"
								role="status"
								aria-live="polite"
							>
								<span class="sr-only">Loading newer messages</span>
								<div
									class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover"
									aria-hidden="true"
								/>
							</div>
						</Show>
						{/* Manual load button for newer messages */}
						<Show when={!loadingNewer() && canLoadNewer()}>
							<div class="flex justify-center py-3">
								<button
									type="button"
									class="rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis"
									onClick={() => {
										// Content will be appended below the user's current
										// position, so they won't be at bottom after the load.
										// Clear stale atBottom to prevent the followingLive and
										// read-receipt effects from firing prematurely when
										// canLoadNewer flips to false on the final page.
										setAtBottom(false);
										loadNewerMessages();
									}}
								>
									Load newer messages
								</button>
							</div>
						</Show>
					</div>

					{/* Scroll-to-bottom / Jump to latest button.
					     Show when scrolled up OR when behind live (even at
					     bottom of current slice, so jump-to-live is reachable). */}
					<Show when={!atBottom() || canLoadNewer()}>
						<button
							type="button"
							class="absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-full bg-surface-3 px-3 py-2 text-text-secondary shadow-lg transition-colors hover:bg-surface-4"
							onClick={() => {
								if (canLoadNewer()) {
									// Ensure atBottom is true so that when jumpToLive
									// clears canLoadNewer, the followingLive effect
									// sees [true, false] and confirms followingLive
									// instead of seeing [false, false] and reverting it.
									setAtBottom(true);
									jumpToLive();
								} else {
									const el = scrollRef;
									if (el)
										el.scrollTo({
											top: el.scrollHeight,
											behavior: "smooth",
										});
								}
							}}
							aria-label={
								canLoadNewer() ? "Jump to latest messages" : "Scroll to bottom"
							}
						>
							<Show when={canLoadNewer()}>
								<span class="text-xs">New messages</span>
							</Show>
							<span>↓</span>
						</button>
					</Show>
				</div>
			</Show>

			{/* Typing indicator */}
			<Show when={typingText()}>
				<div
					class="shrink-0 px-4 py-1 text-xs text-text-disabled"
					aria-live="polite"
				>
					{typingText()}
				</div>
			</Show>

			{/* Composer */}
			<Composer
				roomId={props.roomId}
				replyTo={replyTo()}
				editingEvent={editingEvent()}
				onCancelReply={() => setReplyTo(null)}
				onCancelEdit={() => setEditingEvent(null)}
				onSent={() => {
					setReplyTo(null);
					setEditingEvent(null);
				}}
				packs={packs()}
			/>
		</main>
	);
};

export { TimelineView };
