import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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
