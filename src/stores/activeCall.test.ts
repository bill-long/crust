import { describe, expect, it } from "vitest";
import {
	_resetActiveCallForTests,
	activeCallRoomId,
	setActiveCallRoomId,
} from "./activeCall";

describe("activeCall store", () => {
	it("defaults to null", () => {
		_resetActiveCallForTests();
		expect(activeCallRoomId()).toBeNull();
	});

	it("setActiveCallRoomId stores the room id", () => {
		_resetActiveCallForTests();
		setActiveCallRoomId("!abc:example.org");
		expect(activeCallRoomId()).toBe("!abc:example.org");
	});

	it("setActiveCallRoomId(null) clears the value", () => {
		_resetActiveCallForTests();
		setActiveCallRoomId("!abc:example.org");
		setActiveCallRoomId(null);
		expect(activeCallRoomId()).toBeNull();
	});

	it("supports switching from one room to another (no intermediate null)", () => {
		_resetActiveCallForTests();
		setActiveCallRoomId("!a:example.org");
		setActiveCallRoomId("!b:example.org");
		expect(activeCallRoomId()).toBe("!b:example.org");
	});

	it("_resetActiveCallForTests clears the value", () => {
		setActiveCallRoomId("!abc:example.org");
		_resetActiveCallForTests();
		expect(activeCallRoomId()).toBeNull();
	});
});
