import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SummariesStore } from "../../../../client/summaries";
import {
	_resetActiveCallForTests,
	setActiveCallRoomId,
} from "../../../../stores/activeCall";
import { setCryptoDialogOpen } from "../../../../stores/cryptoActions";
import {
	_resetAppModalStackForTests,
	pushAppModal,
} from "../../../../stores/modalStack";
import {
	_resetVoiceForTests,
	setUserWantsMic,
	userWantsMic,
} from "../../../../stores/voice";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./callSessionStore";
import { makeFakeCallSession } from "./fakeCallSession.test-utils";
import { MiniCallWidget } from "./MiniCallWidget";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
let mockParams: { roomId?: string; spaceId?: string } = {};

vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useParams: () => mockParams,
}));

const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

function emptySummaries(): SummariesStore {
	return {} as SummariesStore;
}

describe("MiniCallWidget", () => {
	const fakes: Array<{ dispose: () => void }> = [];
	const track = <T extends { dispose: () => void }>(fake: T): T => {
		fakes.push(fake);
		return fake;
	};

	afterEach(() => {
		cleanup();
		for (const f of fakes.splice(0)) f.dispose();
		_resetCallSessionForTests();
		_resetActiveCallForTests();
		_resetAppModalStackForTests();
		_resetVoiceForTests();
		setCryptoDialogOpen(false);
		navigateMock.mockReset();
		mockParams = {};
	});

	it("renders nothing when no active call is set", () => {
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		expect(screen.queryByRole("complementary")).toBeNull();
	});

	it("renders nothing when no session has been published", () => {
		setActiveCallRoomId("!room:example.com");
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		expect(screen.queryByRole("complementary")).toBeNull();
	});

	it("renders nothing when the route roomId matches the active call", () => {
		const fake = track(makeFakeCallSession({ roomId: "!room:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!room:example.com");
		mockParams = { roomId: "!room:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		expect(screen.queryByRole("complementary")).toBeNull();
	});

	it("renders when the route differs from the call's room", () => {
		const fake = track(
			makeFakeCallSession({
				roomId: "!call:example.com",
				roomName: "Standup",
			}),
		);
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		expect(
			screen.queryByRole("complementary", { name: "Active call in Standup" }),
		).toBeTruthy();
	});

	it("Return button navigates to the call's room via pickReturnToCallRoute (home fallback when unknown)", () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		screen.getByRole("button", { name: "Return to call" }).click();
		expect(navigateMock).toHaveBeenCalledTimes(1);
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!call:example.com")}`,
		);
	});

	it("Return button uses /space/<spaceId>/<roomId> when the current space lists the call's room as a child", () => {
		const summaries: SummariesStore = {
			"!space:example.com": {
				roomId: "!space:example.com",
				name: "Engineering",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				isSpace: true,
				kind: "text",
				callActive: false,
				children: ["!call:example.com"],
			},
			"!call:example.com": {
				roomId: "!call:example.com",
				name: "Standup",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				isSpace: false,
				kind: "text",
				callActive: true,
				children: [],
			},
		};
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = {
			roomId: "!other:example.com",
			spaceId: "!space:example.com",
		};
		render(() => <MiniCallWidget summaries={summaries} />);
		screen.getByRole("button", { name: "Return to call" }).click();
		const encSpace = encodeURIComponent("!space:example.com");
		const encRoom = encodeURIComponent("!call:example.com");
		expect(navigateMock).toHaveBeenCalledWith(`/space/${encSpace}/${encRoom}`);
	});

	it("Leave button calls session.requestClose", () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		screen.getByRole("button", { name: "Leave call" }).click();
		expect(fake.requestClose).toHaveBeenCalledTimes(1);
	});

	it("Leave button is disabled while leaving", () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		fake.setLeaving(true);
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		expect(
			(screen.getByRole("button", { name: "Leave call" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("mic toggle calls toggleUserWantsMic", () => {
		setUserWantsMic(true);
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		screen.getByRole("button", { name: "Mute microphone" }).click();
		expect(userWantsMic()).toBe(false);
	});

	it("aside is inert when an app modal is open", async () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		pushAppModal();
		await flush();
		const aside = screen.getByRole("complementary", {
			name: /Active call/,
		});
		expect((aside as HTMLElement & { inert?: boolean }).inert).toBe(true);
	});

	it("aside is inert when a crypto dialog is open", async () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		setCryptoDialogOpen(true);
		await flush();
		const aside = screen.getByRole("complementary", {
			name: /Active call/,
		});
		expect((aside as HTMLElement & { inert?: boolean }).inert).toBe(true);
	});

	it("status label reflects rtc.status transitions", async () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <MiniCallWidget summaries={emptySummaries()} />);
		const label = screen.getByTestId("mini-call-status");
		expect(label.textContent).toBe("Not joined");
		fake.setRtcStatus("joining");
		await flush();
		expect(label.textContent).toBe("Connecting…");
		fake.setRtcStatus("joined");
		await flush();
		expect(label.textContent).toBe("Connected");
		fake.setRtcStatus("leaving");
		await flush();
		expect(label.textContent).toBe("Leaving…");
		fake.setRtcStatus("error");
		await flush();
		expect(label.textContent).toBe("Error");
	});
});
