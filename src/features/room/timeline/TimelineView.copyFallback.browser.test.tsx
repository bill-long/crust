/**
 * Browser-mode integration test for the timeline-level "Copy text"
 * fallback wiring: TimelineView's createCopyLink + the hoisted
 * CopyLinkFallbackDialog. TimelineItem is stubbed at its onCopyText
 * seam - opening the real Kobalte overflow menu inside the virtualized
 * harness destabilizes floating-ui's autoUpdate in headless Chromium
 * (endless ResizeObserver loops), and the real menu -> callback path is
 * covered separately by TimelineItem.copyText.browser.test.tsx.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import {
	installTimelineHarness,
	makeTimelineHarnessRef,
	TestClientProvider,
} from "../../../test/TimelineHarness";
import { makeTimelineEvent } from "../../../test/timelineEvent";

const harness = makeTimelineHarnessRef();

vi.mock("./useTimeline", () => ({
	useTimeline: installTimelineHarness(harness),
}));
vi.mock("../composer/Composer", () => ({ Composer: () => null }));
// Stub the row at the onCopyText seam (see the header comment).
vi.mock("./TimelineItem", () => ({
	TimelineItem: (props: {
		event: { eventId: string; body: string };
		onCopyText?: (text: string) => void;
	}) => (
		<button
			type="button"
			data-copy-stub={props.event.eventId}
			onClick={() => props.onCopyText?.(props.event.body)}
		>
			copy stub
		</button>
	),
}));

const { TimelineView } = await import("./TimelineView");

const ROOM_ID = "!copyfallback:example.com";

beforeEach(() => {
	harness.reset();
});

afterEach(() => cleanup());

describe("TimelineView copy-text fallback (browser)", () => {
	it("opens the hoisted dialog with the multiline text when the clipboard write rejects", async () => {
		harness.setRoomState(ROOM_ID, {
			events: [
				makeTimelineEvent({ eventId: "$copyme", body: "line one\nline two" }),
			],
		});
		const writeText = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockRejectedValue(new Error("denied"));
		// Sized fixed wrapper: virtua renders zero rows in a zero-height
		// scroller (same reason the main TimelineView suite mounts one).
		const wrapper = document.createElement("div");
		wrapper.style.cssText =
			"position:fixed;inset:0;width:400px;height:400px;background:#000;";
		document.body.appendChild(wrapper);
		const { container, unmount: unmountRendered } = render(
			() => (
				<TestClientProvider>
					<TimelineView roomId={ROOM_ID} />
				</TestClientProvider>
			),
			{ container: wrapper },
		);
		const unmount = (): void => {
			unmountRendered();
			wrapper.remove();
		};
		const stub = await vi.waitFor(() => {
			const el = container.querySelector<HTMLButtonElement>(
				'[data-copy-stub="$copyme"]',
			);
			if (!el) throw new Error("stub row not rendered");
			return el;
		});
		stub.click();
		const ta = await vi.waitFor(() => {
			const el = document.body.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Message text"]',
			);
			if (!el) throw new Error("fallback dialog not open");
			return el;
		});
		expect(writeText).toHaveBeenCalledWith("line one\nline two");
		// Multiline body survives into the field (textarea, not <input>).
		expect(ta.value).toBe("line one\nline two");
		// The dialog is hosted at the timeline level, outside any virtua
		// row - a fixed overlay inside a row would be clipped by its
		// contain: layout wrapper and die when the row leaves the render
		// window.
		expect(ta.closest("[data-event-id]")).toBeNull();
		const dialog = ta.closest<HTMLElement>('[role="dialog"]');
		const close = [
			...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []),
		].find((b) => b.textContent?.trim() === "Close");
		if (!close) throw new Error("no Close button");
		close.click();
		await vi.waitFor(() => {
			expect(
				document.body.querySelector('textarea[aria-label="Message text"]'),
			).toBeNull();
		});
		writeText.mockRestore();
		unmount();
	});
});
