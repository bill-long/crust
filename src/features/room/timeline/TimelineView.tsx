import { createVirtualizer } from "@tanstack/solid-virtual";
import {
	type Component,
	createEffect,
	createSignal,
	For,
	on,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import TimelineItem from "./TimelineItem";
import { useTimeline } from "./useTimeline";

const TimelineView: Component<{ roomId: string }> = (props) => {
	const { client, summaries } = useClient();
	const { events, loading } = useTimeline(client, () => props.roomId);

	let scrollRef: HTMLDivElement | undefined;
	const [atBottom, setAtBottom] = createSignal(true);

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
	});

	// Reset scroll position when switching rooms
	createEffect(
		on(
			() => props.roomId,
			() => {
				setAtBottom(true);
				requestAnimationFrame(() => {
					scrollRef?.scrollTo({ top: scrollRef.scrollHeight });
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
						scrollRef?.scrollTo({
							top: scrollRef.scrollHeight,
						});
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

	return (
		<main class="relative flex h-full flex-col">
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
				<div ref={scrollRef} class="flex-1 overflow-y-auto" onScroll={onScroll}>
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
											ref={(el) => virtualizer.measureElement(el)}
										>
											<TimelineItem event={event()} />
										</div>
									</Show>
								);
							}}
						</For>
					</div>
				</div>

				{/* Scroll-to-bottom button */}
				<Show when={!atBottom()}>
					<div class="absolute bottom-4 right-4">
						<button
							type="button"
							class="rounded-full bg-neutral-700 p-2 text-neutral-300 shadow-lg transition-colors hover:bg-neutral-600"
							onClick={() =>
								scrollRef?.scrollTo({
									top: scrollRef.scrollHeight,
									behavior: "smooth",
								})
							}
							aria-label="Scroll to bottom"
						>
							↓
						</button>
					</div>
				</Show>
			</Show>
		</main>
	);
};

export default TimelineView;
