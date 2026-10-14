import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AppSyncState,
	ClientContext,
	type CryptoState,
} from "../../../client/client";
import type { SummariesStore } from "../../../client/summaries";
import {
	_resetActiveCallForTests,
	setActiveCallRoomId,
} from "../../../stores/activeCall";
import { TEST_SESSION } from "../../../test/testSession";
import { CallButton } from "./CallButton";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./rtc/callSessionStore";
import { _resetSwitchCallEpochForTests } from "./rtc/switchCall";

const { discoverMock } = vi.hoisted(() => ({ discoverMock: vi.fn() }));
vi.mock("./rtc/discoverFoci", () => ({ discoverLivekitFoci: discoverMock }));
vi.mock("../../../app/ConfigProvider", () => ({
	useConfig: () => ({ elementCall: { url: "https://call.example.com" } }),
}));

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

interface MockRoomOpts {
	roomId: string;
	canSendCallMember: boolean;
	canSendSticky?: boolean;
	membership?: string;
}

function makeMockRoom(opts: MockRoomOpts) {
	const listeners = new Set<() => void>();
	return {
		roomId: opts.roomId,
		getMyMembership: () => opts.membership ?? "join",
		currentState: {
			getStateEvents: () => [],
			maySendEvent: () => opts.canSendSticky ?? false,
			maySendStateEvent: (_type: string, _uid: string): boolean =>
				opts.canSendCallMember,
		},
		on: (_evt: unknown, fn: () => void) => {
			listeners.add(fn);
		},
		removeListener: (_evt: unknown, fn: () => void) => {
			listeners.delete(fn);
		},
	};
}

interface MockClientOpts {
	userId: string;
	rooms: Record<string, ReturnType<typeof makeMockRoom>>;
	sticky?: boolean;
	capabilityFailure?: boolean;
}

function makeMockClient(opts: MockClientOpts) {
	const clientListeners = new Set<(room: unknown) => void>();
	let capabilityAttempts = 0;
	return {
		getUserId: () => opts.userId,
		doesServerSupportUnstableFeature: async () => {
			if (opts.capabilityFailure && capabilityAttempts++ === 0)
				throw new Error("temporary versions failure");
			return opts.sticky ?? false;
		},
		getRoom: (rid: string) => opts.rooms[rid] ?? null,
		on: (_evt: unknown, fn: (room: unknown) => void) => {
			clientListeners.add(fn);
		},
		off: (_evt: unknown, fn: (room: unknown) => void) => {
			clientListeners.delete(fn);
		},
	};
}

async function renderButton(opts: {
	canSendCallMember: boolean;
	canSendSticky?: boolean;
	transport?: "url" | "service" | "dual";
	capabilityFailure?: boolean;
	summaries?: SummariesStore;
}) {
	discoverMock.mockResolvedValue([
		{
			type: "livekit",
			livekit_alias: "!room:example.com",
			livekit_service_url:
				opts.transport === "url" ? "" : "https://sfu.example.com",
			...(opts.transport !== "service" ? { url: "wss://sfu.example.com" } : {}),
		},
	]);
	const room = makeMockRoom({
		roomId: "!room:example.com",
		canSendCallMember: opts.canSendCallMember,
		...(opts.canSendSticky !== undefined
			? { canSendSticky: opts.canSendSticky }
			: {}),
	});
	const client = makeMockClient({
		userId: "@me:example.com",
		sticky: opts.canSendSticky ?? false,
		...(opts.capabilityFailure ? { capabilityFailure: true } : {}),
		rooms: { "!room:example.com": room },
	});
	const [syncState, setSyncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const summaries = opts.summaries ?? ({} as SummariesStore);
	const onStart = vi.fn();
	const result = render(() => (
		<ClientContext.Provider
			value={{
				session: TEST_SESSION,
				client: client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => null,
					backupOnServer: () => false,
					backupTrusted: () => true,
					secretStorageReady: () => true,
					crossSigningStatus: () => undefined,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
				optimisticallyMarkJoined: () => {},
				optimisticallyMarkKnocked: () => {},
				optimisticallyMarkLeft: () => {},
				optimisticallySetMarkedUnread: () => {},
				optimisticallySetRoomTag: () => {},
				optimisticallySetSpaceOrder: () => {},
				forgetRoomLocally: () => {},
			}}
		>
			<CallButton
				roomId="!room:example.com"
				callActive={() => false}
				onStart={onStart}
			/>
		</ClientContext.Provider>
	));
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { ...result, onStart, setSyncState };
}

describe("CallButton visibility", () => {
	afterEach(() => {
		cleanup();
		_resetActiveCallForTests();
		_resetCallSessionForTests();
		_resetSwitchCallEpochForTests();
	});

	it("offers Join to a sticky-capable member without legacy state permission", async () => {
		await renderButton({ canSendCallMember: false, canSendSticky: true });
		await vi.waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Start a call" }),
			).toBeTruthy(),
		);
	});

	it.each([
		{ recovery: "manual", failure: "transports" },
		{ recovery: "reconnect", failure: "transports" },
		{ recovery: "manual", failure: "versions" },
		{ recovery: "reconnect", failure: "versions" },
	])(
		"recovers failed discovery via %s without navigating",
		async ({ recovery, failure }) => {
			const before = discoverMock.mock.calls.length;
			if (failure === "transports") discoverMock.mockResolvedValueOnce([]);
			const { setSyncState, onStart } = await renderButton({
				canSendCallMember: false,
				canSendSticky: true,
				transport: "url",
				capabilityFailure: failure === "versions",
			});
			const retry = screen.getByRole("button", {
				name: "Retry call discovery",
			});
			if (recovery === "manual") retry.click();
			else {
				setSyncState("error");
				setSyncState("live");
			}
			await screen.findByRole("button", { name: "Start a call" });
			expect(discoverMock.mock.calls.length).toBe(before + 2);
			expect(onStart).not.toHaveBeenCalled();
		},
	);

	it.each([
		{
			transport: "service",
			canSendSticky: true,
			canSendCallMember: false,
			visible: false,
		},
		{
			transport: "url",
			canSendSticky: false,
			canSendCallMember: true,
			visible: false,
		},
		{
			transport: "dual",
			canSendSticky: false,
			canSendCallMember: true,
			visible: true,
		},
		{
			transport: "url",
			canSendSticky: true,
			canSendCallMember: false,
			visible: true,
		},
	] as const)(
		"matches eligibility to the resolved transport: %j",
		async (scenario) => {
			await renderButton(scenario);
			expect(
				screen.queryByRole("button", { name: "Start a call" }) !== null,
			).toBe(scenario.visible);
		},
	);

	it("visible when the user can send the call-member state event", async () => {
		await renderButton({ canSendCallMember: true });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeTruthy();
	});

	it("hidden when the user lacks the power level for the call-member state event", async () => {
		await renderButton({ canSendCallMember: false });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});

	it("hidden for a summaries-marked left room even when admin power survives", async () => {
		await renderButton({
			canSendCallMember: true,
			summaries: {
				"!room:example.com": { membership: "leave" },
			} as unknown as SummariesStore,
		});
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});

	it("shows the Switch label when another room has an active call", async () => {
		setActiveCallRoomId("!other:example.com");
		await renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Switch to call in this room",
		}) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		// B-2c: the button is no longer aria-disabled in this state —
		// clicking opens the Switch confirmation dialog.
		expect(btn?.getAttribute("aria-disabled")).toBeNull();
		expect(btn?.disabled).toBe(false);
	});

	it("uses the Start label when the active call is in this room", async () => {
		setActiveCallRoomId("!room:example.com");
		await renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Start a call",
		}) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		expect(btn?.disabled).toBe(false);
	});

	it("clicking the Switch button opens the Switch calls? dialog and does not call onStart", async () => {
		setActiveCallRoomId("!other:example.com");
		const { onStart } = await renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Switch to call in this room",
		}) as HTMLButtonElement | null;
		btn?.click();
		expect(onStart).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("dialog", { name: "Switch calls?" }),
		).toBeTruthy();
	});

	it("clicking Cancel in the Switch dialog closes it and does not switch", async () => {
		setActiveCallRoomId("!other:example.com");
		await renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const cancel = screen.getByRole("button", { name: "Cancel" });
		cancel.click();
		// Dialog is closed
		expect(screen.queryByRole("dialog", { name: "Switch calls?" })).toBeNull();
	});

	it("dialog body names the current and target rooms from summaries", async () => {
		const summaries: SummariesStore = {
			"!room:example.com": {
				roomId: "!room:example.com",
				name: "New Room",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				markedUnread: false,
				isFavourite: false,
				isLowPriority: false,
				spaceOrder: null,
				isMuted: false,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				dmUserId: null,
				isSpace: false,
				kind: "text",
				callActive: false,
				children: [],
			},
			"!other:example.com": {
				roomId: "!other:example.com",
				name: "Current Room",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				markedUnread: false,
				isFavourite: false,
				isLowPriority: false,
				spaceOrder: null,
				isMuted: false,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				dmUserId: null,
				isSpace: false,
				kind: "text",
				callActive: true,
				children: [],
			},
		};
		setActiveCallRoomId("!other:example.com");
		await renderButton({ canSendCallMember: true, summaries });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const dialog = screen.getByRole("dialog", { name: "Switch calls?" });
		expect(dialog.textContent).toContain("Current Room");
		expect(dialog.textContent).toContain("New Room");
	});

	it("falls back to generic names when summaries are missing", async () => {
		setActiveCallRoomId("!other:example.com");
		await renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const dialog = screen.getByRole("dialog", { name: "Switch calls?" });
		expect(dialog.textContent).toContain("another room");
		expect(dialog.textContent).toContain("this room");
	});

	it("treats whitespace-only summary names as missing for dialog fallback", async () => {
		const summaries: SummariesStore = {
			"!room:example.com": {
				roomId: "!room:example.com",
				name: "   ",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				markedUnread: false,
				isFavourite: false,
				isLowPriority: false,
				spaceOrder: null,
				isMuted: false,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				dmUserId: null,
				isSpace: false,
				kind: "text",
				callActive: false,
				children: [],
			},
			"!other:example.com": {
				roomId: "!other:example.com",
				name: "\t\n",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				markedUnread: false,
				isFavourite: false,
				isLowPriority: false,
				spaceOrder: null,
				isMuted: false,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				dmUserId: null,
				isSpace: false,
				kind: "text",
				callActive: true,
				children: [],
			},
		};
		setActiveCallRoomId("!other:example.com");
		await renderButton({ canSendCallMember: true, summaries });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const dialog = screen.getByRole("dialog", { name: "Switch calls?" });
		expect(dialog.textContent).toContain("another room");
		expect(dialog.textContent).toContain("this room");
	});

	it("calls onStart directly when no other call is active", async () => {
		const { onStart } = await renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", { name: "Start a call" });
		btn.click();
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog", { name: "Switch calls?" })).toBeNull();
	});

	it("calls onStart directly when the active call is in this room (not a switch)", async () => {
		setActiveCallRoomId("!room:example.com");
		// Publishing a session for this room so otherCallActive() === false.
		publishCallSession({
			instanceId: 1,
			roomId: "!room:example.com",
			roomName: () => "This Room",
			// biome-ignore lint/suspicious/noExplicitAny: stub for CallButton tests
			rtc: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: stub for CallButton tests
			livekit: {} as any,
			bridgeInitializing: () => false,
			bridgeInitError: () => null,
			leaving: () => false,
			requestJoin: async () => {},
			requestClose: () => {},
			requestLeave: async () => {},
		});
		const { onStart } = await renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", { name: "Start a call" });
		btn.click();
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog", { name: "Switch calls?" })).toBeNull();
	});
});
