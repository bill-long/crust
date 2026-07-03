import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import {
	EventType,
	type MatrixClient,
	type MatrixEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { RoomGeneralTab } from "./RoomGeneralTab";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function fakeStateEvent(
	roomId: string,
	type: string,
	content: Record<string, unknown>,
): MatrixEvent {
	return {
		getType: () => type,
		getRoomId: () => roomId,
		getStateKey: () => "",
		getContent: () => content,
	} as unknown as MatrixEvent;
}

function setup() {
	const room = createMockRoom("!room:example.com", [], [], { name: "Alpha" });
	room.__setStateEvent("m.room.name", "", { name: "Alpha" });
	room.__setStateEvent("m.room.topic", "", { topic: "Original topic" });
	room.__setStateEvent("m.room.canonical_alias", "", {
		alias: "#alpha:example.com",
	});
	const client = createMockClient(new Map([["!room:example.com", room]]));
	render(() => (
		<RoomGeneralTab
			client={client as unknown as MatrixClient}
			roomId="!room:example.com"
		/>
	));
	return { client, room };
}

function nameInput(): HTMLInputElement {
	return screen.getByLabelText("Name") as HTMLInputElement;
}

afterEach(cleanup);

describe("RoomGeneralTab", () => {
	it("renders current name and topic, with no save action when not dirty", () => {
		setup();
		expect(nameInput().value).toBe("Alpha");
		expect((screen.getByLabelText("Topic") as HTMLTextAreaElement).value).toBe(
			"Original topic",
		);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("saves an edited room name and shows the pending state", async () => {
		const { client } = setup();
		let resolveWrite!: () => void;
		(client.sendStateEvent as unknown as Mock).mockImplementationOnce(
			() => new Promise<void>((resolve) => (resolveWrite = resolve)),
		);

		fireEvent.input(nameInput(), { target: { value: "Beta" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledWith(
				"!room:example.com",
				EventType.RoomName,
				{ name: "Beta" },
				"",
			),
		);
		expect(screen.getByRole("status").textContent).toContain("Saving…");

		resolveWrite();
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("updates from a server echo while the field is not dirty", async () => {
		const { client, room } = setup();
		room.__setStateEvent("m.room.name", "", { name: "Server name" });
		client.__emit(
			RoomStateEvent.Events,
			fakeStateEvent("!room:example.com", "m.room.name", {
				name: "Server name",
			}),
		);

		await waitFor(() => expect(nameInput().value).toBe("Server name"));
	});

	it("preserves a dirty edit across divergent server echo and can discard it", async () => {
		const { client, room } = setup();
		fireEvent.input(nameInput(), { target: { value: "Local draft" } });

		room.__setStateEvent("m.room.name", "", { name: "Remote edit" });
		client.__emit(
			RoomStateEvent.Events,
			fakeStateEvent("!room:example.com", "m.room.name", {
				name: "Remote edit",
			}),
		);

		await waitFor(() =>
			expect(screen.getByText(/Updated by someone else/)).toBeTruthy(),
		);
		expect(nameInput().value).toBe("Local draft");

		fireEvent.click(screen.getByRole("button", { name: "view" }));
		expect(nameInput().value).toBe("Remote edit");
	});

	it("surfaces a save failure and Retry sends the same content again", async () => {
		const { client } = setup();
		const sendStateEvent = client.sendStateEvent as unknown as Mock;
		sendStateEvent.mockRejectedValueOnce(new Error("network down"));

		fireEvent.input(nameInput(), { target: { value: "Retry name" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("network down"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() => expect(sendStateEvent).toHaveBeenCalledTimes(2));
		expect(sendStateEvent).toHaveBeenLastCalledWith(
			"!room:example.com",
			EventType.RoomName,
			{ name: "Retry name" },
			"",
		);
	});

	it("Cancel reverts the field to the server baseline", () => {
		setup();
		fireEvent.input(nameInput(), { target: { value: "Throw away" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(nameInput().value).toBe("Alpha");
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("disables editable fields when the user lacks the relevant power level", () => {
		const room = createMockRoom("!room:example.com", [], [], { name: "Alpha" });
		room.__setStateEvent("m.room.name", "", { name: "Alpha" });
		room.__setStateEvent("m.room.topic", "", { topic: "Original topic" });
		room.__setCanSendStateEvent("m.room.name", false);
		room.__setCanSendStateEvent("m.room.topic", false);
		room.__setCanSendStateEvent("m.room.avatar", false);
		const client = createMockClient(new Map([["!room:example.com", room]]));

		render(() => (
			<RoomGeneralTab
				client={client as unknown as MatrixClient}
				roomId="!room:example.com"
			/>
		));

		expect(nameInput().getAttribute("aria-disabled")).toBe("true");
		expect(nameInput().readOnly).toBe(true);
		const topicEl = screen.getByLabelText("Topic") as HTMLTextAreaElement;
		expect(topicEl.getAttribute("aria-disabled")).toBe("true");
		expect(topicEl.readOnly).toBe(true);
		expect(
			screen
				.getByRole("button", { name: "Upload image" })
				.getAttribute("aria-disabled"),
		).toBe("true");
	});
});
