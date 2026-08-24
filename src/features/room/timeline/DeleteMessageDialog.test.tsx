import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { DeleteMessageDialog } from "./DeleteMessageDialog";
import type { TimelineEvent } from "./timelineTypes";

afterEach(cleanup);

function makeEvent(body = "hello world"): TimelineEvent {
	return { eventId: "$ev", body } as unknown as TimelineEvent;
}

function setup() {
	const [target, setTarget] = createSignal<TimelineEvent | null>(makeEvent());
	const onClose = vi.fn(() => setTarget(null));
	const onDelete = vi.fn();
	render(() => (
		<DeleteMessageDialog
			target={target}
			onClose={onClose}
			onDelete={onDelete}
		/>
	));
	return { setTarget, onClose, onDelete };
}

describe("DeleteMessageDialog", () => {
	it("shows the message preview and deletes with the typed reason", () => {
		const { onClose, onDelete } = setup();
		expect(screen.getByText("hello world")).toBeTruthy();
		fireEvent.input(screen.getByPlaceholderText(/Visible to other clients/), {
			target: { value: "spam" },
		});
		fireEvent.click(screen.getByText("Delete"));
		expect(onDelete).toHaveBeenCalledWith("$ev", "spam");
		expect(onClose).toHaveBeenCalled();
	});

	it("clears the reason when reopened for another message", () => {
		const { setTarget, onDelete } = setup();
		fireEvent.input(screen.getByPlaceholderText(/Visible to other clients/), {
			target: { value: "stale reason" },
		});
		setTarget(null);
		setTarget({
			eventId: "$other",
			body: "second",
		} as unknown as TimelineEvent);
		fireEvent.click(screen.getByText("Delete"));
		expect(onDelete).toHaveBeenCalledWith("$other", "");
	});

	it("falls back to 'Attachment' for a bodiless message", () => {
		const [target] = createSignal<TimelineEvent | null>(makeEvent(""));
		render(() => (
			<DeleteMessageDialog
				target={target}
				onClose={() => {}}
				onDelete={() => {}}
			/>
		));
		expect(screen.getByText("Attachment")).toBeTruthy();
	});
});
