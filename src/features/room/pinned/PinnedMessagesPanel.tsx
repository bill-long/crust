import { Popover } from "@kobalte/core/popover";
import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { Virtualizer, type VirtualizerHandle } from "virtua/solid";
import type { ResolvedEmote } from "../../emoji/types";
import { PinIcon } from "./PinIcon";
import { PinnedMessageRow } from "./PinnedMessageRow";
import type { UsePinnedEvents } from "./usePinnedEvents";

/** Above this row count we drop into virtualization (per AGENTS.md). */
const VIRTUALIZE_THRESHOLD = 50;

const PinnedMessagesPanel: Component<{
	client: MatrixClient;
	pins: UsePinnedEvents;
	shortcodeLookup: Map<string, ResolvedEmote>;
	onJump: (eventId: string) => void;
}> = (props) => {
	const [open, setOpen] = createSignal(false);
	const panelId = createUniqueId();
	const count = createMemo(() => props.pins.pinnedIds().length);
	const items = createMemo(() => props.pins.displayOrder());
	const room = createMemo(() => props.pins.room());

	// Roving focus inside the panel. Focus is tracked by eventId (stable
	// across list mutations); the index is recomputed when needed.
	// Keying rowEls by eventId avoids stale-index bugs when surviving
	// rows shift after unpin/reorder (Solid's <For> updates the index()
	// accessor but does NOT re-run callbacks that captured the previous
	// index value).
	const [focusedId, setFocusedId] = createSignal<string | null>(null);
	let virtRef: VirtualizerHandle | undefined;
	let scrollRef: HTMLDivElement | undefined;
	let triggerEl: HTMLButtonElement | undefined;
	const rowEls = new Map<string, HTMLElement>();

	// Reset focus target when items change or panel reopens.
	createEffect(
		on([open, items], ([isOpen, list]) => {
			if (!isOpen) return;
			if (list.length === 0) {
				setFocusedId(null);
				return;
			}
			const current = focusedId();
			if (!current || !list.includes(current)) {
				setFocusedId(list[0] ?? null);
			}
		}),
	);

	// When opening, move focus to the focused row after a frame so the
	// panel content has mounted. Cancel any pending rAF on close so we
	// don't try to focus a detached element after the user dismisses
	// the panel before the frame fires.
	let openFocusRaf: number | undefined;
	const cancelOpenFocusRaf = (): void => {
		if (openFocusRaf !== undefined) {
			cancelAnimationFrame(openFocusRaf);
			openFocusRaf = undefined;
		}
	};
	onCleanup(cancelOpenFocusRaf);
	// Same pattern for the per-keystroke focus rAF used by focusIndex
	// (arrow/Home/End nav). Track and cancel so a late frame can't
	// focus a detached row after the panel closes or unmounts.
	let focusIndexRaf: number | undefined;
	const cancelFocusIndexRaf = (): void => {
		if (focusIndexRaf !== undefined) {
			cancelAnimationFrame(focusIndexRaf);
			focusIndexRaf = undefined;
		}
	};
	onCleanup(cancelFocusIndexRaf);
	createEffect(
		on(open, (isOpen) => {
			cancelOpenFocusRaf();
			cancelFocusIndexRaf();
			if (!isOpen) return;
			openFocusRaf = requestAnimationFrame(() => {
				openFocusRaf = undefined;
				const id = focusedId();
				if (!id) return;
				rowEls.get(id)?.focus();
			});
		}),
	);

	const moveFocusBy = (delta: number): void => {
		const list = items();
		const len = list.length;
		if (len === 0) return;
		const curId = focusedId();
		const cur = curId ? list.indexOf(curId) : -1;
		const base = cur < 0 ? 0 : cur;
		const next = Math.max(0, Math.min(len - 1, base + delta));
		focusIndex(next);
	};

	const focusIndex = (index: number): void => {
		const list = items();
		if (list.length === 0) return;
		const clamped = Math.max(0, Math.min(list.length - 1, index));
		const id = list[clamped];
		if (!id) return;
		setFocusedId(id);
		virtRef?.scrollToIndex(clamped, { align: "nearest" });
		cancelFocusIndexRaf();
		focusIndexRaf = requestAnimationFrame(() => {
			focusIndexRaf = undefined;
			if (!open()) return;
			rowEls.get(id)?.focus();
		});
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (items().length === 0) return;
		// Skip when focus is inside an interactive descendant (e.g. the
		// row's Jump/Unpin <button>s). Otherwise the panel-level Enter
		// shortcut would preventDefault the button's own activation and
		// the Arrow keys would steal scroll/select behaviour from inputs.
		const target = e.target as HTMLElement | null;
		if (target?.closest("button, a, input, textarea, select")) {
			return;
		}
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				moveFocusBy(1);
				break;
			case "ArrowUp":
				e.preventDefault();
				moveFocusBy(-1);
				break;
			case "Home":
				e.preventDefault();
				focusIndex(0);
				break;
			case "End":
				e.preventDefault();
				focusIndex(items().length - 1);
				break;
			case "Enter": {
				e.preventDefault();
				const id = focusedId();
				if (id) handleJump(id);
				break;
			}
		}
	};

	const handleJump = (eventId: string): void => {
		props.onJump(eventId);
		setOpen(false);
	};

	const handleUnpin = (eventId: string): void => {
		// Capture the index being unpinned so we can restore focus to a
		// sibling row after the optimistic removal. Without this, focus
		// falls to <body> and keyboard users lose their place in the
		// panel.
		const idx = items().indexOf(eventId);
		void props.pins.unpin(eventId);
		if (idx >= 0) {
			// After the next tick the overlay has applied; pick the row
			// that now sits at the same index (or the previous one if we
			// just removed the last row).
			queueMicrotask(() => {
				const list = items();
				if (list.length === 0) {
					setFocusedId(null);
					triggerEl?.focus();
					return;
				}
				focusIndex(Math.min(idx, list.length - 1));
			});
		}
	};

	const triggerLabel = createMemo(() => {
		const n = count();
		return n > 0 ? `Pinned messages (${n})` : "Pinned messages";
	});

	const renderRow = (eventId: string) => {
		const r = room();
		if (!r) return null;
		return (
			<PinnedMessageRow
				client={props.client}
				room={r}
				eventId={eventId}
				canPin={props.pins.canPin()}
				shortcodeLookup={props.shortcodeLookup}
				tabIndex={focusedId() === eventId ? 0 : -1}
				rowRef={(el, prevEl) => {
					if (el) {
						rowEls.set(eventId, el);
						return;
					}
					// Identity-checked sync delete: only drop the entry if
					// it still points at the element being unmounted. A
					// remount of the same eventId at a different index will
					// have set the new element first; we must not clobber
					// it with a stale cleanup.
					if (prevEl && rowEls.get(eventId) === prevEl) {
						rowEls.delete(eventId);
					}
				}}
				onFocus={() => setFocusedId(eventId)}
				onJump={() => handleJump(eventId)}
				onUnpin={() => handleUnpin(eventId)}
			/>
		);
	};

	return (
		<Popover
			open={open()}
			onOpenChange={(o) => setOpen(o)}
			placement="bottom-end"
			gutter={6}
		>
			<Popover.Trigger
				ref={(el: HTMLButtonElement) => {
					triggerEl = el;
				}}
				class="relative rounded px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				classList={{
					"bg-surface-3 text-text-emphasis": open(),
					"text-text-disabled hover:bg-surface-2 hover:text-text-secondary":
						!open(),
				}}
				title={triggerLabel()}
				aria-label={triggerLabel()}
				aria-expanded={open()}
				aria-controls={open() ? panelId : undefined}
			>
				<span class="inline-flex items-center gap-1">
					<PinIcon filled={count() > 0} />
					<Show when={count() > 0}>
						<span class="rounded-full bg-accent px-1.5 py-0 text-[10px] font-semibold leading-4 text-accent-foreground">
							{count()}
						</span>
					</Show>
				</span>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					id={panelId}
					class="z-50 w-[360px] max-w-[90vw] rounded-lg border border-border-subtle bg-surface-3 p-2 shadow-lg focus:outline-none"
					role="dialog"
					aria-label="Pinned messages"
					onKeyDown={onKeyDown}
				>
					<div class="flex items-center justify-between px-1 pb-2">
						<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
							Pinned messages
						</span>
						<span class="text-[11px] text-text-disabled">{count()}</span>
					</div>
					<Show when={props.pins.lastError()}>
						{(msg) => (
							<div
								role="alert"
								class="mb-2 rounded border border-danger-bg/40 bg-danger-bg/20 px-2 py-1 text-[11px] text-danger-text"
							>
								{msg()}
							</div>
						)}
					</Show>
					<span aria-live="polite" class="sr-only">
						<Show when={props.pins.pending()}>Updating pinned messages…</Show>
					</span>
					<Show
						when={items().length > 0}
						fallback={
							<div class="px-2 py-6 text-center text-xs text-text-muted">
								No pinned messages.
							</div>
						}
					>
						<Show
							when={items().length > VIRTUALIZE_THRESHOLD}
							fallback={
								<div class="flex max-h-[420px] flex-col gap-1 overflow-y-auto">
									<For each={items()}>{(id) => renderRow(id)}</For>
								</div>
							}
						>
							<div
								ref={(el) => {
									scrollRef = el;
								}}
								class="max-h-[420px] overflow-y-auto"
							>
								<Virtualizer
									ref={(h) => {
										virtRef = h ?? undefined;
									}}
									scrollRef={scrollRef}
									data={items()}
								>
									{(id) => <div class="py-0.5">{renderRow(id)}</div>}
								</Virtualizer>
							</div>
						</Show>
					</Show>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
};

export { PinnedMessagesPanel };
