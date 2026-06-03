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

function renderButton(opts: { canSendCallMember: boolean }) {
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
	// CallButton never reads summaries; an empty object is sufficient.
	const summaries = {} as SummariesStore;
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
	});

	it("visible when the user can send the call-member state event", () => {
		renderButton({ canSendCallMember: true });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeTruthy();
	});

	it("hidden when the user lacks the power level for the call-member state event", () => {
		renderButton({ canSendCallMember: false });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});

	it("disabled with explanatory label when another room has an active call", () => {
		setActiveCallRoomId("!other:example.com");
		renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Leave the current call first",
		}) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		expect(btn?.disabled).toBe(true);
	});

	it("not disabled when the active call is in this room", () => {
		setActiveCallRoomId("!room:example.com");
		renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Start a call",
		}) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		expect(btn?.disabled).toBe(false);
	});

	it("does not invoke onStart when refused due to another active call", () => {
		setActiveCallRoomId("!other:example.com");
		const { onStart } = renderButton({ canSendCallMember: true });
		const btn = screen.queryByRole("button", {
			name: "Leave the current call first",
		}) as HTMLButtonElement | null;
		btn?.click();
		expect(onStart).not.toHaveBeenCalled();
	});
});
