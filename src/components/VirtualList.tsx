import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	on,
	onCleanup,
	onMount,
	Show,
	splitProps,
	untrack,
} from "solid-js";

/** A fixed pitch for every row, or a per-row height by index. */
export type RowHeight = number | ((index: number) => number);

/**
 * Prefix sum of row heights: `offsets[i]` is the top edge of row `i`, and
 * `offsets[count]` is the total content height. Length is `count + 1`.
 */
export function computeRowOffsets(
	count: number,
	rowHeight: RowHeight,
): number[] {
	const offsets = new Array<number>(count + 1);
	offsets[0] = 0;
	for (let i = 0; i < count; i++) {
		const h = typeof rowHeight === "number" ? rowHeight : rowHeight(i);
		offsets[i + 1] = offsets[i] + h;
	}
	return offsets;
}

/** Largest `i` in `[0, n]` with `offsets[i] <= target` (binary search). */
function lastAtOrBelow(offsets: number[], target: number, n: number): number {
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= target) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Clamp a raw `[first, last)` row pair into the final window: grow by
 * `overscan`, keep at least one row, bound to `[0, count]`. The single home
 * of the window-boundary invariant, shared by both offset paths.
 */
function clampRowRange(
	count: number,
	first: number,
	last: number,
	overscan: number,
): [number, number] {
	return [
		Math.max(0, first - overscan),
		Math.min(count, Math.max(last, first + 1) + overscan),
	];
}

/** Smallest `i` in `[0, n]` with `offsets[i] >= target` (binary search). */
function firstAtOrAbove(offsets: number[], target: number, n: number): number {
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid] >= target) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * The `[first, last)` row range overlapping `[scrollTop, scrollTop + viewportH]`,
 * grown by `overscan` rows each side and clamped to `[0, count]`. Pure so the
 * boundary math can be unit-tested without a DOM.
 */
export function visibleRowRange(
	offsets: number[],
	scrollTop: number,
	viewportH: number,
	overscan: number,
): [number, number] {
	const count = offsets.length - 1;
	if (count <= 0) return [0, 0];
	const first = lastAtOrBelow(offsets, scrollTop, count);
	// firstAtOrAbove gives the first row starting at/after the viewport bottom;
	// that row is exclusive, and it's already the count of overlapping rows.
	const last = firstAtOrAbove(offsets, scrollTop + viewportH, count);
	return clampRowRange(count, first, last, overscan);
}

/**
 * `visibleRowRange` for a uniform row height, in O(1) with no offsets
 * array. Must stay boundary-identical to running `visibleRowRange` over
 * `computeRowOffsets(count, rowHeight)` - a property test locks the two
 * together.
 */
export function uniformVisibleRowRange(
	count: number,
	rowHeight: number,
	scrollTop: number,
	viewportH: number,
	overscan: number,
): [number, number] {
	if (count <= 0 || rowHeight <= 0) return [0, 0];
	// floor/ceil mirror lastAtOrBelow / firstAtOrAbove on the prefix sums.
	const first = Math.min(count, Math.floor(scrollTop / rowHeight));
	const last = Math.min(count, Math.ceil((scrollTop + viewportH) / rowHeight));
	return clampRowRange(count, first, last, overscan);
}

/** Imperative surface handed to the `controller` callback. */
export interface VirtualListController {
	/**
	 * Scroll the given row into view (`scrollIntoView({block: "nearest"})`
	 * semantics: no-op when fully visible, otherwise the minimal scroll).
	 * Unlike setting `scrollTop` directly, this also updates the row window
	 * synchronously - programmatic scrolls fire the `scroll` event a frame
	 * late (never in jsdom), and callers like a listbox's active-descendant
	 * tracking need the target row mounted before the next DOM read.
	 */
	scrollToIndex(index: number): void;
	/**
	 * The currently mounted `[first, last)` row range (overscan included).
	 * A reactive read: calling it inside a computation subscribes to window
	 * shifts - intended for consumers that must know whether a given row is
	 * mounted (e.g. an aria-activedescendant that may not reference an
	 * unmounted element).
	 */
	mountedRange(): [number, number];
}

interface VirtualListProps<T>
	extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "children"> {
	/** The rows to render. */
	each: readonly T[];
	/**
	 * Row height in px - either a uniform number, or a `(index) => number` for
	 * known-variable rows (e.g. media tiles whose dimensions come from
	 * metadata). Heights must be knowable without measuring the DOM.
	 */
	rowHeight: RowHeight;
	/** Rows rendered above/below the viewport to hide scroll seams. Default 3. */
	overscan?: number;
	/**
	 * When this value changes, the list scrolls back to the top. Pass the key
	 * that identifies the current dataset (e.g. the active tab/query) so a
	 * retained scroll offset from a longer list can't strand a shorter one.
	 */
	resetKey?: unknown;
	/** Rendered instead of the list when `each` is empty. */
	fallback?: JSX.Element;
	/**
	 * Called on mount with the imperative API (e.g. `scrollToIndex`), and on
	 * cleanup with `undefined` - holders must drop the reference rather than
	 * keep calling into a disposed instance (whose reactive reads are frozen
	 * and whose element is detached).
	 */
	controller?: (api: VirtualListController | undefined) => void;
	children: (item: T, index: Accessor<number>) => JSX.Element;
}

/**
 * A minimal windowing list for uniform- or known-variable-height rows. Only the
 * rows overlapping the viewport (plus overscan) are mounted; a full-height
 * spacer keeps the scrollbar accurate.
 *
 * It owns its scroll container and reads `scrollTop`/`clientHeight` straight
 * from that element, re-measuring via a `ResizeObserver`. That makes it robust
 * to mounting inside a popover/dialog that lays out at zero height and grows a
 * frame later - a case where auto-measuring virtualization libraries render
 * nothing. Extra DOM/aria attributes are forwarded to the scroll container.
 *
 * Row heights must be knowable up front (a number or from item metadata). For
 * rows whose height is only known after layout (measured masonry), this is the
 * wrong tool.
 */
/** Invoke a Solid event-handler prop in either its function or bound-array form. */
function callEventHandler(
	handler: JSX.EventHandlerUnion<HTMLDivElement, Event> | undefined,
	event: Event & { currentTarget: HTMLDivElement; target: Element },
): void {
	if (!handler) return;
	if (typeof handler === "function") handler(event);
	else handler[0](handler[1], event);
}

export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
	// ref/onScroll are pulled out and MERGED (not overridden) with the internal
	// handlers, so a caller can still observe scroll (e.g. GifPicker's infinite
	// scroll) or grab the element without breaking measurement/windowing.
	const [local, rest] = splitProps(props, [
		"each",
		"rowHeight",
		"overscan",
		"resetKey",
		"fallback",
		"controller",
		"children",
		"onScroll",
		"ref",
	]);

	let scrollRef: HTMLDivElement | undefined;
	const [scrollTop, setScrollTop] = createSignal(0);
	const [viewportH, setViewportH] = createSignal(0);
	// Top padding on the scroll container offsets the content below the scroll
	// origin; subtract it so the row window lines up with the real geometry
	// (otherwise a caller with overscan 0 can drop a still-visible edge row).
	const [padTop, setPadTop] = createSignal(0);
	const overscan = (): number => local.overscan ?? 3;

	// Row count as its own memo: the uniform-height geometry below (range,
	// totalHeight) keys on it, so a filtering caller re-minting a
	// same-length array per keystroke doesn't retrigger that math. The
	// per-row offsets memo deliberately keys on the array identity instead -
	// see its comment.
	const count = createMemo(() => local.each.length);
	// The prop compiles to a getter that re-evaluates the caller's
	// expression on every access; memoized so a caller computing the height
	// (e.g. RoomList's getComputedStyle-derived rem pitch) pays once, not
	// on every scroll tick through the range memo below.
	const rowHeight = createMemo(() => local.rowHeight);
	// Prefix sums for per-row heights; `null` for a uniform height, where
	// offsets are `i * rowHeight` in O(1) and rebuilding an O(n) array as a
	// filtered list changes length on each keystroke would be pure waste.
	// The non-numeric branch reads `local.each` (not `count()`) on purpose:
	// a height callback may derive from item metadata, so a same-length
	// `each` swap must still rebuild the sums.
	const offsets = createMemo(() =>
		typeof rowHeight() === "number"
			? null
			: computeRowOffsets(
					local.each.length,
					rowHeight() as (i: number) => number,
				),
	);
	/** Top edge of row `i` (`i === count` gives the total content height). */
	const rowTop = (i: number): number => {
		const offs = offsets();
		return offs ? offs[i] : i * (rowHeight() as number);
	};
	const totalHeight = (): number => rowTop(count());

	onMount(() => {
		const el = scrollRef;
		if (!el) return;
		const measure = (): void => {
			setViewportH(el.clientHeight);
			setPadTop(Number.parseFloat(getComputedStyle(el).paddingTop) || 0);
		};
		measure();
		if (typeof ResizeObserver !== "undefined") {
			const ro = new ResizeObserver(measure);
			ro.observe(el);
			onCleanup(() => ro.disconnect());
		}
		local.controller?.({ scrollToIndex, mountedRange: range });
	});
	onCleanup(() => local.controller?.(undefined));

	// untrack: an imperative API must not subscribe its caller - a consumer
	// calling this from a createEffect would otherwise start tracking the
	// scroll position and re-assert the scroll on every user wheel/drag.
	// A scroll requested while the viewport still measures 0 (a popover that
	// lays out a frame after mounting - the case this component exists for)
	// can't be positioned yet; park it and re-assert once a height lands.
	// A call while `each` is empty is dropped instead of parked: an empty
	// list has no row to hold a position for, and a caller tracking its
	// items (like the Picker's highlight effect) re-asserts when they land.
	let pendingScrollIndex = -1;
	const scrollToIndex = (index: number): void =>
		untrack(() => {
			const el = scrollRef;
			const n = count();
			const vh = viewportH();
			if (!el || n === 0) return;
			if (vh <= 0) {
				pendingScrollIndex = index;
				return;
			}
			pendingScrollIndex = -1;
			const i = Math.max(0, Math.min(index, n - 1));
			const top = padTop() + rowTop(i);
			const bottom = padTop() + rowTop(i + 1);
			// Baseline on the DOM, not the internal signal: the browser clamps
			// scrollTop when the list shrinks under the current offset, and the
			// signal only learns that from the (async) scroll event.
			let target = el.scrollTop;
			if (top < target) target = top;
			// A fully visible row takes neither branch and never writes: the
			// clamp below excludes the container's bottom padding, so writing
			// an unchanged-in-intent target would nudge a list parked at its
			// true bottom up by that padding.
			else if (bottom > target + vh) target = bottom - vh;
			else return;
			// Clamp to the known geometry (bottom padding excluded - no target
			// above needs it), so a stale baseline can't park the window past
			// the real maximum scroll.
			target = Math.max(0, Math.min(target, padTop() + rowTop(n) - vh));
			if (target === el.scrollTop) return;
			el.scrollTop = target;
			// Read back rather than trusting the request: the browser clamps
			// writes computed from stale viewport measurements, and a clamped
			// write fires no scroll event to resync the signal.
			setScrollTop(el.scrollTop);
		});

	createEffect(() => {
		if (viewportH() > 0 && pendingScrollIndex >= 0) {
			const i = pendingScrollIndex;
			pendingScrollIndex = -1;
			scrollToIndex(i);
		}
	});

	createEffect(
		on(
			() => local.resetKey,
			() => {
				// A parked deferred scroll belonged to the previous dataset;
				// letting it fire would defeat the reset-to-top guarantee.
				pendingScrollIndex = -1;
				if (scrollRef) scrollRef.scrollTop = 0;
				setScrollTop(0);
			},
			{ defer: true },
		),
	);

	// Equality-guarded so it only notifies downstream when the window actually
	// shifts (crosses a row boundary), not on every scroll pixel - otherwise the
	// <For> below would tear down and rebuild every mounted row on each tick.
	const range = createMemo(
		(): [number, number] => {
			const offs = offsets();
			const st = Math.max(0, scrollTop() - padTop());
			return offs
				? visibleRowRange(offs, st, viewportH(), overscan())
				: uniformVisibleRowRange(
						count(),
						rowHeight() as number,
						st,
						viewportH(),
						overscan(),
					);
		},
		undefined,
		{ equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
	);

	// The stable item references for the current window. Sliced (not re-wrapped),
	// so <For>'s reference keying keeps unchanged rows mounted across a shift.
	const visibleItems = createMemo(() =>
		local.each.slice(range()[0], range()[1]),
	);

	return (
		<div
			{...rest}
			ref={(el) => {
				scrollRef = el;
				const forwarded = local.ref;
				if (typeof forwarded === "function") {
					(forwarded as (el: HTMLDivElement) => void)(el);
				}
			}}
			onScroll={(e) => {
				setScrollTop(e.currentTarget.scrollTop);
				callEventHandler(local.onScroll, e);
			}}
		>
			<Show when={local.each.length > 0} fallback={local.fallback}>
				{/* role="presentation": when the scroll container carries a
				    composite role (e.g. the Picker's listbox), these layout
				    wrappers must not break the owned-children chain between
				    it and the role="option" rows - AT that walks owned
				    children would otherwise see a listbox of generic divs. */}
				<div role="presentation" style={{ height: `${totalHeight()}px` }}>
					<div
						role="presentation"
						style={{ transform: `translateY(${rowTop(range()[0])}px)` }}
					>
						<For each={visibleItems()}>
							{(item, i) => local.children(item, () => range()[0] + i())}
						</For>
					</div>
				</div>
			</Show>
		</div>
	);
}
