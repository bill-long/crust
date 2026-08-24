import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	type JSX,
	on,
	Show,
	untrack,
} from "solid-js";
import { VirtualList, type VirtualListController } from "../VirtualList";

/**
 * `query` exists only to feed `filterFn`, so the pair is all-or-nothing at
 * the type level: omit both when `items` is already filtered (the list is
 * used as-is, instead of paying a second full pass with a constant-true
 * filter), or provide both to let the picker filter. Passing one without
 * the other doesn't type-check - a lone `filterFn` would silently run
 * against "" and a lone `query` would silently be ignored.
 */
type PickerFilterProps<T> =
	| { query: string; filterFn: (item: T, query: string) => boolean }
	| { query?: undefined; filterFn?: undefined };

export type PickerProps<T> = {
	items: T[];
	onSelect: (item: T) => void;
	onClose: () => void;
	renderItem: (item: T, isHighlighted: boolean) => JSX.Element;
	visible: boolean;
	position: { bottom: string; left: string };
} & PickerFilterProps<T>;

const ITEM_HEIGHT = 36;

/**
 * Generic filtered-list picker popover. Keyboard events must be forwarded
 * from the parent's onKeyDown via the returned `handlePickerKey` function.
 * The option list is windowed (VirtualList), so item sets well past the
 * visible ~6 rows stay cheap; the highlighted option is kept scrolled into
 * view (and therefore mounted) across keyboard moves and wrap-around.
 */
export function createPicker<T>() {
	let handleKey: ((e: KeyboardEvent) => boolean) | undefined;
	let activeDescendantRef: (() => string | undefined) | undefined;
	let expandedRef: (() => boolean) | undefined;
	const pickerId = createUniqueId();
	const listboxId = `picker-listbox-${pickerId}`;

	const Picker: Component<PickerProps<T>> = (props) => {
		const [highlightIndex, setHighlightIndex] = createSignal(0);
		// Imperative handle onto the windowed list. A signal (not a plain
		// let): consumers below re-evaluate when the <VirtualList> remounts
		// (it unmounts whenever the popover hides) and hands out a fresh api.
		const [listController, setListController] =
			createSignal<VirtualListController>();

		const filtered = createMemo(() => {
			const fn = props.filterFn;
			if (!fn) return props.items;
			return props.items.filter((item) => fn(item, props.query ?? ""));
		});

		// A fresh open starts back at the top - a highlight retained from the
		// previous session would point at an arbitrary (and, windowed, likely
		// unmounted) row.
		createEffect(
			on(
				() => props.visible,
				(visible, wasVisible) => {
					if (visible && !wasVisible) setHighlightIndex(0);
				},
				{ defer: true },
			),
		);

		// Clamp highlight index when the filtered list shrinks. filtered()
		// already tracks whatever query the consumer wires in, so its length
		// is the one dependency that matters.
		createEffect(
			on(
				() => filtered().length,
				(len) => setHighlightIndex((i) => Math.min(i, Math.max(0, len - 1))),
			),
		);

		// Keep the highlighted item scrolled into view. Synchronous through
		// the controller, so the row is mounted (and its aria-activedescendant
		// id resolvable) immediately after a keyboard move across the
		// windowed boundary. Keyed to the highlight, the controller (fresh on
		// each list mount), and visibility - deliberately NOT to filtered()'s
		// identity: items churn (keystrokes, member join/leave) must not yank
		// the viewport back to the highlight after the user scrolled away.
		createEffect(
			on(
				[highlightIndex, listController, () => props.visible] as const,
				([idx, controller, visible]) => {
					if (!visible || idx < 0) return;
					if (idx >= untrack(() => filtered().length)) return;
					controller?.scrollToIndex(idx);
				},
			),
		);

		const activeDescendant = () => {
			if (!props.visible) return undefined;
			const items = filtered();
			const idx = highlightIndex();
			if (idx < 0 || idx >= items.length) return undefined;
			// Only reference a row that is actually mounted: the user can
			// wheel-scroll the highlighted row out of the virtualized window
			// (unmounting it), and ARIA forbids referencing absent elements.
			// Sibling implementations of this invariant (rowEls-map flavor,
			// for lists that own their row elements): SearchPanel,
			// PinnedMessagesPanel, ThreadListPanel. Reading mountedRange here
			// is deliberate tracking - the id comes back when the row scrolls
			// back into the window.
			const range = listController()?.mountedRange();
			if (range && (idx < range[0] || idx >= range[1])) return undefined;
			return `${listboxId}-item-${idx}`;
		};

		activeDescendantRef = activeDescendant;
		expandedRef = () => props.visible && filtered().length > 0;

		// Returns true if the event was handled (consumed)
		handleKey = (e: KeyboardEvent): boolean => {
			if (!props.visible) return false;
			const items = filtered();
			if (items.length === 0) {
				if (e.key === "Escape") {
					e.preventDefault();
					props.onClose();
					return true;
				}
				return false;
			}

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlightIndex((i) => (i + 1) % items.length);
				return true;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlightIndex((i) => (i - 1 + items.length) % items.length);
				return true;
			}
			if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
				e.preventDefault();
				const idx = highlightIndex();
				if (idx >= 0 && idx < items.length) {
					props.onSelect(items[idx]);
				}
				return true;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				props.onClose();
				return true;
			}
			return false;
		};

		return (
			<Show when={props.visible && filtered().length > 0}>
				<VirtualList
					id={listboxId}
					each={filtered()}
					rowHeight={ITEM_HEIGHT}
					controller={(api) => setListController(() => api)}
					class="absolute z-20 max-h-[216px] w-64 overflow-y-auto rounded-lg border border-border-default bg-surface-2 py-1 shadow-lg"
					style={{
						bottom: props.position.bottom,
						left: props.position.left,
					}}
					role="listbox"
					aria-label="Suggestions"
					tabIndex={-1}
				>
					{(item, index) => {
						const isHighlighted = () => index() === highlightIndex();
						return (
							<div
								id={`${listboxId}-item-${index()}`}
								role="option"
								aria-selected={isHighlighted()}
								// Windowing keeps only ~a dozen options in the DOM;
								// setsize/posinset tell assistive tech the real set
								// ("n of 500"), which ARIA requires exactly when not
								// all set members are present.
								aria-setsize={filtered().length}
								aria-posinset={index() + 1}
								tabIndex={-1}
								class={`cursor-pointer px-3 py-1.5 text-sm ${
									isHighlighted()
										? "bg-mention-bg/40 text-text-primary"
										: "text-text-secondary hover:bg-surface-3"
								}`}
								style={{ height: `${ITEM_HEIGHT}px` }}
								onMouseDown={(e) => {
									e.preventDefault();
									props.onSelect(item);
								}}
								onMouseEnter={() => setHighlightIndex(index())}
							>
								{props.renderItem(item, isHighlighted())}
							</div>
						);
					}}
				</VirtualList>
			</Show>
		);
	};

	/**
	 * Forward keyboard events from the parent's onKeyDown.
	 * Returns true if the picker consumed the event.
	 */
	function handlePickerKey(e: KeyboardEvent): boolean {
		return handleKey ? handleKey(e) : false;
	}

	function getActiveDescendant(): string | undefined {
		return activeDescendantRef ? activeDescendantRef() : undefined;
	}

	/** Whether the listbox is currently rendered (visible with matches). */
	function getExpanded(): boolean {
		return expandedRef ? expandedRef() : false;
	}

	return {
		Picker,
		handlePickerKey,
		getActiveDescendant,
		getExpanded,
		listboxId,
	};
}
