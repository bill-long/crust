import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import type { SummariesStore } from "../../client/summaries";
import { GlobalSearchPanel } from "./GlobalSearchPanel";
import type { UseGlobalSearch } from "./useGlobalSearch";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigate = vi.fn();
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigate,
	useParams: () => ({}),
}));

const Wrapper: ParentComponent = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const summaries = {
		"!a:x": { roomId: "!a:x", name: "Design", avatarUrl: null },
		"!b:x": { roomId: "!b:x", name: "Backend", avatarUrl: null },
	} as unknown as SummariesStore;
	return (
		<ClientContext.Provider
			value={
				{
					client: {} as MatrixClient,
					syncState,
					cryptoState,
					summaries,
				} as never
			}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function hit(id: string, roomId: string, body: string) {
	return {
		eventId: id,
		sender: "@ann:x",
		senderName: "Ann",
		timestamp: 0,
		body,
		roomId,
	};
}

/** A stub hook: the panel is what is under test, not the search itself. */
function stubSearch(over: Partial<UseGlobalSearch> = {}): UseGlobalSearch {
	// `total` on both, matching the `RoomHitGroup` contract: it is what the
	// room heading renders, so a stub that omits it hides exactly the bug
	// the heading count exists to avoid.
	const groups = [
		{
			roomId: "!a:x",
			hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
			total: 2,
		},
		{
			roomId: "!b:x",
			hits: [hit("$3", "!b:x", "three")],
			total: 1,
		},
	];
	return {
		query: () => "hello",
		submissions: () => 0,
		submit: vi.fn(),
		reset: vi.fn(),
		groups: () => groups,
		total: () => 3,
		totalRooms: () => 2,
		status: () => "results",
		mode: () => "server",
		hasMore: () => false,
		hasPrevious: () => false,
		loadPrevious: vi.fn(),
		loading: () => false,
		loadMore: vi.fn(),
		error: () => null,
		highlights: () => ["hello"],
		locallyCovered: () => 0,
		encryptedRoomCount: () => 0,
		scanTruncated: () => false,
		serverUnsupported: () => false,
		...over,
	} as UseGlobalSearch;
}

afterEach(() => {
	cleanup();
	navigate.mockClear();
});

describe("GlobalSearchPanel", () => {
	it("renders without throwing", () => {
		// The panel had a memo reading two consts from above their own
		// declarations. `createMemo` evaluates eagerly, so it threw a
		// ReferenceError out of the first render and killed the sidebar -
		// and no test rendered this component, so seven review rounds and a
		// green suite never noticed.
		expect(() =>
			render(() => (
				<Wrapper>
					<GlobalSearchPanel search={stubSearch()} />
				</Wrapper>
			)),
		).not.toThrow();
	});

	it("groups results under a heading per room", () => {
		render(() => (
			<Wrapper>
				<GlobalSearchPanel search={stubSearch()} />
			</Wrapper>
		));
		expect(screen.getByText("Design")).toBeTruthy();
		expect(screen.getByText("Backend")).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(3);
	});

	it("moves DOM focus, not just aria-selected, on ArrowDown", () => {
		// The invalidation effect used to wipe the recorded elements after
		// the refs populated them, so focus never moved: only `aria-selected`
		// changed, and the eye and the screen reader disagreed.
		render(() => (
			<Wrapper>
				<GlobalSearchPanel search={stubSearch()} />
			</Wrapper>
		));
		const list = screen.getByRole("listbox");
		const options = screen.getAllByRole("option");
		options[0].focus();

		fireEvent.keyDown(list, { key: "ArrowDown" });

		expect(document.activeElement).toBe(options[1]);
		expect(options[1].getAttribute("aria-selected")).toBe("true");
	});

	it("moves focus to the far end of a full page, not just the neighbour", () => {
		// This is the case virtualization kept breaking: a row far from the
		// current one. There is no virtua mock in this file any more, so the
		// component under test is the one that ships.
		const groups = Array.from({ length: 20 }, (_, r) => ({
			roomId: `!r${r}:x`,
			hits: [hit(`$h${r}`, `!r${r}:x`, "match")],
			total: 1,
		}));
		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({ groups: () => groups, total: () => 20 })}
				/>
			</Wrapper>
		));
		const options = screen.getAllByRole("option");
		// 20 hits across 20 rooms is the worst-case row count for a page.
		expect(options).toHaveLength(20);
		options[0].focus();

		fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });

		expect(document.activeElement).toBe(options[19]);
	});

	it("reports a mouse activation as such, so focus is not stolen back", () => {
		const onNavigated = vi.fn();
		render(() => (
			<Wrapper>
				<GlobalSearchPanel search={stubSearch()} onNavigated={onNavigated} />
			</Wrapper>
		));

		fireEvent.click(screen.getAllByRole("option")[0]);

		expect(navigate).toHaveBeenCalled();
		expect(onNavigated).toHaveBeenCalledWith(false);
	});

	it("reports a keyboard activation as such", () => {
		const onNavigated = vi.fn();
		render(() => (
			<Wrapper>
				<GlobalSearchPanel search={stubSearch()} onNavigated={onNavigated} />
			</Wrapper>
		));

		fireEvent.keyDown(screen.getAllByRole("option")[0], { key: "Enter" });

		expect(onNavigated).toHaveBeenCalledWith(true);
	});

	it("does not steal focus when the pager button survives the load", async () => {
		// The rescue used to be armed on click and disarmed only by an
		// effect on `hasMore` - which does not fire when the value is
		// unchanged, the usual case. It stayed armed until the next search
		// set `hasMore` false, and then yanked focus out of the field onto
		// the previous query's last row.
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one")],
				total: 1,
			},
		]);
		const outside = document.createElement("input");
		document.body.appendChild(outside);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => groups(),
						hasMore: () => true,
						// A load that leaves more to come: the button stays.
						loadMore: () =>
							setGroups([
								{
									roomId: "!a:x",
									hits: [hit("$2", "!a:x", "two")],
									total: 1,
								},
							]),
					})}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		fireEvent.click(older);
		outside.focus();
		// A later publish must not reach back for focus.
		setGroups([
			{
				roomId: "!a:x",
				hits: [hit("$3", "!a:x", "three")],
				total: 1,
			},
		]);

		expect(document.activeElement).toBe(outside);
		document.body.removeChild(outside);
	});

	it("rescues focus when the Newer button unmounts under the press", async () => {
		// The final back-step flips `hasPrevious` false and removes the
		// button the user just activated; without a rescue focus lands on
		// <body> and the next Tab restarts at the top of the document.
		// Two rows, not one: with a single option the first and last are the
		// same element, so a rescue landing at the wrong end is invisible.
		const [prev, setPrev] = createSignal(true);
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
				total: 2,
			},
		]);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => groups(),
						hasPrevious: () => prev(),
						loadPrevious: () => {
							setPrev(false);
							setGroups([
								{
									roomId: "!a:x",
									hits: [
										hit("$0", "!a:x", "zero"),
										hit("$0b", "!a:x", "zero-b"),
									],
									total: 2,
								},
							]);
						},
					})}
				/>
			</Wrapper>
		));

		const newer = screen.getByText("Newer");
		newer.focus();
		fireEvent.click(newer);
		await Promise.resolve();

		expect(screen.queryByText("Newer")).toBeNull();
		// The *first* row of the earlier page: stepping back, the last row is
		// the far end from where the user was reading, and focusing it
		// scrolls the list to its bottom.
		expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
	});

	it("rescues focus when the pager button is disabled rather than removed", async () => {
		// Server paging sets `loading` synchronously, which disables the
		// button under the press. The browser blurs a disabled element while
		// leaving it in the document, so a rescue keyed on `isConnected`
		// took its early exit and focus stayed on <body>.
		const [loading, setLoading] = createSignal(false);
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
				total: 2,
			},
		]);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => groups(),
						hasMore: () => true,
						loading: () => loading(),
						loadMore: () => {
							setLoading(true);
							setGroups([
								{
									roomId: "!a:x",
									hits: [hit("$3", "!a:x", "three"), hit("$4", "!a:x", "four")],
									total: 2,
								},
							]);
						},
					})}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		fireEvent.click(older);
		await Promise.resolve();

		// Still in the document - only disabled - so a rescue keyed on
		// `isConnected` stands down and strands the focus that was on it.
		expect(older.isConnected).toBe(true);
		expect((older as HTMLButtonElement).disabled).toBe(true);
		// The top of the page just revealed, which is where reading it starts.
		expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
	});

	it("leaves focus alone when the pager button survives enabled", async () => {
		// The other direction of the same guard: if the button is still
		// there and still focusable, the press did not strand anything and
		// the rescue must not move the user somewhere they did not ask to
		// go.
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
				total: 2,
			},
		]);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => groups(),
						hasMore: () => true,
						loadMore: () =>
							setGroups([
								{
									roomId: "!a:x",
									hits: [hit("$3", "!a:x", "three"), hit("$4", "!a:x", "four")],
									total: 2,
								},
							]),
					})}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		fireEvent.click(older);
		await Promise.resolve();

		expect((older as HTMLButtonElement).disabled).toBe(false);
		expect(document.activeElement).toBe(older);
	});

	it("does not rescue focus after a mouse press", async () => {
		// A pointer user has focus wherever they pointed; moving it into the
		// results and scrolling the list under them is the same theft
		// `onNavigated` refuses to commit after a click.
		const [loading, setLoading] = createSignal(false);
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
				total: 2,
			},
		]);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => groups(),
						hasMore: () => true,
						loading: () => loading(),
						loadMore: () => {
							setLoading(true);
							setGroups([
								{
									roomId: "!a:x",
									hits: [hit("$3", "!a:x", "three"), hit("$4", "!a:x", "four")],
									total: 2,
								},
							]);
						},
					})}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		// `detail: 1` is a real pointer click; a keyboard-activated button
		// reports 0.
		fireEvent.click(older, { detail: 1 });
		await Promise.resolve();

		expect(document.activeElement).not.toBe(screen.getAllByRole("option")[0]);
	});

	it("says so, visibly, when a search finds nothing", () => {
		// The room list is hidden while results are showing, so with no rows
		// the pane was blank apart from an 11px disabled-grey status line.
		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => [],
						total: () => 0,
						totalRooms: () => 0,
						status: () => "empty",
					})}
				/>
			</Wrapper>
		));

		expect(screen.getByText("No messages found.")).toBeTruthy();
	});

	it("says something while refining a search that found nothing", () => {
		// Refining keeps the previous (empty) results while the next query
		// runs, so with no rows, no empty state and no note the panel was
		// blank but for an 11px status line - the failure the empty state
		// was added to fix, reached from the other side.
		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => [],
						total: () => 0,
						totalRooms: () => 0,
						status: () => "searching",
					})}
				/>
			</Wrapper>
		));

		expect(screen.getByText(/Searching/)).toBeTruthy();
	});

	it("hides the room heading from assistive tech, subtree included", () => {
		// `role="presentation"` drops only the element's own semantics; the
		// avatar, name and count stay in the tree as non-option children of
		// a listbox.
		render(() => (
			<Wrapper>
				<GlobalSearchPanel search={stubSearch()} />
			</Wrapper>
		));

		const heading = screen.getByText("Design").closest("[aria-hidden]");
		expect(heading).not.toBeNull();
		expect(heading?.getAttribute("aria-hidden")).toBe("true");
	});

	it("rescues focus even when rows are published before the button goes", async () => {
		// Order matters and must not have to. Solid flushes effects per
		// write, so a caller that publishes rows first runs this rescue
		// while the button is still mounted and enabled; standing down there
		// disarms it a moment before the next write removes the button under
		// the user's focus. The stubs in the tests above happen to write the
		// other way round, which is why they never exercised this.
		const [prev, setPrev] = createSignal(true);
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
				total: 2,
			},
		]);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => groups(),
						hasPrevious: () => prev(),
						loadPrevious: () => {
							// Rows first, flag second - the order the hook used
							// to use.
							setGroups([
								{
									roomId: "!a:x",
									hits: [hit("$0", "!a:x", "zero"), hit("$0b", "!a:x", "b")],
									total: 2,
								},
							]);
							setPrev(false);
						},
					})}
				/>
			</Wrapper>
		));

		const newer = screen.getByText("Newer");
		newer.focus();
		fireEvent.click(newer);
		await Promise.resolve();

		expect(screen.queryByText("Newer")).toBeNull();
		expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
	});

	it("disarms a pending rescue when a new query arrives", async () => {
		// `loadMore`'s server path returns without publishing once a newer
		// query supersedes it, so an arming can outlive its press. With
		// focus orphaned on <body>, the next query's publish would then be
		// rescued into results no pager press produced.
		// The submit counter is what `submit` bumps, and what the disarm
		// keys on - re-running an identical query must count too.
		const [submissions, setSubmissions] = createSignal(0);
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
				total: 2,
			},
		]);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						submissions: () => submissions(),
						groups: () => groups(),
						hasMore: () => true,
						// Never publishes: the arming survives the press.
						loadMore: () => {},
					})}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		fireEvent.click(older);
		(older as HTMLButtonElement).blur();

		// A new query lands.
		setSubmissions(1);
		setGroups([
			{
				roomId: "!b:x",
				hits: [hit("$9", "!b:x", "nine"), hit("$10", "!b:x", "ten")],
				total: 2,
			},
		]);
		await Promise.resolve();

		expect(document.activeElement).toBe(document.body);
	});

	it("does not rescue into a later query's results", async () => {
		// The rescue is deferred, so a press can still be armed when a new
		// query publishes. It must not then pull focus out of wherever the
		// user is now and into results belonging to a different search.
		const [groups, setGroups] = createSignal([
			{
				roomId: "!a:x",
				hits: [hit("$1", "!a:x", "one"), hit("$2", "!a:x", "two")],
				total: 2,
			},
		]);
		const field = document.createElement("input");
		document.body.appendChild(field);

		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => groups(),
						hasMore: () => true,
						// A press that changes nothing: the rescue stays armed.
						loadMore: () => {},
					})}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		fireEvent.click(older);

		// The user goes back to the field and runs another search.
		field.focus();
		setGroups([
			{
				roomId: "!b:x",
				hits: [hit("$9", "!b:x", "nine"), hit("$10", "!b:x", "ten")],
				total: 2,
			},
		]);
		await Promise.resolve();

		expect(document.activeElement).toBe(field);
		document.body.removeChild(field);
	});

	it("dismisses on Escape with the pager up and no rows at all", async () => {
		// The state the code explicitly designs for: a server page that
		// projects to nothing while `next_batch` is set, so the listbox is
		// unmounted and the pager is not. The empty-rows guard used to run
		// first and swallow Escape exactly there.
		const onDismiss = vi.fn();
		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({
						groups: () => [],
						total: () => 0,
						totalRooms: () => 0,
						status: () => "empty",
						hasMore: () => true,
					})}
					onDismiss={onDismiss}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		fireEvent.keyDown(older, { key: "Escape" });

		expect(onDismiss).toHaveBeenCalled();
	});

	it("dismisses on Escape from a pager button, not only from the list", async () => {
		// The buttons are the listbox's siblings, so a handler bound to the
		// listbox never saw them.
		const onDismiss = vi.fn();
		render(() => (
			<Wrapper>
				<GlobalSearchPanel
					search={stubSearch({ hasMore: () => true })}
					onDismiss={onDismiss}
				/>
			</Wrapper>
		));

		const older = screen.getByText("Older");
		older.focus();
		fireEvent.keyDown(older, { key: "Escape" });

		expect(onDismiss).toHaveBeenCalled();
	});
});
