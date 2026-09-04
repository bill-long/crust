import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SummariesStore } from "../../../client/summaries";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { makeSummary } from "../../../test/summaryFixtures";
import { TestClientProvider } from "../../../test/TimelineHarness";

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

function setup(
	active: RoomSettingsTab = "general",
	isSpace?: boolean,
	options?: {
		/** Summaries-store membership (the app's source of truth). */
		membership?: string;
		/** SDK-room membership when it should differ from the store. */
		sdkMembership?: string;
		onForgot?: (roomId: string) => void;
		/** Render for a room neither the store nor the SDK knows. */
		unknownRoom?: boolean;
	},
) {
	const room = createMockRoom("!room:example.com", [], [], {
		name: "Test Room",
		membership: options?.sdkMembership ?? options?.membership,
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
	const [summaries] = createStore<SummariesStore>({
		"!room:example.com": makeSummary("!room:example.com", {
			name: "Test Room",
			membership: options?.membership ?? "join",
			isSpace: isSpace ?? false,
		}),
	});

	render(() => {
		const [activeTab, setTab] = createSignal(active);
		setActive = setTab;
		return (
			<TestClientProvider client={client} summaries={summaries}>
				<RoomSettingsOverlay
					client={client as unknown as MatrixClient}
					roomId={
						options?.unknownRoom ? "!missing:example.com" : "!room:example.com"
					}
					activeTab={activeTab()}
					onTabChange={onTabChange}
					onClose={onClose}
					isSpace={isSpace}
					onForgot={options?.onForgot}
				/>
			</TestClientProvider>
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

	it("shows the space-only Rooms tab for a space", () => {
		setup("general", true);
		expect(screen.getByRole("button", { name: "Rooms" })).toBeTruthy();
	});

	it("hides the Rooms tab for a regular room", () => {
		setup("general", false);
		expect(screen.queryByRole("button", { name: "Rooms" })).toBeNull();
	});

	it("shows the space-only Visibility tab for a space", () => {
		setup("general", true);
		expect(screen.getByRole("button", { name: "Visibility" })).toBeTruthy();
	});

	it("hides the Visibility tab for a regular room", () => {
		setup("general", false);
		expect(screen.queryByRole("button", { name: "Visibility" })).toBeNull();
	});

	it("renders the Visibility tab content for a space", () => {
		setup("visibility", true);
		expect(screen.getByRole("heading", { name: "Join rule" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Guest access" })).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "Directory listing" }),
		).toBeTruthy();
	});

	it("moves Join rule out of the Advanced tab for spaces", () => {
		setup("advanced", true);
		// For spaces, join rule / history live on the Visibility tab, so the
		// Advanced tab only shows the Danger zone.
		expect(screen.queryByRole("heading", { name: "Join rule" })).toBeNull();
		expect(screen.getByRole("button", { name: "Leave space" })).toBeTruthy();
	});

	it("keeps Join rule on the Advanced tab for regular rooms", () => {
		setup("advanced", false);
		expect(screen.getByRole("heading", { name: "Join rule" })).toBeTruthy();
	});

	it("passes membership through: a left room's Advanced tab offers Forget", () => {
		setup("advanced", false, { membership: "leave" });
		expect(screen.getByRole("button", { name: "Forget room" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Leave room" })).toBeNull();
	});

	it("forwards onForgot and closes after a successful Forget", async () => {
		const onForgot = vi.fn();
		const { client, onClose } = setup("advanced", false, {
			membership: "leave",
			onForgot,
		});
		(client as unknown as { forget: ReturnType<typeof vi.fn> }).forget = vi
			.fn()
			.mockResolvedValue(undefined);
		fireEvent.click(screen.getByRole("button", { name: "Forget room" }));
		fireEvent.click(screen.getByRole("button", { name: "Forget" }));

		await waitFor(() =>
			expect(onForgot).toHaveBeenCalledWith("!room:example.com"),
		);
		expect(onClose).toHaveBeenCalled();
	});

	describe("non-member notice (#527)", () => {
		it("shows nothing for a joined room", () => {
			setup("general");
			expect(screen.queryByRole("status")).toBeNull();
		});

		it("names the reason for a left room and renders the tab read-only", () => {
			setup("general", false, { membership: "leave" });
			expect(screen.getByRole("status").textContent).toBe(
				"You're not a member of this room. Its settings can't be changed.",
			);
			// The mock grants every power level; membership alone must gate.
			const name = screen.getByLabelText("Name") as HTMLInputElement;
			expect(name.readOnly).toBe(true);
		});

		it("treats a room neither the store nor the SDK knows as not a member", () => {
			// SyncGate has run by the time settings can open, so an unknown room
			// is one the user is not in; every gate is false and the notice must
			// agree with them rather than leave an unexplained read-only tab.
			setup("general", false, { unknownRoom: true });
			expect(screen.getByRole("status").textContent).toBe(
				"You're not a member of this room. Its settings can't be changed.",
			);
		});

		it("uses banned copy and the space noun for a banned space", () => {
			setup("visibility", true, { membership: "ban" });
			expect(screen.getByRole("status").textContent).toBe(
				"You've been banned from this space. Its settings can't be changed.",
			);
		});
	});

	describe("membership source (#527)", () => {
		it("trusts the store's optimistic join over a lagging SDK room", () => {
			// client.joinRoom() resolves before /sync updates the SDK room;
			// Layout marks the summary joined and opens the pane on that.
			setup("general", false, { membership: "join", sdkMembership: "invite" });
			expect(screen.queryByRole("status")).toBeNull();
			const name = screen.getByLabelText("Name") as HTMLInputElement;
			expect(name.readOnly).toBe(false);
		});

		it("trusts the store's optimistic leave over a lagging SDK room", () => {
			setup("general", false, { membership: "leave", sdkMembership: "join" });
			expect(screen.getByRole("status")).toBeTruthy();
			const name = screen.getByLabelText("Name") as HTMLInputElement;
			expect(name.readOnly).toBe(true);
		});

		it("keeps join rule on Advanced for a left room, alongside Forget", () => {
			setup("advanced", false, { membership: "leave" });
			expect(screen.getByRole("heading", { name: "Join rule" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Forget room" })).toBeTruthy();
		});
	});
});
