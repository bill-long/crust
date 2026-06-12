/**
 * Browser-mode tests for TimelineView's Phase 2 drag-and-drop overlay
 * (issue #276): the room-wide drop target that feeds dropped files into
 * the composer's enqueue seam.
 *
 * The composer is stubbed to capture the `onEnqueueReady` callback so the
 * drop wiring can be asserted without rendering the full composer. The
 * `useTimeline` harness mirrors TimelineView's other browser tests.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, onMount } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import { createMockClient } from "../../../test/mockClient";
import {
	installTimelineHarness,
	makeTimelineHarnessRef,
	TestClientProvider,
} from "../../../test/TimelineHarness";

const harness = makeTimelineHarnessRef();
vi.mock("./useTimeline", () => ({
	useTimeline: installTimelineHarness(harness),
}));

// Capture the enqueue seam the composer hands up via onEnqueueReady. The
// `mock` prefix opts this variable out of vitest's vi.mock hoisting guard.
const mockEnqueue = vi.fn();
vi.mock("../composer/Composer", () => ({
	// biome-ignore lint/suspicious/noExplicitAny: minimal prop shape for the stub
	Composer: (props: any) => {
		onMount(() => props.onEnqueueReady?.(mockEnqueue));
		return null;
	},
}));

const { TimelineView } = await import("./TimelineView");

const OVERLAY_TEXT = "Drop files to upload";

/** Build a DragEvent carrying the given files (so `dataTransfer.types` has "Files"). */
function fileDragEvent(type: string, files: File[]): DragEvent {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	return new DragEvent(type, {
		bubbles: true,
		cancelable: true,
		dataTransfer: dt,
	});
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function getMain(container: HTMLElement): HTMLElement {
	const el = container.querySelector("main");
	if (!el) throw new Error("main not found");
	return el;
}

afterEach(() => {
	cleanup();
	harness.reset();
	mockEnqueue.mockReset();
});

describe("TimelineView drag-and-drop", () => {
	it("shows the overlay while files are dragged over and hides it on leave", async () => {
		const { container, queryByText } = render(() => (
			<TestClientProvider client={createMockClient()}>
				<TimelineView roomId="!a:example.com" />
			</TestClientProvider>
		));
		await tick();
		const main = getMain(container);

		expect(queryByText(OVERLAY_TEXT)).toBeNull();

		main.dispatchEvent(fileDragEvent("dragenter", [new File(["x"], "a.png")]));
		await tick();
		expect(queryByText(OVERLAY_TEXT)).toBeTruthy();

		main.dispatchEvent(fileDragEvent("dragleave", [new File(["x"], "a.png")]));
		await tick();
		expect(queryByText(OVERLAY_TEXT)).toBeNull();
	});

	it("ignores non-file drags (e.g. text selection)", async () => {
		const { container, queryByText } = render(() => (
			<TestClientProvider client={createMockClient()}>
				<TimelineView roomId="!a:example.com" />
			</TestClientProvider>
		));
		await tick();
		const main = getMain(container);

		const dt = new DataTransfer();
		dt.setData("text/plain", "hello");
		main.dispatchEvent(
			new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }),
		);
		await tick();
		expect(queryByText(OVERLAY_TEXT)).toBeNull();
	});

	it("enqueues dropped files into the composer and clears the overlay", async () => {
		const { container, queryByText } = render(() => (
			<TestClientProvider client={createMockClient()}>
				<TimelineView roomId="!a:example.com" />
			</TestClientProvider>
		));
		await tick();
		const main = getMain(container);

		main.dispatchEvent(fileDragEvent("dragenter", [new File(["x"], "a.png")]));
		await tick();
		expect(queryByText(OVERLAY_TEXT)).toBeTruthy();

		const file = new File(["bytes"], "dropped.bin", {
			type: "application/octet-stream",
		});
		main.dispatchEvent(fileDragEvent("drop", [file]));
		await tick();

		expect(mockEnqueue).toHaveBeenCalledTimes(1);
		const passed = mockEnqueue.mock.calls[0][0] as FileList;
		expect(passed.length).toBe(1);
		expect(passed[0].name).toBe("dropped.bin");
		// Drop ends the drag, so the overlay is gone.
		expect(queryByText(OVERLAY_TEXT)).toBeNull();
	});

	it("clears a stuck overlay when the room switches mid-drag", async () => {
		let setRoomId: ((r: string) => void) | undefined;
		const Harness = () => {
			const [roomId, setRid] = createSignal("!a:example.com");
			setRoomId = setRid;
			return (
				<TestClientProvider client={createMockClient()}>
					<TimelineView roomId={roomId()} />
				</TestClientProvider>
			);
		};
		const { container, queryByText } = render(() => <Harness />);
		await tick();
		const main = getMain(container);

		main.dispatchEvent(fileDragEvent("dragenter", [new File(["x"], "a.png")]));
		await tick();
		expect(queryByText(OVERLAY_TEXT)).toBeTruthy();

		setRoomId?.("!b:example.com");
		await tick();
		expect(queryByText(OVERLAY_TEXT)).toBeNull();
	});
});
