import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import {
	EventType,
	HistoryVisibility,
	JoinRule,
	type MatrixClient,
} from "matrix-js-sdk";
import { createStore } from "solid-js/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SummariesStore } from "../../../client/summaries";
import {
	_resetActiveCallForTests,
	activeCallRoomId,
	setActiveCallRoomId,
} from "../../../stores/activeCall";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { makeSummary } from "../../../test/summaryFixtures";
import { TestClientProvider } from "../../../test/TimelineHarness";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "../call/rtc/callSessionStore";
import { makeFakeCallSession } from "../call/rtc/fakeCallSession.test-utils";
import { AdvancedTab } from "./AdvancedTab";

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
	leave: ReturnType<typeof vi.fn>;
	forget: ReturnType<typeof vi.fn>;
}

function setup(options?: {
	join?: Record<string, unknown>;
	history?: Record<string, unknown>;
	canJoinRules?: boolean;
	canHistory?: boolean;
	onLeft?: (roomId: string) => void;
	onForgot?: (roomId: string) => void;
	membership?: string;
	isSpace?: boolean;
}) {
	const room = createMockRoom("!room:example.com", [], [], { name: "Alpha" });
	room.__setStateEvent("m.room.join_rules", "", {
		join_rule: JoinRule.Invite,
		...(options?.join ?? {}),
	});
	room.__setStateEvent("m.room.history_visibility", "", {
		history_visibility: HistoryVisibility.Shared,
		...(options?.history ?? {}),
	});
	if (options?.canJoinRules === false) {
		room.__setCanSendStateEvent("m.room.join_rules", false);
	}
	if (options?.canHistory === false) {
		room.__setCanSendStateEvent("m.room.history_visibility", false);
	}
	const client = createMockClient(new Map([["!room:example.com", room]]));
	const actionClient = client as unknown as ActionClient;
	actionClient.leave = vi.fn().mockResolvedValue(undefined);
	actionClient.forget = vi.fn().mockResolvedValue(undefined);
	const [summaries, setSummaries] = createStore<SummariesStore>({
		"!room:example.com": makeSummary("!room:example.com", {
			name: "Alpha",
			membership: options?.membership ?? "join",
			isSpace: options?.isSpace ?? false,
		}),
	});
	render(() => (
		<TestClientProvider client={client} summaries={summaries}>
			<AdvancedTab
				client={client as unknown as MatrixClient}
				roomId="!room:example.com"
				onLeft={options?.onLeft}
				onForgot={options?.onForgot}
				isSpace={options?.isSpace}
			/>
		</TestClientProvider>
	));
	return { client: actionClient, room, setSummaries };
}

function button(name: string): HTMLButtonElement {
	return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** Fake-call-session roots to dispose after each test. */
const sessionDisposers: Array<() => void> = [];

function publishFakeCall(roomId: string) {
	const fake = makeFakeCallSession({ roomId });
	sessionDisposers.push(fake.dispose);
	publishCallSession(fake.api);
	setActiveCallRoomId(roomId);
	return fake;
}

afterEach(() => {
	cleanup();
	for (const dispose of sessionDisposers.splice(0)) dispose();
	_resetActiveCallForTests();
	_resetCallSessionForTests();
});

describe("AdvancedTab", () => {
	it("renders join rule and history visibility segments with current values selected", () => {
		setup({
			join: { join_rule: JoinRule.Public },
			history: { history_visibility: HistoryVisibility.Joined },
		});
		expect(button("Public").getAttribute("aria-pressed")).toBe("true");
		expect(button("Members (since joining)").getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("writes join rule changes preserving a restricted allow list", async () => {
		const allow = [
			{ room_id: "!space:example.com", type: "m.room_membership" },
		];
		const { client } = setup({ join: { join_rule: JoinRule.Invite, allow } });

		fireEvent.click(button("Restricted (space)"));

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!room:example.com",
			EventType.RoomJoinRules,
			{ join_rule: JoinRule.Restricted, allow },
			"",
		);
	});

	it("keeps Restricted selectable even without an existing allow list", () => {
		setup({ join: { join_rule: JoinRule.Restricted, allow: [] } });
		expect(
			button("Restricted (space)").getAttribute("aria-disabled"),
		).toBeNull();
		cleanup();

		setup({ join: { join_rule: JoinRule.Invite, allow: [] } });
		expect(
			button("Restricted (space)").getAttribute("aria-disabled"),
		).toBeNull();
	});

	it("writes history visibility changes", async () => {
		const { client } = setup({
			history: { history_visibility: HistoryVisibility.Shared },
		});

		fireEvent.click(button("Members (since joining)"));

		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!room:example.com",
			EventType.RoomHistoryVisibility,
			{ history_visibility: HistoryVisibility.Joined },
			"",
		);
	});

	it("Leave confirms, calls client.leave, and invokes onLeft on success", async () => {
		const onLeft = vi.fn();
		const { client } = setup({ onLeft });
		fireEvent.click(button("Leave room"));
		expect(screen.getByRole("dialog").textContent).toContain("Leave Alpha?");

		fireEvent.click(button("Leave"));

		await waitFor(() =>
			expect(client.leave).toHaveBeenCalledWith("!room:example.com"),
		);
		expect(onLeft).toHaveBeenCalledWith("!room:example.com");
	});

	it("ends a call hosted in this room before leaving it (#436)", async () => {
		const fake = publishFakeCall("!room:example.com");
		const order: string[] = [];
		fake.requestLeave.mockImplementationOnce(async () => {
			order.push("endCall");
			setActiveCallRoomId(null);
		});
		const { client } = setup();
		client.leave.mockImplementationOnce(async () => {
			order.push("leave");
		});

		fireEvent.click(button("Leave room"));
		fireEvent.click(button("Leave"));

		await waitFor(() => expect(client.leave).toHaveBeenCalled());
		expect(order).toEqual(["endCall", "leave"]);
		expect(activeCallRoomId()).toBeNull();
	});

	it("does not touch a call hosted in a different room", async () => {
		const fake = publishFakeCall("!other:example.com");
		const { client } = setup();

		fireEvent.click(button("Leave room"));
		fireEvent.click(button("Leave"));

		await waitFor(() => expect(client.leave).toHaveBeenCalled());
		expect(fake.requestLeave).not.toHaveBeenCalled();
		expect(activeCallRoomId()).toBe("!other:example.com");
	});

	it("Leave failure stays in the dialog and does not call onLeft", async () => {
		const onLeft = vi.fn();
		const { client } = setup({ onLeft });
		client.leave.mockRejectedValueOnce(new Error("cannot leave"));
		fireEvent.click(button("Leave room"));
		fireEvent.click(button("Leave"));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("cannot leave"),
		);
		expect(onLeft).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("offers Forget instead of Leave once the room is left", () => {
		setup({ membership: "leave" });
		expect(button("Forget room")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Leave room" })).toBeNull();
	});

	it("offers Forget for a banned room", () => {
		setup({ membership: "ban" });
		expect(button("Forget room")).toBeTruthy();
	});

	it("keeps Leave (no Forget) while still joined", () => {
		setup({ membership: "join" });
		expect(button("Leave room")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Forget room" })).toBeNull();
	});

	it("uses space copy for the Forget action", () => {
		setup({ membership: "leave", isSpace: true });
		expect(button("Forget space")).toBeTruthy();
	});

	it("Forget confirms, calls client.forget, and invokes onForgot on success", async () => {
		const onForgot = vi.fn();
		const { client } = setup({ membership: "leave", onForgot });
		fireEvent.click(button("Forget room"));
		expect(screen.getByRole("dialog").textContent).toContain("Forget Alpha?");

		fireEvent.click(button("Forget"));

		await waitFor(() =>
			// deleteRoom=false: local state is dropped after navigation via
			// the onForgot chain, not by the SDK call.
			expect(client.forget).toHaveBeenCalledWith("!room:example.com", false),
		);
		expect(onForgot).toHaveBeenCalledWith("!room:example.com");
	});

	it("falls back to the SDK room's membership when the store has no entry", () => {
		const room = createMockRoom("!room:example.com", [], [], { name: "Alpha" });
		room.getMyMembership = () => "leave";
		const client = createMockClient(new Map([["!room:example.com", room]]));
		(client as unknown as ActionClient).leave = vi.fn();
		(client as unknown as ActionClient).forget = vi.fn();
		const [summaries] = createStore<SummariesStore>({});
		render(() => (
			<TestClientProvider client={client} summaries={summaries}>
				<AdvancedTab
					client={client as unknown as MatrixClient}
					roomId="!room:example.com"
				/>
			</TestClientProvider>
		));
		expect(button("Forget room")).toBeTruthy();
	});

	it("closes an open confirm dialog when membership flips under it", async () => {
		const { setSummaries } = setup();
		fireEvent.click(button("Leave room"));
		expect(screen.getByRole("dialog")).toBeTruthy();

		setSummaries("!room:example.com", "membership", "leave");

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(button("Forget room")).toBeTruthy();
	});

	it("keeps a pending confirm dialog mounted through a membership flip so its failure still renders", async () => {
		const { client, setSummaries } = setup();
		let rejectLeave!: (e: Error) => void;
		client.leave = vi.fn(
			() =>
				new Promise((_, reject) => {
					rejectLeave = reject;
				}),
		);
		fireEvent.click(button("Leave room"));
		fireEvent.click(button("Leave"));
		await waitFor(() => expect(client.leave).toHaveBeenCalledTimes(1));

		// The leave is in flight; a membership flip must not unmount the
		// dialog (the failure below would otherwise vanish silently).
		setSummaries("!room:example.com", "membership", "leave");
		expect(screen.getByRole("dialog")).toBeTruthy();

		rejectLeave(new Error("kicked meanwhile"));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"kicked meanwhile",
			),
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("Forget failure stays in the dialog and does not call onForgot", async () => {
		const onForgot = vi.fn();
		const { client } = setup({ membership: "leave", onForgot });
		client.forget.mockRejectedValueOnce(new Error("cannot forget"));
		fireEvent.click(button("Forget room"));
		fireEvent.click(button("Forget"));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("cannot forget"),
		);
		expect(onForgot).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("disables state controls without permission while Leave remains enabled", () => {
		setup({ canJoinRules: false, canHistory: false });
		expect(button("Public").getAttribute("aria-disabled")).toBe("true");
		expect(button("Invite only").getAttribute("aria-disabled")).toBe("true");
		expect(
			button("Members (since joining)").getAttribute("aria-disabled"),
		).toBe("true");
		expect(button("Leave room").disabled).toBe(false);
	});
});
