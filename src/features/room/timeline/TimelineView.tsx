import { createVirtualizer } from "@tanstack/solid-virtual";
import { EventType, ReceiptType, RelationType, RoomEvent } from "matrix-js-sdk";
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
import EmojiPicker from "../../emoji/EmojiPicker";
import type { PickerEmoji } from "../../emoji/types";
import {
	buildEmoteLookup,
	buildShortcodeLookup,
	useImagePacks,
} from "../../emoji/useImagePacks";
import Composer from "../composer/Composer";
import TimelineItem from "./TimelineItem";
import { type TimelineEvent, useTimeline } from "./useTimeline";

interface ReadReceiptEntry {
	userId: string;
	displayName: string;
}

const TimelineView: Component<{ roomId: string }> = (props) => {
	const { client, summaries } = useClient();
	const { events, loading, typingUsers, getSourceEvent } = useTimeline(
		client,
		() => props.roomId,
	);

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

	const myUserId = client.getUserId() ?? "";

	const roomName = () => {
		const s = summaries[props.roomId];
		return s?.name?.trim() || "Room";
	};

	const virtualizer = createVirtualizer({
		get count() {
			return events.length;
		},
		getScrollElement: () => scrollRef ?? null,
		estimateSize: () => 60,
		overscan: 10,
		getItemKey: (index: number) => events[index]?.eventId ?? index,
	});

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

		const timelineEvents = room.getLiveTimeline().getEvents();
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
		const lastEvent = events[events.length - 1];
		if (!lastEvent || lastEvent.eventId === lastSentReceiptEventId) return;
		const room = client.getRoom(props.roomId);
		if (!room) return;
		const matrixEvent = room
			.getLiveTimeline()
			.getEvents()
			.find((e) => e.getId() === lastEvent.eventId);
		if (!matrixEvent) return;
		const eventId = lastEvent.eventId;
		client
			.sendReadReceipt(matrixEvent, ReceiptType.Read)
			.then(() => {
				lastSentReceiptEventId = eventId;
			})
			.catch(() => {
				// Best-effort; receipt will retry on next scroll/event
			});
	}

	// Send receipt when new events arrive while at bottom
	createEffect(
		on(
			() => events.length,
			() => sendReadReceipt(),
		),
	);

	// Send receipt when user scrolls to bottom
	createEffect(
		on(atBottom, (isAtBottom) => {
			if (isAtBottom) sendReadReceipt();
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
				requestAnimationFrame(() => {
					const el = scrollRef;
					if (el) el.scrollTo({ top: el.scrollHeight });
				});
			},
		),
	);

	// Auto-scroll to bottom when new messages arrive and user is at bottom
	createEffect(
		on(
			() => events.length,
			() => {
				if (atBottom() && scrollRef) {
					requestAnimationFrame(() => {
						const el = scrollRef;
						if (el) el.scrollTo({ top: el.scrollHeight });
					});
				}
			},
		),
	);

	const onScroll = (): void => {
		if (!scrollRef) return;
		const threshold = 50;
		const distFromBottom =
			scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
		setAtBottom(distFromBottom < threshold);
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

	const onReactionPickerSelect = (eventId: string, item: PickerEmoji): void => {
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
			{/* Room header */}
			<div class="flex h-12 shrink-0 items-center border-b border-neutral-800 px-4">
				<span class="text-sm font-semibold text-neutral-200">{roomName()}</span>
			</div>

			{/* Timeline */}
			<Show
				when={!loading()}
				fallback={
					<div class="flex flex-1 items-center justify-center">
						<div class="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-pink-500" />
					</div>
				}
			>
				<div class="relative min-h-0 flex-1">
					<div
						ref={scrollRef}
						class="absolute inset-0 overflow-y-auto"
						onScroll={onScroll}
					>
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								position: "relative",
								width: "100%",
							}}
						>
							<For each={virtualizer.getVirtualItems()}>
								{(vItem) => {
									const event = () => events[vItem.index];
									let itemRef: HTMLDivElement | undefined;
									return (
										<Show when={event()}>
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
													virtualizer.measureElement(el);
												}}
											>
												<TimelineItem
													event={event()}
													isOwnMessage={event().senderId === myUserId}
													onReact={(key) => onReact(event().eventId, key)}
													onReply={() => setReplyTo(event())}
													onEdit={() => onEdit(event())}
													onDelete={() => onDelete(event().eventId)}
													onImageLoad={() => {
														if (itemRef) virtualizer.measureElement(itemRef);
													}}
													readReceipts={receipts()[event().eventId]}
													client={client}
													shortcodeLookup={shortcodeLookup()}
													emoteLookup={emoteLookup()}
													onOpenReactionPicker={() =>
														setReactionPickerEventId(event().eventId)
													}
												/>
												<Show
													when={reactionPickerEventId() === event().eventId}
												>
													<div class="ml-11 mt-1 mb-1">
														<EmojiPicker
															packs={packs()}
															onSelect={(item) =>
																onReactionPickerSelect(event().eventId, item)
															}
															onClose={() => setReactionPickerEventId(null)}
														/>
													</div>
												</Show>
											</div>
										</Show>
									);
								}}
							</For>
						</div>
					</div>

					{/* Scroll-to-bottom button */}
					<Show when={!atBottom()}>
						<button
							type="button"
							class="absolute bottom-4 right-4 z-10 rounded-full bg-neutral-700 p-2 text-neutral-300 shadow-lg transition-colors hover:bg-neutral-600"
							onClick={() => {
								const el = scrollRef;
								if (el)
									el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
							}}
							aria-label="Scroll to bottom"
						>
							↓
						</button>
					</Show>
				</div>
			</Show>

			{/* Typing indicator */}
			<Show when={typingText()}>
				<div
					class="shrink-0 px-4 py-1 text-xs text-neutral-500"
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

export default TimelineView;
