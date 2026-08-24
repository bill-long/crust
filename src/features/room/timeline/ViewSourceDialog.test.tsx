import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixEvent } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import type { TimelineEvent } from "./timelineTypes";
import { ViewSourceDialog } from "./ViewSourceDialog";

afterEach(cleanup);

function makeSource(options?: { encrypted?: boolean }): MatrixEvent {
	return {
		getEffectiveEvent: () => ({
			type: "m.room.message",
			content: { msgtype: "m.text", body: "decrypted-body-marker" },
		}),
		isEncrypted: () => options?.encrypted ?? false,
		event: {
			type: "m.room.encrypted",
			content: { algorithm: "m.megolm.v1.aes-sha2" },
		},
	} as unknown as MatrixEvent;
}

function setup(options?: {
	encrypted?: boolean;
	getSourceEvent?: () => MatrixEvent | undefined;
}) {
	const [target, setTarget] = createSignal<TimelineEvent | null>({
		eventId: "$src",
		body: "hi",
	} as unknown as TimelineEvent);
	const onClose = vi.fn(() => setTarget(null));
	render(() => (
		<ViewSourceDialog
			target={target}
			roomId={() => "!room:server"}
			getSourceEvent={options?.getSourceEvent ?? (() => makeSource(options))}
			onClose={onClose}
		/>
	));
	return { onClose };
}

describe("ViewSourceDialog", () => {
	it("shows the room/event ids and the decrypted event JSON", () => {
		setup();
		expect(screen.getByText(/!room:server · \$src/)).toBeTruthy();
		expect(screen.getByText(/decrypted-body-marker/)).toBeTruthy();
		// Plaintext events show no wire section.
		expect(screen.queryByText("Encrypted wire event")).toBeNull();
	});

	it("adds the wire envelope section for encrypted events", () => {
		setup({ encrypted: true });
		expect(screen.getByText("Encrypted wire event")).toBeTruthy();
		expect(screen.getByText(/m\.megolm\.v1\.aes-sha2/)).toBeTruthy();
	});

	it("falls back gracefully when the source event is gone", () => {
		setup({ getSourceEvent: () => undefined });
		expect(
			screen.getByText("The original event is no longer available."),
		).toBeTruthy();
	});

	it("recaptures focus stolen by an outside element while open", async () => {
		const outside = document.createElement("button");
		outside.textContent = "outside";
		document.body.appendChild(outside);
		try {
			setup();
			await Promise.resolve();
			const closeBtn = screen.getByText("Close");
			expect(document.activeElement).toBe(closeBtn);
			// The opener (e.g. Kobalte's menu) restoring focus to itself after
			// the dialog took focus must not strand keyboard handling outside.
			outside.focus();
			expect(document.activeElement).toBe(closeBtn);
		} finally {
			outside.remove();
		}
	});

	it("closes on Escape", () => {
		const { onClose } = setup();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});
});
