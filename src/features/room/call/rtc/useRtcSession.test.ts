import { renderHook } from "@solidjs/testing-library";
import type { CallMembership } from "matrix-js-sdk/lib/matrixrtc";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcE2EEContext } from "./rtcE2EEBridge";
import { useRtcSession } from "./useRtcSession";

type Listener = (...args: unknown[]) => void;

interface FakeSession {
	memberships: CallMembership[];
	isJoined: () => boolean;
	joinRoomSession: ReturnType<typeof vi.fn>;
	leaveRoomSession: ReturnType<typeof vi.fn>;
	reemitEncryptionKeys: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	off: ReturnType<typeof vi.fn>;
	emit: (event: string, ...args: unknown[]) => void;
	_joined: boolean;
}

function createFakeSession(): FakeSession {
	const listeners = new Map<string, Set<Listener>>();
	const session: FakeSession = {
		memberships: [],
		_joined: false,
		isJoined: () => session._joined,
		joinRoomSession: vi.fn(() => {
			session._joined = true;
			session.emit(MatrixRTCSessionEvent.JoinStateChanged, true);
		}),
		leaveRoomSession: vi.fn(async () => {
			session._joined = false;
			session.emit(MatrixRTCSessionEvent.JoinStateChanged, false);
			return true;
		}),
		reemitEncryptionKeys: vi.fn(),
		on: vi.fn((event: string, cb: Listener) => {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(cb);
		}),
		off: vi.fn((event: string, cb: Listener) => {
			listeners.get(event)?.delete(cb);
		}),
		emit: (event: string, ...args: unknown[]) => {
			for (const cb of listeners.get(event) ?? []) cb(...args);
		},
	};
	return session;
}

function createClient(opts: { roomFound?: boolean; session: FakeSession }): {
	client: ReturnType<typeof makeClient>;
} {
	function makeClient() {
		return {
			getRoom: vi.fn(() => (opts.roomFound === false ? null : ({} as never))),
			matrixRTC: {
				getRoomSession: vi.fn(() => opts.session),
			},
		};
	}
	return { client: makeClient() };
}

const renderRtc = (overrides?: {
	roomFound?: boolean;
	session?: FakeSession;
	elementCallUrl?: string;
	e2ee?: () => RtcE2EEContext | null;
}) => {
	const session = overrides?.session ?? createFakeSession();
	const { client } = createClient({
		roomFound: overrides?.roomFound,
		session,
	});
	const { result } = renderHook(() =>
		useRtcSession({
			client: client as never,
			roomId: "!room:example.com",
			elementCallUrl: overrides?.elementCallUrl ?? "https://call.example.com",
			e2ee: overrides?.e2ee,
		}),
	);
	return { rtc: result, session, client };
};

describe("useRtcSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("starts idle when the room exists and foci are configured", () => {
		const { rtc } = renderRtc();
		expect(rtc.status()).toBe("idle");
		expect(rtc.canJoin()).toBe(true);
		expect(rtc.memberships()).toEqual([]);
	});

	it("enters error state when the room is not in the client store", () => {
		const { rtc } = renderRtc({ roomFound: false });
		expect(rtc.status()).toBe("error");
		expect(rtc.error()?.message).toContain("not found");
	});

	it("disables join when no foci can be derived", () => {
		const { rtc } = renderRtc({ elementCallUrl: "" });
		expect(rtc.canJoin()).toBe(false);
	});

	it("calls joinRoomSession with the no-bridge guardrail flags (manageMediaKeys: false)", async () => {
		const { rtc, session } = renderRtc();
		await rtc.join();
		expect(session.joinRoomSession).toHaveBeenCalledTimes(1);
		const [foci, multi, joinConfig] = session.joinRoomSession.mock.calls[0];
		expect(foci).toEqual([
			{
				type: "livekit",
				livekit_service_url: "https://call.example.com/livekit/sfu/get",
				livekit_alias: "!room:example.com",
			},
		]);
		expect(multi).toBeUndefined();
		expect(joinConfig).toEqual({
			manageMediaKeys: false,
			unstableSendStickyEvents: false,
		});
		expect(rtc.status()).toBe("joined");
	});

	it("returns to idle after leaveRoomSession resolves", async () => {
		const { rtc, session } = renderRtc();
		await rtc.join();
		expect(rtc.status()).toBe("joined");
		await rtc.leave();
		expect(session.leaveRoomSession).toHaveBeenCalledTimes(1);
		expect(rtc.status()).toBe("idle");
	});

	it("reacts to MembershipsChanged from the SDK", () => {
		const { rtc, session } = renderRtc();
		const fakeMembership = {
			userId: "@alice:example.com",
			deviceId: "AAA",
			memberId: "@alice:example.com:AAA",
		} as unknown as CallMembership;
		session.emit(
			MatrixRTCSessionEvent.MembershipsChanged,
			[],
			[fakeMembership],
		);
		expect(rtc.memberships()).toHaveLength(1);
		expect(rtc.memberships()[0]?.userId).toBe("@alice:example.com");
	});

	it("captures MembershipManagerError events into error state", () => {
		const { rtc, session } = renderRtc();
		session.emit(
			MatrixRTCSessionEvent.MembershipManagerError,
			new Error("ratelimited"),
		);
		expect(rtc.status()).toBe("error");
		expect(rtc.error()?.message).toBe("ratelimited");
	});

	it("keeps status joined on MembershipManagerError when SDK still reports joined", async () => {
		const { rtc, session } = renderRtc();
		await rtc.join();
		expect(rtc.status()).toBe("joined");
		session.emit(
			MatrixRTCSessionEvent.MembershipManagerError,
			new Error("transient"),
		);
		expect(rtc.status()).toBe("joined");
		expect(rtc.error()?.message).toBe("transient");
	});

	it("clears a prior error when a new leave attempt starts", async () => {
		const { rtc, session } = renderRtc();
		await rtc.join();
		session.emit(
			MatrixRTCSessionEvent.MembershipManagerError,
			new Error("transient"),
		);
		expect(rtc.error()?.message).toBe("transient");
		await rtc.leave();
		expect(rtc.status()).toBe("idle");
		expect(rtc.error()).toBeNull();
	});

	it("keeps status leaving when a MembershipManagerError fires mid-leave", async () => {
		const session = createFakeSession();
		let resolveLeave: (() => void) | undefined;
		session.leaveRoomSession.mockImplementation(
			() =>
				new Promise<boolean>((res) => {
					resolveLeave = () => {
						session._joined = false;
						res(true);
					};
				}),
		);
		const { client } = createClient({ session });
		const { result } = renderHook(() =>
			useRtcSession({
				client: client as never,
				roomId: "!room:example.com",
				elementCallUrl: "https://call.example.com",
			}),
		);
		await result.join();
		const leavePromise = result.leave();
		expect(result.status()).toBe("leaving");
		session.emit(
			MatrixRTCSessionEvent.MembershipManagerError,
			new Error("transient mid-leave"),
		);
		// Status must remain "leaving" so UI close-suppression isn't bypassed.
		expect(result.status()).toBe("leaving");
		resolveLeave?.();
		await leavePromise;
		expect(result.status()).toBe("idle");
		expect(result.error()).toBeNull();
	});

	it("does not invoke leaveRoomSession a second time on unmount when an explicit leave is in flight", async () => {
		const session = createFakeSession();
		let resolveLeave: (() => void) | undefined;
		session.leaveRoomSession.mockImplementation(
			() =>
				new Promise<boolean>((res) => {
					resolveLeave = () => {
						session._joined = false;
						res(true);
					};
				}),
		);
		const { client } = createClient({ session });
		const { result, cleanup } = renderHook(() =>
			useRtcSession({
				client: client as never,
				roomId: "!room:example.com",
				elementCallUrl: "https://call.example.com",
			}),
		);
		await result.join();
		const leavePromise = result.leave();
		// Unmount while the leave is still in-flight.
		cleanup();
		resolveLeave?.();
		await leavePromise;
		expect(session.leaveRoomSession).toHaveBeenCalledTimes(1);
	});

	it("reverts status to joined when leaveRoomSession throws but SDK still reports joined", async () => {
		const session = createFakeSession();
		session.leaveRoomSession.mockImplementation(async () => {
			// SDK didn't actually leave — _joined stays true.
			throw new Error("network");
		});
		const { client } = createClient({ session });
		const { result } = renderHook(() =>
			useRtcSession({
				client: client as never,
				roomId: "!room:example.com",
				elementCallUrl: "https://call.example.com",
			}),
		);
		await result.join();
		expect(result.status()).toBe("joined");
		await result.leave();
		expect(result.status()).toBe("joined");
		expect(result.error()?.message).toBe("network");
	});

	it("calls leaveRoomSession on unmount when the user closed without explicit leave", async () => {
		const session = createFakeSession();
		const { client } = createClient({ session });
		const { result, cleanup } = renderHook(() =>
			useRtcSession({
				client: client as never,
				roomId: "!room:example.com",
				elementCallUrl: "https://call.example.com",
			}),
		);
		await result.join();
		expect(session.leaveRoomSession).not.toHaveBeenCalled();
		cleanup();
		expect(session.leaveRoomSession).toHaveBeenCalledTimes(1);
	});

	it("calls leaveRoomSession on unmount when a join is still pending", async () => {
		const session = createFakeSession();
		// Simulate a join that has been requested but the SDK has not yet
		// flipped isJoined to true (joinRoomSession is fire-and-forget).
		session.joinRoomSession.mockImplementation(() => {
			/* no isJoined flip, no JoinStateChanged */
		});
		const { client } = createClient({ session });
		const { result, cleanup } = renderHook(() =>
			useRtcSession({
				client: client as never,
				roomId: "!room:example.com",
				elementCallUrl: "https://call.example.com",
			}),
		);
		await result.join();
		expect(result.status()).toBe("joining");
		expect(session.leaveRoomSession).not.toHaveBeenCalled();
		cleanup();
		expect(session.leaveRoomSession).toHaveBeenCalledTimes(1);
	});

	it("does NOT block join on encrypted rooms (Phase 4 lifted the gate)", async () => {
		// The hook no longer tracks room encryption — encrypted rooms are
		// expected to be joined via the E2EE bridge passed by the
		// consumer. Asserting canJoin stays true keeps a regression that
		// re-introduces the Phase-2 gate from sneaking in.
		const { rtc } = renderRtc();
		expect(rtc.canJoin()).toBe(true);
		expect(rtc.joinBlockReason()).toBeNull();
	});

	it("exposes a null activeFocus until joined", () => {
		const { rtc } = renderRtc();
		expect(rtc.activeFocus()).toBeNull();
	});

	it("activeFocus falls back to the offered focus when no oldest member exists", async () => {
		const { rtc } = renderRtc();
		await rtc.join();
		expect(rtc.activeFocus()).toEqual({
			type: "livekit",
			livekit_service_url: "https://call.example.com/livekit/sfu/get",
			livekit_alias: "!room:example.com",
		});
	});

	it("activeFocus uses the oldest member's LiveKit transport when present", async () => {
		const { rtc, session } = renderRtc();
		await rtc.join();
		const oldestTransport = {
			type: "livekit" as const,
			livekit_service_url: "https://other-sfu.example.com/livekit/sfu/get",
			livekit_alias: "!room:example.com",
		};
		const oldest = {
			userId: "@alice:example.com",
			deviceId: "AAA",
			createdTs: () => 1000,
			getTransport: () => oldestTransport,
		} as unknown as CallMembership;
		const younger = {
			userId: "@bob:example.com",
			deviceId: "BBB",
			createdTs: () => 5000,
			getTransport: () => undefined,
		} as unknown as CallMembership;
		session.emit(
			MatrixRTCSessionEvent.MembershipsChanged,
			[],
			[younger, oldest],
		);
		expect(rtc.activeFocus()).toEqual(oldestTransport);
	});

	describe("Phase 4 E2EE bridge wiring", () => {
		const fakeCtx = (): {
			ctx: RtcE2EEContext;
			attach: ReturnType<typeof vi.fn>;
			reemit: ReturnType<typeof vi.fn>;
			dispose: ReturnType<typeof vi.fn>;
			detach: ReturnType<typeof vi.fn>;
		} => {
			const detach = vi.fn();
			const attach = vi.fn(() => detach);
			const reemit = vi.fn();
			const dispose = vi.fn();
			const ctx = {
				e2eeOptions: { keyProvider: {} as never, worker: {} as never },
				attach,
				reemit,
				dispose,
			} as unknown as RtcE2EEContext;
			return { ctx, attach, reemit, dispose, detach };
		};

		it("attaches the bridge BEFORE joinRoomSession and reemits AFTER", async () => {
			const { ctx, attach, reemit } = fakeCtx();
			const { rtc, session } = renderRtc({ e2ee: () => ctx });
			await rtc.join();
			// Invocation-order assertion: attach < joinRoomSession < reemit.
			const attachOrder = attach.mock.invocationCallOrder[0];
			const joinOrder = session.joinRoomSession.mock.invocationCallOrder[0];
			const reemitOrder = reemit.mock.invocationCallOrder[0];
			expect(attachOrder).toBeLessThan(joinOrder);
			expect(joinOrder).toBeLessThan(reemitOrder);
		});

		it("flips manageMediaKeys: true when the bridge is supplied", async () => {
			const { ctx } = fakeCtx();
			const { rtc, session } = renderRtc({ e2ee: () => ctx });
			await rtc.join();
			const joinConfig = session.joinRoomSession.mock.calls[0][2];
			expect(joinConfig).toEqual({
				manageMediaKeys: true,
				// Phase 5+ owns this flag; must stay false until summaries.ts
				// learns the newer m.rtc.member format.
				unstableSendStickyEvents: false,
			});
		});

		it("attach receives an isLive closure that returns false after leave", async () => {
			const { ctx, attach } = fakeCtx();
			const { rtc } = renderRtc({ e2ee: () => ctx });
			await rtc.join();
			const isLive = attach.mock.calls[0][1] as () => boolean;
			expect(isLive()).toBe(true);
			await rtc.leave();
			expect(isLive()).toBe(false);
		});

		it("detaches the bridge listener on leave", async () => {
			const { ctx, detach } = fakeCtx();
			const { rtc } = renderRtc({ e2ee: () => ctx });
			await rtc.join();
			expect(detach).not.toHaveBeenCalled();
			await rtc.leave();
			expect(detach).toHaveBeenCalledTimes(1);
		});

		it("detaches the bridge listener on unmount", async () => {
			const { ctx, detach } = fakeCtx();
			const session = createFakeSession();
			const { client } = createClient({ session });
			const [e2eeAcc] = createSignal<RtcE2EEContext | null>(ctx);
			const { result, cleanup } = renderHook(() =>
				useRtcSession({
					client: client as never,
					roomId: "!room:example.com",
					elementCallUrl: "https://call.example.com",
					e2ee: e2eeAcc,
				}),
			);
			await result.join();
			cleanup();
			expect(detach).toHaveBeenCalled();
		});

		it("detaches and bumps isLive when joinRoomSession synchronously throws", async () => {
			const { ctx, attach, detach } = fakeCtx();
			const session = createFakeSession();
			session.joinRoomSession.mockImplementation(() => {
				throw new Error("validation failed");
			});
			const { rtc } = renderRtc({ session, e2ee: () => ctx });
			await rtc.join();
			expect(rtc.status()).toBe("error");
			expect(detach).toHaveBeenCalledTimes(1);
			// isLive must be false after the failed attempt so any late
			// EncryptionKeyChanged that snuck in before detach bails.
			const isLive = attach.mock.calls[0][1] as () => boolean;
			expect(isLive()).toBe(false);
		});

		it("detaches and bumps isLive on async MembershipManagerError when not joined", async () => {
			const { ctx, attach, detach } = fakeCtx();
			const session = createFakeSession();
			// joinRoomSession returns OK synchronously without flipping
			// _joined — simulates an async join failure where the SDK
			// fires MembershipManagerError before JoinStateChanged(true).
			session.joinRoomSession.mockImplementation(() => {
				/* no _joined flip, no JoinStateChanged */
			});
			const { rtc } = renderRtc({ session, e2ee: () => ctx });
			await rtc.join();
			expect(detach).not.toHaveBeenCalled();
			session.emit(
				MatrixRTCSessionEvent.MembershipManagerError,
				new Error("network"),
			);
			expect(rtc.status()).toBe("error");
			expect(detach).toHaveBeenCalledTimes(1);
			// isLive must be false so a late EncryptionKeyChanged bails
			// before pumping a key from the failed session into the bridge.
			const isLive = attach.mock.calls[0][1] as () => boolean;
			expect(isLive()).toBe(false);
		});

		it("keeps bridge attached on MembershipManagerError when still joined", async () => {
			const { ctx, attach, detach } = fakeCtx();
			const session = createFakeSession();
			const { rtc } = renderRtc({ session, e2ee: () => ctx });
			await rtc.join();
			expect(rtc.status()).toBe("joined");
			session.emit(
				MatrixRTCSessionEvent.MembershipManagerError,
				new Error("transient"),
			);
			// Transient SDK errors during a healthy call must NOT orphan the
			// bridge — detach would silently kill E2EE mid-call.
			expect(rtc.status()).toBe("joined");
			expect(detach).not.toHaveBeenCalled();
			const isLive = attach.mock.calls[0][1] as () => boolean;
			expect(isLive()).toBe(true);
		});

		it("detaches and bumps isLive on SDK-driven JoinStateChanged(false)", async () => {
			const { ctx, attach, detach } = fakeCtx();
			const session = createFakeSession();
			const { rtc } = renderRtc({ session, e2ee: () => ctx });
			await rtc.join();
			expect(detach).not.toHaveBeenCalled();
			// Simulate an SDK-driven leave (kicked, network teardown) —
			// JoinStateChanged(false) fires without our leave() in flight.
			session._joined = false;
			session.emit(MatrixRTCSessionEvent.JoinStateChanged, false);
			// Bridge must detach + bump epoch so late EncryptionKeyChanged
			// events from the departing RTCEncryptionManager bail before
			// pumping a stale key into the keyProvider.
			expect(detach).toHaveBeenCalledTimes(1);
			const isLive = attach.mock.calls[0][1] as () => boolean;
			expect(isLive()).toBe(false);
		});
	});
});
