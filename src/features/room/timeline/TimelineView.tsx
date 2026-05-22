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
	on,
	onCleanup,
	Show,
} from "solid-js";
import { Virtualizer } from "virtua/solid";
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
	// Signal mirror of scrollRef so effects depending on the element's
	// existence (e.g. the row-growth re-anchor RO below) can attach when
	// the parent <Show> finally mounts the scroller, rather than running
	// once during the loading fallback and bailing forever.
	const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
	const [atBottom, setAtBottom] = createSignal(true);
	// `wantsBottom` is the user's *intent* to stay anchored at the live
	// end, independent of the transient `atBottom` state. Programmatic
	// scrolls fire scroll events whose `distFromBottom` can be briefly
	// large while measurements settle, which would flip `atBottom` false
	// mid-settle and cause the auto-scroll effect to bail (#77 symptoms).
	// `wantsBottom` defaults true and is only cleared by a deliberate
	// upward user gesture (wheel up, ArrowUp/PageUp/Home).
	const [wantsBottom, setWantsBottom] = createSignal(true);
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

	// Virtua auto-measures rows via ResizeObserver and caches sizes by
	// data identity, so we no longer need estimate functions, manual
	// measure overrides, or the data-index ref hack. Backward-pagination
	// scroll preservation is handled by toggling the `shift` prop while
	// a load is in flight; live-end pinning is handled by the
	// `wantsBottom` settle loop driving the scroller directly.
	const [pagingOlder, setPagingOlder] = createSignal(false);

	// `startMargin` keeps Virtua's index/offset math correct when content
	// is rendered above it inside the same scroller (loading-older
	// spinner, "Load older messages" button, "Beginning of conversation"
	// marker). Without this, Virtua treats scrollTop=0 as the start of
	// its own item list — but actually scrollTop=0 is the top of the
	// above content, which shifts every item Virtua thinks it sees by
	// that height. The height is measured live via ResizeObserver so
	// transitions of the above content (e.g. spinner appearing during
	// back-pagination) stay in sync. The ref is signal-backed because
	// the parent <Show> may render its loading fallback on first run —
	// a non-reactive `let` ref would leave the observer permanently
	// detached after the scroll area finally mounts.
	const [topAreaEl, setTopAreaEl] = createSignal<HTMLDivElement>();
	const [topAreaHeight, setTopAreaHeight] = createSignal(0);
	createEffect(() => {
		const el = topAreaEl();
		if (!el) return;
		// Synchronous initial read so Virtua doesn't get one frame of
		// startMargin=0 before the ResizeObserver callback runs.
		setTopAreaHeight(el.getBoundingClientRect().height);
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setTopAreaHeight(entry.contentRect.height);
			}
		});
		ro.observe(el);
		onCleanup(() => ro.disconnect());
	});

	// Generation token for backward-pagination requests. Incremented on
	// every call and on room change so a stale `.finally()` from a prior
	// request (e.g. surviving an A→B→A switch) cannot clear pagingOlder
	// during a newer request still in flight, which would disable Virtua's
	// shift mid-prepend and cause a scroll jump.
	let pagingOlderToken = 0;

	// Wraps loadOlderMessages with the pagingOlder toggle Virtua's `shift`
	// prop reads to preserve scroll position when items are prepended.
	// All backward-pagination entry points (onScroll, auto-pagination,
	// manual button) must route through here — calling loadOlderMessages
	// directly bypasses the shift and re-introduces the scroll-jump bug.
	const paginateOlder = (): Promise<void> => {
		const token = ++pagingOlderToken;
		setPagingOlder(true);
		return loadOlderMessages().finally(() => {
			if (token === pagingOlderToken) setPagingOlder(false);
		});
	};

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

	// Programmatic-scroll grace window. The settle loop, new-message
	// pin RAF, and re-anchor RO all call scrollTo. Each one fires an
	// `onScroll` event whose distFromBottom is briefly large during the
	// transient before layout catches up. Without a grace window,
	// onScroll's "user scrolled away → clear wantsBottom" path would
	// fire on our own programmatic scrolls and immediately disable the
	// pin we just applied. Grace must cover smooth-scroll animations
	// (the bottom button uses behavior: "smooth") so the value is set
	// high enough to span the smooth animation duration.
	const PROGRAMMATIC_SCROLL_GRACE_MS = 250;
	let lastProgrammaticScrollAt = 0;
	const markProgrammaticScroll = (): void => {
		lastProgrammaticScrollAt = performance.now();
	};
	const inProgrammaticScrollGrace = (): boolean =>
		performance.now() - lastProgrammaticScrollAt < PROGRAMMATIC_SCROLL_GRACE_MS;

	// Pin the scroller to the live end via a settle loop that re-applies
	// scrollTop = scrollHeight each frame until layout stabilises (or
	// until the user clears `wantsBottom` by scrolling up). Direct
	// scrollTo on the scrollRef is preferred over imperative
	// scrollToIndex calls for the settle pattern because:
	//
	//  - the browser clamps scrollTop to scrollHeight − clientHeight, so
	//    "scroll to a number bigger than possible" is a self-correcting
	//    no-op once layout is final;
	//  - Virtua's scrollToIndex computes against currently-measured
	//    sizes, so when rows grow after their first paint (avatars
	//    decoding, image loads, custom emoji metrics) "end" alignment
	//    lands short and would need a separate re-anchor mechanism;
	//  - the loop honours messages arriving during the settle (each
	//    tick re-reads scrollHeight), so late events still get pinned.
	//
	// The loop exits early when the user clears `wantsBottom`, or after
	// being stable at the bottom for STABLE_REQUIRED frames, or after
	// MAX_FRAMES if measurements keep shifting (defensive bound — avoids
	// pinning the main thread on a pathological room).
	const MAX_SETTLE_FRAMES = 60;
	// Separate budget for the pre-mount wait so a slow initial sync
	// doesn't eat into the settle budget once the scroller appears.
	// 30 frames (~500ms at 60fps) is generous — if the parent <Show>
	// takes longer than that to mount, layout has bigger problems.
	const MAX_MOUNT_FRAMES = 30;
	const STABLE_FRAMES_REQUIRED = 4;
	const settleAtBottom = (): void => {
		let stableFrames = 0;
		let mountFrames = 0;
		let settleFrames = 0;
		const tick = (): void => {
			if (!wantsBottom()) return;
			const el = scrollEl();
			if (!el?.isConnected) {
				// Scroller not mounted yet (parent <Show> still rendering its
				// loading fallback) — or briefly detached during a room
				// switch that unmounts and remounts the scroller. Retry up
				// to MAX_MOUNT_FRAMES so the room-entry pin survives a slow
				// initial sync.
				if (++mountFrames < MAX_MOUNT_FRAMES) requestAnimationFrame(tick);
				return;
			}
			const before = el.scrollTop;
			markProgrammaticScroll();
			el.scrollTo({ top: el.scrollHeight });
			const after = el.scrollTop;
			const dist = el.scrollHeight - after - el.clientHeight;
			if (dist < 1 && Math.abs(after - before) < 1) {
				stableFrames++;
				if (stableFrames >= STABLE_FRAMES_REQUIRED) return;
			} else {
				stableFrames = 0;
			}
			if (++settleFrames < MAX_SETTLE_FRAMES) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	};

	// Re-anchor to the bottom when content above grows while the user
	// wants to be at the live end. Virtua auto-measures rows via its own
	// ResizeObserver; when a row grows (a late image decode without
	// info.w/h, a custom emoji whose font metrics settle, an embed that
	// expands) Virtua's totalSize grows, the scroller's scrollHeight
	// grows, and — with overflow-anchor disabled — the user would drift
	// up by that amount. We observe direct children of the scroller so
	// any of them resizing re-pins us if intent says we belong at the
	// bottom. MutationObserver picks up later-added children (loading
	// spinners, manual newer/older buttons) so they don't escape the RO.
	createEffect(() => {
		const el = scrollEl();
		if (!el) return;
		const reanchor = (): void => {
			if (!wantsBottom() || canLoadNewer()) return;
			markProgrammaticScroll();
			el.scrollTo({ top: el.scrollHeight });
		};
		const ro = new ResizeObserver(reanchor);
		for (const child of Array.from(el.children)) {
			if (child instanceof HTMLElement) ro.observe(child);
		}
		const mo = new MutationObserver((mutations) => {
			for (const mut of mutations) {
				for (const node of Array.from(mut.addedNodes)) {
					if (node instanceof HTMLElement) ro.observe(node);
				}
			}
		});
		mo.observe(el, { childList: true });
		onCleanup(() => {
			ro.disconnect();
			mo.disconnect();
		});
	});

	// Reset scroll position and reply/edit state when switching rooms.
	// Bumping pagingOlderToken invalidates any in-flight backward
	// pagination from the previous room so its .finally() becomes a
	// no-op for pagingOlder cleanup (otherwise it could clear shift
	// during the new room's first prepend and cause a scroll jump).
	createEffect(
		on(
			() => props.roomId,
			() => {
				setAtBottom(true);
				setWantsBottom(true);
				setReplyTo(null);
				setEditingEvent(null);
				setReactionPickerEventId(null);
				pagingOlderToken++;
				setPagingOlder(false);
				settleAtBottom();
			},
		),
	);

	// Auto-scroll to bottom when new messages arrive and the user wants
	// to stay at the live end. Uses `wantsBottom` rather than `atBottom`
	// because the latter is transiently flipped false during programmatic
	// scroll settling. Suppressed when behind live (`canLoadNewer`) so
	// forward pagination via "Load newer messages" doesn't jump past the
	// loaded page.
	let bottomScrollRafPending = false;
	createEffect(
		on(
			() => events.length,
			(len) => {
				if (!wantsBottom() || canLoadNewer() || len === 0) return;
				if (bottomScrollRafPending) return;
				bottomScrollRafPending = true;
				requestAnimationFrame(() => {
					bottomScrollRafPending = false;
					if (!wantsBottom() || canLoadNewer() || !scrollRef) return;
					markProgrammaticScroll();
					scrollRef.scrollTo({ top: scrollRef.scrollHeight });
				});
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
						paginateOlder();
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

		// Reflect non-gesture user scrolling (touch, scrollbar drag) into
		// `wantsBottom`. Wheel and keyboard arrow gestures are handled
		// instantly by their own handlers; this path catches everything
		// else by treating any scroll-away-from-bottom outside the
		// programmatic grace as user intent. The grace window prevents
		// the settle loop and the bottom-pin RAF from clobbering their
		// own pins (each tick fires onScroll whose distFromBottom is
		// briefly large before layout catches up).
		if (!inProgrammaticScrollGrace()) {
			setWantsBottom(distFromBottom < threshold);
		}

		// Load older messages when scrolled near the top. Virtua's `shift`
		// prop preserves the user's viewport position when items prepend;
		// the paginateOlder() helper toggles it for the duration of the load.
		if (scrollRef.scrollTop < 200 && canLoadOlder() && !loadingOlder()) {
			paginateOlder();
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

	// Detect deliberate upward user gestures to clear `wantsBottom`. We
	// can't infer "user wants to scroll up" from `onScroll`'s
	// `distFromBottom` alone because the room-switch settle loop
	// transiently inflates that value too. These handlers are wired via
	// Solid's `on:wheel` / `on:keydown` namespace on the scroll container
	// below; that namespace attaches directly via addEventListener
	// (bypassing lint/a11y/noStaticElementInteractions, which fires on
	// onWheel/onKeyDown JSX props for non-button elements).
	const onUserWheel = (e: WheelEvent): void => {
		if (e.deltaY < 0) {
			setWantsBottom(false);
		} else if (e.deltaY > 0) {
			// Wheel-down all the way back to the live end re-arms intent.
			if (!scrollRef) return;
			const dist =
				scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
			if (dist < 50) setWantsBottom(true);
		}
	};
	const onUserKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
			setWantsBottom(false);
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
		_itemRef: HTMLDivElement | undefined,
	): void => {
		const key = item.kind === "custom" ? item.emote.mxcUrl : item.emoji.unicode;
		onReact(eventId, key);
		setReactionPickerEventId(null);
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
						ref={(el) => {
							// Solid's ref callbacks are not invoked with null on
							// unmount, so a `let` ref or signal would otherwise
							// retain a stale reference to a detached element
							// after the parent <Show> unmounts the scroller.
							// Clear both on cleanup so reactive effects re-run
							// and the settle loop's `.isConnected` check stays
							// in sync with reality.
							scrollRef = el;
							setScrollEl(el);
							onCleanup(() => {
								if (scrollRef === el) scrollRef = undefined;
								setScrollEl(undefined);
							});
						}}
						class="absolute inset-0 overflow-y-auto"
						style={{ "overflow-anchor": "none" }}
						onScroll={onScroll}
						on:wheel={onUserWheel}
						on:keydown={onUserKeyDown}
						tabIndex={-1}
					>
						{/* Content above the Virtualizer must be measured so its
						    height feeds Virtua's startMargin — otherwise Virtua's
						    scrollTop math is offset by this region's height. */}
						<div
							ref={(el) => {
								setTopAreaEl(el);
								onCleanup(() => setTopAreaEl(undefined));
							}}
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
										onClick={() => paginateOlder()}
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
						</div>
						<Virtualizer
							scrollRef={scrollRef}
							data={events}
							shift={pagingOlder()}
							startMargin={topAreaHeight()}
						>
							{(event, indexAcc) => (
								<div>
									<TimelineItem
										event={event}
										showHeader={shouldShowHeader(events, indexAcc())}
										isOwnMessage={event.senderId === myUserId}
										onReact={(key) => onReact(event.eventId, key)}
										onReply={() => setReplyTo(event)}
										onEdit={() => onEdit(event)}
										onDelete={() => onDelete(event.eventId)}
										onRetry={() => onRetry(event.eventId)}
										onDiscard={() => cancelPending(event.eventId)}
										onCancel={() => cancelPending(event.eventId)}
										onRetryRedaction={() => onRetryRedaction(event.eventId)}
										onDiscardRedaction={() => onDiscardRedaction(event.eventId)}
										pendingRedactionStatus={
											pendingRedactions[event.eventId]?.status
										}
										readReceipts={receipts()[event.eventId]}
										client={client}
										shortcodeLookup={shortcodeLookup()}
										emoteLookup={emoteLookup()}
										onOpenReactionPicker={() => {
											setReactionPickerEventId(event.eventId);
										}}
									/>
									<Show when={reactionPickerEventId() === event.eventId}>
										<div class="ml-11 mt-1 mb-1">
											<EmojiPicker
												packs={packs()}
												onSelect={(item) =>
													onReactionPickerSelect(event.eventId, item, undefined)
												}
												onClose={() => {
													setReactionPickerEventId(null);
													requestAnimationFrame(() => {
														scrollRef?.focus();
													});
												}}
											/>
										</div>
									</Show>
								</div>
							)}
						</Virtualizer>
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
								// User-initiated jump back to the live end re-arms
								// `wantsBottom` so the settle loop + new-message
								// effect resume pinning when fresh events arrive.
								setWantsBottom(true);
								if (canLoadNewer()) {
									// Ensure atBottom is true so that when jumpToLive
									// clears canLoadNewer, the followingLive effect
									// sees [true, false] and confirms followingLive
									// instead of seeing [false, false] and reverting it.
									setAtBottom(true);
									jumpToLive();
								} else {
									const el = scrollRef;
									if (el) {
										markProgrammaticScroll();
										el.scrollTo({
											top: el.scrollHeight,
											behavior: "smooth",
										});
									}
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
