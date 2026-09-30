import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { PermissionsTab } from "./PermissionsTab";

afterEach(cleanup);
it("configures member calls and custom notification levels using browser controls", async () => {
	const room = createMockRoom("!room:example.com");
	const client = createMockClient(new Map([[room.roomId, room]]));
	let server: Record<string, unknown> = {
		state_default: 50,
		events: { "m.room.topic": 75 },
		notifications: { room: 50 },
	};
	room.__setStateEvent("m.room.power_levels", "", server);
	room.getMember = (id: string) =>
		({ userId: id, powerLevel: 100 }) as ReturnType<typeof room.getMember>;
	Object.assign(client, { getStateEvent: vi.fn(async () => server) });
	client.sendStateEvent.mockImplementation(async (_id, _type, next) => {
		server = next;
		return { event_id: "$saved" };
	});
	render(() => (
		<PermissionsTab
			client={client as unknown as MatrixClient}
			roomId={room.roomId}
		/>
	));
	await userEvent.click(
		screen.getByRole("button", { name: "Start / join calls: Members" }),
	);
	await expect.poll(() => client.sendStateEvent.mock.calls.length).toBe(1);
	expect(server.events).toEqual({
		"m.room.topic": 75,
		"org.matrix.msc3401.call.member": 0,
	});
	const custom = screen.getByLabelText("Notify everyone (@room): custom level");
	await userEvent.fill(custom, "25");
	await userEvent.click(
		screen.getByRole("button", {
			name: "Notify everyone (@room): apply custom level",
		}),
	);
	await expect.poll(() => client.sendStateEvent.mock.calls.length).toBe(2);
	expect(server.notifications).toEqual({ room: 25 });
	await userEvent.click(
		screen.getByRole("button", { name: "Change room settings: Members" }),
	);
	expect(screen.getByRole("dialog")).toBeTruthy();
	await userEvent.keyboard("{Escape}");
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(client.sendStateEvent.mock.calls.length).toBe(2);
});
