import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { createSignal } from "solid-js";
import { Avatar } from "./Avatar";

afterEach(cleanup);

// An <img> with an empty alt is presentational (no "img" ARIA role), so query
// by tag rather than role - the fallback path deliberately omits alt.
function img(container: HTMLElement): HTMLImageElement | null {
	return container.querySelector("img");
}

describe("Avatar", () => {
	it("renders the image when a url is provided", () => {
		const { container } = render(() => (
			<Avatar url="https://example.com/a.png" initial="A" alt="Alice" />
		));
		const el = img(container);
		expect(el?.src).toBe("https://example.com/a.png");
		expect(el?.alt).toBe("Alice");
	});

	it("uses an empty alt when none is supplied", () => {
		const { container } = render(() => (
			<Avatar url="https://example.com/a.png" initial="A" />
		));
		expect(img(container)?.alt).toBe("");
	});

	it("shows the initial fallback when url is null", () => {
		const { container, getByText } = render(() => (
			<Avatar url={null} initial="Q" />
		));
		expect(img(container)).toBeNull();
		expect(getByText("Q")).toBeTruthy();
	});

	it("falls back to the initial when the image errors", () => {
		const { container, getByText } = render(() => (
			<Avatar url="https://example.com/broken.png" initial="Z" />
		));
		img(container)?.dispatchEvent(new Event("error"));
		expect(img(container)).toBeNull();
		expect(getByText("Z")).toBeTruthy();
	});

	it("wraps the avatar once when a presence dot is wanted", () => {
		// `inner()` is written twice - as the <Show> fallback and inside the
		// wrapped branch - which reads like the avatar gets built both ways on
		// every render. It does not: Solid compiles a call expression in a
		// component prop to a getter, so <Show> reads `fallback` only when the
		// condition is false. What this pins is the outcome that matters -
		// one avatar, inside the wrapper, with the dot as its sibling.
		const { container, getByLabelText } = render(() => (
			<Avatar
				url="https://example.com/a.png"
				initial="A"
				alt="Alice"
				presence="online"
			/>
		));
		expect(container.querySelectorAll("img")).toHaveLength(1);
		const dot = getByLabelText("Online");
		expect(img(container)?.parentElement).toBe(dot.parentElement);
	});

	it("adds no wrapper element when presence is omitted", () => {
		// Every call site that predates #445 renders a bare avatar, and
		// wrapping all of them would change flex/grid behaviour across the app
		// for no reason - so the wrapper has to stay opt-in.
		const { container, queryByLabelText } = render(() => (
			<Avatar url="https://example.com/a.png" initial="A" alt="Alice" />
		));
		expect(queryByLabelText("Online")).toBeNull();
		expect(img(container)?.parentElement).toBe(container);
	});

	it("recovers from a prior error when the url changes", () => {
		const [url, setUrl] = createSignal<string | null>(
			"https://example.com/broken.png",
		);
		const { container } = render(() => <Avatar url={url()} initial="Z" />);
		img(container)?.dispatchEvent(new Event("error"));
		expect(img(container)).toBeNull();

		// A new url resets the failed state and re-attempts the image.
		setUrl("https://example.com/fresh.png");
		expect(img(container)?.src).toBe("https://example.com/fresh.png");
	});
});
