import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { Avatar } from "./Avatar";
import { PresenceDot } from "./PresenceDot";

afterEach(cleanup);

describe("PresenceDot", () => {
	it("announces each state it draws", () => {
		render(() => <PresenceDot status="online" />);
		expect(screen.getByRole("img", { name: "Online" })).toBeTruthy();
	});

	it("labels idle by the word every other client uses", () => {
		render(() => <PresenceDot status="idle" />);
		expect(screen.getByRole("img", { name: "Idle" })).toBeTruthy();
	});

	it("draws nothing for a user we have never heard about", () => {
		// A grey dot would assert they are offline, which is a different and
		// possibly wrong claim.
		const { container } = render(() => <PresenceDot status="unknown" />);
		expect(container.querySelector("span")).toBeNull();
	});
});

describe("Avatar presence overlay", () => {
	it("shows the dot when a presence is given", () => {
		render(() => (
			<Avatar url={null} initial="A" alt="Alice" presence="online" />
		));
		expect(screen.getByRole("img", { name: "Online" })).toBeTruthy();
		expect(screen.getByRole("img", { name: "Alice" })).toBeTruthy();
	});

	it("adds no wrapper at all where presence has no meaning", () => {
		// Room avatars and space tiles pass no presence; introducing a
		// wrapper for them would change flex/grid behaviour app-wide.
		const { container } = render(() => (
			<Avatar url={null} initial="R" alt="Room" />
		));
		expect(container.querySelector("span.relative")).toBeNull();
	});

	it("omits the dot for unknown without losing the avatar", () => {
		render(() => (
			<Avatar url={null} initial="A" alt="Alice" presence="unknown" />
		));
		expect(screen.queryByRole("img", { name: "Online" })).toBeNull();
		expect(screen.getByRole("img", { name: "Alice" })).toBeTruthy();
	});

	it("scales the dot with the portrait size", () => {
		const { container } = render(() => (
			<Avatar url={null} initial="A" alt="Alice" size="xl" presence="online" />
		));
		const dot = container.querySelector('[aria-label="Online"]');
		expect(dot?.className).toContain("h-4");
	});
});
