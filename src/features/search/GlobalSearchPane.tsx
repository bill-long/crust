import { useLocation } from "@solidjs/router";
import {
	createEffect,
	createSignal,
	on,
	type ParentComponent,
	Show,
} from "solid-js";
import { useClient } from "../../client/client";
import { MAX_QUERY_LEN } from "../../lib/searchHit";
import { GlobalSearchPanel } from "./GlobalSearchPanel";
import { coverageNote, searchStatusMessage } from "./panelRows";
import { useGlobalSearch } from "./useGlobalSearch";

/**
 * The room-list pane, with a search field above it.
 *
 * Wraps the room list rather than living inside it: searching spans every
 * room, so it is not the room list's concern, and this way the list stays a
 * child that gets swapped out for results while a search is showing.
 *
 * The field is the only entry point today. A Ctrl/Cmd+K palette is the
 * Discord-style goal AGENTS.md calls out, and when it arrives it should
 * drive this same hook rather than growing a second search implementation.
 */
const GlobalSearchPane: ParentComponent = (props) => {
	const { client } = useClient();
	const search = useGlobalSearch(client);
	const [draft, setDraft] = createSignal("");
	let inputEl: HTMLInputElement | undefined;
	let panelEl: HTMLDivElement | undefined;

	// The first focusable row, found through the DOM rather than threaded
	// back out of the panel: the panel owns its roving focus, and handing a
	// ref upward would give two owners for the same state.
	const firstRowEl = (): HTMLElement | null =>
		panelEl?.querySelector<HTMLElement>('[role="option"]') ?? null;

	const clear = (): void => {
		setDraft("");
		search.reset();
	};

	// What the pane shows is the last *settled* state: a search in progress
	// changes nothing on screen until it has something to say.
	//
	// Both directions matter. Switching to results while searching left the
	// sidebar blank but for "Searching..." for a whole round trip - on a
	// server without /search, a round trip known in advance to fail.
	// Switching back to the room list while searching was worse: refining a
	// query tore the results down, rebuilt the entire room list, and
	// replaced it again a moment later, unmounting the aria-live region on
	// the way so "Searching..." was never announced either.
	const [showingResults, setShowingResults] = createSignal(false);
	createEffect(() => {
		const status = search.status();
		if (status === "idle") setShowingResults(false);
		else if (status !== "searching") setShowingResults(true);
	});

	// Any navigation ends the search, not just clicking a result. Switching
	// space in the rail changes the route and the main pane while this
	// sidebar keeps rendering results from the space before it - so the
	// switch appears to do nothing until the user finds Clear.
	const location = useLocation();
	createEffect(
		on(
			() => location.pathname,
			() => {
				if (search.status() !== "idle") clear();
			},
			{ defer: true },
		),
	);

	return (
		// Carries the sidebar's own surface and right divider, so the search
		// field sits on the pane rather than above it and the divider still
		// meets both edges. `RoomList`'s root deliberately no longer paints
		// them.
		<div class="flex h-full min-h-0 flex-col border-r border-border-subtle bg-surface-1/50">
			<div class="shrink-0 px-2 py-2">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						search.submit(draft());
					}}
				>
					<label class="sr-only" for="global-search-input">
						Search all rooms
					</label>
					<div class="flex items-center gap-1">
						<input
							id="global-search-input"
							ref={(el) => {
								inputEl = el;
							}}
							type="search"
							value={draft()}
							maxLength={MAX_QUERY_LEN}
							placeholder="Search all rooms"
							autocomplete="off"
							onInput={(e) => {
								const value = e.currentTarget.value;
								setDraft(value);
								// `type="search"` makes the browser draw its own
								// clear button, which fires only `input` with "".
								// Without this it empties the field while stale
								// results stay on screen and the room list stays
								// hidden - two clear affordances side by side,
								// one of them half-working.
								if (value === "") search.reset();
							}}
							onKeyDown={(e) => {
								// Esc clears and hands the pane back to the room
								// list, matching the cancel semantics AGENTS.md
								// gives Esc everywhere else.
								if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									clear();
									return;
								}
								// ArrowDown moves from the field into the
								// results, so the list is reachable without
								// hunting for it with Tab. The rows own
								// everything after that.
								if (e.key === "ArrowDown" && showingResults()) {
									e.preventDefault();
									firstRowEl()?.focus();
								}
							}}
							class="min-w-0 flex-1 rounded bg-surface-2/60 px-2 py-1.5 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
						/>
						<Show when={draft().length > 0}>
							<button
								type="button"
								onClick={() => {
									setDraft("");
									clear();
									inputEl?.focus();
								}}
								aria-label="Clear search"
								class="shrink-0 rounded px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Clear
							</button>
						</Show>
					</div>
				</form>
			</div>
			{/* The line the results announce, mounted whatever is showing and
			    above the <Show>. A live region has to exist before its text
			    changes or the change is not announced, so owning it inside
			    the panel meant the first search of a session announced
			    nothing: the region arrived already containing the answer. */}
			<div
				aria-live="polite"
				role="status"
				class="shrink-0 px-3 pb-1 text-[11px] text-text-disabled"
			>
				{searchStatusMessage({
					status: search.status(),
					error: search.error(),
					total: search.total(),
					totalRooms: search.totalRooms(),
					moreOnServer: search.moreOnServer(),
				})}
			</div>
			{/* The coverage caveat, mounted whatever is showing and above the
			    <Show>, for the same reason the status line is: a live region
			    only announces changes to a region that was already there, so
			    owning it inside the panel meant the first search of a
			    session rendered the sentence with nothing spoken. That is
			    the failure the status line was hoisted to avoid, and putting
			    the note one element down reintroduced it. */}
			<div
				aria-live="polite"
				classList={{
					"mx-2 mb-1 shrink-0 rounded border border-border-subtle bg-surface-2/60 px-2 py-1 text-[11px] text-text-muted":
						coverageNote(
							search.mode(),
							search.locallyCovered(),
							search.encryptedRoomCount(),
							search.scanTruncated(),
							search.serverUnsupported(),
						) !== null,
				}}
			>
				{coverageNote(
					search.mode(),
					search.locallyCovered(),
					search.encryptedRoomCount(),
					search.scanTruncated(),
					search.serverUnsupported(),
				)}
			</div>
			{/* Hidden, not unmounted, so the room list keeps its scroll
			    position and its virtual window across a search.
			    `hiddenScroll.browser.test.ts` is why: four review rounds
			    asserted that `display:none` zeroes a descendant scroller's
			    `scrollTop`, and Chromium in fact preserves it and fires no
			    scroll event - so `VirtualList`'s signal still matches the DOM
			    on re-show. `display:none` also removes the subtree from the
			    tab order and the accessibility tree, so no aria-hidden is
			    needed.
			    Padding wraps the results only: the list renders its own
			    full-bleed rows, which must still reach the pane edges. */}
			<div
				class="flex min-h-0 flex-1 flex-col overflow-hidden"
				classList={{ hidden: showingResults() }}
			>
				{props.children}
			</div>
			<Show when={showingResults()}>
				<div
					ref={(el) => {
						panelEl = el;
					}}
					class="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2"
				>
					<GlobalSearchPanel
						search={search}
						onNavigated={(viaKeyboard) => {
							// Keyboard only. Clearing unmounts the panel
							// including the focused row and nothing else claims
							// focus, so a keyboard user who arrowed to a result
							// and pressed Enter would land on <body> with the
							// next Tab restarting at the top of the document.
							// After a mouse click there is nothing to rescue,
							// and pulling focus back to this field would send
							// the next keystrokes into search rather than the
							// room the user just opened.
							if (viaKeyboard) inputEl?.focus();
							clear();
						}}
						onDismiss={() => {
							clear();
							inputEl?.focus();
						}}
					/>
				</div>
			</Show>
		</div>
	);
};

export { GlobalSearchPane };
