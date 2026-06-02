import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AppSyncState,
	ClientContext,
	type CryptoState,
} from "../../../client/client";
import type { SummariesStore } from "../../../client/summaries";
import { updateSetting, userSettings } from "../../../stores/settings";
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

function renderButton(opts: {
	canSendCallMember: boolean;
	elementCallUrl: string;
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
	// CallButton never reads summaries; an empty object is sufficient.
	const summaries = {} as SummariesStore;
	return render(() => (
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
				elementCallUrl={opts.elementCallUrl}
				onStart={() => undefined}
			/>
		</ClientContext.Provider>
	));
}

describe("CallButton visibility (Phase 5, #122)", () => {
	let previousUseNative: boolean;

	beforeEach(() => {
		previousUseNative = userSettings().useNativeCalls;
	});

	afterEach(() => {
		cleanup();
		updateSetting("useNativeCalls", previousUseNative);
	});

	it("native mode + empty elementCallUrl: visible (foci can come from .well-known)", () => {
		updateSetting("useNativeCalls", true);
		renderButton({ canSendCallMember: true, elementCallUrl: "" });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeTruthy();
	});

	it("native mode + populated elementCallUrl: visible", () => {
		updateSetting("useNativeCalls", true);
		renderButton({
			canSendCallMember: true,
			elementCallUrl: "https://call.example.com",
		});
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeTruthy();
	});

	it("iframe mode + empty elementCallUrl: hidden", () => {
		updateSetting("useNativeCalls", false);
		renderButton({ canSendCallMember: true, elementCallUrl: "" });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});

	it("iframe mode + whitespace-only elementCallUrl: hidden", () => {
		updateSetting("useNativeCalls", false);
		renderButton({ canSendCallMember: true, elementCallUrl: "   " });
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});

	it("iframe mode + populated elementCallUrl: visible", () => {
		updateSetting("useNativeCalls", false);
		renderButton({
			canSendCallMember: true,
			elementCallUrl: "https://call.example.com",
		});
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeTruthy();
	});

	it("power-level denial: hidden regardless of mode (native)", () => {
		updateSetting("useNativeCalls", true);
		renderButton({
			canSendCallMember: false,
			elementCallUrl: "https://call.example.com",
		});
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});

	it("power-level denial: hidden regardless of mode (iframe)", () => {
		updateSetting("useNativeCalls", false);
		renderButton({
			canSendCallMember: false,
			elementCallUrl: "https://call.example.com",
		});
		expect(screen.queryByRole("button", { name: "Start a call" })).toBeNull();
	});
});
