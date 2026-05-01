import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	on,
	Show,
} from "solid-js";

export interface PickerProps<T> {
	items: T[];
	query: string;
	onSelect: (item: T) => void;
	onClose: () => void;
	renderItem: (item: T, isHighlighted: boolean) => JSX.Element;
	filterFn: (item: T, query: string) => boolean;
	keyFn: (item: T) => string;
	visible: boolean;
	position: { bottom: number; left: number };
}

const ITEM_HEIGHT = 36;

/**
 * Generic filtered-list picker popover. Keyboard events must be forwarded
 * from the parent's onKeyDown via the returned `handlePickerKey` function.
 */
export function createPicker<T>() {
	let handleKey: ((e: KeyboardEvent) => boolean) | undefined;
	let activeDescendantRef: (() => string | undefined) | undefined;
	const pickerId = createUniqueId();
	const listboxId = `picker-listbox-${pickerId}`;

	const Picker: Component<PickerProps<T>> = (props) => {
		const [highlightIndex, setHighlightIndex] = createSignal(0);

		const filtered = createMemo(() =>
			props.items.filter((item) => props.filterFn(item, props.query)),
		);

		// Reset highlight when query changes or filtered list shrinks
		createEffect(
			on(
				() => [props.query, props.visible, filtered().length] as const,
				() =>
					setHighlightIndex((i) =>
						Math.min(i, Math.max(0, filtered().length - 1)),
					),
			),
		);

		// Scroll highlighted item into view
		createEffect(() => {
			const idx = highlightIndex();
			const items = filtered();
			if (!props.visible || idx < 0 || idx >= items.length) return;
			const el = document.getElementById(`${listboxId}-item-${idx}`);
			el?.scrollIntoView({ block: "nearest" });
		});

		const activeDescendant = () => {
			if (!props.visible) return undefined;
			const items = filtered();
			const idx = highlightIndex();
			if (idx >= 0 && idx < items.length) {
				return `${listboxId}-item-${idx}`;
			}
			return undefined;
		};

		activeDescendantRef = activeDescendant;

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
				<div
					id={listboxId}
					class="absolute z-20 max-h-[216px] w-64 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-800 py-1 shadow-lg"
					style={{
						bottom: `${props.position.bottom}px`,
						left: `${props.position.left}px`,
					}}
					role="listbox"
					aria-label="Suggestions"
					tabIndex={-1}
				>
					<For each={filtered()}>
						{(item, index) => {
							const isHighlighted = () => index() === highlightIndex();
							return (
								<div
									id={`${listboxId}-item-${index()}`}
									role="option"
									aria-selected={isHighlighted()}
									tabIndex={-1}
									class={`cursor-pointer px-3 py-1.5 text-sm ${
										isHighlighted()
											? "bg-pink-900/40 text-neutral-100"
											: "text-neutral-300 hover:bg-neutral-700"
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
					</For>
				</div>
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

	return { Picker, handlePickerKey, getActiveDescendant, listboxId };
}
