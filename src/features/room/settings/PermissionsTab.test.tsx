import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import {
	type MatrixClient,
	type MatrixEvent,
	RoomEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import { afterEach, expect, it, vi } from "vitest";
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
afterEach(cleanup);
function setup(content: Record<string, unknown> = {}, level = 100) {
	const room = createMockRoom("!room:example.com");
	room.__setStateEvent("m.room.power_levels", "", content);
	const client = createMockClient(new Map([[room.roomId, room]]));
	room.getMember = (id: string) =>
		({
			userId: id,
			powerLevel: id === client.getUserId() ? level : 0,
		}) as ReturnType<typeof room.getMember>;
	Object.assign(client, {
		getStateEvent: vi.fn(
			async () =>
				(
					room.currentState.getStateEvents(
						"m.room.power_levels",
						"",
					) as MatrixEvent | null
				)?.getContent() ?? {},
		),
	});
	client.sendStateEvent.mockImplementation(async (_rid, _type, next) => {
		room.__setStateEvent("m.room.power_levels", "", next);
		return { event_id: "$saved" };
	});
	render(() => (
		<PermissionsTab
			client={client as unknown as MatrixClient}
			roomId={room.roomId}
		/>
	));
	return { client, room };
}
const press = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));
it("enables member calls without altering unrelated overrides or defaults", async () => {
	const original = {
		state_default: 50,
		users: { "@a:s": 75 },
		events: { "com.example.custom": 87 },
		notifications: { room: 50, custom: 33 },
	};
	const { client } = setup(original);
	press("Start / join calls: Members");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
	expect(client.sendStateEvent.mock.calls[0]?.[2]).toEqual({
		...original,
		events: { ...original.events, "org.matrix.msc3401.call.member": 0 },
	});
	expect(
		screen
			.getByRole("button", { name: "Start / join calls: Members" })
			.getAttribute("aria-pressed"),
	).toBe("true");
});
it("edits and removes arbitrary event overrides with inherited named controls", async () => {
	const { client } = setup({
		state_default: 75,
		events: { "com.example.custom": 87, "m.room.topic": 0 },
	});
	press("m.room.topic: reset");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
	expect(client.sendStateEvent.mock.calls[0]?.[2]).toEqual({
		state_default: 75,
		events: { "com.example.custom": 87 },
	});
	expect(
		screen.getByLabelText("Change room topic: custom level"),
	).toHaveProperty("value", "75");
	fireEvent.input(screen.getByLabelText("com.example.custom: custom level"), {
		target: { value: "42" },
	});
	press("com.example.custom: apply custom level");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(2));
	expect(client.sendStateEvent.mock.calls[1]?.[2]).toEqual({
		state_default: 75,
		events: { "com.example.custom": 42 },
	});
});
it("rolls back failed writes and shows inline error", async () => {
	const { client } = setup();
	client.sendStateEvent.mockRejectedValueOnce(new Error("Rejected"));
	press("Start / join calls: Members");
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("Rejected"),
	);
	expect(
		screen.getByLabelText("Start / join calls: custom level"),
	).toHaveProperty("value", "50");
});
it("blocks invalid or higher levels and permission loss during confirmation", async () => {
	const { client, room } = setup({}, 50);
	press("Start / join calls: Admins");
	expect(client.sendStateEvent).not.toHaveBeenCalled();
	expect(screen.getByRole("alert").textContent).toContain("above your own");
	fireEvent.input(screen.getByLabelText("Start / join calls: custom level"), {
		target: { value: "2.5" },
	});
	press("Start / join calls: apply custom level");
	expect(client.sendStateEvent).not.toHaveBeenCalled();
	press("Change room settings: Members");
	expect(screen.getByRole("dialog")).toBeTruthy();
	room.__setCanSendStateEvent("m.room.power_levels", false);
	room.getMyMembership = () => "leave";
	client.__emit(RoomEvent.MyMembership, room, "leave", "join");
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(
		screen.getByRole("button", { name: "Start / join calls: Members" }),
	).toHaveProperty("disabled", true);
});
it("reflects external changes and preserves them in subsequent writes", async () => {
	const { client, room } = setup();
	room.__setStateEvent("m.room.power_levels", "", {
		events: { "m.room.topic": 23 },
		notifications: { room: 75 },
	});
	client.__emit(
		RoomStateEvent.Events,
		room.currentState.getStateEvents(
			"m.room.power_levels",
			"",
		) as MatrixEvent | null,
	);
	expect(
		screen.getByLabelText("Change room topic: custom level"),
	).toHaveProperty("value", "23");
	press("Start / join calls: Members");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
	expect(client.sendStateEvent.mock.calls[0]?.[2]).toEqual({
		events: { "m.room.topic": 23, "org.matrix.msc3401.call.member": 0 },
		notifications: { room: 75 },
	});
});
it("switches override categories without writing the previous category", async () => {
	const { client } = setup({
		events: { room: 1 },
		notifications: { room: 50 },
	});
	fireEvent.change(screen.getByLabelText("Override type"), {
		target: { value: "notifications" },
	});
	press("room: Members");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
	expect(client.sendStateEvent.mock.calls[0]?.[2]).toEqual({
		events: { room: 1 },
		notifications: { room: 0 },
	});
});

it("refreshes the server document and preserves changes absent from local sync", async () => {
	const { client, room } = setup();
	room.__setStateEvent("m.room.power_levels", "", {
		events: { "unseen.setting": 75 },
		extension: { value: 1 },
	});
	press("Start / join calls: Members");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
	expect(client.sendStateEvent.mock.calls[0]?.[2]).toEqual({
		events: { "unseen.setting": 75, "org.matrix.msc3401.call.member": 0 },
		extension: { value: 1 },
	});
});
it("refuses a conflicting change instead of overwriting another moderator", async () => {
	const { client, room } = setup();
	room.__setStateEvent("m.room.power_levels", "", {
		events: { "org.matrix.msc3401.call.member": 75 },
	});
	press("Start / join calls: Members");
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("another session"),
	);
	expect(client.sendStateEvent).not.toHaveBeenCalled();
});
it("does not send after the editor closes while refreshing state", async () => {
	const { client } = setup();
	let finish!: (value: Record<string, unknown>) => void;
	Object.assign(client, {
		getStateEvent: vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		),
	});
	press("Start / join calls: Members");
	await waitFor(() => expect(finish).toBeTypeOf("function"));
	cleanup();
	finish({});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(client.sendStateEvent).not.toHaveBeenCalled();
});
it("reconciles an echo before the response, including fresh unrelated fields", async () => {
	const { client, room } = setup();
	room.__setStateEvent("m.room.power_levels", "", {
		events: { "m.room.topic": 75 },
	});
	let finish!: () => void;
	client.sendStateEvent.mockImplementationOnce(async (_rid, _type, next) => {
		room.__setStateEvent(
			"m.room.power_levels",
			"",
			JSON.parse(JSON.stringify(next)),
		);
		client.__emit(
			RoomStateEvent.Events,
			room.currentState.getStateEvents("m.room.power_levels", ""),
		);
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { event_id: "$saved" };
	});
	press("Start / join calls: Members");
	await waitFor(() => expect(finish).toBeTypeOf("function"));
	expect(
		screen.getByLabelText("Change room topic: custom level"),
	).toHaveProperty("value", "75");
	expect(
		screen
			.getByRole("button", { name: "Start / join calls: Members" })
			.getAttribute("aria-pressed"),
	).toBe("true");
	finish();
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Change room topic: Members" }),
		).toHaveProperty("disabled", false),
	);
	press("Change room topic: Members");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(2));
	expect(client.sendStateEvent.mock.calls[1]?.[2]).toEqual({
		events: { "m.room.topic": 0, "org.matrix.msc3401.call.member": 0 },
	});
});
it("rejects a reset when the server's inherited default changed", async () => {
	const { client, room } = setup({
		users_default: 0,
		users: { "@other:s": 50 },
	});
	fireEvent.change(screen.getByLabelText("Override type"), {
		target: { value: "users" },
	});
	room.__setStateEvent("m.room.power_levels", "", {
		users_default: 100,
		users: { "@other:s": 50 },
	});
	press("@other:s: reset");
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("another session"),
	);
	expect(client.sendStateEvent).not.toHaveBeenCalled();
});
it("permits delegated moderators to add an event override below a high default", async () => {
	const { client } = setup(
		{ state_default: 100, events: { "m.room.power_levels": 50 } },
		50,
	);
	press("Change room topic: Moderators");
	await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
	expect(client.sendStateEvent.mock.calls[0]?.[2]).toEqual({
		state_default: 100,
		events: { "m.room.power_levels": 50, "m.room.topic": 50 },
	});
});
