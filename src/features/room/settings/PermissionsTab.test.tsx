import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { EventType, type MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { PermissionsTab } from "./PermissionsTab";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function setup(powerLevels: Record<string, unknown> = {}) {
	const room = createMockRoom("!room:example.com");
	room.__setStateEvent("m.room.power_levels", "", powerLevels);
	const client = createMockClient(new Map([["!room:example.com", room]]));
	render(() => (
		<PermissionsTab
			client={client as unknown as MatrixClient}
			roomId="!room:example.com"
		/>
	));
	return { client, room };
}

function rowFor(label: string): HTMLElement {
	const row = screen.getByText(label).parentElement;
	if (!row) throw new Error(`row not found for ${label}`);
	return row;
}

function rowButton(label: string, button: string): HTMLButtonElement {
	const found = Array.from(rowFor(label).querySelectorAll("button")).find(
		(el) => el.textContent === button,
	);
	if (!found) throw new Error(`button ${button} not found in ${label}`);
	return found as HTMLButtonElement;
}

afterEach(cleanup);

describe("PermissionsTab", () => {
	it("renders preset pills and custom badges from current power levels", () => {
		setup({
			events_default: 0,
			state_default: 50,
			invite: 25,
			kick: 0,
			ban: 50,
			redact: 75,
		});

		expect(
			rowButton("Send messages", "Anyone").getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			rowButton("Change room settings", "Moderators only").getAttribute(
				"aria-pressed",
			),
		).toBe("true");
		expect(rowFor("Invite users").textContent).toContain("Custom (25)");
		expect(rowButton("Kick users", "Anyone").getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(
			rowButton("Ban users", "Moderators only").getAttribute("aria-pressed"),
		).toBe("true");
		expect(rowFor("Redact messages").textContent).toContain("Custom (75)");
	});

	it("writes selected presets merged with existing users and events maps", async () => {
		const { client } = setup({
			users: { "@alice:example.com": 100 },
			events: { "m.reaction": 0 },
			events_default: 50,
			ban: 50,
		});

		fireEvent.click(rowButton("Send messages", "Anyone"));

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		expect(client.sendStateEvent).toHaveBeenLastCalledWith(
			"!room:example.com",
			EventType.RoomPowerLevels,
			{
				users: { "@alice:example.com": 100 },
				events: { "m.reaction": 0 },
				events_default: 0,
				ban: 50,
			},
			"",
		);
	});

	it("confirms before lowering state_default to Anyone and Cancel does not write", async () => {
		const { client } = setup({ state_default: 50, users: { "@a:s": 100 } });

		fireEvent.click(rowButton("Change room settings", "Anyone"));
		expect(screen.getByRole("dialog").textContent).toContain(
			"Lower the bar for state changes?",
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(client.sendStateEvent).not.toHaveBeenCalled();

		fireEvent.click(rowButton("Change room settings", "Anyone"));
		fireEvent.click(screen.getByRole("button", { name: "Yes, allow anyone" }));

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!room:example.com",
			EventType.RoomPowerLevels,
			{ state_default: 0, users: { "@a:s": 100 } },
			"",
		);
	});

	it("disables all rows when the user cannot send power-level state", () => {
		const { client, room } = setup({});
		cleanup();
		room.__setCanSendStateEvent("m.room.power_levels", false);
		render(() => (
			<PermissionsTab
				client={client as unknown as MatrixClient}
				roomId="!room:example.com"
			/>
		));

		for (const button of screen.getAllByRole("button")) {
			expect(button.getAttribute("aria-disabled")).toBe("true");
			fireEvent.click(button);
		}
		expect(client.sendStateEvent).not.toHaveBeenCalled();
	});

	it("renders a per-event override note when the events map is non-empty", () => {
		setup({ events: { "m.room.message": 0, "m.room.topic": 50 } });
		expect(screen.getAllByText("2 per-event overrides preserved.").length).toBe(
			2,
		);
	});

	it("surfaces write errors inline", async () => {
		const { client } = setup({ kick: 50 });
		(client.sendStateEvent as unknown as Mock).mockRejectedValueOnce(
			new Error("nope"),
		);

		fireEvent.click(rowButton("Kick users", "Anyone"));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("nope"),
		);
	});
});
