import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadPanel } from "./ThreadPanel";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// The panel's job under test is its own chrome (header, close, Esc,
// resource states); the timeline machinery has its own suites.
vi.mock("../timeline/TimelineView", () => ({
	TimelineView: (props: { thread?: { threadId: string } }) => (
		<div data-testid="thread-timeline">{props.thread?.threadId}</div>
	),
}));

const getRoom = vi.fn();
vi.mock("../../../client/client", () => ({
	useClient: () => ({ client: { getRoom } }),
}));

afterEach(() => {
	cleanup();
	getRoom.mockReset();
});

function roomWithThread(thread: unknown) {
	return { getThread: () => thread };
}

describe("ThreadPanel", () => {
	it("mounts the thread-scoped timeline once the thread resolves", async () => {
		getRoom.mockReturnValue(
			roomWithThread({ id: "$root", initialEventsFetched: true }),
		);
		render(() => (
			<ThreadPanel roomId="!r:hs" threadId="$root" onClose={() => {}} />
		));
		expect(await screen.findByTestId("thread-timeline")).toBeTruthy();
		expect(screen.getByTestId("thread-timeline").textContent).toBe("$root");
	});

	it("shows a failure state when the thread can't load", async () => {
		getRoom.mockReturnValue(null);
		render(() => (
			<ThreadPanel roomId="!r:hs" threadId="$root" onClose={() => {}} />
		));
		expect(await screen.findByText("Couldn't load this thread")).toBeTruthy();
	});

	it("restores focus to the opener when closed with focus inside", async () => {
		getRoom.mockReturnValue(
			roomWithThread({ id: "$root", initialEventsFetched: true }),
		);
		const [open, setOpen] = createSignal(false);
		render(() => (
			<>
				<button type="button" data-testid="opener">
					open
				</button>
				<Show when={open()}>
					<ThreadPanel roomId="!r:hs" threadId="$root" onClose={() => {}} />
				</Show>
			</>
		));
		screen.getByTestId("opener").focus();
		setOpen(true);
		await screen.findByTestId("thread-timeline");
		// Mount moved focus into the panel; closing hands it back.
		expect(screen.getByLabelText("Thread")).toBe(document.activeElement);
		setOpen(false);
		expect(document.activeElement).toBe(screen.getByTestId("opener"));
	});

	it("does not steal focus when closed while focus is elsewhere", async () => {
		getRoom.mockReturnValue(
			roomWithThread({ id: "$root", initialEventsFetched: true }),
		);
		const [open, setOpen] = createSignal(false);
		render(() => (
			<>
				<button type="button" data-testid="opener">
					open
				</button>
				<button type="button" data-testid="elsewhere">
					elsewhere
				</button>
				<Show when={open()}>
					<ThreadPanel roomId="!r:hs" threadId="$root" onClose={() => {}} />
				</Show>
			</>
		));
		screen.getByTestId("opener").focus();
		setOpen(true);
		await screen.findByTestId("thread-timeline");
		// The user moved on (e.g. to the main composer); a programmatic
		// close (room switch) must not yank focus back to the opener.
		screen.getByTestId("elsewhere").focus();
		setOpen(false);
		expect(document.activeElement).toBe(screen.getByTestId("elsewhere"));
	});

	it("re-captures focus per thread under a keyed Show (Layout wiring)", async () => {
		getRoom.mockReturnValue(
			roomWithThread({ id: "$root", initialEventsFetched: true }),
		);
		const [tid, setTid] = createSignal<string | null>("$a");
		render(() => (
			<>
				<button type="button" data-testid="chip-b">
					other chip
				</button>
				<Show when={tid()} keyed>
					{(threadId) => (
						<ThreadPanel
							roomId="!r:hs"
							threadId={threadId}
							onClose={() => {}}
						/>
					)}
				</Show>
			</>
		));
		await screen.findByTestId("thread-timeline");
		expect(screen.getByTestId("thread-timeline").textContent).toBe("$a");
		// Switching threads from another root's chip must remount the panel:
		// focus moves into the NEW panel (keeping Escape live) rather than
		// staying on the chip with the old panel updated in place.
		screen.getByTestId("chip-b").focus();
		setTid("$b");
		await screen.findByTestId("thread-timeline");
		expect(screen.getByTestId("thread-timeline").textContent).toBe("$b");
		expect(document.activeElement).toBe(screen.getByLabelText("Thread"));
	});

	it("closes via the button and via Escape", async () => {
		getRoom.mockReturnValue(
			roomWithThread({ id: "$root", initialEventsFetched: true }),
		);
		const onClose = vi.fn();
		render(() => (
			<ThreadPanel roomId="!r:hs" threadId="$root" onClose={onClose} />
		));
		await screen.findByTestId("thread-timeline");
		fireEvent.click(screen.getByLabelText("Close thread"));
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(screen.getByLabelText("Thread"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
