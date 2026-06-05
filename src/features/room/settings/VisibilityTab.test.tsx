import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { VisibilityTab } from "./VisibilityTab";

const ROOM_ID = "!space:example.com";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(opts?: {
	guestAccess?: string;
	directory?: "public" | "private";
	canGuest?: boolean;
}) {
	const room = createMockRoom(ROOM_ID, [], [], { name: "My Space" });
	room.__setStateEvent("m.room.power_levels", "", {});
	room.__setStateEvent("m.room.join_rules", "", { join_rule: "invite" });
	room.__setStateEvent("m.room.history_visibility", "", {
		history_visibility: "shared",
	});
	if (opts?.guestAccess) {
		room.__setStateEvent("m.room.guest_access", "", {
			guest_access: opts.guestAccess,
		});
	}
	if (opts?.canGuest === false) {
		room.__setCanSendStateEvent("m.room.guest_access", false);
	}
	const client = createMockClient(new Map([[ROOM_ID, room]]));
	(
		client.getRoomDirectoryVisibility as ReturnType<typeof vi.fn>
	).mockResolvedValue({ visibility: opts?.directory ?? "private" });
	render(() => (
		<VisibilityTab
			client={client as unknown as MatrixClient}
			roomId={ROOM_ID}
		/>
	));
	return { client, room };
}

afterEach(cleanup);

describe("VisibilityTab", () => {
	it("renders all four visibility sections", () => {
		setup();
		expect(screen.getByRole("heading", { name: "Join rule" })).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "History visibility" }),
		).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Guest access" })).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "Directory listing" }),
		).toBeTruthy();
	});

	it("reflects the current guest access (forbidden by default)", () => {
		setup();
		expect(screen.getByRole("button", { name: "Forbidden" })).toHaveProperty(
			"ariaPressed",
			"true",
		);
	});

	it("writes a guest access change", async () => {
		const { client } = setup({ guestAccess: "forbidden" });
		fireEvent.click(screen.getByRole("button", { name: "Allow guests" }));
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			ROOM_ID,
			"m.room.guest_access",
			{ guest_access: "can_join" },
			"",
		);
	});

	it("disables guest access controls without permission", () => {
		setup({ canGuest: false });
		expect(
			screen
				.getByRole("button", { name: "Allow guests" })
				.getAttribute("aria-disabled"),
		).toBe("true");
	});

	it("loads and shows the published directory state", async () => {
		setup({ directory: "public" });
		await flush();
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
	});

	it("publishes to the directory when toggled on", async () => {
		const { client } = setup({ directory: "private" });
		await flush();
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		expect(checkbox.checked).toBe(false);
		fireEvent.click(checkbox);
		await flush();
		expect(client.setRoomDirectoryVisibility).toHaveBeenCalledWith(
			ROOM_ID,
			"public",
		);
		expect(checkbox.checked).toBe(true);
	});

	it("reverts the directory toggle when the write fails", async () => {
		const { client } = setup({ directory: "private" });
		await flush();
		(
			client.setRoomDirectoryVisibility as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("nope"));
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		fireEvent.click(checkbox);
		await flush();
		await flush();
		expect(checkbox.checked).toBe(false);
		expect(screen.getByRole("alert")).toBeTruthy();
	});
});
