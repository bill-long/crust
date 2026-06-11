import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Controllable stand-in for the viewport store so we can drive the
// mobile/desktop breakpoint deterministically (jsdom has no matchMedia).
const vp = vi.hoisted(() => ({
	setMobile: undefined as undefined | ((v: boolean) => void),
}));

vi.mock("../stores/viewport", async () => {
	const { createSignal } = await import("solid-js");
	const [isMobile, setIsMobile] = createSignal(false);
	vp.setMobile = setIsMobile;
	return { isMobile };
});

import { ResizableLayout } from "./ResizableLayout";

afterEach(() => {
	cleanup();
	vp.setMobile?.(false);
});

const renderLayout = (showMain: boolean) =>
	render(() => (
		<ResizableLayout
			showMainOnMobile={() => showMain}
			spaces={<div>SPACES</div>}
			roomList={<div>ROOMS</div>}
			main={<div>MAIN</div>}
			userBar={<div>USERBAR</div>}
		/>
	));

describe("ResizableLayout", () => {
	it("desktop renders all three panes side-by-side with resize dividers", () => {
		vp.setMobile?.(false);
		renderLayout(false);
		expect(screen.getByText("SPACES")).toBeTruthy();
		expect(screen.getByText("ROOMS")).toBeTruthy();
		expect(screen.getByText("MAIN")).toBeTruthy();
		// Two dividers on desktop: spaces|roomList and sidebar|main.
		expect(screen.getAllByRole("separator")).toHaveLength(2);
	});

	it("mobile with no room selected shows the sidebar pane and hides main", () => {
		vp.setMobile?.(true);
		renderLayout(false);
		expect(screen.getByText("SPACES")).toBeTruthy();
		expect(screen.getByText("ROOMS")).toBeTruthy();
		expect(screen.getByText("USERBAR")).toBeTruthy();
		expect(screen.queryByText("MAIN")).toBeNull();
		// No resize dividers in the single-pane mobile layout.
		expect(screen.queryAllByRole("separator")).toHaveLength(0);
	});

	it("mobile with a room selected shows the main pane and hides the sidebar", () => {
		vp.setMobile?.(true);
		renderLayout(true);
		expect(screen.getByText("MAIN")).toBeTruthy();
		expect(screen.queryByText("SPACES")).toBeNull();
		expect(screen.queryByText("ROOMS")).toBeNull();
		expect(screen.queryAllByRole("separator")).toHaveLength(0);
	});

	it("reacts to a viewport change without remounting", () => {
		vp.setMobile?.(false);
		renderLayout(true);
		// Desktop: both sidebar and main visible.
		expect(screen.getByText("ROOMS")).toBeTruthy();
		expect(screen.getByText("MAIN")).toBeTruthy();
		// Switch to mobile with a room selected: sidebar collapses, main remains.
		vp.setMobile?.(true);
		expect(screen.queryByText("ROOMS")).toBeNull();
		expect(screen.getByText("MAIN")).toBeTruthy();
	});
});
