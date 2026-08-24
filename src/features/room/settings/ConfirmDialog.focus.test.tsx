import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog focus containment", () => {
	it("recaptures focus stolen by an outside element while open", async () => {
		const outside = document.createElement("button");
		outside.textContent = "outside";
		document.body.appendChild(outside);
		try {
			render(() => (
				<ConfirmDialog
					open={() => true}
					onClose={() => {}}
					title="Confirm thing"
					body="Sure?"
					onConfirm={() => {}}
				/>
			));
			// Initial focus lands on the confirm button (queueMicrotask).
			await Promise.resolve();
			const confirmBtn = screen.getByText("Confirm");
			expect(document.activeElement).toBe(confirmBtn);
			// An opener asynchronously restoring focus to itself (Kobalte's
			// dropdown menu refocuses its trigger after unmount) must not
			// strand the modal's keyboard handling outside the overlay.
			outside.focus();
			expect(document.activeElement).toBe(confirmBtn);
		} finally {
			outside.remove();
		}
	});
});
