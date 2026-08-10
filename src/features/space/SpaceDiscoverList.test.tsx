import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoverEntry } from "./SpaceDiscoverList";
import type { DiscoverableRoom } from "./useSpaceHierarchy";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function makeRoom(overrides: Partial<DiscoverableRoom> = {}): DiscoverableRoom {
	return {
		roomId: "!room:example.com",
		name: "Clubhouse",
		avatarUrl: null,
		topic: null,
		memberCount: 7,
		joinRule: "knock",
		canJoin: false,
		canKnock: true,
		...overrides,
	};
}

afterEach(cleanup);

describe("DiscoverEntry knock button (#442)", () => {
	it("renders a Request button for knockable rooms and fires onRequest", () => {
		const onRequest = vi.fn();
		render(() => (
			<DiscoverEntry
				room={makeRoom()}
				joinState="idle"
				onJoin={vi.fn()}
				onRequest={onRequest}
			/>
		));
		const button = screen.getByRole("button", {
			name: "Request to join Clubhouse",
		});
		expect(button.textContent).toBe("Request");
		expect((button as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(button);
		expect(onRequest).toHaveBeenCalledOnce();
	});

	it("shows the Invite only label for rooms that are neither joinable nor knockable", () => {
		render(() => (
			<DiscoverEntry
				room={makeRoom({ canJoin: false, canKnock: false })}
				joinState="idle"
				onJoin={vi.fn()}
				onRequest={vi.fn()}
			/>
		));
		expect(screen.getByText("Invite only")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("joinable rooms show Join, not Request, with per-state labels and disabling", () => {
		const room = makeRoom({ canJoin: true, canKnock: true });
		const { unmount } = render(() => (
			<DiscoverEntry
				room={room}
				joinState="idle"
				onJoin={vi.fn()}
				onRequest={vi.fn()}
			/>
		));
		expect(screen.getByRole("button", { name: "Join Clubhouse" })).toBeTruthy();
		expect(screen.queryByText("Request")).toBeNull();
		unmount();

		render(() => (
			<DiscoverEntry
				room={room}
				joinState="joined"
				onJoin={vi.fn()}
				onRequest={vi.fn()}
			/>
		));
		const joined = screen.getByRole("button", {
			name: "Joined Clubhouse",
		});
		expect(joined.textContent).toBe("Joined");
		expect((joined as HTMLButtonElement).disabled).toBe(true);
	});
});
