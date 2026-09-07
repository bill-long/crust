import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { OverlayRoute } from "./OverlayRoute";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("surfaces a rejected native hang-up in the overlay itself", async () => {
	vi.stubGlobal("isTauri", true);
	const invoke = vi.fn().mockRejectedValue(new Error("IPC unavailable"));
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
	vi.spyOn(console, "error").mockImplementation(() => {});
	const channel = new BroadcastChannel("crust:call-overlay");
	try {
		render(() => <OverlayRoute />);
		channel.postMessage({
			kind: "snapshot",
			producerId: "test",
			snapshot: { active: true, roomName: "Test", participants: [] },
		});
		const hangUp = await screen.findByRole("button", {
			name: "Disconnect from call",
		});
		await userEvent.click(hangUp);
		await vi.waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Couldn't disconnect",
			),
		);
		expect(invoke).toHaveBeenCalledWith("leave_overlay_call", undefined);
	} finally {
		channel.close();
	}
});
