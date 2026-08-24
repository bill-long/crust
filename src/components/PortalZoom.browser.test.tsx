/**
 * Browser-mode regression tests for #487/#485: Kobalte popovers portal into
 * document.body, so the app's UI-scale zoom MUST NOT create a zoom context
 * around them. When zoom sat on <html>, floating-ui measured trigger rects in
 * visual pixels, positioned in zoomed pixels, and read the clipping viewport
 * in logical pixels - popovers landed far from their triggers (pinned panel in
 * the "white bar", #485) or clean off-screen (UserBar chevron drop-up, #487).
 *
 * The arrangement under test: zoom lives on #root (global.css), portaled
 * content re-scales itself via `.portal-scale`. Needs a real browser - jsdom
 * does no layout, which is exactly why the original bug never failed CI.
 */

import { Popover } from "@kobalte/core/popover";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../styles/global.css";

const ZOOM = 1.3;

beforeEach(() => {
	document.documentElement.style.setProperty("--app-zoom", `${ZOOM}`);
});

afterEach(() => {
	cleanup();
	document.documentElement.style.removeProperty("--app-zoom");
	document.getElementById("root")?.remove();
});

/** Mount UI inside a zoomed #root container, mirroring the app shell. */
function renderInZoomedRoot(ui: () => import("solid-js").JSX.Element): void {
	const root = document.createElement("div");
	root.id = "root"; // picks up global.css's `#root { zoom: var(--app-zoom) }`
	document.body.appendChild(root);
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

describe("portal positioning under UI zoom (#487/#485)", () => {
	it("positions a bottom-anchored drop-up above its trigger, fully on-screen", async () => {
		renderInZoomedRoot(popoverFixture);
		const trigger = document.querySelector<HTMLElement>(
			'[data-testid="zoom-trigger"]',
		);
		if (!trigger) throw new Error("trigger missing");
		trigger.click();
		const content = await new Promise<HTMLElement>((resolve, reject) => {
			const t0 = performance.now();
			const poll = (): void => {
				const el = document.querySelector<HTMLElement>(
					'[data-testid="zoom-content"]',
				);
				if (el) {
					resolve(el);
					return;
				}
				if (performance.now() - t0 > 3000) {
					reject(new Error("no content"));
					return;
				}
				requestAnimationFrame(poll);
			};
			poll();
		});
		// Give floating-ui a frame to settle its position.
		await new Promise((r) => requestAnimationFrame(() => r(null)));

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

	it("keeps the portal container outside the zoom context", () => {
		renderInZoomedRoot(popoverFixture);
		// body children other than #root (Kobalte portals) must not inherit
		// a zoom from an ancestor - #root is the only zoomed element.
		const root = document.getElementById("root");
		if (!root) throw new Error("root missing");
		expect(getComputedStyle(root).zoom).toBe(`${ZOOM}`);
		expect(getComputedStyle(document.documentElement).zoom).toBe("1");
		expect(getComputedStyle(document.body).zoom).toBe("1");
	});
});
