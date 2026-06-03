import { describe, expect, it } from "vitest";
import {
	_resetCallSessionForTests,
	allocCallSessionInstanceId,
	type CallSessionApi,
	clearCallSessionIfCurrent,
	currentCallSession,
	publishCallSession,
} from "./callSessionStore";

function stubApi(instanceId: number, roomId: string): CallSessionApi {
	return {
		instanceId,
		roomId,
		roomName: () => "Test Room",
		// biome-ignore lint/suspicious/noExplicitAny: stub for store tests
		rtc: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: stub for store tests
		livekit: {} as any,
		bridgeInitializing: () => false,
		bridgeInitError: () => null,
		leaving: () => false,
		requestJoin: async () => {},
		requestClose: () => {},
		requestLeave: async () => {},
	};
}

describe("callSessionStore", () => {
	it("currentCallSession defaults to null", () => {
		_resetCallSessionForTests();
		expect(currentCallSession()).toBeNull();
	});

	it("publishCallSession sets the current API", () => {
		_resetCallSessionForTests();
		const id = allocCallSessionInstanceId();
		publishCallSession(stubApi(id, "!a:x"));
		expect(currentCallSession()?.roomId).toBe("!a:x");
		expect(currentCallSession()?.instanceId).toBe(id);
	});

	it("allocCallSessionInstanceId returns monotonically increasing ids", () => {
		_resetCallSessionForTests();
		const a = allocCallSessionInstanceId();
		const b = allocCallSessionInstanceId();
		const c = allocCallSessionInstanceId();
		expect(b).toBe(a + 1);
		expect(c).toBe(b + 1);
	});

	it("clearCallSessionIfCurrent clears when the instance id matches", () => {
		_resetCallSessionForTests();
		const id = allocCallSessionInstanceId();
		publishCallSession(stubApi(id, "!a:x"));
		clearCallSessionIfCurrent(id);
		expect(currentCallSession()).toBeNull();
	});

	it("clearCallSessionIfCurrent is a no-op when a newer instance is published", () => {
		// Simulates the switch-flow ordering hazard: old controller's
		// unmount runs AFTER the new controller has mounted and published.
		// The old cleanup must NOT clobber the new publication.
		_resetCallSessionForTests();
		const oldId = allocCallSessionInstanceId();
		const newId = allocCallSessionInstanceId();
		publishCallSession(stubApi(oldId, "!a:x"));
		publishCallSession(stubApi(newId, "!b:x"));
		clearCallSessionIfCurrent(oldId);
		expect(currentCallSession()?.instanceId).toBe(newId);
		expect(currentCallSession()?.roomId).toBe("!b:x");
	});

	it("clearCallSessionIfCurrent is a no-op when nothing is published", () => {
		_resetCallSessionForTests();
		const id = allocCallSessionInstanceId();
		clearCallSessionIfCurrent(id);
		expect(currentCallSession()).toBeNull();
	});

	it("_resetCallSessionForTests clears the API and resets the id counter", () => {
		const id = allocCallSessionInstanceId();
		publishCallSession(stubApi(id, "!a:x"));
		_resetCallSessionForTests();
		expect(currentCallSession()).toBeNull();
		expect(allocCallSessionInstanceId()).toBe(1);
	});
});
