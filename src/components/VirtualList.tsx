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
	return [
		Math.max(0, first - overscan),
		Math.min(count, Math.max(last, first + 1) + overscan),
	];
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

	// Recomputed only when the data or row sizing changes - not on scroll.
	const offsets = createMemo(() =>
		computeRowOffsets(local.each.length, local.rowHeight),
	);
	const totalHeight = (): number => offsets()[local.each.length];

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
	});

	createEffect(
		on(
			() => local.resetKey,
			() => {
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
		(): [number, number] =>
			visibleRowRange(
				offsets(),
				Math.max(0, scrollTop() - padTop()),
				viewportH(),
				overscan(),
			),
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
				<div style={{ height: `${totalHeight()}px` }}>
					<div style={{ transform: `translateY(${offsets()[range()[0]]}px)` }}>
						<For each={visibleItems()}>
							{(item, i) => local.children(item, () => range()[0] + i())}
						</For>
					</div>
				</div>
			</Show>
		</div>
	);
}
