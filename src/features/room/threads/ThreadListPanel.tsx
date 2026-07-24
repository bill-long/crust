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
import { formatRelativeTime, useMinuteTick } from "../../../lib/relativeTime";
import { type ThreadListRow, useThreadList } from "./useThreadList";

/** Above this row count we drop into virtualization (per AGENTS.md). */
const VIRTUALIZE_THRESHOLD = 50;

/**
 * Room-wide "Threads" browser (issue #331): a header popover listing every
 * thread in the room, newest activity first - Element's Threads panel,
 * following the PinnedMessagesPanel popover/roving-focus pattern. Clicking
 * a row opens the existing per-thread panel via `onOpenThread`.
 */
const ThreadListPanel: Component<{
	client: MatrixClient;
	roomId: string;
	onOpenThread: (rootId: string) => void;
}> = (props) => {
	const [open, setOpen] = createSignal(false);
	const panelId = createUniqueId();
	const list = useThreadList(props.client, () => props.roomId, open);
	const rows = list.rows;
	const tick = useMinuteTick();

	// Roving focus, tracked by rootId (stable across list reorders), same
	// scheme as the pinned panel. Rows here are single whole-row buttons,
	// so Enter/Space activation is native - only Arrow/Home/End move focus.
	const [focusedId, setFocusedId] = createSignal<string | null>(null);
	let virtRef: VirtualizerHandle | undefined;
	let scrollRef: HTMLDivElement | undefined;
	const rowEls = new Map<string, HTMLElement>();

	createEffect(
		on([open, rows], ([isOpen, listRows]) => {
			if (!isOpen) return;
			if (listRows.length === 0) {
				setFocusedId(null);
				return;
			}
			const current = focusedId();
			if (!current || !listRows.some((r) => r.rootId === current)) {
				setFocusedId(listRows[0]?.rootId ?? null);
			}
		}),
	);

	// Focus the current row a frame after opening (content mounts in a
	// portal); cancel on close/unmount so a late frame can't focus a
	// detached node. Mirrors the pinned panel.
	let openFocusRaf: number | undefined;
	const cancelOpenFocusRaf = (): void => {
		if (openFocusRaf !== undefined) {
			cancelAnimationFrame(openFocusRaf);
			openFocusRaf = undefined;
		}
	};
	onCleanup(cancelOpenFocusRaf);
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

	const focusIndex = (index: number): void => {
		const listRows = rows();
		if (listRows.length === 0) return;
		const clamped = Math.max(0, Math.min(listRows.length - 1, index));
		const id = listRows[clamped]?.rootId;
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

	const moveFocusBy = (delta: number): void => {
		const listRows = rows();
		if (listRows.length === 0) return;
		const curId = focusedId();
		const cur = curId ? listRows.findIndex((r) => r.rootId === curId) : -1;
		focusIndex((cur < 0 ? 0 : cur) + delta);
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (rows().length === 0) return;
		// Rows are buttons, so Enter/Space activate natively and the arrows
		// only move the roving focus. Skip OTHER interactive descendants
		// (the Load more button) so arrows don't yank focus off them - the
		// rows themselves are buttons too, hence the data-attribute check
		// rather than the pinned panel's bare closest("button") guard.
		const target = e.target as HTMLElement | null;
		if (
			target?.closest("button, a, input, textarea, select") &&
			!target.closest("[data-thread-row]")
		) {
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
				focusIndex(rows().length - 1);
				break;
		}
	};

	const handleOpenThread = (rootId: string): void => {
		props.onOpenThread(rootId);
		setOpen(false);
	};

	// When the final page loads, the still-focused "Load more" button
	// unmounts and focus would fall to <body>, killing keyboard navigation
	// (the pins panel's unpin-restore precedent). Hand focus to the current
	// row - but only when it actually dropped, never stealing from a
	// control the user moved to meanwhile.
	createEffect(
		on(
			() => list.hasMore(),
			(has, had) => {
				if (!had || has || !open()) return;
				queueMicrotask(() => {
					if (!open()) return;
					const active = document.activeElement;
					if (active && active !== document.body) return;
					const id = focusedId() ?? rows()[0]?.rootId;
					if (id) rowEls.get(id)?.focus();
				});
			},
		),
	);

	const renderRow = (row: ThreadListRow) => (
		<button
			type="button"
			data-thread-row
			ref={(el) => {
				rowEls.set(row.rootId, el);
				onCleanup(() => {
					if (rowEls.get(row.rootId) === el) rowEls.delete(row.rootId);
				});
			}}
			tabIndex={focusedId() === row.rootId ? 0 : -1}
			onFocus={() => setFocusedId(row.rootId)}
			onClick={() => handleOpenThread(row.rootId)}
			class="flex w-full flex-col gap-0.5 rounded-md border border-transparent bg-surface-2/40 px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
		>
			{/* No aria-label: the visible content (sender, time, snippet, reply
				count, sr-only unread) IS the accessible name - an authored label
				would erase the snippet for screen readers. */}
			<span class="flex w-full items-baseline gap-2">
				<span class="min-w-0 truncate text-xs font-semibold text-text-emphasis">
					{row.senderName}
				</span>
				<Show when={row.summary.latestTs !== null}>
					<span class="ml-auto shrink-0 text-[11px] text-text-disabled">
						{formatRelativeTime(row.summary.latestTs ?? 0, tick())}
					</span>
				</Show>
			</span>
			<span class="line-clamp-2 w-full text-xs text-text-secondary">
				{row.snippet}
			</span>
			<span class="flex items-center gap-1.5 text-[11px] font-medium text-accent-text">
				{row.summary.replyCount === 1
					? "1 reply"
					: `${row.summary.replyCount} replies`}
				<Show when={row.summary.unreadCount > 0}>
					<span
						class="h-1.5 w-1.5 shrink-0 rounded-full bg-indicator"
						aria-hidden="true"
					/>
					<span class="sr-only">unread</span>
				</Show>
			</span>
		</button>
	);

	return (
		<Popover
			open={open()}
			onOpenChange={(o) => setOpen(o)}
			placement="bottom-end"
			gutter={6}
		>
			<Popover.Trigger
				class="inline-flex h-8 w-8 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
				classList={{
					"bg-surface-3 text-text-emphasis": open(),
					"text-text-disabled hover:bg-surface-2 hover:text-text-primary":
						!open(),
				}}
				title="Threads"
				aria-label="Threads"
				aria-expanded={open()}
				aria-controls={open() ? panelId : undefined}
			>
				{/* Same speech-bubble glyph as ThreadSummaryChip, so the header
					affordance and the in-timeline chip read as one feature. */}
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
				</svg>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					id={panelId}
					class="z-50 flex w-[360px] max-w-[90vw] flex-col gap-2 rounded-lg border border-border-subtle bg-surface-3 p-2 shadow-lg focus:outline-none"
					role="dialog"
					aria-label="Threads"
					onKeyDown={onKeyDown}
				>
					<div class="flex items-center justify-between px-1">
						<span class="text-xs font-semibold uppercase tracking-wider text-text-disabled">
							Threads
						</span>
						{/* Count hidden while more pages exist: a partial count
							presented like a total would mislead. */}
						<span class="text-[11px] text-text-disabled">
							{rows().length > 0 && !list.hasMore() ? rows().length : ""}
						</span>
					</div>
					<Show when={list.degraded()}>
						<div class="rounded border border-border-subtle bg-surface-2/60 px-2 py-1 text-[11px] text-text-muted">
							Couldn't fetch the room's full thread list. Showing threads seen
							in this session.
						</div>
					</Show>
					{/* Known threads paint immediately even while the server fetch
						runs; the placeholders only cover the genuinely empty cases. */}
					<Show
						when={rows().length > 0}
						fallback={
							<Show
								when={list.status() === "ready"}
								fallback={
									<div class="px-2 py-6 text-center text-xs text-text-muted">
										Loading threads…
									</div>
								}
							>
								<div class="px-2 py-6 text-center text-xs text-text-muted">
									No threads in this room.
								</div>
							</Show>
						}
					>
						<Show
							when={rows().length > VIRTUALIZE_THRESHOLD}
							fallback={
								<div class="flex max-h-[420px] flex-col gap-1 overflow-y-auto">
									<For each={rows()}>{(row) => renderRow(row)}</For>
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
									data={rows()}
								>
									{(row) => <div class="py-0.5">{renderRow(row)}</div>}
								</Virtualizer>
							</div>
						</Show>
					</Show>
					<Show when={list.hasMore()}>
						<button
							type="button"
							onClick={() => list.loadMore()}
							disabled={list.loadingMore()}
							class="self-center rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							{list.loadingMore() ? "Loading…" : "Load more"}
						</button>
					</Show>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
};

export { ThreadListPanel };
