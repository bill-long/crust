/**
 * Browser-mode regression tests for #487/#485: Kobalte popovers portal into
 * document.body, so the app's UI-scale zoom MUST NOT create a zoom context
 * around them. When zoom sat on <html>, floating-ui measured trigger rects in
 * visual pixels, positioned in zoomed pixels, and read the clipping viewport
 * in logical pixels - popovers landed far from their triggers (pinned panel in
 * the "white bar", #485) or clean off-screen (UserBar chevron drop-up, #487).
 *
 * The arrangement under test: `updateSetting("zoomLevel", ...)` drives
 * applyZoom, which writes ONLY `--app-zoom`; global.css zooms `#root` from
 * the variable and portaled content re-scales itself via `.portal-scale`.
 * Driving the real settings path (not hand-set styles) means a regression in
 * applyZoom itself - e.g. re-zooming <html>, the exact #487 bug - fails here.
 * Needs a real browser: jsdom does no layout, which is exactly why the
 * original bug never failed CI.
 */

import { Popover } from "@kobalte/core/popover";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../styles/global.css";
import { updateSetting } from "../stores/settings";

const ZOOM = 1.3;

beforeEach(() => {
	// #root must exist before applyZoom runs (production order: index.html
	// provides it before app bootstrap).
	const root = document.createElement("div");
	root.id = "root"; // picks up global.css's `#root { zoom: var(--app-zoom) }`
	document.body.appendChild(root);
	updateSetting("zoomLevel", ZOOM * 100);
});

afterEach(() => {
	cleanup();
	updateSetting("zoomLevel", 100);
	localStorage.removeItem("crust:settings");
	document.getElementById("root")?.remove();
});

/** Mount UI inside the zoomed #root container, mirroring the app shell. */
function renderInRoot(ui: () => import("solid-js").JSX.Element): void {
	const root = document.getElementById("root");
	if (!root) throw new Error("#root missing");
	render(ui, { container: root });
}

function popoverFixture(): import("solid-js").JSX.Element {
	return (
		<Popover placement="top-start" gutter={8}>
			<Popover.Trigger
				data-testid="zoom-trigger"
				// Anchored near the bottom-left of the viewport, like the
				// UserBar chevron - the placement that fell off-screen in #487.
				style={{
					position: "fixed",
					left: "16px",
					bottom: "16px",
					width: "40px",
					height: "24px",
				}}
			>
				open
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					data-testid="zoom-content"
					class="portal-scale"
					style={{ width: "200px", height: "120px" }}
				>
					drop-up content
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}

async function openPopover(): Promise<{
	trigger: HTMLElement;
	content: HTMLElement;
}> {
	const trigger = await screen.findByTestId("zoom-trigger");
	trigger.click();
	const content = await screen.findByTestId("zoom-content");
	// Give floating-ui a frame to settle its position.
	await new Promise((r) => requestAnimationFrame(() => r(null)));
	return { trigger, content };
}

describe("portal positioning under UI zoom (#487/#485)", () => {
	it("positions a bottom-anchored drop-up above its trigger, fully on-screen", async () => {
		renderInRoot(popoverFixture);
		const { trigger, content } = await openPopover();

		const t = trigger.getBoundingClientRect();
		const c = content.getBoundingClientRect();
		// Fully on-screen (the #487 failure put it below the viewport).
		expect(c.top).toBeGreaterThanOrEqual(0);
		expect(c.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
		expect(c.left).toBeGreaterThanOrEqual(0);
		// Anchored to the trigger: content bottom sits just above trigger top
		// (top-start with an 8px gutter), not hundreds of pixels away (#485).
		expect(Math.abs(t.top - c.bottom)).toBeLessThanOrEqual(24);
		expect(Math.abs(t.left - c.left)).toBeLessThanOrEqual(24);
		// The portaled surface re-applies the user's scale.
		expect(getComputedStyle(content).zoom).toBe(`${ZOOM}`);
	});

	it("keeps the portaled content outside every zoom context except its own", async () => {
		renderInRoot(popoverFixture);
		const { content } = await openPopover();

		// The app root carries the scale; document chrome does not - a
		// regression that re-zooms <html> (the original #487 bug) fails here
		// because updateSetting drove the REAL applyZoom above.
		const root = document.getElementById("root");
		if (!root) throw new Error("root missing");
		expect(getComputedStyle(root).zoom).toBe(`${ZOOM}`);
		expect(getComputedStyle(document.documentElement).zoom).toBe("1");
		expect(getComputedStyle(document.body).zoom).toBe("1");
		// Every ANCESTOR of the really-opened portal content (its positioner
		// wrapper, the portal container, body, html) is unzoomed - only the
		// content itself opts back into the scale via .portal-scale.
		let node: HTMLElement | null = content.parentElement;
		while (node) {
			expect(getComputedStyle(node).zoom).toBe("1");
			node = node.parentElement;
		}
	});
});
