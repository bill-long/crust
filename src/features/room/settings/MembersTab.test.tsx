import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { EventType, type MatrixClient, RoomStateEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { MembersTab } from "./MembersTab";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

interface ActionClient {
	sendStateEvent: ReturnType<typeof vi.fn>;
	kick: ReturnType<typeof vi.fn>;
	ban: ReturnType<typeof vi.fn>;
	invite: ReturnType<typeof vi.fn>;
	__emit: (event: string, ...args: unknown[]) => void;
}

function setup(options?: {
	myPower?: number;
	powerLevels?: Record<string, unknown>;
	includeInvite?: boolean;
}) {
	const myPower = options?.myPower ?? 100;
	const members: {
		userId: string;
		name: string;
		powerLevel: number;
		membership?: string;
	}[] = [
		{ userId: "@test:example.com", name: "Me", powerLevel: myPower },
		{ userId: "@admin:example.com", name: "Admin", powerLevel: 100 },
		{ userId: "@mod:example.com", name: "Mod", powerLevel: 50 },
		{ userId: "@alice:example.com", name: "Alice", powerLevel: 0 },
	];
	if (options?.includeInvite) {
		members.push({
			userId: "@bob:example.com",
			name: "Bob",
			powerLevel: 0,
			membership: "invite",
		});
	}
	const room = createMockRoom("!room:example.com", [], members);
	room.__setStateEvent("m.room.power_levels", "", {
		users: {
			"@test:example.com": myPower,
			"@admin:example.com": 100,
			"@mod:example.com": 50,
		},
		users_default: 0,
		kick: 50,
		ban: 50,
		invite: 0,
		...(options?.powerLevels ?? {}),
	});
	const client = createMockClient(new Map([["!room:example.com", room]]));
	const actionClient = client as unknown as ActionClient;
	actionClient.kick = vi.fn().mockResolvedValue(undefined);
	actionClient.ban = vi.fn().mockResolvedValue(undefined);
	actionClient.invite = vi.fn().mockResolvedValue(undefined);
	render(() => (
		<MembersTab
			client={client as unknown as MatrixClient}
			roomId="!room:example.com"
		/>
	));
	return { client: actionClient, room };
}

async function openActions(displayName: string): Promise<void> {
	const trigger = screen.getByLabelText(`Member actions for ${displayName}`);
	fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
	fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
	fireEvent.click(trigger);
	fireEvent.keyDown(trigger, { key: "Enter" });
	await waitFor(() => expect(screen.getByText("Kick…")).toBeTruthy());
}

async function clickAction(displayName: string, label: string): Promise<void> {
	await openActions(displayName);
	const item = screen.getByText(label);
	fireEvent.pointerMove(item, { pointerType: "mouse" });
	fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
	fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
	fireEvent.click(item);
	fireEvent.keyDown(item, { key: "Enter" });
}

beforeEach(() => {
	window.scrollTo = vi.fn();
	if (!globalThis.requestAnimationFrame) {
		globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
			window.setTimeout(() => cb(Date.now()), 0);
		globalThis.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
	}
});

afterEach(cleanup);

describe("MembersTab", () => {
	it("renders joined members sorted by power level descending", () => {
		setup();
		const text = screen.getByText("@admin:example.com · PL 100");
		const list = text.closest("ul");
		if (!list) throw new Error("member list not found");
		const content = Array.from(list.querySelectorAll("li")).map(
			(li) => li.textContent ?? "",
		);
		expect(content[0]).toContain("Admin");
		expect(content[1]).toContain("Me");
		expect(content[2]).toContain("Mod");
		expect(content[3]).toContain("Alice");
	});

	it("promotes a member to Moderator by merging users into power levels", async () => {
		const { client } = setup();
		await clickAction("Alice", "Promote to Moderator");

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!room:example.com",
			EventType.RoomPowerLevels,
			expect.objectContaining({
				users: expect.objectContaining({ "@alice:example.com": 50 }),
			}),
			"",
		);
	});

	it("promotes a member to Admin when the caller is above that level", async () => {
		const { client } = setup({ myPower: 101 });
		await clickAction("Alice", "Promote to Admin");

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!room:example.com",
			EventType.RoomPowerLevels,
			expect.objectContaining({
				users: expect.objectContaining({ "@alice:example.com": 100 }),
			}),
			"",
		);
	});

	it("demotes by deleting the user key when users_default is 0", async () => {
		const { client } = setup();
		await clickAction("Mod", "Demote to Member");

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		const content = client.sendStateEvent.mock.calls[0][2] as {
			users: Record<string, number>;
		};
		expect(content.users["@mod:example.com"]).toBeUndefined();
		expect(content.users["@admin:example.com"]).toBe(100);
	});

	it("demotes by writing explicit 0 when users_default is non-zero", async () => {
		const { client } = setup({ powerLevels: { users_default: 25 } });
		await clickAction("Mod", "Demote to Member");

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		const content = client.sendStateEvent.mock.calls[0][2] as {
			users: Record<string, number>;
		};
		expect(content.users["@mod:example.com"]).toBe(0);
	});

	it("hides promotion actions the caller can't perform (gating-at-UI)", async () => {
		// myPower=75: I can promote Alice (PL 0) to Moderator (50 < 75)
		// but NOT to Admin (100 > 75). The dropdown should hide the
		// Admin item rather than showing it as failed-on-click.
		setup({ myPower: 75 });
		await openActions("Alice");
		expect(screen.queryByText("Promote to Admin")).toBeNull();
		expect(screen.queryByText("Promote to Moderator")).toBeTruthy();
	});

	it("opens a confirm dialog for Kick and calls client.kick on Confirm", async () => {
		const { client } = setup();
		await clickAction("Alice", "Kick…");
		expect(screen.getByRole("dialog").textContent).toContain("Kick Alice?");
		fireEvent.click(screen.getByRole("button", { name: "Kick" }));

		await waitFor(() =>
			expect(client.kick).toHaveBeenCalledWith(
				"!room:example.com",
				"@alice:example.com",
			),
		);
	});

	it("surfaces kick failures inside the ConfirmDialog without closing it", async () => {
		const { client } = setup();
		client.kick.mockRejectedValueOnce(new Error("M_FORBIDDEN: not allowed"));
		await clickAction("Alice", "Kick…");
		fireEvent.click(screen.getByRole("button", { name: "Kick" }));

		await waitFor(() => {
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toContain("M_FORBIDDEN");
		});
		// Dialog is still open after the failure.
		expect(screen.getByRole("dialog").textContent).toContain("Kick Alice?");
	});

	it("opens a confirm dialog for Ban and calls client.ban on Confirm", async () => {
		const { client } = setup();
		await clickAction("Alice", "Ban…");
		expect(screen.getByRole("dialog").textContent).toContain("Ban Alice?");
		fireEvent.click(screen.getByRole("button", { name: "Ban" }));

		await waitFor(() =>
			expect(client.ban).toHaveBeenCalledWith(
				"!room:example.com",
				"@alice:example.com",
			),
		);
	});

	it("shows pending invites and Revoke calls kick; state change removes it", async () => {
		const { client, room } = setup({ includeInvite: true });
		expect(screen.getByText("Bob")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
		await waitFor(() =>
			expect(client.kick).toHaveBeenCalledWith(
				"!room:example.com",
				"@bob:example.com",
			),
		);

		room.__addMember({
			userId: "@bob:example.com",
			name: "Bob",
			membership: "leave",
			powerLevel: 0,
		});
		client.__emit(
			RoomStateEvent.Members,
			{},
			{},
			{ roomId: "!room:example.com" },
		);
		await waitFor(() => expect(screen.queryByText("Bob")).toBeNull());
	});

	it("surfaces invite revoke failures inline", async () => {
		const { client } = setup({ includeInvite: true });
		client.kick.mockRejectedValueOnce(new Error("no revoke"));

		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("no revoke"),
		);
	});

	it("hides the invite form when the user cannot invite", () => {
		setup({ myPower: 0, powerLevels: { invite: 50 } });
		expect(screen.queryByLabelText("User ID")).toBeNull();
		expect(
			screen.getByText("You don't have permission to invite users."),
		).toBeTruthy();
	});
});
