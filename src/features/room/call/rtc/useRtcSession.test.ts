import { renderHook } from "@solidjs/testing-library";
import { RoomStateEvent } from "matrix-js-sdk";
import type { CallMembership } from "matrix-js-sdk/lib/matrixrtc";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRtcSession } from "./useRtcSession";

type Listener = (...args: unknown[]) => void;

interface FakeSession {
	memberships: CallMembership[];
	isJoined: () => boolean;
	joinRoomSession: ReturnType<typeof vi.fn>;
	leaveRoomSession: ReturnType<typeof vi.fn>;
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

function createClient(opts: {
	roomFound?: boolean;
	session: FakeSession;
	encrypted?: boolean;
}): {
	client: ReturnType<typeof makeClient>;
} {
	function makeClient() {
		const clientListeners = new Map<string, Set<Listener>>();
		return {
			getRoom: vi.fn(() =>
				opts.roomFound === false
					? null
					: ({
							hasEncryptionStateEvent: () => opts.encrypted === true,
						} as never),
			),
			matrixRTC: {
				getRoomSession: vi.fn(() => opts.session),
			},
			on: vi.fn((event: string, cb: Listener) => {
				let set = clientListeners.get(event);
				if (!set) {
					set = new Set();
					clientListeners.set(event, set);
				}
				set.add(cb);
			}),
			off: vi.fn((event: string, cb: Listener) => {
				clientListeners.get(event)?.delete(cb);
			}),
			__emit: (event: string, ...args: unknown[]): void => {
				for (const cb of clientListeners.get(event) ?? []) cb(...args);
			},
		};
	}
	return { client: makeClient() };
}

const renderRtc = (overrides?: {
	roomFound?: boolean;
	session?: FakeSession;
	elementCallUrl?: string;
	encrypted?: boolean;
}) => {
	const session = overrides?.session ?? createFakeSession();
	const { client } = createClient({
		roomFound: overrides?.roomFound,
		session,
		encrypted: overrides?.encrypted,
	});
	const { result } = renderHook(() =>
		useRtcSession({
			client: client as never,
			roomId: "!room:example.com",
			elementCallUrl: overrides?.elementCallUrl ?? "https://call.example.com",
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

	it("calls joinRoomSession with the Phase-1 guardrail flags", async () => {
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

	it("blocks join in encrypted rooms with a clear reason (Phase 2)", async () => {
		const { rtc, session } = renderRtc({ encrypted: true });
		expect(rtc.canJoin()).toBe(false);
		expect(rtc.joinBlockReason()).toContain("unencrypted");
		await rtc.join();
		expect(session.joinRoomSession).not.toHaveBeenCalled();
		expect(rtc.status()).toBe("error");
	});

	it("flips canJoin to false when an m.room.encryption state event arrives after mount", async () => {
		const session = createFakeSession();
		const { client } = createClient({ session });
		// Mutable flag so the room reports encrypted=true only after we emit
		// the state event (mirrors the late-arrival race the Phase 2 gate
		// must defend against).
		let nowEncrypted = false;
		client.getRoom = vi.fn(
			() =>
				({
					hasEncryptionStateEvent: () => nowEncrypted,
				}) as never,
		);
		const { result: rtc } = renderHook(() =>
			useRtcSession({
				client: client as never,
				roomId: "!room:example.com",
				elementCallUrl: "https://call.example.com",
			}),
		);
		expect(rtc.canJoin()).toBe(true);
		nowEncrypted = true;
		client.__emit(RoomStateEvent.Events, {
			getRoomId: () => "!room:example.com",
			getType: () => "m.room.encryption",
		} as never);
		expect(rtc.canJoin()).toBe(false);
		expect(rtc.joinBlockReason()).toContain("unencrypted");
		await rtc.join();
		expect(session.joinRoomSession).not.toHaveBeenCalled();
		expect(rtc.status()).toBe("error");
	});

	it("ignores RoomState.events for unrelated rooms or types", async () => {
		const session = createFakeSession();
		const { client } = createClient({ session });
		let encrypted = false;
		client.getRoom = vi.fn(
			() =>
				({
					hasEncryptionStateEvent: () => encrypted,
				}) as never,
		);
		const { result: rtc } = renderHook(() =>
			useRtcSession({
				client: client as never,
				roomId: "!room:example.com",
				elementCallUrl: "https://call.example.com",
			}),
		);
		expect(rtc.canJoin()).toBe(true);
		// Unrelated room.
		encrypted = true;
		client.__emit(RoomStateEvent.Events, {
			getRoomId: () => "!other:example.com",
			getType: () => "m.room.encryption",
		} as never);
		expect(rtc.canJoin()).toBe(true);
		// Right room, wrong type.
		client.__emit(RoomStateEvent.Events, {
			getRoomId: () => "!room:example.com",
			getType: () => "m.room.topic",
		} as never);
		expect(rtc.canJoin()).toBe(true);
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
});
