import { useNavigate } from "@solidjs/router";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	Show,
} from "solid-js";
import { useDecodedParams } from "../../app/useDecodedParams";
import { useClient } from "../../client/client";
import { Avatar } from "../../components/Avatar";
import { SearchResultRow } from "../../components/SearchResultRow";
import { avatarInitial } from "../../lib/avatar";
import { createFailedImageUrls } from "../../lib/imageFallback";
import { roomRoutePath } from "../../lib/roomRoute";
import { type FlatRow, flattenGroups } from "./panelRows";
import type { GlobalSearchHit, UseGlobalSearch } from "./useGlobalSearch";

/**
 * Whether a click came from the keyboard rather than a pointer.
 *
 * Only the keyboard needs rescuing. A pointer user who presses a pager
 * button has focus wherever they pointed, and moving it into the results -
 * scrolling the list under them - is the same theft `onNavigated` refuses
 * to commit after a mouse click. `detail` is the click count, which is 0
 * for a button activated by Enter or Space.
 */
function keyboardActivated(e: MouseEvent): boolean {
	return e.detail === 0;
}

const GlobalSearchPanel: Component<{
	search: UseGlobalSearch;
	/**
	 * Called after a result is opened, so the host can close the panel.
	 * `viaKeyboard` says whether focus needs putting somewhere: a click
	 * leaves focus where the user pointed, a keypress does not.
	 */
	onNavigated?: (viaKeyboard: boolean) => void;
	/** Esc from within the results, which the field's own handler cannot see. */
	onDismiss?: () => void;
}> = (props) => {
	const navigate = useNavigate();
	const params = useDecodedParams<{ spaceId?: string }>();
	const { summaries } = useClient();

	const rows = createMemo(() => flattenGroups(props.search.groups()));
	const broken = createFailedImageUrls();

	// Trimmed before the fallback, the way room names are read everywhere
	// else here: a name of only spaces would otherwise render an empty
	// heading and an empty accessible context label on every row under it.
	const roomName = (roomId: string): string =>
		summaries[roomId]?.name?.trim() || roomId;

	const jump = (hit: GlobalSearchHit, viaKeyboard: boolean): void => {
		// `?event=` is the permalink param the room pane already honours
		// (#441). A thread reply carries `?thread=` as well, and the pane
		// pairs them: the reply is not in the main timeline, so its id has to
		// reach the thread panel rather than the timeline's jump request.
		const query = new URLSearchParams({ event: hit.eventId });
		if (hit.threadRootId) query.set("thread", hit.threadRootId);

		// Stay in the open space when the hit is in one of its rooms.
		// Sending every result to `/home/` would deselect the space and swap
		// the sidebar out from under someone searching within it - and most
		// results are in the space they are already looking at.
		// `useDecodedParams`, not a bare decode: Solid Router hands path
		// params through undecoded, and a stray `%` makes
		// `decodeURIComponent` throw a URIError - which here would mean
		// clicking a result did nothing at all, with no error surfaced.
		//
		// The route itself comes from the shared helper. Building it here
		// meant reimplementing the rules minus the one that matters most:
		// a hit in a DM went to `/home/`, which Layout canonicalises to
		// `/dm/` - a different route branch, so the pane remounted and took
		// the `?event=` jump with it. The room opened; the message was never
		// reached.
		const target = `${roomRoutePath(summaries, hit.roomId, params.spaceId)}?${query}`;
		navigate(target);
		props.onNavigated?.(viaKeyboard);
	};

	// What to show in place of a result list, when there is nothing to list.
	const emptyText = createMemo<string | null>(() => {
		const status = props.search.status();
		if (status === "empty") return "No messages found.";
		if (status === "error") {
			return props.search.error() ?? "Search failed.";
		}
		// A refine after an answer with no hits keeps those (empty) results
		// while the next query runs, so without this the panel had no rows,
		// no empty state and no note - blank but for an 11px status line,
		// which is the failure the empty state was added to fix.
		if (status === "searching") return "Searching…";
		return null;
	});

	// Roving tabindex over the hit rows: the focused row carries tabIndex 0
	// and every other -1, which is what `SearchResultRow` already implements
	// through its `focused` prop. Without an owner that moves that focus, a
	// keyboard or screen-reader user can run a search and never reach a
	// single result. Deliberately not aria-activedescendant - that is the
	// other listbox pattern, where the container keeps focus, and mixing the
	// two makes both the container and a row focusable.
	const hitRows = createMemo(() =>
		rows().flatMap((row, index) => (row.kind === "hit" ? [index] : [])),
	);
	const [focusedHit, setFocusedHit] = createSignal(0);
	const rowEls = new Map<number, HTMLElement>();

	const rowDomId = (flatIndex: number): string => `gsearch-row-${flatIndex}`;

	// Focus rescue for a pager button that unmounts under the press that
	// used it.
	//
	// Keyed on the rendered rows, not on `hasMore`. A Solid signal does not
	// notify when the value is unchanged, and the usual case is exactly that
	// - the fetched page still has more, so `setHasMore(true)` runs while it
	// is already true and an effect watching it never fires. The flag then
	// stayed armed until the next `submit` set it false, which yanked focus
	// out of the search field onto the previous query's last row.
	//
	// `rows` changes on every publish, so this runs after every load of
	// either kind, and both conditions are read from the DOM rather than
	// inferred: the button is really gone, and focus really was orphaned.
	let rescueEl: HTMLElement | null = null;
	// Drop rows that have gone. Solid never re-invokes a ref with null, so
	// nothing else removes them, and this pane is mounted for the life of
	// the app - a 40-row result set replaced by a 4-row one would otherwise
	// keep 36 detached rows reachable forever. Pruning by liveness rather
	// than clearing wholesale is what makes it safe here: the effect runs
	// after the refs for the new rows have already registered, so a blanket
	// clear would wipe exactly the entries it needs to keep.
	const pruneRowEls = (): void => {
		for (const [index, el] of rowEls) {
			if (!el.isConnected) rowEls.delete(index);
		}
	};
	// Decide once, after every synchronous write in the press has landed.
	//
	// Solid flushes effects per write, so a press that publishes rows and
	// then flips the flag that removes the button - or the reverse - runs
	// this twice, and neither moment on its own is the right one to judge:
	// at the first, the button may still be there; at the other, the rows
	// may not have arrived. A microtask runs after both, whichever order
	// they came in, and after the DOM has caught up.
	let rescuePending = false;
	createEffect(
		on(
			// Rows alone is enough, because the decision is deferred: every
			// path that removes a pager button also publishes, so whichever
			// write lands first, the microtask sees the settled result.
			rows,
			() => {
				pruneRowEls();
				if (!rescueEl || rescuePending) return;
				rescuePending = true;
				queueMicrotask(() => {
					rescuePending = false;
					const el = rescueEl;
					if (!el) return;
					rescueEl = null;
					const active = document.activeElement;
					const stranded =
						active === null ||
						active === document.body ||
						(active === el && (el as HTMLButtonElement).disabled === true);
					if (!stranded) return;
					focusHit(0);
				});
			},
			{ defer: true },
		),
	);

	// A new query resets the position; paging does not. It also disarms any
	// pending rescue: the press that armed it belonged to the previous
	// result set, and `loadMore`'s server path returns without publishing
	// when a newer query has superseded it - so the arming would otherwise
	// survive and fire against results no pager press produced.
	createEffect(
		on(
			// The submit counter, not the query text: a Solid signal does not
			// notify when the value is unchanged, so re-running the same
			// search left this guard silently not running - the case its own
			// comment describes.
			() => props.search.submissions(),
			() => {
				setFocusedHit(0);
				rescueEl = null;
			},
			{ defer: true },
		),
	);
	// A new result set invalidates the old position.
	createEffect(
		on(hitRows, (list) => {
			if (focusedHit() >= list.length) setFocusedHit(0);
		}),
	);

	const focusHit = (next: number): void => {
		const list = hitRows();
		if (list.length === 0) return;
		const clamped = Math.max(0, Math.min(next, list.length - 1));
		const row = list[clamped];
		if (!row) return;
		setFocusedHit(clamped);
		// Every row is rendered, so the element is simply there. `isConnected`
		// is still checked because Solid never re-invokes a ref with null: a
		// row that has gone leaves a detached node behind, and `focus()` on
		// one is a silent no-op that drops focus to <body>, where the listbox
		// stops receiving keys.
		const el = rowEls.get(row);
		if (el?.isConnected) el.focus();
		// The browser scrolls a focused element into view on its own.
	};

	const onListKeyDown = (e: KeyboardEvent): void => {
		// Escape before the empty-rows guard. This handler is also the pager
		// buttons', and the pager is mounted with no rows whenever a server
		// page projects to nothing while `next_batch` is set - exactly the
		// state where a keyboard user most needs a way out.
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			props.onDismiss?.();
			return;
		}
		if (hitRows().length === 0) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				focusHit(focusedHit() + 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				focusHit(focusedHit() - 1);
				break;
			case "Home":
				e.preventDefault();
				focusHit(0);
				break;
			case "End":
				e.preventDefault();
				focusHit(hitRows().length - 1);
				break;
			default:
				break;
		}
	};

	const renderRow = (row: FlatRow, flatIndex: number) =>
		row.kind === "header" ? (
			// `aria-hidden`, not `role="presentation"`: presentation drops the
			// element's own semantics but leaves its descendants - the
			// avatar, the room name, the count - in the accessibility tree as
			// non-option children of a listbox, which is both invalid and
			// announced as stray content between options. The room reaches
			// assistive tech through each option's `contextLabel` instead.
			<div aria-hidden="true" class="flex items-center gap-2 px-1 pt-3 pb-1">
				<Avatar
					url={summaries[row.roomId]?.avatarUrl ?? null}
					initial={avatarInitial(roomName(row.roomId))}
					loading="lazy"
					// Shared registry: `flattenGroups` re-mints every row on
					// each publish and `<For>` keys by reference, so every
					// row remounts on each Load more - and without it a
					// 404ing avatar re-requests each time.
					broken={broken}
				/>
				<span class="min-w-0 flex-1 truncate text-xs font-semibold text-text-emphasis">
					{roomName(row.roomId)}
				</span>
				<span class="shrink-0 text-[11px] text-text-disabled">{row.count}</span>
			</div>
		) : (
			<SearchResultRow
				hit={row.hit}
				terms={props.search.highlights()}
				focused={hitRows()[focusedHit()] === flatIndex}
				rowId={rowDomId(flatIndex)}
				onJump={(viaKeyboard) => jump(row.hit, viaKeyboard)}
				contextLabel={roomName(row.hit.roomId)}
				onFocus={() => {
					const at = hitRows().indexOf(flatIndex);
					if (at >= 0) setFocusedHit(at);
				}}
				rowRef={(el) => {
					if (el) rowEls.set(flatIndex, el);
				}}
			/>
		);

	return (
		<div class="flex min-h-0 flex-1 flex-col gap-1">
			{/* A real empty state. The room list is hidden while results are
			    showing, so with no rows and no note the sidebar was blank
			    apart from an 11px disabled-grey line in the status region -
			    easy to miss at that size, and the whole pane to lose. */}
			<Show when={rows().length === 0 && emptyText()}>
				{(text) => (
					<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
						<span class="text-sm text-text-secondary">{text()}</span>
						<span class="text-xs text-text-disabled">
							Press Esc to go back to your rooms.
						</span>
					</div>
				)}
			</Show>
			<Show when={rows().length > 0}>
				{/* Not virtualized, deliberately. The rendered window is one
				    page wide and does not grow: 20 hits, 40 rows worst case
				    at one room per hit, under the ~50 AGENTS.md sets the bar
				    at. An accumulating cursor would have broken that after
				    three pages, which is why paging replaces rather than
				    appends. Virtualizing it
				    meant moving focus to rows that were not mounted, and
				    every attempt ran into another of virtua's asynchronous
				    stages: scheduled scrolling, deferred measurement, and
				    `visibility: hidden` until measured, which silently makes
				    `focus()` a no-op. A "Load more" click is the cheaper
				    trade. */}
				<div
					role="listbox"
					aria-label="Search results"
					onKeyDown={onListKeyDown}
					class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
				>
					<For each={rows()}>{(row, i) => renderRow(row, i())}</For>
				</div>
			</Show>
			<Show when={props.search.hasMore() || props.search.hasPrevious()}>
				{/* Escape on the buttons, not on their container: they are the
				    listbox's siblings, so the list's handler never saw them,
				    and a keydown handler on a plain div is an interaction on
				    a non-interactive element. */}
				<div class="flex shrink-0 items-center justify-center gap-2 pt-1">
					<Show when={props.search.hasPrevious()}>
						<button
							type="button"
							onClick={(e) => {
								// Same rescue as Older: the final back-step
								// flips `hasPrevious` false and unmounts this
								// button under the press that used it.
								rescueEl = keyboardActivated(e) ? e.currentTarget : null;
								props.search.loadPrevious();
							}}
							onKeyDown={onListKeyDown}
							disabled={props.search.loading()}
							class="rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							Newer
						</button>
					</Show>
					<Show when={props.search.hasMore()}>
						<button
							type="button"
							onClick={(e) => {
								// Remember the element, not a boolean: whether it
								// survived is a fact about the DOM after the load,
								// and the load may be a network round trip away.
								rescueEl = keyboardActivated(e) ? e.currentTarget : null;
								props.search.loadMore();
							}}
							onKeyDown={onListKeyDown}
							disabled={props.search.loading()}
							class="rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							{props.search.loading() ? "Loading…" : "Older"}
						</button>
					</Show>
				</div>
			</Show>
		</div>
	);
};

export { GlobalSearchPanel };
