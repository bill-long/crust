import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createFailedImageUrls,
	type FailedImageUrls,
} from "../../../lib/imageFallback";
import { GroupedMembershipNotice } from "./GroupedMembershipNotice";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(cleanup);

/** The timeline owns the registry in the app; tests stand in for it. It must
    be one stable instance per render - a fresh one per read would never see
    the failure the <img> reported. */
function makeRegistry(): FailedImageUrls {
	return createRoot(() => createFailedImageUrls());
}

function renderNotice(avatarUrl: string | null) {
	const registry = makeRegistry();
	return render(() => (
		<GroupedMembershipNotice
			members={[
				{ userId: "@alice:example.com", name: "Alice", avatarUrl },
				{ userId: "@bob:example.com", name: "Bob", avatarUrl: null },
			]}
			kind="join"
			leaderEventId="$lead"
			timestamp={1_700_000_000_000}
			onExpand={() => {}}
			brokenAvatars={registry}
		/>
	));
}

describe("GroupedMembershipNotice", () => {
	it("summarizes the run and expands on click", () => {
		const onExpand = vi.fn();
		const registry = makeRegistry();
		render(() => (
			<GroupedMembershipNotice
				members={[
					{ userId: "@alice:example.com", name: "Alice", avatarUrl: null },
					{ userId: "@bob:example.com", name: "Bob", avatarUrl: null },
				]}
				kind="join"
				leaderEventId="$lead"
				timestamp={1_700_000_000_000}
				onExpand={onExpand}
				brokenAvatars={registry}
			/>
		));
		const trigger = screen.getByRole("button", { expanded: false });
		expect(trigger.textContent).toContain("Alice");

		fireEvent.click(trigger);
		expect(onExpand).toHaveBeenCalledTimes(1);
	});

	it("falls back to the member initial when a stacked avatar errors (#457)", () => {
		const { container } = renderNotice("https://example.com/broken.png");
		expect(container.querySelector("img")).not.toBeNull();

		fireEvent.error(container.querySelector("img") as HTMLImageElement);

		expect(container.querySelector("img")).toBeNull();
		// Alice's initial takes the failed image's place; Bob already had one.
		expect(screen.getAllByText("A").length).toBeGreaterThan(0);
	});

	it("renders initials without any image when no avatars are set", () => {
		const { container } = renderNotice(null);
		expect(container.querySelector("img")).toBeNull();
	});
});
