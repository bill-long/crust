import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
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
vi.mock("../../gif/gifConfig", () => ({
	useGifConfig: () => ({ available: () => false }),
}));

const { TimelineView } = await import("./TimelineView");

afterEach(() => cleanup());

it("focuses the composer on every Reply click and preserves the draft", async () => {
	const roomId = "!reply:example.com";
	harness.setRoomState(roomId, {
		events: [makeTimelineEvent({ eventId: "$reply", body: "Reply to this" })],
	});
	const { container, getByRole } = render(() => (
		<TestClientProvider>
			<div style={{ width: "800px", height: "500px" }}>
				<TimelineView roomId={roomId} />
			</div>
		</TestClientProvider>
	));
	const input = getByRole("textbox", { name: "Message" });
	await userEvent.fill(input, "Existing draft");
	const reply = await vi.waitFor(() => {
		const button = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Reply"]',
		);
		if (!button) throw new Error("Reply button not rendered");
		return button;
	});
	for (let i = 0; i < 2; i++) {
		await userEvent.hover(
			container.querySelector('[data-event-id="$reply"]') as HTMLElement,
		);
		await userEvent.click(reply);
		await expect.poll(() => document.activeElement).toBe(input);
		await userEvent.keyboard("!");
		expect((input as HTMLTextAreaElement).value).toBe(
			`Existing draft${"!".repeat(i + 1)}`,
		);
	}
});
