import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetActiveCallForTests,
	activeCallRoomId,
	setActiveCallRoomId,
} from "../../../../stores/activeCall";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./callSessionStore";
import { endActiveCall, endCallForRoomLeave } from "./endCall";
import { makeFakeCallSession } from "./fakeCallSession.test-utils";

const ROOM = "!room:example.com";

describe("endCallForRoomLeave", () => {
	const disposers: Array<() => void> = [];

	afterEach(() => {
		for (const d of disposers.splice(0)) d();
		_resetActiveCallForTests();
		_resetCallSessionForTests();
		vi.restoreAllMocks();
		// `restoreAllMocks` does NOT undo `useFakeTimers`, so a test that
		// fails mid-body would otherwise leak fake timers into the rest of
		// the file.
		vi.useRealTimers();
	});

	function publishFake(roomId = ROOM) {
		const fake = makeFakeCallSession({ roomId });
		disposers.push(fake.dispose);
		publishCallSession(fake.api);
		return fake;
	}

	it("does nothing when no call is active", async () => {
		const fake = publishFake();
		await endCallForRoomLeave(ROOM);
		expect(fake.requestLeave).not.toHaveBeenCalled();
		expect(activeCallRoomId()).toBeNull();
	});

	it("leaves an active call in another room untouched", async () => {
		setActiveCallRoomId("!other:example.com");
		const fake = publishFake("!other:example.com");
		await endCallForRoomLeave(ROOM);
		expect(fake.requestLeave).not.toHaveBeenCalled();
		expect(activeCallRoomId()).toBe("!other:example.com");
	});

	it("awaits requestLeave when the room hosts the active call", async () => {
		setActiveCallRoomId(ROOM);
		const fake = publishFake();
		let resolveLeave!: () => void;
		fake.requestLeave.mockImplementationOnce(
			() =>
				new Promise<void>((res) => {
					resolveLeave = () => {
						// The real controller clears the signal itself, last.
						setActiveCallRoomId(null);
						res();
					};
				}),
		);

		let settled = false;
		const pending = endCallForRoomLeave(ROOM).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(fake.requestLeave).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		expect(activeCallRoomId()).toBe(ROOM);

		resolveLeave();
		await pending;
		expect(settled).toBe(true);
		expect(activeCallRoomId()).toBeNull();
	});

	it("gives up and lets the leave proceed when the teardown never settles", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		setActiveCallRoomId(ROOM);
		const fake = publishFake();
		// A teardown that hangs forever — e.g. `livekit.disconnect()` awaiting
		// `room.disconnect()` on a wedged socket, which carries no timeout of
		// its own. The room leave must not be blocked on it.
		fake.requestLeave.mockImplementationOnce(() => new Promise<void>(() => {}));

		let settled = false;
		const pending = endCallForRoomLeave(ROOM).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(9_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		await pending;

		expect(settled).toBe(true);
		expect(activeCallRoomId()).toBeNull();
	});

	it("clears the signal and resolves when requestLeave rejects", async () => {
		setActiveCallRoomId(ROOM);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fake = publishFake();
		fake.requestLeave.mockRejectedValueOnce(new Error("leave failed"));
		await expect(endCallForRoomLeave(ROOM)).resolves.toBeUndefined();
		expect(activeCallRoomId()).toBeNull();
	});

	it("clears a stale signal when no session is published for the room", async () => {
		setActiveCallRoomId(ROOM);
		await endCallForRoomLeave(ROOM);
		expect(activeCallRoomId()).toBeNull();
	});

	it("clears the signal when the published session points at another room", async () => {
		setActiveCallRoomId(ROOM);
		const fake = publishFake("!stale:example.com");
		await endCallForRoomLeave(ROOM);
		expect(fake.requestLeave).not.toHaveBeenCalled();
		expect(activeCallRoomId()).toBeNull();
	});
});

describe("endActiveCall", () => {
	const disposers: Array<() => void> = [];

	afterEach(() => {
		for (const d of disposers.splice(0)) d();
		_resetActiveCallForTests();
		_resetCallSessionForTests();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function publishFake(roomId = ROOM) {
		const fake = makeFakeCallSession({ roomId });
		disposers.push(fake.dispose);
		publishCallSession(fake.api);
		return fake;
	}

	it("does nothing when no call is active", async () => {
		const fake = publishFake();
		await endActiveCall();
		expect(fake.requestLeave).not.toHaveBeenCalled();
	});

	it("tears down whichever room hosts the call, without being told which", async () => {
		setActiveCallRoomId("!elsewhere:example.com");
		const fake = publishFake("!elsewhere:example.com");
		fake.requestLeave.mockImplementationOnce(async () => {
			setActiveCallRoomId(null);
		});

		await endActiveCall();

		expect(fake.requestLeave).toHaveBeenCalledTimes(1);
		expect(activeCallRoomId()).toBeNull();
	});

	it("resolves so logout proceeds even when the teardown rejects", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		setActiveCallRoomId(ROOM);
		const fake = publishFake();
		fake.requestLeave.mockRejectedValueOnce(new Error("leave failed"));

		await expect(endActiveCall()).resolves.toBeUndefined();
		expect(activeCallRoomId()).toBeNull();
	});

	it("gives up on a teardown that never settles so logout is not blocked", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		setActiveCallRoomId(ROOM);
		const fake = publishFake();
		fake.requestLeave.mockImplementationOnce(() => new Promise<void>(() => {}));

		let settled = false;
		const pending = endActiveCall().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(9_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		await pending;

		expect(settled).toBe(true);
		expect(activeCallRoomId()).toBeNull();
	});
});
