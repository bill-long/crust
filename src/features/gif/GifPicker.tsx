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
import { useConfig } from "../../app/ConfigProvider";
import { userSettings } from "../../stores/settings";
import { createGifProvider } from "./provider";
import type { GifItem, GifProvider as GifProviderType } from "./types";

const DEBOUNCE_MS = 350;
const PAGE_SIZE = 25;

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
					doFetch(provider(), q, 0, false);
					if (scrollRef) scrollRef.scrollTop = 0;
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

	return (
		<section
			ref={pickerRef}
			class="flex h-[400px] w-80 flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-800 shadow-xl"
			onKeyDown={onKeyDown}
			aria-label="GIF picker"
		>
			{/* Search input */}
			<div class="border-b border-neutral-700 p-2">
				<input
					ref={searchRef}
					type="text"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					placeholder={attr().searchPlaceholder}
					aria-label={attr().searchPlaceholder}
					class="w-full rounded bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-pink-500"
				/>
			</div>

			{/* Grid area */}
			<div
				ref={scrollRef}
				class="flex-1 overflow-y-auto p-1"
				onScroll={onScroll}
			>
				<Show when={error()}>
					<div class="p-4 text-center text-sm text-red-400">{error()}</div>
				</Show>

				<Show when={items().length > 0}>
					<div class="grid grid-cols-2 gap-1">
						<For each={items()}>
							{(gif) => (
								<button
									type="button"
									class="group relative overflow-hidden rounded bg-neutral-900 transition-transform hover:scale-[1.02] focus:outline-none focus:ring-1 focus:ring-pink-500"
									style={{
										"aspect-ratio": `${gif.width} / ${gif.height}`,
									}}
									onClick={() => props.onSelect(gif)}
									aria-label={gif.title || "GIF"}
								>
									<img
										src={
											userSettings().autoDownloadGifs
												? gif.previewUrl
												: gif.stillUrl
										}
										alt={gif.title || "GIF"}
										class="h-full w-full object-cover"
										loading="lazy"
									/>
									<Show when={gif.title}>
										<div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100">
											<p class="truncate text-[10px] text-white">{gif.title}</p>
										</div>
									</Show>
								</button>
							)}
						</For>
					</div>
				</Show>

				<Show when={loading()}>
					<div class="flex justify-center py-4">
						<div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-600 border-t-pink-500" />
					</div>
				</Show>

				<Show when={!loading() && items().length === 0 && !error()}>
					<p class="p-4 text-center text-sm text-neutral-500">
						{query().trim() ? "No GIFs found" : "Search for GIFs"}
					</p>
				</Show>
			</div>

			{/* Attribution footer — required by provider TOS */}
			<div class="flex items-center justify-center gap-1.5 border-t border-neutral-700 px-2 py-1.5">
				<span class="text-[10px] text-neutral-500">Powered by</span>
				<a
					href={attr().url}
					target="_blank"
					rel="noopener noreferrer"
					class="text-xs font-semibold text-neutral-400 transition-colors hover:text-neutral-200"
				>
					{attr().name}
				</a>
			</div>
		</section>
	);
};

export default GifPicker;
