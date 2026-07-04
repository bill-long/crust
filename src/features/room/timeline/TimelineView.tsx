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
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { Virtualizer, type VirtualizerHandle } from "virtua/solid";
import { useClient } from "../../../client/client";
import type { ImagePack } from "../../emoji/types";
import {
	buildEmoteLookup,
	buildShortcodeLookup,
	useImagePacks,
} from "../../emoji/useImagePacks";
import { Composer } from "../composer/Composer";
import { composerTextareaSelector } from "../composer/composerTextarea";
import {
	mainTimelineSource,
	threadTimelineSource,
} from "../threads/timelineSource";
import {
	formatDateSeparatorLabel,
	isDifferentDay,
	isSameDay,
	useDayTick,
} from "./dateFormatting";
import { GroupedMembershipNotice } from "./GroupedMembershipNotice";
import { ImageLightbox, type LightboxImage } from "./ImageLightbox";
import {
	computeMembershipGroups,
	type MembershipGroup,
} from "./membershipGrouping";
import { TimelineItem } from "./TimelineItem";
import { type TimelineEvent, useTimeline } from "./useTimeline";

const MESSAGE_GROUP_GAP_MS = 7 * 60 * 1000; // 7 minutes

/** Whether a message should show the full header (avatar + name + time). */
function shouldShowHeader(
	events: readonly TimelineEvent[],
	index: number,
): boolean {
	const curr = events[index];
	if (!curr) return true;
	// State notices render as a compact one-liner without an avatar or
	// header — and a regular message immediately after a notice should
	// always show its own header so the grouping doesn't span the
	// notice.
	if (curr.stateNotice) return false;
	if (index === 0) return true;
	const prev = events[index - 1];
	if (!prev) return true;
	if (prev.stateNotice) return true;
	if (prev.senderId !== curr.senderId) return true;
	if (curr.timestamp - prev.timestamp > MESSAGE_GROUP_GAP_MS) return true;
	// Break group on day boundary so the date separator can land cleanly
	// between the two halves.
	if (!isSameDay(prev.timestamp, curr.timestamp)) return true;
	return false;
}

/**
 * Whether to render a date separator above this message. True at the
 * top of the loaded timeline, and whenever the message is the first
 * one on a new calendar day.
 */
function shouldShowDateSeparator(
	events: readonly TimelineEvent[],
	index: number,
): boolean {
	if (index === 0) return true;
	const prev = events[index - 1];
	const curr = events[index];
	if (!prev || !curr) return false;
	return isDifferentDay(prev.timestamp, curr.timestamp);
}

interface ReadReceiptEntry {
	userId: string;
	displayName: string;
}

const TimelineView: Component<{
	roomId: string;
	canPin?: boolean;
	isPinned?: (eventId: string) => boolean;
	onTogglePin?: (eventId: string) => void;
	jumpRequest?: () => string | null;
	onJumpHandled?: () => void;
	/** Optional shared image packs accessor. When provided, TimelineView
	 *  reuses it instead of spinning up its own `useImagePacks` instance.
	 *  Lifting to the parent avoids duplicate SDK event subscriptions
	 *  (ClientEvent.AccountData + RoomStateEvent.Events) when sibling
	 *  components (e.g. PinnedMessagesPanel) also need the packs. */
	packs?: () => ImagePack[];
	/** Thread scope: when set, this instance windows the thread's timeline
	 *  (the thread panel) instead of the room's. Typing indicators are
	 *  room-level and therefore suppressed in a thread. */
	thread?: { threadId: string };
	/** Open the thread panel for a root event ("Open thread" affordances
	 *  on chips and the hover toolbar). Absent inside the panel itself. */
	onOpenThread?: (threadId: string) => void;
}> = (props) => {
	const { client } = useClient();
	// Memoized: useTimeline reads source() in hot per-event paths, so the
	// source object must be stable per thread change, not per call.
	const timelineSource = createMemo(() =>
		props.thread
			? threadTimelineSource(props.thread.threadId)
			: mainTimelineSource(),
	);
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
		jumpToEvent,
		pendingScrollToId,
		consumePendingScrollToId,
		setFollowingLive,
		typingUsers,
		getSourceEvent,
		getWindowEvents,
		pendingRedactions,
		pendingReactions,
		pendingEdits,
		votePoll,
		endPoll,
	} = useTimeline(client, () => props.roomId, {
		source: timelineSource,
	});

	// Custom emoji packs for this room. When the parent passes a shared
	// `packs` accessor (Layout does — same accessor also feeds the
	// pinned-messages panel), reuse it to avoid a duplicate
	// `useImagePacks` subscription per room. Tests render TimelineView
	// in isolation and rely on the fallback.
	const localPacks = props.packs
		? null
		: useImagePacks(client, () => props.roomId);
	const packs = createMemo(() =>
		props.packs ? props.packs() : (localPacks?.() ?? []),
	);
	const shortcodeLookup = createMemo(() => buildShortcodeLookup(packs()));
	const emoteLookup = createMemo(() => buildEmoteLookup(packs()));

	// Group consecutive same-kind membership transitions (join/leave/invite/
	// kick/ban) so a burst doesn't drown out real messages. Recomputed when
	// the loaded events change; expansion is tracked by member event ID so it
	// survives pagination (array indices shift, event IDs don't).
	const membershipGroups = createMemo(() => computeMembershipGroups(events));
	const [expandedMemberIds, setExpandedMemberIds] = createSignal<
		ReadonlySet<string>
	>(new Set());
	const isGroupExpanded = (group: MembershipGroup): boolean => {
		const set = expandedMemberIds();
		return group.memberEventIds.some((id) => set.has(id));
	};
	const expandGroup = (group: MembershipGroup): void => {
		setExpandedMemberIds((prev) => {
			const next = new Set(prev);
			for (const id of group.memberEventIds) next.add(id);
			return next;
		});
	};
	const collapseGroup = (group: MembershipGroup): void => {
		setExpandedMemberIds((prev) => {
			const next = new Set(prev);
			for (const id of group.memberEventIds) next.delete(id);
			return next;
		});
	};
	const groupMembers = (
		group: MembershipGroup,
	): { userId: string; name: string; avatarUrl: string | null }[] =>
		group.memberIndices.map((mi) => {
			const e = events[mi];
			const mt = e?.membershipTransition;
			return {
				userId: mt?.userId ?? e?.senderId ?? "",
				name: mt?.subject ?? e?.senderName ?? "",
				avatarUrl: mt?.avatarUrl ?? null,
			};
		});

	// Prune expansion state to event IDs still present in a current group.
	// Without this the Set would accumulate IDs forever as the user expands
	// groups and as events scroll out of the loaded window; it also clears
	// naturally on room switch (the events — and thus their IDs — change).
	createEffect(() => {
		const groups = membershipGroups();
		setExpandedMemberIds((prev) => {
			if (prev.size === 0) return prev;
			// The same group object repeats at every member index; add each
			// group's IDs once by visiting only its leader index.
			const present = new Set<string>();
			groups.forEach((g, i) => {
				if (g && g.leaderIndex === i) {
					for (const id of g.memberEventIds) present.add(id);
				}
			});
			let changed = false;
			const next = new Set<string>();
			for (const id of prev) {
				if (present.has(id)) next.add(id);
				else changed = true;
			}
			return changed ? next : prev;
		});
	});

	// Per-row "expanded" lookup, precomputed once per change of groups or
	// expansion state. Each group's membership IDs are scanned at most once
	// (visiting only the leader index), so the virtualizer render prop can
	// read O(1) per row instead of re-scanning the run for every member row.
	const expandedByIndex = createMemo<boolean[]>(() => {
		const groups = membershipGroups();
		const set = expandedMemberIds();
		const out = new Array<boolean>(groups.length).fill(false);
		groups.forEach((g, i) => {
			if (g && g.leaderIndex === i) {
				const expanded = g.memberEventIds.some((id) => set.has(id));
				if (expanded) for (const mi of g.memberIndices) out[mi] = true;
			}
		});
		return out;
	});

	// Reactive "now" that updates at local midnight so separator labels
	// like "Today" / "Yesterday" stay accurate for sessions left open
	// across a day boundary.
	const dayTick = useDayTick();

	let scrollRef: HTMLDivElement | undefined;
	let virtHandle: VirtualizerHandle | undefined;
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
	const [paginationStatus, setPaginationStatus] = createSignal("");

	// --- Drag-and-drop file attachments ---
	// The drop target is the whole room view, but the file queue lives in the
	// composer. The composer hands us its enqueue seam via `onEnqueueReady`;
	// dropped files go through the same path as paste / the attach button
	// (which gates encrypted rooms and edit mode in one place).
	const [isDraggingFiles, setIsDraggingFiles] = createSignal(false);
	// dragenter/dragleave fire per child element, so a boolean would flicker as
	// the cursor crosses internal boundaries. Track nesting depth instead.
	let dragDepth = 0;
	let enqueueFiles: ((files: Iterable<File>) => void) | undefined;

	// `dataTransfer.types` is a frozen string array; checked on every dragover,
	// so avoid allocating a copy per event.
	const dragHasFiles = (e: DragEvent): boolean =>
		!!e.dataTransfer && e.dataTransfer.types.includes("Files");

	const onDragEnter = (e: DragEvent): void => {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		dragDepth++;
		setIsDraggingFiles(true);
	};
	const onDragOver = (e: DragEvent): void => {
		if (!dragHasFiles(e)) return;
		// Required, or the browser treats the element as a non-drop-zone and
		// never fires `drop`.
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
	};
	const onDragLeave = (e: DragEvent): void => {
		if (!dragHasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) setIsDraggingFiles(false);
	};
	const onDrop = (e: DragEvent): void => {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		dragDepth = 0;
		setIsDraggingFiles(false);
		const files = e.dataTransfer?.files;
		if (files && files.length > 0) enqueueFiles?.(files);
	};

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

		// Build a set of displayable event IDs for quick lookup.
		// State-notice events (joins/leaves/name changes) are excluded so
		// receipts targeting them fall through to the nearest prior
		// message via the walk-backwards path below — otherwise the
		// "read by …" avatars would intermittently disappear whenever
		// membership churns.
		const displayableIds = new Set<string>();
		for (const ev of events) {
			if (ev.stateNotice) continue;
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
		// Sort each per-event receipt list by userId for stable ordering.
		// Per-event lists are typically <10 entries, so this is far cheaper
		// than sorting the full room member list (which can be 1000s) on
		// every receipt tick.
		for (const id in map) {
			map[id].sort((a, b) => a.userId.localeCompare(b.userId));
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
			// Main timeline: UNTHREADED (3rd arg true) - a plain receipt would
			// get thread_id "main" and clear only main-timeline counts, leaving
			// the per-thread counts the room badge sums un-clearable outside
			// the panel. Unthreaded preserves the pre-thread invariant that
			// reading a room clears its whole badge.
			// Thread panel: THREADED (3rd arg false) - the SDK derives
			// thread_id from the event, so reading a thread clears exactly that
			// thread's counts and never the whole room's read state.
			.sendReadReceipt(matrixEvent, ReceiptType.Read, !props.thread)
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
	// Set when we scroll the container while the tab is hidden (the live-append
	// pin's setTimeout path). A programmatic scroll performed while hidden takes
	// effect but fires NO scroll event until the tab is foregrounded - Chromium
	// ties scroll-event dispatch to frame production, which is paused while
	// hidden (verified empirically; the same reason rAF is paused). The deferred
	// scroll event then arrives long after the 250ms grace has expired, so
	// onScroll would misread our own hidden pin as a user scroll-away and clear
	// `wantsBottom`, silently dropping follow-live (issue #337 case 1).
	let hiddenProgrammaticScrollPending = false;
	const markProgrammaticScroll = (): void => {
		lastProgrammaticScrollAt = performance.now();
		if (typeof document !== "undefined" && document.hidden) {
			hiddenProgrammaticScrollPending = true;
		}
	};
	const inProgrammaticScrollGrace = (): boolean =>
		performance.now() - lastProgrammaticScrollAt < PROGRAMMATIC_SCROLL_GRACE_MS;

	// On foreground, if we scrolled the container while hidden, refresh the
	// grace window so the now-deferred scroll event from that hidden pin lands
	// inside it and isn't treated as a user gesture. This does NOT re-scroll -
	// the re-anchor ResizeObserver below still performs the actual re-pin when
	// grown rows remeasure on foreground - so it can't yank the view (the
	// failure mode an earlier foreground-re-pin attempt hit).
	//
	// Two accepted bounds, both narrow:
	//  - Ordering: this relies on visibilitychange firing before the browser
	//    replays the hidden pin's scroll event. That holds in Chromium (the
	//    only engine this hidden-tab path was verified against). If an engine
	//    delivered the scroll first, the grace would still be expired and
	//    follow-live would drop - i.e. it degrades to the pre-fix behaviour, no
	//    worse, never a new regression.
	//  - The refresh reuses the shared 250ms grace, so for up to 250ms after
	//    foreground a genuine touch / scrollbar-drag scroll-away is read as
	//    programmatic and won't clear `wantsBottom`. This is the same trade-off
	//    the grace already makes after every programmatic scroll; it self-
	//    corrects on the next scroll event, only bites when a hidden pin armed
	//    the flag, and wheel/keyboard gestures are unaffected (they clear
	//    `wantsBottom` via their own handlers, not onScroll).
	if (typeof document !== "undefined") {
		const onVisibleReconcilePin = (): void => {
			if (document.visibilityState !== "visible") return;
			if (!hiddenProgrammaticScrollPending) return;
			hiddenProgrammaticScrollPending = false;
			markProgrammaticScroll();
		};
		document.addEventListener("visibilitychange", onVisibleReconcilePin);
		onCleanup(() =>
			document.removeEventListener("visibilitychange", onVisibleReconcilePin),
		);
	}

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
	// Frame scheduler for the live-append pin that survives a hidden tab. The
	// browser pauses `requestAnimationFrame` entirely while the document is
	// hidden, which used to strand a live append below the fold until reload
	// (see #324). `setTimeout` still fires while hidden (throttled to ~1s,
	// which is fine - nobody is watching), so fall back to it. Returns a
	// cancel fn the pin uses to drop a still-pending frame on unmount. Only
	// the live pin needs the hidden-tab fallback; the room-entry settle loop
	// below stays on raw rAF, which correctly idles while hidden (no invisible
	// scroll-settling churn) and resumes on foreground.
	const scheduleFrame = (cb: () => void): (() => void) => {
		if (typeof document !== "undefined" && document.hidden) {
			const id = window.setTimeout(cb, 16);
			return () => window.clearTimeout(id);
		}
		const id = requestAnimationFrame(cb);
		return () => cancelAnimationFrame(id);
	};
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
				for (const node of Array.from(mut.removedNodes)) {
					if (node instanceof HTMLElement) ro.unobserve(node);
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
				// Cancel any live-append pin scheduled at the previous room's
				// bottom. Today `RoomPane` keys `TimelineView` on roomId, so a
				// room switch remounts this component and `onCleanup` already
				// drops the pin - this call is a no-op (cancelPin === null) in
				// that path. It exists so the pin can't fire a stale scrollTo
				// against the new room's scroller if the instance is ever
				// reused across a switch (issue #337 case 2).
				cancelPin?.();
				cancelPin = null;
				setAtBottom(true);
				setWantsBottom(true);
				setReplyTo(null);
				setEditingEvent(null);
				// Clear any in-progress drag overlay so a drag that started in the
				// previous room doesn't leave a stuck overlay on the new one.
				setIsDraggingFiles(false);
				dragDepth = 0;
				pagingOlderToken++;
				setPagingOlder(false);
				settleAtBottom();
			},
		),
	);

	// Jump-to-event integration with the pinned-messages panel (and any
	// other deep-link-style navigation). The parent (`Layout`) owns the
	// request signal so the panel — which lives in the header — can
	// drive the timeline below it.
	createEffect(
		on(
			() => props.jumpRequest?.(),
			(id) => {
				if (!id) return;
				// User wants to anchor on a historical message — cancel any
				// pending bottom pin so the settle loop doesn't fight the
				// scroll, then run the load.
				setWantsBottom(false);
				void jumpToEvent(id);
				props.onJumpHandled?.();
			},
		),
	);

	// When useTimeline reports a pending scroll target, find the row in
	// the events store, scrollToIndex on Virtua, then flash + focus the
	// DOM row. Runs on every events update so a late-arriving event
	// from the anchored window still lands the scroll.
	// Tracks the pending flash-pin removal timer so back-to-back jumps
	// (or unmount mid-flash) cancel the prior timer instead of leaving
	// it to fire on a detached node.
	let flashTimeoutId: number | undefined;
	let flashRaf1: number | undefined;
	let flashRaf2: number | undefined;
	// Track the element currently displaying the flash-pin class so we
	// can strip it when a new jump starts (otherwise the prior row's
	// class lingers indefinitely because the new jump clears the old
	// removal timeout before scheduling its own).
	let currentFlashEl: HTMLElement | undefined;
	const clearFlashClass = () => {
		if (currentFlashEl) {
			currentFlashEl.classList.remove("flash-pin");
			currentFlashEl = undefined;
		}
		if (flashTimeoutId !== undefined) {
			window.clearTimeout(flashTimeoutId);
			flashTimeoutId = undefined;
		}
	};
	const cancelPendingFlash = () => {
		if (flashRaf1 !== undefined) {
			cancelAnimationFrame(flashRaf1);
			flashRaf1 = undefined;
		}
		if (flashRaf2 !== undefined) {
			cancelAnimationFrame(flashRaf2);
			flashRaf2 = undefined;
		}
	};
	onCleanup(() => {
		clearFlashClass();
		cancelPendingFlash();
	});
	createEffect(() => {
		const id = pendingScrollToId();
		if (!id) return;
		// Cancel any prior in-flight rAF chain and strip the previous
		// row's flash-pin class *before* the early returns: a stale
		// chain could otherwise fire and consume a newer pending ID,
		// and the old row's class would linger because the timeout we
		// scheduled to remove it gets cancelled by the new jump.
		cancelPendingFlash();
		clearFlashClass();
		const idx = events.findIndex((e) => e.eventId === id);
		if (idx < 0) return;
		// If the target is hidden inside a collapsed membership group, expand
		// it first so the individual row exists and can be scrolled to/flashed.
		const targetGroup = membershipGroups()[idx];
		if (targetGroup && !isGroupExpanded(targetGroup)) {
			expandGroup(targetGroup);
		}
		const handle = virtHandle;
		if (!handle) return;
		markProgrammaticScroll();
		handle.scrollToIndex(idx, { align: "center" });
		// Wait two frames so Virtua has measured + scrolled the row
		// before we look it up in the DOM.
		flashRaf1 = requestAnimationFrame(() => {
			flashRaf1 = undefined;
			flashRaf2 = requestAnimationFrame(() => {
				flashRaf2 = undefined;
				const el = scrollRef?.querySelector<HTMLElement>(
					`[data-event-id="${CSS.escape(id)}"]`,
				);
				if (el) {
					el.classList.remove("flash-pin");
					// Force reflow so the animation restarts if the row was
					// already flashed once this session.
					void el.offsetWidth;
					el.classList.add("flash-pin");
					currentFlashEl = el;
					el.setAttribute("tabindex", "-1");
					// Don't steal focus from an interactive control the user
					// has since moved to (composer, another button, etc.).
					// Only grab focus if it's on body/null or still inside
					// the timeline scroll region.
					const active = document.activeElement;
					const safeToFocus =
						!active ||
						active === document.body ||
						(scrollRef ? scrollRef.contains(active) : false);
					if (safeToFocus) {
						el.focus({ preventScroll: true });
					}
					if (flashTimeoutId !== undefined) {
						window.clearTimeout(flashTimeoutId);
					}
					flashTimeoutId = window.setTimeout(() => {
						flashTimeoutId = undefined;
						el.classList.remove("flash-pin");
						if (currentFlashEl === el) currentFlashEl = undefined;
					}, 1800);
				}
				// Only consume if the pending ID is still ours; a newer
				// jumpToEvent may have set a different target while our
				// rAF chain was queued.
				if (pendingScrollToId() === id) {
					consumePendingScrollToId();
				}
			});
		});
	});

	// Auto-scroll to bottom when new messages arrive and the user wants
	// to stay at the live end. Uses `wantsBottom` rather than `atBottom`
	// because the latter is transiently flipped false during programmatic
	// scroll settling. Suppressed when behind live (`canLoadNewer`) so
	// forward pagination via "Load newer messages" doesn't jump past the
	// loaded page. A single deferred scroll (not a settle loop) - late row
	// growth is re-pinned by the re-anchor ResizeObserver above (which also
	// covers a hidden-tab pin that scrolled short before virtua remeasured the
	// row: the row grows on foreground and the observer re-pins), so one
	// scrollTo per arrival is enough and avoids refreshing the grace window.
	//
	// Coalescing (not cancel-and-reschedule): while a pin is already pending we
	// leave it, so a burst of arrivals faster than one frame still fires it
	// promptly (it re-reads scrollHeight when it runs) instead of being pushed
	// out one frame per arrival and starving. `scheduleFrame` runs it via
	// setTimeout while the tab is hidden (rAF is paused there - the #324 bug);
	// a pin scheduled as rAF just before the tab hides simply resumes on
	// foreground. The pin re-checks its gates at fire time because
	// `canLoadNewer` can flip during the deferral.
	let cancelPin: (() => void) | null = null;
	const schedulePin = (): void => {
		if (cancelPin) return;
		cancelPin = scheduleFrame(() => {
			cancelPin = null;
			if (!wantsBottom() || canLoadNewer() || !scrollRef) return;
			markProgrammaticScroll();
			scrollRef.scrollTo({ top: scrollRef.scrollHeight });
		});
	};
	createEffect(
		on(
			() => events.length,
			(len) => {
				if (!wantsBottom() || canLoadNewer() || len === 0) return;
				schedulePin();
			},
		),
	);
	onCleanup(() => cancelPin?.());

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

	// threadId for the SDK's 3-arg overloads: in a thread panel the local
	// echo only gets its thread association (setThread) when a threadId is
	// passed - without it the echo lives in no timeline set and this
	// hook's acceptsEvent gate rejects it, so reactions/redactions would
	// show no optimistic update inside the panel.
	const sendThreadId = (): string | null => props.thread?.threadId ?? null;

	const onReact = async (eventId: string, key: string): Promise<void> => {
		const ev = events.find((e) => e.eventId === eventId);
		if (!ev) return;

		const existingId = Object.hasOwn(ev.myReactions, key)
			? ev.myReactions[key]
			: undefined;
		try {
			if (existingId) {
				await client.redactEvent(props.roomId, sendThreadId(), existingId);
			} else {
				await client.sendEvent(
					props.roomId,
					sendThreadId(),
					EventType.Reaction,
					{
						"m.relates_to": {
							rel_type: RelationType.Annotation,
							event_id: eventId,
							key,
						},
					},
				);
			}
		} catch (e) {
			console.error("Reaction failed:", e);
		}
	};

	const onDelete = async (eventId: string): Promise<void> => {
		try {
			await client.redactEvent(props.roomId, sendThreadId(), eventId);
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
				composerTextareaSelector(props.thread?.threadId),
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
	 * Abort a pending redaction echo (whether in-flight QUEUED /
	 * ENCRYPTING or failed NOT_SENT). Both Cancel (in-flight overlay)
	 * and Discard (failed banner) call this — `cancelPendingEvent`
	 * triggers the SDK's `unmarkLocallyRedacted`, which restores the
	 * target's content, and the `_removed` Timeline handler in
	 * `useTimeline` clears the pending overlay and re-renders the row.
	 */
	const abortPendingRedaction = (targetId: string): void => {
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

	/**
	 * Retry the most-recent failed reaction echo for `(targetId, key)`.
	 * Earlier failed echoes for the same key stay in the pending store
	 * until the user discards (or their own retry/cancel transitions
	 * clean them up). Resending replays the SDK's pending-event queue,
	 * which fires `LocalEchoUpdated(SENDING)` and pops the echo out of
	 * `pendingReactions` via the per-event lifecycle.
	 */
	const onRetryReaction = async (
		targetId: string,
		key: string,
	): Promise<void> => {
		const arr = pendingReactions[targetId]?.[key];
		if (!arr || arr.length === 0) return;
		const room = client.getRoom(props.roomId);
		if (!room) return;
		const last = arr[arr.length - 1];
		if (last.status !== EventStatus.NOT_SENT) return;
		const originalRoomId = props.roomId;
		try {
			await client.resendEvent(last, room);
		} catch (e) {
			console.error("resendEvent (reaction) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/**
	 * Discard every failed reaction echo for `(targetId, key)`. Each
	 * cancel is wrapped in its own try/catch + status guard so one
	 * SDK throw (e.g. an echo whose status raced past NOT_SENT) does
	 * not strand the rest. The SDK's `_removed` Timeline path and
	 * `LocalEchoUpdated(CANCELLED)` both clear the store entries.
	 */
	const onDiscardReaction = (targetId: string, key: string): void => {
		const arr = pendingReactions[targetId]?.[key];
		if (!arr || arr.length === 0) return;
		const originalRoomId = props.roomId;
		// Snapshot before iterating — the store mutates underneath us as
		// each cancel fires its synchronous lifecycle events.
		const snapshot = [...arr];
		for (const ev of snapshot) {
			if (ev.status !== EventStatus.NOT_SENT) continue;
			try {
				client.cancelPendingEvent(ev);
			} catch (e) {
				console.error("cancelPendingEvent (reaction) failed:", e);
			}
		}
		focusComposer(originalRoomId);
	};

	/** Retry the most-recent failed edit echo for `targetId`. */
	const onRetryEdit = async (targetId: string): Promise<void> => {
		const arr = pendingEdits[targetId];
		if (!arr || arr.length === 0) return;
		const room = client.getRoom(props.roomId);
		if (!room) return;
		const last = arr[arr.length - 1];
		if (last.status !== EventStatus.NOT_SENT) return;
		const originalRoomId = props.roomId;
		try {
			await client.resendEvent(last, room);
		} catch (e) {
			console.error("resendEvent (edit) failed:", e);
		} finally {
			focusComposer(originalRoomId);
		}
	};

	/** Discard every failed edit echo for `targetId`. */
	const onDiscardEdit = (targetId: string): void => {
		const arr = pendingEdits[targetId];
		if (!arr || arr.length === 0) return;
		const originalRoomId = props.roomId;
		const snapshot = [...arr];
		for (const ev of snapshot) {
			if (ev.status !== EventStatus.NOT_SENT) continue;
			try {
				client.cancelPendingEvent(ev);
			} catch (e) {
				console.error("cancelPendingEvent (edit) failed:", e);
			}
		}
		focusComposer(originalRoomId);
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

	// ─── Image lightbox ─────────────────────────────────────────────
	// Gallery is built from confirmed (status === null) m.image events
	// only. Pending / failed local echoes are excluded because their
	// event id can re-key on confirmation, which would orphan the open
	// lightbox descriptor.
	const [lightboxEventId, setLightboxEventId] = createSignal<string | null>(
		null,
	);
	const imageGallery = createMemo<TimelineEvent[]>(() =>
		events.filter(
			(e) => e.msgtype === "m.image" && e.status === null && !!e.mediaFullUrl,
		),
	);
	const lightboxIndex = createMemo<number>(() => {
		const id = lightboxEventId();
		if (!id) return -1;
		return imageGallery().findIndex((e) => e.eventId === id);
	});
	const lightboxOpen = (): boolean => lightboxEventId() !== null;
	// Auto-close if the currently open image disappears from the list
	// (redacted, paged out, room switched, status flipped, etc.).
	createEffect(() => {
		if (lightboxEventId() !== null && lightboxIndex() === -1) {
			setLightboxEventId(null);
		}
	});
	const currentLightboxImage = createMemo<LightboxImage | null>(() => {
		const idx = lightboxIndex();
		if (idx < 0) return null;
		const e = imageGallery()[idx];
		if (!e?.mediaFullUrl) return null;
		return {
			eventId: e.eventId,
			fullUrl: e.mediaFullUrl,
			mimetype: e.mediaMimetype,
			size: e.mediaSize,
			filename: e.mediaFilename,
			width: e.mediaWidth,
			height: e.mediaHeight,
			senderName: e.senderName,
			timestamp: e.timestamp,
			isEncrypted: e.mediaIsEncrypted,
			encryptedFile: e.mediaEncryptedFile,
		};
	});
	const hasPrev = (): boolean => lightboxIndex() > 0;
	const hasNext = (): boolean => {
		const idx = lightboxIndex();
		return idx >= 0 && idx < imageGallery().length - 1;
	};
	const goPrev = (): void => {
		const idx = lightboxIndex();
		if (idx > 0) setLightboxEventId(imageGallery()[idx - 1].eventId);
	};
	const goNext = (): void => {
		const idx = lightboxIndex();
		const g = imageGallery();
		if (idx >= 0 && idx < g.length - 1) {
			setLightboxEventId(g[idx + 1].eventId);
		}
	};

	return (
		<main
			class="relative flex h-full flex-col"
			on:dragenter={onDragEnter}
			on:dragover={onDragOver}
			on:dragleave={onDragLeave}
			on:drop={onDrop}
		>
			{/* Drag-over overlay. `pointer-events-none` is essential: it keeps the
			    overlay from becoming the drag target, so crossing onto it doesn't
			    fire a dragleave on the content below and flicker the overlay. The
			    drop still bubbles up to <main> from the child under the cursor. */}
			<Show when={isDraggingFiles()}>
				<div
					class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-surface-1/80"
					aria-hidden="true"
				>
					<div class="rounded-xl border-2 border-dashed border-accent-hover bg-surface-2/90 px-8 py-6 text-sm font-medium text-text-emphasis shadow-lg">
						Drop files to upload
					</div>
				</div>
			</Show>
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
						data-testid="timeline-scroller"
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
								<div class="py-3 text-center text-xs text-text-disabled">
									Beginning of conversation
								</div>
							</Show>
						</div>
						<Virtualizer
							ref={(h) => {
								virtHandle = h ?? undefined;
							}}
							scrollRef={scrollRef}
							data={events}
							shift={pagingOlder()}
							startMargin={topAreaHeight()}
						>
							{(event, indexAcc) => {
								// Membership-group state for this row. Plain functions
								// (not memos) so no per-row computation owner is needed
								// inside virtua's render prop; reads still track the
								// underlying signals.
								const group = (): MembershipGroup | null =>
									membershipGroups()[indexAcc()] ?? null;
								// O(1) per-row expansion lookup (precomputed memo).
								const expanded = (): boolean =>
									expandedByIndex()[indexAcc()] ?? false;
								const mode = (): "item" | "summary" | "hidden" => {
									const g = group();
									if (!g || expanded()) return "item";
									return g.leaderIndex === indexAcc() ? "summary" : "hidden";
								};
								const showCollapseControl = (): boolean => {
									const g = group();
									return (
										!!g &&
										expanded() &&
										g.memberIndices[g.memberIndices.length - 1] === indexAcc()
									);
								};
								return (
									<div>
										<Show when={shouldShowDateSeparator(events, indexAcc())}>
											<div class="flex items-center gap-3 px-4 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-text-muted uppercase select-none">
												<div
													class="h-px flex-1 bg-border-default"
													aria-hidden="true"
												/>
												<span>
													{formatDateSeparatorLabel(event.timestamp, dayTick())}
												</span>
												<div
													class="h-px flex-1 bg-border-default"
													aria-hidden="true"
												/>
											</div>
										</Show>
										<Switch>
											<Match when={mode() === "summary"}>
												<GroupedMembershipNotice
													members={
														group()
															? groupMembers(group() as MembershipGroup)
															: []
													}
													kind={group()?.kind ?? "join"}
													leaderEventId={event.eventId}
													timestamp={event.timestamp}
													onExpand={() => {
														const g = group();
														if (g) expandGroup(g);
													}}
												/>
											</Match>
											{/* Collapsed non-leader member: a zero-height anchor
											    that keeps the 1:1 event↔row mapping (so indices,
											    pagination shift, and jump-to-event by
											    data-event-id all stay intact). */}
											<Match when={mode() === "hidden"}>
												<div data-event-id={event.eventId} />
											</Match>
											<Match when={mode() === "item"}>
												<TimelineItem
													event={event}
													showHeader={shouldShowHeader(events, indexAcc())}
													isOwnMessage={event.senderId === myUserId}
													canPin={props.canPin}
													isPinned={props.isPinned?.(event.eventId) ?? false}
													onTogglePin={() => props.onTogglePin?.(event.eventId)}
													onReact={(key) => onReact(event.eventId, key)}
													onVote={(answerIds) =>
														void votePoll(event.eventId, answerIds)
													}
													onEndPoll={() => void endPoll(event.eventId)}
													onOpenThread={props.onOpenThread}
													onReply={() => setReplyTo(event)}
													onJumpToReply={(id) => {
														setWantsBottom(false);
														void jumpToEvent(id);
													}}
													onEdit={() => onEdit(event)}
													onDelete={() => onDelete(event.eventId)}
													onRetry={() => onRetry(event.eventId)}
													onDiscard={() => cancelPending(event.eventId)}
													onCancel={() => cancelPending(event.eventId)}
													onRetryRedaction={() =>
														onRetryRedaction(event.eventId)
													}
													onDiscardRedaction={() =>
														abortPendingRedaction(event.eventId)
													}
													onCancelRedaction={() =>
														abortPendingRedaction(event.eventId)
													}
													pendingRedactionStatus={
														pendingRedactions[event.eventId]?.status
													}
													failedReactionKeys={Object.keys(
														pendingReactions[event.eventId] ?? {},
													)}
													onRetryReaction={(key) =>
														onRetryReaction(event.eventId, key)
													}
													onDiscardReaction={(key) =>
														onDiscardReaction(event.eventId, key)
													}
													failedEditAttempt={(() => {
														const arr = pendingEdits[event.eventId];
														if (!arr || arr.length === 0) return undefined;
														const last = arr[arr.length - 1];
														const newContent = last.getContent()?.[
															"m.new_content"
														] as { body?: unknown } | undefined;
														const body =
															typeof newContent?.body === "string"
																? newContent.body
																: "";
														// Replacement bodies sent by the composer carry
														// the "* " prefix on the wrapper `body` (Matrix
														// reply-fallback convention); `m.new_content`
														// carries the unprefixed text we want to show.
														return body;
													})()}
													onRetryEdit={() => onRetryEdit(event.eventId)}
													onDiscardEdit={() => onDiscardEdit(event.eventId)}
													readReceipts={receipts()[event.eventId]}
													client={client}
													shortcodeLookup={shortcodeLookup()}
													emoteLookup={emoteLookup()}
													packs={packs()}
													onOpenImage={setLightboxEventId}
												/>
												<Show when={showCollapseControl()}>
													<div class="flex items-center gap-3 px-4 py-0.5">
														<div class="w-8 shrink-0" aria-hidden="true" />
														<button
															type="button"
															aria-expanded="true"
															onClick={() => {
																const g = group();
																if (g) collapseGroup(g);
															}}
															class="rounded text-left text-xs text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:min-h-11"
														>
															Show less
														</button>
													</div>
												</Show>
											</Match>
										</Switch>
									</div>
								);
							}}
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
						{/* Bottom sentinel spacer so the last message's descenders
						    and media don't touch the composer's top divider.
						    Lives inside the scroller so scrollHeight-based
						    bottom-pin math (scrollTo({ top: scrollHeight }))
						    keeps working unchanged. */}
						<div class="h-2" aria-hidden="true" />
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

			{/* Typing indicator (room-level; meaningless inside a thread) */}
			<Show when={!props.thread && typingText()}>
				<div
					class="shrink-0 px-4 py-1 text-xs text-text-disabled"
					aria-live="polite"
				>
					{typingText()}
				</div>
			</Show>

			{/* Composer. In a thread panel it targets the thread (the SDK's
			    3-arg send overload builds the MSC3440 relation). */}
			<Composer
				roomId={props.roomId}
				threadRootId={props.thread?.threadId}
				replyTo={replyTo()}
				editingEvent={editingEvent()}
				onCancelReply={() => setReplyTo(null)}
				onCancelEdit={() => setEditingEvent(null)}
				onSent={() => {
					setReplyTo(null);
					setEditingEvent(null);
				}}
				onEnqueueReady={(fn) => {
					enqueueFiles = fn;
				}}
				packs={packs()}
			/>

			<ImageLightbox
				open={lightboxOpen}
				onClose={() => setLightboxEventId(null)}
				image={currentLightboxImage}
				onPrev={goPrev}
				onNext={goNext}
				hasPrev={hasPrev}
				hasNext={hasNext}
				fallbackFocus={() => scrollRef ?? null}
			/>
		</main>
	);
};

export { TimelineView };
