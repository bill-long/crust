import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	type JSX,
	on,
	Show,
} from "solid-js";
import { VirtualList, type VirtualListController } from "../VirtualList";

export interface PickerProps<T> {
	items: T[];
	onSelect: (item: T) => void;
	onClose: () => void;
	renderItem: (item: T, isHighlighted: boolean) => JSX.Element;
	visible: boolean;
	position: { bottom: string; left: string };
	/** Omit both when `items` is already filtered - the list is used as-is,
	    instead of paying a second full pass with a constant-true filter.
	    `query` only exists to feed `filterFn`, so they travel together. */
	query?: string;
	filterFn?: (item: T, query: string) => boolean;
}

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

		// Clamp highlight index when the filtered list shrinks
		createEffect(
			on(
				() => [props.query, filtered().length] as const,
				() =>
					setHighlightIndex((i) =>
						Math.min(i, Math.max(0, filtered().length - 1)),
					),
			),
		);

		// Keep the highlighted item scrolled into view. Synchronous through
		// the controller, so the row is mounted (and its aria-activedescendant
		// id resolvable) immediately after a keyboard move across the
		// windowed boundary.
		createEffect(() => {
			const idx = highlightIndex();
			if (!props.visible || idx < 0 || idx >= filtered().length) return;
			listController()?.scrollToIndex(idx);
		});

		const activeDescendant = () => {
			if (!props.visible) return undefined;
			const items = filtered();
			const idx = highlightIndex();
			if (idx < 0 || idx >= items.length) return undefined;
			// Only reference a row that is actually mounted: the user can
			// wheel-scroll the highlighted row out of the virtualized window
			// (unmounting it), and ARIA forbids referencing absent elements
			// (SearchPanel's activeDescendantId idiom). Reading mountedRange
			// here is deliberate tracking - the id comes back when the row
			// scrolls back into the window.
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
