import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SummariesStore } from "../../../../client/summaries";
import {
	_resetActiveCallForTests,
	setActiveCallRoomId,
} from "../../../../stores/activeCall";
import {
	_resetCallOverlayForTests,
	setOverlayHandlers,
	setOverlayWindow,
} from "../../../../stores/callOverlay";
import { setCryptoDialogOpen } from "../../../../stores/cryptoActions";
import {
	_resetAppModalStackForTests,
	pushAppModal,
} from "../../../../stores/modalStack";
import { _resetVoiceForTests } from "../../../../stores/voice";
import { CallStatusPanel } from "./CallStatusPanel";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./callSessionStore";
import { makeFakeCallSession } from "./fakeCallSession.test-utils";

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

describe("CallStatusPanel", () => {
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
		_resetCallOverlayForTests();
		delete (window as unknown as { documentPictureInPicture?: unknown })
			.documentPictureInPicture;
	});

	it("renders nothing when no active call is set", () => {
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		expect(screen.queryByTestId("call-status-panel")).toBeNull();
	});

	it("renders nothing when no session has been published", () => {
		setActiveCallRoomId("!room:example.com");
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		expect(screen.queryByTestId("call-status-panel")).toBeNull();
	});

	it("renders nothing when the published session's roomId does not match activeCallRoomId", () => {
		const fake = track(makeFakeCallSession({ roomId: "!other:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		expect(screen.queryByTestId("call-status-panel")).toBeNull();
	});

	it("renders when call is active and session matches", () => {
		const fake = track(
			makeFakeCallSession({
				roomId: "!call:example.com",
				roomName: "Standup",
			}),
		);
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		expect(screen.getByTestId("call-status-panel")).toBeTruthy();
		expect(
			screen.queryByRole("complementary", { name: "Active call in Standup" }),
		).toBeTruthy();
	});

	it("still renders when the user is viewing the call's own room (Discord-style always-visible)", () => {
		const fake = track(
			makeFakeCallSession({
				roomId: "!call:example.com",
				roomName: "Standup",
			}),
		);
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!call:example.com" };
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		expect(screen.getByTestId("call-status-panel")).toBeTruthy();
	});

	it("Return click navigates to the call's room via pickReturnToCallRoute (home fallback)", () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		screen.getByRole("button", { name: /Return to call/ }).click();
		expect(navigateMock).toHaveBeenCalledTimes(1);
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!call:example.com")}`,
		);
	});

	it("Return click uses /space/<spaceId>/<roomId> when the current space lists the call's room", () => {
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
		render(() => <CallStatusPanel summaries={summaries} />);
		screen.getByRole("button", { name: /Return to call/ }).click();
		const encSpace = encodeURIComponent("!space:example.com");
		const encRoom = encodeURIComponent("!call:example.com");
		expect(navigateMock).toHaveBeenCalledWith(`/space/${encSpace}/${encRoom}`);
	});

	it("Disconnect click calls session.requestClose and does not also navigate", () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		mockParams = { roomId: "!other:example.com" };
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		screen.getByRole("button", { name: "Disconnect from call" }).click();
		expect(fake.requestClose).toHaveBeenCalledTimes(1);
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("Disconnect button is disabled while leaving", () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		fake.setLeaving(true);
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		expect(
			(
				screen.getByRole("button", {
					name: "Disconnect from call",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("aside is inert when an app modal is open", async () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		pushAppModal();
		await flush();
		const aside = screen.getByTestId("call-status-panel");
		expect((aside as HTMLElement & { inert?: boolean }).inert).toBe(true);
	});

	it("aside is inert when a crypto dialog is open", async () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		setCryptoDialogOpen(true);
		await flush();
		const aside = screen.getByTestId("call-status-panel");
		expect((aside as HTMLElement & { inert?: boolean }).inert).toBe(true);
	});

	it("status label reflects rtc.status transitions", async () => {
		const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
		publishCallSession(fake.api);
		setActiveCallRoomId("!call:example.com");
		render(() => <CallStatusPanel summaries={emptySummaries()} />);
		const label = screen.getByTestId("call-status-label");
		expect(label.textContent).toBe("Not joined");
		fake.setRtcStatus("joining");
		await flush();
		expect(label.textContent).toBe("Connecting…");
		fake.setRtcStatus("joined");
		await flush();
		expect(label.textContent).toBe("Voice Connected");
		fake.setRtcStatus("joined");
		fake.setRtcError(new Error("boom"));
		await flush();
		expect(label.textContent).toBe("Connected (error)");
		fake.setRtcError(null);
		fake.setRtcStatus("leaving");
		await flush();
		expect(label.textContent).toBe("Leaving…");
		fake.setRtcStatus("error");
		await flush();
		expect(label.textContent).toBe("Error");
	});

	describe("floating overlay trigger", () => {
		const TRIGGER_NAME = /floating voice overlay/i;

		function enablePipSupport(): void {
			(
				window as unknown as { documentPictureInPicture: unknown }
			).documentPictureInPicture = {
				requestWindow: () => Promise.resolve({} as Window),
			};
		}

		function activeCall(): void {
			const fake = track(makeFakeCallSession({ roomId: "!call:example.com" }));
			publishCallSession(fake.api);
			setActiveCallRoomId("!call:example.com");
		}

		it("hides the trigger when the PiP API is unsupported", () => {
			activeCall();
			render(() => <CallStatusPanel summaries={emptySummaries()} />);
			expect(screen.queryByRole("button", { name: TRIGGER_NAME })).toBeNull();
		});

		it("shows the trigger and opens the overlay on click when supported", () => {
			enablePipSupport();
			const openSpy = vi.fn();
			const closeSpy = vi.fn();
			setOverlayHandlers(openSpy, closeSpy);
			activeCall();
			render(() => <CallStatusPanel summaries={emptySummaries()} />);
			const btn = screen.getByRole("button", {
				name: "Open floating voice overlay",
			});
			expect((btn as HTMLButtonElement).getAttribute("aria-pressed")).toBe(
				"false",
			);
			btn.click();
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(closeSpy).not.toHaveBeenCalled();
		});

		it("reflects open state and closes the overlay on click", () => {
			enablePipSupport();
			const openSpy = vi.fn();
			const closeSpy = vi.fn();
			setOverlayHandlers(openSpy, closeSpy);
			setOverlayWindow({} as Window); // mark overlay open
			activeCall();
			render(() => <CallStatusPanel summaries={emptySummaries()} />);
			const btn = screen.getByRole("button", {
				name: "Close floating voice overlay",
			});
			expect((btn as HTMLButtonElement).getAttribute("aria-pressed")).toBe(
				"true",
			);
			btn.click();
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(openSpy).not.toHaveBeenCalled();
		});
	});
});
