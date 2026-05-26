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
import { SearchResultRow } from "./SearchResultRow";
import { MAX_QUERY_LEN, useRoomSearch } from "./useRoomSearch";

const VIRTUALIZE_THRESHOLD = 50;

/**
 * Focus the active room composer textarea, if one exists. Lets a keyboard
 * user who jumps to a search result land back on the input they were typing
 * in without an extra Tab. We rely on the singleton `data-composer-textarea`
 * marker rendered by Composer; if no composer is mounted this is a no-op.
 */
function focusComposer(): void {
	const textarea = document.querySelector<HTMLTextAreaElement>(
		"textarea[data-composer-textarea]",
	);
	textarea?.focus();
}

const SearchIcon: Component<{ class?: string }> = (props) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		class={props.class ?? "h-4 w-4"}
	>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</svg>
);

const SearchPanel: Component<{
	client: MatrixClient;
	roomId: string;
	onJump: (eventId: string) => void;
}> = (props) => {
	const search = useRoomSearch(props.client, () => props.roomId);
	const [open, setOpen] = createSignal(false);
	const [draft, setDraft] = createSignal("");
	const [focusedIndex, setFocusedIndex] = createSignal(0);
	// Tracks whether the current close was triggered by a successful Jump
	// (in which case we redirect focus to the composer so the user can keep
	// typing) vs. any other close path — Escape, outside click, or trigger
	// click — where Kobalte's default "return focus to trigger" is the
	// expected popover behavior.
	let closeViaJump = false;

	const panelId = createUniqueId();
	const inputId = createUniqueId();
	const listboxId = createUniqueId();
	const rowIdBase = createUniqueId();

	let inputEl: HTMLInputElement | undefined;
	let scrollRef: HTMLDivElement | undefined;
	let virtRef: VirtualizerHandle | undefined;
	const rowEls = new Map<number, HTMLElement>();
	// Bumped whenever rowEls mutates so reactive consumers (e.g.
	// aria-activedescendant) can verify the focused row is actually
	// rendered, which is not guaranteed under virtualization.
	const [renderedTick, setRenderedTick] = createSignal(0);
	const bumpRendered = (): void => {
		setRenderedTick((n) => n + 1);
	};

	const rowId = (index: number): string => `${rowIdBase}-${index}`;

	const results = createMemo(() => search.results());
	const terms = createMemo(() => search.highlights());

	// Only point aria-activedescendant at a row id that is actually rendered.
	// Under virtualization a focused index may not yet have a corresponding
	// DOM node, and ARIA forbids referencing absent elements.
	const activeDescendantId = createMemo<string | undefined>(() => {
		renderedTick();
		const list = results();
		const idx = focusedIndex();
		if (list.length === 0) return undefined;
		if (!rowEls.has(idx)) return undefined;
		return rowId(idx);
	});

	// Reset roving focus and (when the user typed a new query) the
	// results list whenever the result count changes.
	createEffect(
		on(results, (list) => {
			if (list.length === 0) {
				setFocusedIndex(0);
				return;
			}
			if (focusedIndex() >= list.length) setFocusedIndex(0);
		}),
	);

	// On close, drop any in-flight search state so reopening starts fresh.
	createEffect(
		on(open, (isOpen) => {
			if (!isOpen) {
				cancelFocusRaf();
				cancelOpenFocusRaf();
				setDraft("");
				setFocusedIndex(0);
				rowEls.clear();
				bumpRendered();
				search.reset();
			}
		}),
	);

	onCleanup(() => {
		cancelFocusRaf();
		cancelOpenFocusRaf();
		search.reset();
	});

	const onSubmit = (e: SubmitEvent): void => {
		e.preventDefault();
		const q = draft().trim();
		if (q.length === 0) return;
		setFocusedIndex(0);
		rowEls.clear();
		bumpRendered();
		search.submit(q);
	};

	const jumpAt = (index: number): void => {
		const hit = results()[index];
		if (!hit) return;
		closeViaJump = true;
		props.onJump(hit.eventId);
		setOpen(false);
	};

	let focusRaf = 0;
	let openFocusRaf = 0;

	const cancelFocusRaf = (): void => {
		if (focusRaf !== 0) {
			cancelAnimationFrame(focusRaf);
			focusRaf = 0;
		}
	};
	const cancelOpenFocusRaf = (): void => {
		if (openFocusRaf !== 0) {
			cancelAnimationFrame(openFocusRaf);
			openFocusRaf = 0;
		}
	};

	const focusRow = (index: number): void => {
		const list = results();
		if (list.length === 0) return;
		const clamped = Math.max(0, Math.min(list.length - 1, index));
		setFocusedIndex(clamped);
		virtRef?.scrollToIndex(clamped, { align: "nearest" });
		cancelFocusRaf();
		focusRaf = requestAnimationFrame(() => {
			focusRaf = 0;
			if (!open()) return;
			rowEls.get(clamped)?.focus();
		});
	};

	const onListKeyDown = (e: KeyboardEvent): void => {
		const list = results();
		if (list.length === 0) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				focusRow(focusedIndex() + 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				focusRow(focusedIndex() - 1);
				break;
			case "Home":
				e.preventDefault();
				focusRow(0);
				break;
			case "End":
				e.preventDefault();
				focusRow(list.length - 1);
				break;
			case "Enter":
				e.preventDefault();
				jumpAt(focusedIndex());
				break;
		}
	};

	const onInputKeyDown = (e: KeyboardEvent): void => {
		const list = results();
		if (e.key === "ArrowDown" && list.length > 0) {
			e.preventDefault();
			focusRow(0);
		}
	};

	const statusMessage = createMemo(() => {
		switch (search.status()) {
			case "searching":
				return "Searching…";
			case "results": {
				const n = results().length;
				const err = search.error();
				if (err) return err;
				return search.hasMore()
					? `Showing ${n} results, more available`
					: `${n} ${n === 1 ? "result" : "results"}`;
			}
			case "empty":
				return "No results";
			case "error":
				return search.error() ?? "Search failed";
			default:
				return "";
		}
	});

	const triggerLabel = "Search messages";

	const renderRow = (
		hit: ReturnType<typeof results>[number],
		index: number,
	) => (
		<SearchResultRow
			hit={hit}
			terms={terms()}
			focused={focusedIndex() === index}
			rowId={rowId(index)}
			rowRef={(el) => {
				if (el) rowEls.set(index, el);
				else rowEls.delete(index);
				bumpRendered();
			}}
			onJump={() => jumpAt(index)}
			onFocus={() => setFocusedIndex(index)}
		/>
	);

	return (
		<Popover
			open={open()}
			onOpenChange={(o) => setOpen(o)}
			placement="bottom-end"
			gutter={6}
		>
			<Popover.Trigger
				class="inline-flex h-8 w-8 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
				classList={{
					"bg-surface-3 text-text-emphasis": open(),
					"text-text-disabled hover:bg-surface-2 hover:text-text-primary":
						!open(),
				}}
				title={triggerLabel}
				aria-label={triggerLabel}
				aria-expanded={open()}
				aria-controls={open() ? panelId : undefined}
			>
				<SearchIcon />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					id={panelId}
					class="z-50 flex w-[380px] max-w-[90vw] flex-col gap-2 rounded-lg border border-border-subtle bg-surface-3 p-2 shadow-lg focus:outline-none"
					role="dialog"
					aria-label="Search messages"
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						closeViaJump = false;
						// Defer to next frame so the input element exists in the
						// portal subtree before we try to focus it.
						cancelOpenFocusRaf();
						openFocusRaf = requestAnimationFrame(() => {
							openFocusRaf = 0;
							if (!open()) return;
							inputEl?.focus();
						});
					}}
					onCloseAutoFocus={(e) => {
						if (closeViaJump) {
							e.preventDefault();
							closeViaJump = false;
							focusComposer();
						}
					}}
				>
					<form onSubmit={onSubmit} class="flex flex-col gap-2">
						<label for={inputId} class="sr-only">
							Search messages in this room
						</label>
						<div class="flex items-center gap-2 rounded-md bg-surface-1 px-2 py-1.5 focus-within:ring-1 focus-within:ring-accent-hover">
							<SearchIcon class="h-3.5 w-3.5 shrink-0 text-text-disabled" />
							<input
								ref={(el) => {
									inputEl = el;
								}}
								id={inputId}
								type="search"
								value={draft()}
								onInput={(e) => setDraft(e.currentTarget.value)}
								onKeyDown={onInputKeyDown}
								placeholder="Search this room…"
								maxLength={MAX_QUERY_LEN}
								autocomplete="off"
								aria-controls={results().length > 0 ? listboxId : undefined}
								aria-activedescendant={activeDescendantId()}
								class="min-w-0 flex-1 bg-transparent text-sm text-text-emphasis placeholder:text-text-disabled focus:outline-none"
							/>
							<Show when={search.loading()}>
								<span class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							</Show>
						</div>
					</form>
					<Show when={search.isEncrypted()}>
						<div class="rounded border border-border-subtle bg-surface-2/60 px-2 py-1 text-[11px] text-text-muted">
							This room is encrypted. Only messages already loaded in this
							client are searchable.
						</div>
					</Show>
					<Show when={search.mode() === "local" && !search.isEncrypted()}>
						<div class="rounded border border-border-subtle bg-surface-2/60 px-2 py-1 text-[11px] text-text-muted">
							Server search unavailable. Showing matches from messages already
							loaded in this client.
						</div>
					</Show>
					<div
						aria-live="polite"
						role="status"
						class="px-1 text-[11px] text-text-disabled"
					>
						{statusMessage()}
					</div>
					<Show when={results().length > 0}>
						<Show
							when={results().length > VIRTUALIZE_THRESHOLD}
							fallback={
								<div
									role="listbox"
									id={listboxId}
									aria-label="Search results"
									onKeyDown={onListKeyDown}
									class="flex max-h-[420px] flex-col gap-1 overflow-y-auto"
								>
									<For each={results()}>{(hit, i) => renderRow(hit, i())}</For>
								</div>
							}
						>
							<div
								ref={(el) => {
									scrollRef = el;
								}}
								role="listbox"
								id={listboxId}
								aria-label="Search results"
								onKeyDown={onListKeyDown}
								class="max-h-[420px] overflow-y-auto"
							>
								<Virtualizer
									ref={(h) => {
										virtRef = h ?? undefined;
									}}
									scrollRef={scrollRef}
									data={results()}
								>
									{(hit, i) => <div class="py-0.5">{renderRow(hit, i())}</div>}
								</Virtualizer>
							</div>
						</Show>
					</Show>
					<Show when={search.hasMore()}>
						<button
							type="button"
							onClick={() => search.loadMore()}
							disabled={search.loading()}
							class="self-center rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							{search.loading() ? "Loading…" : "Load more"}
						</button>
					</Show>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
};

export { SearchPanel };
