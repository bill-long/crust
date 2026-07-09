import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useConfig } from "../../app/ConfigProvider";
import { VirtualList } from "../../components/VirtualList";
import { userSettings } from "../../stores/settings";
import { createGifProvider } from "./provider";
import type { GifItem, GifProvider as GifProviderType } from "./types";

const DEBOUNCE_MS = 350;
const PAGE_SIZE = 25;
/** 2-column grid; GAP is the `gap-1` gutter (also the inter-row gap). */
const COLS = 2;
const GAP = 4;
/** (320px w-80 - 8 padding - 4 gutter) / 2, used until the scroller is measured. */
const DEFAULT_COL_WIDTH = 154;

const GifPicker: Component<{
	onSelect: (gif: GifItem) => void;
	/** Called when picker should close. focusTrigger=true for keyboard/select closes. */
	onClose: (focusTrigger: boolean) => void;
	/** The trigger element — excluded from outside-click detection. */
	triggerRef?: HTMLElement;
}> = (props) => {
	const config = useConfig();

	const provider = createMemo(() => createGifProvider(config.gif));

	const [query, setQuery] = createSignal("");
	const [items, setItems] = createSignal<GifItem[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [hasMore, setHasMore] = createSignal(false);
	const [nextOffset, setNextOffset] = createSignal(0);
	const [error, setError] = createSignal<string | null>(null);
	// Bumped only when a new search actually dispatches (not per keystroke), so
	// VirtualList's resetKey scrolls to the top for a genuinely new result set.
	const [resetToken, setResetToken] = createSignal(0);

	let searchRef: HTMLInputElement | undefined;
	let scrollRef: HTMLDivElement | undefined;
	let pickerRef: HTMLElement | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	// Generation counter to discard stale responses
	let fetchGen = 0;

	// Outside-click handler
	let mounted = true;
	function onDocumentClick(e: MouseEvent) {
		const target = e.target as Node;
		if (pickerRef && !pickerRef.contains(target)) {
			// Don't close if the click is on the trigger button (toggle handles it)
			if (props.triggerRef?.contains(target)) return;
			props.onClose(false); // Outside click — don't steal focus
		}
	}

	// Defer listener so the opening click doesn't immediately close
	const rafId = requestAnimationFrame(() => {
		if (mounted) {
			document.addEventListener("mousedown", onDocumentClick);
		}
	});

	onCleanup(() => {
		mounted = false;
		cancelAnimationFrame(rafId);
		document.removeEventListener("mousedown", onDocumentClick);
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
	});

	async function doFetch(
		p: GifProviderType,
		q: string,
		offset: number,
		append: boolean,
	) {
		const gen = ++fetchGen;
		setLoading(true);
		setError(null);
		try {
			if (!q.trim()) {
				// Empty query — show trending if configured, otherwise clear
				if (!config.gif.trendingOnOpen) {
					if (gen !== fetchGen) return;
					setItems([]);
					setHasMore(false);
					setNextOffset(0);
					return;
				}
				const result = await p.trending(
					config.gif.maxRating,
					offset,
					PAGE_SIZE,
				);
				if (gen !== fetchGen) return;
				if (append) {
					setItems((prev) => [...prev, ...result.items]);
				} else {
					setItems(result.items);
				}
				setHasMore(result.hasMore);
				setNextOffset(result.nextOffset);
			} else {
				const result = await p.search(
					q.trim(),
					config.gif.maxRating,
					offset,
					PAGE_SIZE,
				);
				if (gen !== fetchGen) return;
				if (append) {
					setItems((prev) => [...prev, ...result.items]);
				} else {
					setItems(result.items);
				}
				setHasMore(result.hasMore);
				setNextOffset(result.nextOffset);
			}
		} catch (e) {
			if (gen !== fetchGen) return;
			setError(e instanceof Error ? e.message : "Failed to load GIFs");
		} finally {
			if (gen === fetchGen) setLoading(false);
		}
	}

	// Initial load: trending on open (if configured)
	createEffect(() => {
		const p = provider();
		if (config.gif.trendingOnOpen) {
			doFetch(p, "", 0, false);
		}
	});

	// Debounced search — defer: true skips the initial run so we don't
	// duplicate the trending fetch or fire when trendingOnOpen is false
	createEffect(
		on(
			query,
			(q) => {
				if (debounceTimer !== undefined) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					// Bump before the fetch so VirtualList's resetKey scrolls the new
					// results to the top (a new query, not an append).
					setResetToken((n) => n + 1);
					doFetch(provider(), q, 0, false);
				}, DEBOUNCE_MS);
			},
			{ defer: true },
		),
	);

	function loadMore() {
		if (loading() || !hasMore()) return;
		doFetch(provider(), query(), nextOffset(), true);
	}

	function onScroll(e: Event) {
		const el = e.target as HTMLDivElement;
		// Load more when within 200px of bottom
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
			loadMore();
		}
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			props.onClose(true); // Keyboard close — return focus to trigger
		}
	}

	// Focus search on mount
	createEffect(() => {
		requestAnimationFrame(() => searchRef?.focus());
	});

	const attr = createMemo(() => provider().attribution);

	// Bucketed rows for VirtualList. Reuse the previous row array whenever its
	// items are unchanged (by reference) so pagination - which appends items and
	// leaves earlier rows intact - keeps stable row identities; otherwise
	// VirtualList's reference-keyed <For> would remount every visible tile and
	// re-decode its GIF on each page append.
	let prevRows: GifItem[][] = [];
	const rows = createMemo<GifItem[][]>(() => {
		const list = items();
		const next: GifItem[][] = [];
		for (let i = 0; i < list.length; i += COLS) {
			const slice = list.slice(i, i + COLS);
			const prev = prevRows[next.length];
			const same =
				prev?.length === slice.length &&
				prev.every((gif, j) => gif === slice[j]);
			next.push(same ? prev : slice);
		}
		prevRows = next;
		return next;
	});

	// Column width is measured from the scroller (it shrinks when a scrollbar
	// appears), so row heights - derived from each tile's known aspect ratio -
	// track the real layout. Reactive: reading colWidth() in rowContentHeight
	// makes VirtualList's offsets and the row markup recompute on resize.
	const [colWidth, setColWidth] = createSignal(DEFAULT_COL_WIDTH);

	/** Rendered height (px) of a row: the taller of its tiles at the column width. */
	function rowContentHeight(row: GifItem[]): number {
		const cw = colWidth();
		let max = 0;
		for (const gif of row) {
			// Fall back to a square tile if a provider omits usable dimensions.
			const h =
				gif.width > 0 && gif.height > 0 ? (cw * gif.height) / gif.width : cw;
			if (h > max) max = h;
		}
		return Math.round(max);
	}

	/** Row pitch for VirtualList = content height + the inter-row gap. */
	function rowPitch(index: number): number {
		const row = rows()[index];
		return row ? rowContentHeight(row) + GAP : 0;
	}

	function measureColumns(): void {
		if (!scrollRef) return;
		// Read the scroller's actual horizontal padding rather than assuming the
		// `p-1` utility, so column width stays correct if the padding changes.
		const cs = getComputedStyle(scrollRef);
		const padX =
			(Number.parseFloat(cs.paddingLeft) || 0) +
			(Number.parseFloat(cs.paddingRight) || 0);
		const cw = (scrollRef.clientWidth - padX - (COLS - 1) * GAP) / COLS;
		if (cw > 0) setColWidth(cw);
	}

	onMount(() => {
		measureColumns();
		if (scrollRef && typeof ResizeObserver !== "undefined") {
			const ro = new ResizeObserver(measureColumns);
			ro.observe(scrollRef);
			onCleanup(() => ro.disconnect());
		}
	});

	return (
		<section
			ref={pickerRef}
			class="flex h-[400px] w-80 flex-col overflow-hidden rounded-lg border border-border-default bg-surface-2 shadow-xl"
			onKeyDown={onKeyDown}
			aria-label="GIF picker"
		>
			{/* Search input */}
			<div class="border-b border-border-default p-2">
				<input
					ref={searchRef}
					type="text"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					placeholder={attr().searchPlaceholder}
					aria-label={attr().searchPlaceholder}
					class="w-full rounded bg-surface-1 px-3 py-1.5 text-sm text-text-emphasis placeholder:text-text-disabled focus:outline-none focus:ring-1 focus:ring-accent-hover"
				/>
			</div>

			{/* Grid area (windowed rows of 2). Relative so the pagination
				indicator can overlay without disturbing the scroll geometry. */}
			<div class="relative flex min-h-0 flex-1 flex-col">
				{/* Prominent error banner: a failed search must not be missed while
					stale results stay on screen. */}
				<Show when={error()}>
					<div
						role="alert"
						class="border-b border-danger/30 bg-danger-bg/30 px-3 py-2 text-center text-sm text-danger-text"
					>
						{error()}
					</div>
				</Show>
				<VirtualList
					ref={(el: HTMLDivElement) => {
						scrollRef = el;
					}}
					each={rows()}
					rowHeight={rowPitch}
					resetKey={resetToken()}
					onScroll={onScroll}
					class="min-h-0 flex-1 overflow-y-auto p-1"
					fallback={
						<Show
							when={loading()}
							fallback={
								// The error banner above covers the error case.
								<Show when={!error()}>
									<p class="p-4 text-center text-sm text-text-disabled">
										{query().trim() ? "No GIFs found" : "Search for GIFs"}
									</p>
								</Show>
							}
						>
							<div class="flex justify-center py-4">
								<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-strong border-t-accent-hover" />
							</div>
						</Show>
					}
				>
					{(row) => {
						const height = createMemo(() => rowContentHeight(row));
						return (
							<div style={{ height: `${height() + GAP}px` }}>
								<div
									class="grid grid-cols-2 gap-1"
									style={{ height: `${height()}px` }}
								>
									<For each={row}>
										{(gif) => {
											// Trim so a whitespace-only title doesn't become an
											// empty accessible name or a blank hover overlay.
											const title = gif.title?.trim() ?? "";
											return (
												<button
													type="button"
													class="group relative h-full overflow-hidden rounded bg-surface-1 transition-transform hover:scale-[1.02] focus:outline-none focus:ring-1 focus:ring-accent-hover"
													onClick={() => props.onSelect(gif)}
													aria-label={title || "GIF"}
												>
													<img
														src={
															userSettings().autoDownloadGifs
																? gif.previewUrl
																: gif.stillUrl
														}
														alt={title || "GIF"}
														class="h-full w-full object-cover"
														loading="lazy"
														referrerPolicy="no-referrer"
													/>
													<Show when={title}>
														<div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface-0/70 to-transparent px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100">
															<p class="truncate text-[10px] text-text-primary">
																{title}
															</p>
														</div>
													</Show>
												</button>
											);
										}}
									</For>
								</div>
							</div>
						);
					}}
				</VirtualList>

				{/* Pagination spinner overlaid at the bottom so it stays outside the
					windowed content (only while more pages are loading). */}
				<Show when={items().length > 0 && loading()}>
					<div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-surface-2 to-transparent py-2">
						<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-strong border-t-accent-hover" />
					</div>
				</Show>
			</div>

			{/* Attribution footer — required by provider TOS */}
			<div class="flex items-center justify-center gap-1.5 border-t border-border-default px-2 py-1.5">
				<span class="text-[10px] text-text-disabled">Powered by</span>
				<a
					href={attr().url}
					target="_blank"
					rel="noopener noreferrer"
					class="text-xs font-semibold text-text-muted transition-colors hover:text-text-emphasis"
				>
					{attr().name}
				</a>
			</div>
		</section>
	);
};

export { GifPicker };
