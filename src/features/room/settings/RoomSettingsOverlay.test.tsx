import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import {
	RoomSettingsOverlay,
	type RoomSettingsTab,
} from "./RoomSettingsOverlay";

function setup(active: RoomSettingsTab = "general", isSpace?: boolean) {
	const room = createMockRoom("!room:example.com", [], [], {
		name: "Test Room",
	});
	room.__setStateEvent("m.room.name", "", { name: "Test Room" });
	room.__setStateEvent("m.room.topic", "", { topic: "Initial topic" });
	room.__setStateEvent("m.room.power_levels", "", {});
	room.__setStateEvent("m.room.join_rules", "", { join_rule: "invite" });
	room.__setStateEvent("m.room.history_visibility", "", {
		history_visibility: "shared",
	});
	const client = createMockClient(new Map([["!room:example.com", room]]));
	const onClose = vi.fn();
	const onTabChange = vi.fn();
	let setActive!: (tab: RoomSettingsTab) => void;

	render(() => {
		const [activeTab, setTab] = createSignal(active);
		setActive = setTab;
		return (
			<RoomSettingsOverlay
				client={client as unknown as MatrixClient}
				roomId="!room:example.com"
				activeTab={activeTab()}
				onTabChange={onTabChange}
				onClose={onClose}
				isSpace={isSpace}
			/>
		);
	});

	return { client, room, onClose, onTabChange, setActive };
}

beforeEach(() => {
	HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(cleanup);

describe("RoomSettingsOverlay", () => {
	it("renders the active tab and switches content when activeTab changes", async () => {
		const { setActive } = setup("general");
		expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
		expect(screen.getByLabelText("Name")).toBeTruthy();

		setActive("permissions");
		await Promise.resolve();
		expect(screen.getByRole("heading", { name: "Permissions" })).toBeTruthy();
		expect(screen.getByText(/Choose who can perform each action/)).toBeTruthy();
	});

	it("calls onClose when Escape is pressed", () => {
		const { onClose } = setup();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes from the backdrop but not from inside the panel", () => {
		const { onClose } = setup();
		fireEvent.click(screen.getByText("Room Settings"));
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("dialog"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("calls onTabChange when a sidebar tab is clicked", () => {
		const { onTabChange } = setup("general");
		fireEvent.click(screen.getByRole("button", { name: "Members" }));
		expect(onTabChange).toHaveBeenCalledWith("members");
	});

	it("calls onClose when the close button is clicked", () => {
		const { onClose } = setup();
		fireEvent.click(screen.getByLabelText("Close room settings"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("uses Space-flavored labels when isSpace is true", () => {
		setup("general", true);
		expect(screen.getByText("Space Settings")).toBeTruthy();
		expect(screen.getByLabelText("Close space settings")).toBeTruthy();
		expect(
			screen.getByRole("dialog", { name: "Space settings — Test Room" }),
		).toBeTruthy();
	});

	it("uses Room-flavored labels when isSpace is false", () => {
		setup("general", false);
		expect(screen.getByText("Room Settings")).toBeTruthy();
		expect(screen.getByLabelText("Close room settings")).toBeTruthy();
	});

	it("passes isSpace=true into AdvancedTab leave label", () => {
		setup("advanced", true);
		expect(screen.getByRole("button", { name: "Leave space" })).toBeTruthy();
	});

	it("passes isSpace=false (default) into AdvancedTab leave label", () => {
		setup("advanced");
		expect(screen.getByRole("button", { name: "Leave room" })).toBeTruthy();
	});
});
