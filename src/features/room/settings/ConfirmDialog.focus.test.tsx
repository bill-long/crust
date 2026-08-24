import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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

	it("falls back to the overlay when the confirm button is disabled (pending)", async () => {
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
					onConfirm={() => new Promise(() => {})}
				/>
			));
			await Promise.resolve();
			fireEvent.click(screen.getByText("Confirm"));
			// While pending, the confirm button is disabled and can't take
			// focus - containment must land on the overlay instead of
			// silently failing.
			expect(screen.getByText("Working…")).toBeTruthy();
			outside.focus();
			const overlay = screen.getByRole("dialog");
			expect(overlay.contains(document.activeElement)).toBe(true);
		} finally {
			outside.remove();
		}
	});

	it("does not confirm on Enter from a checkbox in the body", () => {
		const onConfirm = vi.fn();
		render(() => (
			<ConfirmDialog
				open={() => true}
				onClose={() => {}}
				title="Leave space"
				body={
					<label>
						<input type="checkbox" /> also leave rooms
					</label>
				}
				onConfirm={onConfirm}
			/>
		));
		const checkbox = screen.getByRole("checkbox");
		fireEvent.keyDown(checkbox, { key: "Enter" });
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("leaves focus alone inside another aria-modal surface (stacked dialogs must not fight)", async () => {
		const stacked = document.createElement("div");
		stacked.setAttribute("aria-modal", "true");
		const stackedBtn = document.createElement("button");
		stackedBtn.textContent = "stacked";
		stacked.appendChild(stackedBtn);
		document.body.appendChild(stacked);
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
			await Promise.resolve();
			// A dialog stacked on top (crypto dialog, or a second
			// containment-enabled modal) owns its own focus; recapturing it
			// would ping-pong two containment listeners into a synchronous
			// focusin recursion.
			stackedBtn.focus();
			expect(document.activeElement).toBe(stackedBtn);
		} finally {
			stacked.remove();
		}
	});

	it("two open containment dialogs settle focus without recursing", async () => {
		const outside = document.createElement("button");
		outside.textContent = "outside";
		document.body.appendChild(outside);
		try {
			render(() => (
				<>
					<ConfirmDialog
						open={() => true}
						onClose={() => {}}
						title="First"
						body="a"
						onConfirm={() => {}}
					/>
					<ConfirmDialog
						open={() => true}
						onClose={() => {}}
						title="Second"
						body="b"
						onConfirm={() => {}}
					/>
				</>
			));
			await Promise.resolve();
			// Focus fully outside both: each may take one recapture hop, but
			// the other-modal gate stops the mutual yanking that would
			// otherwise recurse to a stack overflow.
			outside.focus();
			const active = document.activeElement;
			expect(active?.textContent).toBe("Confirm");
		} finally {
			outside.remove();
		}
	});
});
