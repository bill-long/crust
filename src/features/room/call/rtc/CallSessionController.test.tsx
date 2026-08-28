import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
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
import { clearNotices, notices } from "../../../../stores/notices";
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
		localScreenShareEnabled: () => false,
		setLocalScreenShareEnabled: async () => {},
		screenShareSupported: true,
		videoTracks: () => new Map(),
		screenShareTracks: () => new Map(),
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

import { TEST_SESSION } from "../../../../test/testSession";
// Imported after vi.mock so the mocks are in place when the module loads.
import { CallSessionController } from "./CallSessionController";

const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

function renderController(opts?: { encrypted?: boolean }): {
	unmount: () => void;
	setEncrypted: (v: boolean) => void;
	emitRoomState: (event: MatrixEvent) => void;
} {
	let encrypted = opts?.encrypted ?? true;
	let roomStateHandler: ((event: MatrixEvent) => void) | null = null;
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const summaries = {} as SummariesStore;
	const result = render(() => (
		<ClientContext.Provider
			value={{
				session: TEST_SESSION,
				client: {
					// roomEncrypted() reads the authoritative room state, not
					// the summaries store (which can be optimistically false).
					getRoom: () => ({
						hasEncryptionStateEvent: () => encrypted,
					}),
					// Capture the RoomStateEvent.Events listener so tests can
					// emit a late-arriving m.room.encryption event.
					on: (_event: string, handler: (e: MatrixEvent) => void) => {
						roomStateHandler = handler;
					},
					off: () => {},
				} as unknown as MatrixClient,
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
			<CallSessionController
				roomId="!room:example.com"
				roomName={() => "Test Room"}
				elementCallUrl="https://element.example.com"
			/>
		</ClientContext.Provider>
	));
	return {
		...result,
		setEncrypted: (v: boolean) => {
			encrypted = v;
		},
		emitRoomState: (event: MatrixEvent) => roomStateHandler?.(event),
	};
}

describe("CallSessionController", () => {
	beforeEach(() => {
		resetHooksState();
	});

	afterEach(() => {
		cleanup();
		// `restoreAllMocks` does not undo `useFakeTimers`; a test that fails
		// mid-body would otherwise leak them into the rest of the file.
		vi.useRealTimers();
		// Spies must be restored too: `spyOn` on an already-spied method hands
		// back the SAME mock, so an unrestored console spy leaks its call
		// history into the next test's `toHaveBeenCalled` assertions.
		vi.restoreAllMocks();
		clearNotices();
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

	it("requestJoin in an UNENCRYPTED room skips the E2EE bridge (plaintext media, matching peers)", async () => {
		renderController({ encrypted: false });
		const s = currentCallSession();
		expect(s).not.toBeNull();
		await s?.requestJoin();
		// No bridge is built — media stays plaintext so peers (who also
		// don't encrypt in an unencrypted room) can decode our audio.
		expect(hooksState.createE2EE).not.toHaveBeenCalled();
		expect(hooksState.rtcJoin).toHaveBeenCalledTimes(1);
	});

	it("joined-on-mount in an ENCRYPTED room builds the E2EE bridge (recovery path)", async () => {
		renderController({ encrypted: true });
		// Simulate the controller mounting while MatrixRTC already reports
		// joined (close-without-leave, hot reload). The recovery effect
		// should build the bridge because the room is encrypted.
		hooksState.setRtcStatus("joined");
		await flush();
		expect(hooksState.createE2EE).toHaveBeenCalledTimes(1);
	});

	it("joined-on-mount in an UNENCRYPTED room does NOT build the E2EE bridge", async () => {
		renderController({ encrypted: false });
		hooksState.setRtcStatus("joined");
		await flush();
		// Plaintext call: the recovery effect must not build a bridge,
		// otherwise we would re-encrypt alone and peers hear noise.
		expect(hooksState.createE2EE).not.toHaveBeenCalled();
	});

	it("late-arriving m.room.encryption builds the bridge (reactive re-gate)", async () => {
		const { setEncrypted, emitRoomState } = renderController({
			encrypted: false,
		});
		hooksState.setRtcStatus("joined");
		await flush();
		expect(hooksState.createE2EE).not.toHaveBeenCalled();
		// Room becomes encrypted after mount; the m.room.encryption state
		// event arrives → roomEncrypted flips true → recovery effect builds
		// the bridge so media is encrypted before reconnect.
		setEncrypted(true);
		emitRoomState({
			getType: () => "m.room.encryption",
			getRoomId: () => "!room:example.com",
		} as unknown as MatrixEvent);
		await flush();
		expect(hooksState.createE2EE).toHaveBeenCalledTimes(1);
	});

	it("ignores m.room.encryption events for OTHER rooms", async () => {
		const { setEncrypted, emitRoomState } = renderController({
			encrypted: false,
		});
		hooksState.setRtcStatus("joined");
		await flush();
		setEncrypted(true);
		// Wrong room id — must not flip our gate.
		emitRoomState({
			getType: () => "m.room.encryption",
			getRoomId: () => "!other:example.com",
		} as unknown as MatrixEvent);
		await flush();
		expect(hooksState.createE2EE).not.toHaveBeenCalled();
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

	describe("media-death watchdog (#434)", () => {
		/** Joined on both layers, media connected — the healthy steady state. */
		async function joinedAndConnected() {
			setActiveCallRoomId("!room:example.com");
			const rendered = renderController();
			hooksState.setRtcStatus("joined");
			hooksState.setLivekitStatus("connected");
			await flush();
			return rendered;
		}

		it("ends the call when media stays down while MatrixRTC still reports joined", async () => {
			vi.useFakeTimers();
			await joinedAndConnected();
			hooksState.rtcLeave.mockImplementationOnce(async () => {
				hooksState.setRtcStatus("idle");
			});

			// livekit-client gave up (SFU unreachable / duplicate identity).
			hooksState.setLivekitStatus("idle");
			await flush();
			expect(hooksState.rtcLeave).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(20_000);
			await flush();

			expect(hooksState.rtcLeave).toHaveBeenCalledTimes(1);
			expect(activeCallRoomId()).toBeNull();
		});

		it("does not end the call when media recovers within the grace period", async () => {
			vi.useFakeTimers();
			await joinedAndConnected();

			hooksState.setLivekitStatus("idle");
			await flush();
			await vi.advanceTimersByTimeAsync(19_000);
			hooksState.setLivekitStatus("connecting");
			await flush();
			hooksState.setLivekitStatus("connected");
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			await flush();

			expect(hooksState.rtcLeave).not.toHaveBeenCalled();
			expect(activeCallRoomId()).toBe("!room:example.com");
		});

		it("does not fire during the pre-connect window of a normal join", async () => {
			vi.useFakeTimers();
			setActiveCallRoomId("!room:example.com");
			renderController();
			// RTC joined, LiveKit not connected YET — "idle" here is the
			// ordinary pre-connect state, not a death.
			hooksState.setRtcStatus("joined");
			hooksState.setLivekitStatus("idle");
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			await flush();

			expect(hooksState.rtcLeave).not.toHaveBeenCalled();
			expect(activeCallRoomId()).toBe("!room:example.com");
		});

		it("stands down once MatrixRTC is no longer joined", async () => {
			vi.useFakeTimers();
			await joinedAndConnected();

			hooksState.setLivekitStatus("idle");
			await flush();
			// The RTC layer terminates on its own — the existing watcher owns
			// this case, and it already cleared the signal.
			hooksState.setRtcStatus("idle");
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			await flush();

			expect(hooksState.rtcLeave).not.toHaveBeenCalled();
		});

		it("does not fire while the user's own leave is in flight", async () => {
			vi.useFakeTimers();
			await joinedAndConnected();
			const s = currentCallSession();

			let releaseDisconnect!: () => void;
			hooksState.livekitDisconnect.mockImplementationOnce(
				() =>
					new Promise<void>((res) => {
						releaseDisconnect = res;
					}),
			);
			hooksState.rtcLeave.mockImplementationOnce(async () => {
				hooksState.setRtcStatus("idle");
			});

			const leave = s?.requestLeave();
			await flush();
			// The user's leave disconnects media; that must not look like a death.
			hooksState.setLivekitStatus("idle");
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			await flush();
			expect(hooksState.rtcLeave).not.toHaveBeenCalled();

			releaseDisconnect();
			await leave;
			await flush();
			// Exactly one leave — the user's, not a second from the watchdog.
			expect(hooksState.rtcLeave).toHaveBeenCalledTimes(1);
		});

		it("stays out of the way after a FAILED user leave, and re-arms on Stay", async () => {
			vi.useFakeTimers();
			await joinedAndConnected();
			const s = currentCallSession();
			hooksState.setRtcError(new Error("server rejected leave"));
			// rtc.leave resolves but status stays "joined" → runLeave throws.
			hooksState.rtcLeave.mockImplementationOnce(async () => {});

			await expect(s?.requestLeave()).rejects.toThrow("server rejected leave");
			// The resting state after a failed leave: media parked at "idle"
			// by our own teardown, `leaveRequested` sticky, RTC still joined.
			hooksState.setLivekitStatus("idle");
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			await flush();

			// Exactly the one leave the user asked for — no watchdog retry, and
			// the confirm dialog (with its error) is still on screen.
			expect(hooksState.rtcLeave).toHaveBeenCalledTimes(1);
			expect(activeCallRoomId()).toBe("!room:example.com");
			expect(screen.queryByText("Leave call?")).toBeTruthy();

			// "Stay" clears the sticky suppressor; media is still dead, so the
			// watchdog takes over from there.
			hooksState.rtcLeave.mockImplementationOnce(async () => {
				hooksState.setRtcStatus("idle");
			});
			hooksState.setRtcError(null);
			screen.getByRole("button", { name: "Stay" }).click();
			await flush();
			await vi.advanceTimersByTimeAsync(20_000);
			await flush();

			expect(hooksState.rtcLeave).toHaveBeenCalledTimes(2);
			expect(activeCallRoomId()).toBeNull();
		});

		it("announces the ended call rather than letting it vanish silently", async () => {
			vi.useFakeTimers();
			await joinedAndConnected();
			hooksState.rtcLeave.mockImplementationOnce(async () => {
				hooksState.setRtcStatus("idle");
			});

			hooksState.setLivekitStatus("idle");
			await flush();
			expect(notices()).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(20_000);
			await flush();

			expect(notices().map((n) => n.message)).toEqual([
				"Call ended — lost connection to the voice server.",
			]);
		});

		it("still tears the call down when the leave itself fails", async () => {
			vi.useFakeTimers();
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			await joinedAndConnected();
			// rtc.leave resolves but status stays "joined" → runLeave throws.
			hooksState.setRtcError(new Error("server rejected leave"));
			hooksState.rtcLeave.mockImplementationOnce(async () => {});

			hooksState.setLivekitStatus("idle");
			await flush();
			await vi.advanceTimersByTimeAsync(20_000);
			// The watchdog's leave is fire-and-forget; drain its rejection
			// here so `reportError` cannot land in a later test's console spy.
			await flush();
			await flush();
			await flush();

			expect(hooksState.rtcLeave).toHaveBeenCalledTimes(1);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to end call after media loss:",
				expect.anything(),
			);
			// The media is gone; the call must not keep presenting itself as
			// live even though the withdrawal failed.
			expect(activeCallRoomId()).toBeNull();
		});

		it("holds off while a reconnect is still in flight", async () => {
			vi.useFakeTimers();
			await joinedAndConnected();

			hooksState.setLivekitStatus("idle");
			await flush();
			// A reconnect starts before the countdown elapses and is still
			// dialling well past it — in flight is not dead.
			await vi.advanceTimersByTimeAsync(5_000);
			hooksState.setLivekitStatus("connecting");
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			await flush();

			expect(hooksState.rtcLeave).not.toHaveBeenCalled();
			expect(activeCallRoomId()).toBe("!room:example.com");
		});

		it("cancels the pending countdown on unmount rather than only no-oping", async () => {
			vi.useFakeTimers();
			const { unmount } = await joinedAndConnected();

			hooksState.setLivekitStatus("idle");
			await flush();
			const armed = vi.getTimerCount();
			unmount();
			// The timer must be gone, not merely harmless when it fires.
			expect(vi.getTimerCount()).toBeLessThan(armed);
		});

		it("does not end a newer call when the controller unmounts mid-countdown", async () => {
			vi.useFakeTimers();
			const { unmount } = await joinedAndConnected();

			hooksState.setLivekitStatus("idle");
			await flush();
			unmount();
			setActiveCallRoomId("!other:example.com");
			await vi.advanceTimersByTimeAsync(60_000);
			await flush();

			expect(hooksState.rtcLeave).not.toHaveBeenCalled();
			expect(activeCallRoomId()).toBe("!other:example.com");
		});
	});

	it("an abandoned leave that completes after unmount never clears a newer activeCallRoomId", async () => {
		// `endCallForRoomLeave` stops awaiting a teardown that outruns its
		// timeout and tears the controller down anyway. The abandoned
		// `runLeave` keeps running; by the time it resumes the user may have
		// started a DIFFERENT call, and its trailing clear would silently
		// drop them from it.
		setActiveCallRoomId("!room:example.com");
		const { unmount } = renderController();
		const s = currentCallSession();
		hooksState.setRtcStatus("joined");
		await flush();

		let releaseDisconnect!: () => void;
		hooksState.livekitDisconnect.mockImplementationOnce(
			() =>
				new Promise<void>((res) => {
					releaseDisconnect = res;
				}),
		);
		hooksState.rtcLeave.mockImplementationOnce(async () => {
			hooksState.setRtcStatus("idle");
		});

		// Leave is started but never awaited to completion by the caller.
		const abandoned = s?.requestLeave();
		await flush();

		// Caller gives up, drops the signal, and the controller unmounts.
		setActiveCallRoomId(null);
		unmount();
		// The user starts a new call elsewhere.
		setActiveCallRoomId("!other:example.com");

		// The wedged disconnect finally resolves and the stale leave finishes.
		releaseDisconnect();
		await abandoned;
		await flush();

		expect(activeCallRoomId()).toBe("!other:example.com");
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
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
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
			// Post-unmount signal writes (setLeaving(false), setLeaveError,
			// setConfirmLeaveOpen) must not log anything — Solid silently no-ops
			// writes to disposed signals, so any console.error here would
			// indicate a regression.
			expect(consoleErrorSpy).not.toHaveBeenCalled();
		} finally {
			consoleErrorSpy.mockRestore();
		}
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
