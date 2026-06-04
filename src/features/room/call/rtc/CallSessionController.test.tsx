import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createRoot, createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AppSyncState,
	ClientContext,
	type CryptoState,
} from "../../../../client/client";
import type { SummariesStore } from "../../../../client/summaries";
import {
	_resetActiveCallForTests,
	activeCallRoomId,
	setActiveCallRoomId,
} from "../../../../stores/activeCall";
import {
	_resetCallSessionForTests,
	currentCallSession,
} from "./callSessionStore";
import type { RtcE2EEContext } from "./rtcE2EEBridge";
import type { LivekitConnectionStatus, LivekitRoomApi } from "./useLivekitRoom";
import type { RtcSessionApi, RtcStatus } from "./useRtcSession";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Module-level fake state — tests mutate this BEFORE calling render().
interface FakeHooksState {
	rtcStatus: () => RtcStatus;
	setRtcStatus: Setter<RtcStatus>;
	rtcError: () => Error | null;
	setRtcError: Setter<Error | null>;
	rtcJoin: ReturnType<typeof vi.fn>;
	rtcLeave: ReturnType<typeof vi.fn>;
	livekitStatus: () => LivekitConnectionStatus;
	setLivekitStatus: Setter<LivekitConnectionStatus>;
	livekitDisconnect: ReturnType<typeof vi.fn>;
	livekitTeardownComplete: ReturnType<typeof vi.fn>;
	createE2EE: ReturnType<typeof vi.fn>;
	e2eeCtxDispose: ReturnType<typeof vi.fn>;
}

let hooksState: FakeHooksState;
let disposeHooksRoot: (() => void) | null = null;

function resetHooksState(): void {
	if (disposeHooksRoot) {
		disposeHooksRoot();
		disposeHooksRoot = null;
	}
	disposeHooksRoot = createRoot((dispose) => {
		const [rtcStatus, setRtcStatus] = createSignal<RtcStatus>("idle");
		const [rtcError, setRtcError] = createSignal<Error | null>(null);
		const [livekitStatus, setLivekitStatus] =
			createSignal<LivekitConnectionStatus>("idle");
		const e2eeCtxDispose = vi.fn();
		const createE2EE = vi.fn(
			async (): Promise<RtcE2EEContext> => ({
				attach: () => () => {},
				reemit: () => {},
				bindRoom: () => ({ keyProvider: {}, release: () => {} }) as never,
				dispose: e2eeCtxDispose,
			}),
		);
		hooksState = {
			rtcStatus,
			setRtcStatus,
			rtcError,
			setRtcError,
			rtcJoin: vi.fn(async () => {}),
			rtcLeave: vi.fn(async () => {}),
			livekitStatus,
			setLivekitStatus,
			livekitDisconnect: vi.fn(async () => {}),
			livekitTeardownComplete: vi.fn(async () => {}),
			createE2EE,
			e2eeCtxDispose,
		};
		return dispose;
	});
}

resetHooksState();

vi.mock("./useRtcSession", () => ({
	useRtcSession: (): RtcSessionApi => ({
		status: hooksState.rtcStatus,
		memberships: () => [],
		error: hooksState.rtcError,
		canJoin: () => true,
		joinBlockReason: () => null,
		activeFocus: () => null,
		fociReady: Promise.resolve(),
		join: hooksState.rtcJoin as unknown as () => Promise<void>,
		leave: hooksState.rtcLeave as unknown as () => Promise<void>,
	}),
}));

vi.mock("./useLivekitRoom", () => ({
	useLivekitRoom: (): LivekitRoomApi => ({
		status: hooksState.livekitStatus,
		error: () => null,
		participants: () => [],
		localCamEnabled: () => false,
		setLocalCamEnabled: async () => {},
		videoTracks: () => new Map(),
		disconnect: hooksState.livekitDisconnect as unknown as () => Promise<void>,
		audioBlocked: () => false,
		resumeAudio: async () => {},
		teardownComplete:
			hooksState.livekitTeardownComplete as unknown as () => Promise<void>,
	}),
}));

vi.mock("./rtcE2EEBridge", () => ({
	createRtcE2EEContext: (): Promise<RtcE2EEContext> =>
		(hooksState.createE2EE as unknown as () => Promise<RtcE2EEContext>)(),
}));

// Imported after vi.mock so the mocks are in place when the module loads.
import { CallSessionController } from "./CallSessionController";

const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

function renderController(): { unmount: () => void } {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const summaries = {} as SummariesStore;
	const result = render(() => (
		<ClientContext.Provider
			value={{
				client: {} as MatrixClient,
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
			}}
		>
			<CallSessionController
				roomId="!room:example.com"
				roomName={() => "Test Room"}
				elementCallUrl="https://element.example.com"
			/>
		</ClientContext.Provider>
	));
	return result;
}

describe("CallSessionController", () => {
	beforeEach(() => {
		resetHooksState();
	});

	afterEach(() => {
		cleanup();
		if (disposeHooksRoot) {
			disposeHooksRoot();
			disposeHooksRoot = null;
		}
		_resetCallSessionForTests();
		_resetActiveCallForTests();
	});

	it("publishes a CallSessionApi synchronously on mount", () => {
		renderController();
		const s = currentCallSession();
		expect(s).not.toBeNull();
		expect(s?.roomId).toBe("!room:example.com");
		expect(s?.roomName()).toBe("Test Room");
	});

	it("does NOT call rtc.join on mount — mounting just publishes the API", () => {
		renderController();
		expect(hooksState.rtcJoin).not.toHaveBeenCalled();
	});

	it("clears the published session on unmount", () => {
		const result = renderController();
		expect(currentCallSession()).not.toBeNull();
		result.unmount();
		expect(currentCallSession()).toBeNull();
	});

	it("requestJoin builds the E2EE bridge before calling rtc.join", async () => {
		renderController();
		const s = currentCallSession();
		expect(s).not.toBeNull();
		await s?.requestJoin();
		expect(hooksState.createE2EE).toHaveBeenCalledTimes(1);
		expect(hooksState.rtcJoin).toHaveBeenCalledTimes(1);
		// Bridge built first.
		expect(hooksState.createE2EE.mock.invocationCallOrder[0]).toBeLessThan(
			hooksState.rtcJoin.mock.invocationCallOrder[0],
		);
	});

	it("requestJoin is a no-op while bridgeInitializing is true", async () => {
		// Make the bridge build hang so bridgeInitializing stays true.
		let resolveBuild: (ctx: RtcE2EEContext) => void = () => {};
		hooksState.createE2EE.mockImplementationOnce(
			() =>
				new Promise<RtcE2EEContext>((r) => {
					resolveBuild = r;
				}),
		);
		renderController();
		const s = currentCallSession();
		const first = s?.requestJoin();
		await flush();
		expect(s?.bridgeInitializing()).toBe(true);
		// Second concurrent call returns immediately without calling rtc.join.
		await s?.requestJoin();
		expect(hooksState.rtcJoin).not.toHaveBeenCalled();
		// Let the first finish to avoid hanging cleanup.
		resolveBuild({
			attach: () => () => {},
			reemit: () => {},
			bindRoom: () => ({ keyProvider: {}, release: () => {} }) as never,
			dispose: hooksState.e2eeCtxDispose as unknown as () => void,
		});
		await first;
		expect(hooksState.rtcJoin).toHaveBeenCalledTimes(1);
	});

	it("requestLeave success path: disconnect → leave → clear activeCallRoomId", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		const s = currentCallSession();
		// Simulate "already joined" so the leave executes and our
		// rtc.leave mock has a chance to flip status idle.
		hooksState.setRtcStatus("joined");
		await flush();
		hooksState.rtcLeave.mockImplementationOnce(async () => {
			hooksState.setRtcStatus("idle");
		});
		await s?.requestLeave();
		expect(hooksState.livekitDisconnect).toHaveBeenCalledTimes(1);
		expect(hooksState.rtcLeave).toHaveBeenCalledTimes(1);
		expect(activeCallRoomId()).toBeNull();
	});

	it("requestLeave rejects and preserves activeCallRoomId when rtc.status stays joined after leave", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		const s = currentCallSession();
		hooksState.setRtcStatus("joined");
		hooksState.setRtcError(new Error("server rejected leave"));
		await flush();
		// rtc.leave resolves but status stays joined → runLeave throws.
		hooksState.rtcLeave.mockImplementationOnce(async () => {});
		await expect(s?.requestLeave()).rejects.toThrow("server rejected leave");
		expect(activeCallRoomId()).toBe("!room:example.com");
	});

	it("concurrent requestLeave callers dedup via the single-flight leavePromise", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		const s = currentCallSession();
		hooksState.setRtcStatus("joined");
		await flush();
		let resolveLeave: () => void = () => {};
		hooksState.rtcLeave.mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					resolveLeave = () => {
						hooksState.setRtcStatus("idle");
						r();
					};
				}),
		);
		const p1 = s?.requestLeave();
		const p2 = s?.requestLeave();
		await flush();
		resolveLeave();
		await Promise.all([p1, p2]);
		expect(hooksState.rtcLeave).toHaveBeenCalledTimes(1);
		expect(hooksState.livekitDisconnect).toHaveBeenCalledTimes(1);
	});

	it("SDK-driven termination (joined → idle) clears activeCallRoomId", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		hooksState.setRtcStatus("joined");
		await flush();
		// SDK ends the session externally (network drop, kick).
		hooksState.setRtcStatus("idle");
		await flush();
		expect(activeCallRoomId()).toBeNull();
	});

	it("does NOT clear activeCallRoomId on idle→idle transitions (controller never joined)", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		// Force a re-evaluation of the watcher effect by toggling error
		// without ever passing through 'joined'.
		hooksState.setRtcError(new Error("foci offline"));
		hooksState.setRtcStatus("error");
		await flush();
		expect(activeCallRoomId()).toBe("!room:example.com");
	});

	it("onCleanup of a stale controller does not clobber a newer controller's publication", () => {
		// Simulates the switch-flow ordering hazard: the OLD controller's
		// onCleanup runs AFTER a NEW controller has already mounted and
		// published. clearCallSessionIfCurrent must be a no-op in that
		// case (different instance id), so the new publication survives.
		const first = renderController();
		const firstApi = currentCallSession();
		expect(firstApi).not.toBeNull();
		const firstInstanceId = firstApi?.instanceId;

		// Mount a second controller WITHOUT unmounting the first. The new
		// controller publishes a fresh CallSessionApi with a new instanceId,
		// overwriting `currentCallSession()`.
		renderController();
		const secondApi = currentCallSession();
		expect(secondApi).not.toBeNull();
		expect(secondApi?.instanceId).not.toBe(firstInstanceId);

		// Now unmount the first controller. Its onCleanup runs
		// `clearCallSessionIfCurrent(firstInstanceId)`, which must NOT
		// clear the newer publication.
		first.unmount();
		expect(currentCallSession()).toBe(secondApi);
	});

	it("requestClose opens the leave-confirm ConfirmDialog when status is joined", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		const s = currentCallSession();
		hooksState.setRtcStatus("joined");
		await flush();
		expect(screen.queryByRole("dialog", { name: "Leave call?" })).toBeNull();
		s?.requestClose();
		await flush();
		const dialog = screen.getByRole("dialog", { name: "Leave call?" });
		expect(dialog).toBeTruthy();
		expect(screen.getByRole("button", { name: "Leave call" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stay" })).toBeTruthy();
		// Did NOT leave yet — just opened the dialog.
		expect(hooksState.rtcLeave).not.toHaveBeenCalled();
		expect(activeCallRoomId()).toBe("!room:example.com");
	});

	it("requestClose with status=idle skips the dialog and clears activeCallRoomId immediately", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		const s = currentCallSession();
		// status stays idle (default).
		s?.requestClose();
		await flush();
		expect(screen.queryByRole("dialog", { name: "Leave call?" })).toBeNull();
		expect(activeCallRoomId()).toBeNull();
	});

	it("dispose during in-flight leave: cleanup completes without error and runLeave's finally setLeaving(false) is benign after unmount", async () => {
		setActiveCallRoomId("!room:example.com");
		const result = renderController();
		const s = currentCallSession();
		expect(s).not.toBeNull();
		if (!s) throw new Error("currentCallSession() returned null");
		hooksState.setRtcStatus("joined");
		await flush();
		let resolveDisconnect: () => void = () => {};
		hooksState.livekitDisconnect.mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					resolveDisconnect = r;
				}),
		);
		const leavePromise = s.requestLeave();
		await flush();
		// Unmount the controller while the leave is awaiting livekit.disconnect().
		// `runLeave`'s finally writes setLeaving(false) AFTER unmount; the
		// signal write must be a benign no-op (no console errors, no
		// post-unmount UI mutation). Also exercises the requestLeave catch
		// branch: requestLeave does setLeaveError + setConfirmLeaveOpen
		// after the throw from `if (rtc.status === "joined")`, both signal
		// writes on a torn-down controller.
		result.unmount();
		// rtc.leave resolves but status stays "joined" → runLeave throws
		// "Leave failed." inside its try, finally clears `leaving`, the
		// caught error propagates out of requestLeave (which also calls
		// setLeaveError/setConfirmLeaveOpen post-unmount).
		hooksState.rtcLeave.mockImplementationOnce(async () => {});
		resolveDisconnect();
		await expect(leavePromise).rejects.toThrow("Leave failed.");
		// Session was cleared by the unmount path; no resurrected publication.
		expect(currentCallSession()).toBeNull();
	});

	it("ConfirmDialog Stay button closes the dialog without leaving the call", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		const s = currentCallSession();
		hooksState.setRtcStatus("joined");
		await flush();
		s?.requestClose();
		await flush();
		screen.getByRole("button", { name: "Stay" }).click();
		await flush();
		expect(screen.queryByRole("dialog", { name: "Leave call?" })).toBeNull();
		expect(hooksState.rtcLeave).not.toHaveBeenCalled();
		expect(activeCallRoomId()).toBe("!room:example.com");
	});

	it("ConfirmDialog Leave button runs the leave path and clears activeCallRoomId", async () => {
		setActiveCallRoomId("!room:example.com");
		renderController();
		const s = currentCallSession();
		hooksState.setRtcStatus("joined");
		await flush();
		hooksState.rtcLeave.mockImplementationOnce(async () => {
			hooksState.setRtcStatus("idle");
		});
		s?.requestClose();
		await flush();
		screen.getByRole("button", { name: "Leave call" }).click();
		// Allow the dialog's onConfirm promise (confirmLeave → rtc.leave)
		// to resolve through its microtasks.
		await flush();
		await flush();
		await flush();
		expect(hooksState.livekitDisconnect).toHaveBeenCalledTimes(1);
		expect(hooksState.rtcLeave).toHaveBeenCalledTimes(1);
		expect(activeCallRoomId()).toBeNull();
	});
});
