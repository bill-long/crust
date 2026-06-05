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
import { CallButton } from "./CallButton";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./rtc/callSessionStore";
import { _resetSwitchCallEpochForTests } from "./rtc/switchCall";

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
}

function makeMockRoom(opts: MockRoomOpts) {
	const listeners = new Set<() => void>();
	return {
		roomId: opts.roomId,
		currentState: {
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
}

function makeMockClient(opts: MockClientOpts) {
	const clientListeners = new Set<(room: unknown) => void>();
	return {
		getUserId: () => opts.userId,
		getRoom: (rid: string) => opts.rooms[rid] ?? null,
		on: (_evt: unknown, fn: (room: unknown) => void) => {
			clientListeners.add(fn);
		},
		off: (_evt: unknown, fn: (room: unknown) => void) => {
			clientListeners.delete(fn);
		},
	};
}

function renderButton(opts: {
	canSendCallMember: boolean;
	summaries?: SummariesStore;
}) {
	const room = makeMockRoom({
		roomId: "!room:example.com",
		canSendCallMember: opts.canSendCallMember,
	});
	const client = makeMockClient({
		userId: "@me:example.com",
		rooms: { "!room:example.com": room },
	});
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const summaries = opts.summaries ?? ({} as SummariesStore);
	const onStart = vi.fn();
	const result = render(() => (
		<ClientContext.Provider
			value={{
				client: client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => null,
					backupTrusted: () => true,
					secretStorageReady: () => true,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
				optimisticallyMarkJoined: () => {},
				optimisticallyMarkLeft: () => {},
			}}
		>
			<CallButton
				roomId="!room:example.com"
				callActive={() => false}
				onStart={onStart}
			/>
		</ClientContext.Provider>
	));
	return { ...result, onStart };
}

describe("CallButton visibility", () => {
	afterEach(() => {
		cleanup();
		_resetActiveCallForTests();
		_resetCallSessionForTests();
		_resetSwitchCallEpochForTests();
	});

	it("visible when the user can send the call-member state event", () => {
		renderButton({ canSendCallMember: true });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeTruthy();
	});

	it("hidden when the user lacks the power level for the call-member state event", () => {
		renderButton({ canSendCallMember: false });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});

	it("shows the Switch label when another room has an active call", () => {
		setActiveCallRoomId("!other:example.com");
		renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Switch to call in this room",
		}) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		// B-2c: the button is no longer aria-disabled in this state —
		// clicking opens the Switch confirmation dialog.
		expect(btn?.getAttribute("aria-disabled")).toBeNull();
		expect(btn?.disabled).toBe(false);
	});

	it("uses the Start label when the active call is in this room", () => {
		setActiveCallRoomId("!room:example.com");
		renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Start a call",
		}) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		expect(btn?.disabled).toBe(false);
	});

	it("clicking the Switch button opens the Switch calls? dialog and does not call onStart", () => {
		setActiveCallRoomId("!other:example.com");
		const { onStart } = renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Switch to call in this room",
		}) as HTMLButtonElement | null;
		btn?.click();
		expect(onStart).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("dialog", { name: "Switch calls?" }),
		).toBeTruthy();
	});

	it("clicking Cancel in the Switch dialog closes it and does not switch", () => {
		setActiveCallRoomId("!other:example.com");
		renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const cancel = screen.getByRole("button", { name: "Cancel" });
		cancel.click();
		// Dialog is closed
		expect(screen.queryByRole("dialog", { name: "Switch calls?" })).toBeNull();
	});

	it("dialog body names the current and target rooms from summaries", () => {
		const summaries: SummariesStore = {
			"!room:example.com": {
				roomId: "!room:example.com",
				name: "New Room",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
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
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				isSpace: false,
				kind: "text",
				callActive: true,
				children: [],
			},
		};
		setActiveCallRoomId("!other:example.com");
		renderButton({ canSendCallMember: true, summaries });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const dialog = screen.getByRole("dialog", { name: "Switch calls?" });
		expect(dialog.textContent).toContain("Current Room");
		expect(dialog.textContent).toContain("New Room");
	});

	it("falls back to generic names when summaries are missing", () => {
		setActiveCallRoomId("!other:example.com");
		renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const dialog = screen.getByRole("dialog", { name: "Switch calls?" });
		expect(dialog.textContent).toContain("another room");
		expect(dialog.textContent).toContain("this room");
	});

	it("treats whitespace-only summary names as missing for dialog fallback", () => {
		const summaries: SummariesStore = {
			"!room:example.com": {
				roomId: "!room:example.com",
				name: "   ",
				avatarUrl: null,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
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
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				isSpace: false,
				kind: "text",
				callActive: true,
				children: [],
			},
		};
		setActiveCallRoomId("!other:example.com");
		renderButton({ canSendCallMember: true, summaries });
		const btn = screen.getByRole("button", {
			name: "Switch to call in this room",
		});
		btn.click();
		const dialog = screen.getByRole("dialog", { name: "Switch calls?" });
		expect(dialog.textContent).toContain("another room");
		expect(dialog.textContent).toContain("this room");
	});

	it("calls onStart directly when no other call is active", () => {
		const { onStart } = renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", { name: "Start a call" });
		btn.click();
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog", { name: "Switch calls?" })).toBeNull();
	});

	it("calls onStart directly when the active call is in this room (not a switch)", () => {
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
		const { onStart } = renderButton({ canSendCallMember: true });
		const btn = screen.getByRole("button", { name: "Start a call" });
		btn.click();
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog", { name: "Switch calls?" })).toBeNull();
	});
});
