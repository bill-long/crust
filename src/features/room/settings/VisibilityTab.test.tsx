import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
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

	function mkRoom(id: string) {
		const room = createMockRoom(id, [], [], { name: id });
		room.__setStateEvent("m.room.power_levels", "", {});
		room.__setStateEvent("m.room.join_rules", "", { join_rule: "invite" });
		room.__setStateEvent("m.room.history_visibility", "", {
			history_visibility: "shared",
		});
		return room;
	}

	it("clears saving state and re-enables the control after the room changes mid-write", async () => {
		const roomA = mkRoom("!a:example.com");
		const roomB = mkRoom("!b:example.com");
		const client = createMockClient(
			new Map([
				["!a:example.com", roomA],
				["!b:example.com", roomB],
			]),
		);
		(
			client.getRoomDirectoryVisibility as ReturnType<typeof vi.fn>
		).mockImplementation(async (rid: string) => ({
			visibility: rid === "!b:example.com" ? "public" : "private",
		}));
		// Room A's publish write hangs until we release it.
		let resolveWrite!: () => void;
		(
			client.setRoomDirectoryVisibility as ReturnType<typeof vi.fn>
		).mockImplementationOnce(
			() =>
				new Promise<Record<string, never>>((res) => {
					resolveWrite = () => res({});
				}),
		);

		const [roomId, setRoomId] = createSignal("!a:example.com");
		render(() => (
			<VisibilityTab
				client={client as unknown as MatrixClient}
				roomId={roomId()}
			/>
		));
		await flush();
		const checkbox = (): HTMLInputElement =>
			screen.getByRole("checkbox") as HTMLInputElement;
		// Start publishing room A (private -> public); the write hangs, leaving
		// the control in the saving (disabled) state.
		fireEvent.click(checkbox());
		await flush();
		expect(checkbox().disabled).toBe(true);
		// Switching rooms must reset the transient saving state so the new
		// room's control isn't stuck disabled by room A's in-flight write.
		setRoomId("!b:example.com");
		await flush();
		await flush();
		expect(checkbox().checked).toBe(true);
		expect(checkbox().disabled).toBe(false);
		// The stale room-A write later resolves; nothing should change.
		resolveWrite();
		await flush();
		await flush();
		expect(checkbox().checked).toBe(true);
		expect(checkbox().disabled).toBe(false);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("ignores a stale directory write rejection after the room changed", async () => {
		const roomA = mkRoom("!a:example.com");
		const roomB = mkRoom("!b:example.com");
		const client = createMockClient(
			new Map([
				["!a:example.com", roomA],
				["!b:example.com", roomB],
			]),
		);
		(
			client.getRoomDirectoryVisibility as ReturnType<typeof vi.fn>
		).mockImplementation(async (rid: string) => ({
			visibility: rid === "!b:example.com" ? "public" : "private",
		}));
		let rejectWrite!: () => void;
		(
			client.setRoomDirectoryVisibility as ReturnType<typeof vi.fn>
		).mockImplementationOnce(
			() =>
				new Promise<Record<string, never>>((_res, rej) => {
					rejectWrite = () => rej(new Error("late failure"));
				}),
		);

		const [roomId, setRoomId] = createSignal("!a:example.com");
		render(() => (
			<VisibilityTab
				client={client as unknown as MatrixClient}
				roomId={roomId()}
			/>
		));
		await flush();
		const checkbox = (): HTMLInputElement =>
			screen.getByRole("checkbox") as HTMLInputElement;
		fireEvent.click(checkbox());
		await flush();
		setRoomId("!b:example.com");
		await flush();
		await flush();
		// The stale room-A write rejects — no error should surface on room B.
		rejectWrite();
		await flush();
		await flush();
		expect(checkbox().checked).toBe(true);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
