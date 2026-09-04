import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The order is the contract: the chime stops before anything that can take a
 * bounded while, the call teardown runs while the token can still write to the
 * room, and the global signal is cleared after the teardown that only clears
 * it for the room it tore down. Each step is recorded as it actually runs.
 */
const order: string[] = [];

const closeNotificationSound = vi.fn(() => {
	order.push("closeNotificationSound");
});
const endActiveCall = vi.fn(async () => {
	order.push("endActiveCall");
});
const setActiveCallRoomId = vi.fn(() => {
	order.push("setActiveCallRoomId");
});
const reportError = vi.fn();

vi.mock("../features/room/notificationSound", () => ({
	closeNotificationSound: () => closeNotificationSound(),
}));
vi.mock("../features/room/call/rtc/endCall", () => ({
	endActiveCall: () => endActiveCall(),
}));
vi.mock("../stores/activeCall", () => ({
	setActiveCallRoomId: () => setActiveCallRoomId(),
}));
vi.mock("../lib/reportError", () => ({
	reportError: (...args: unknown[]) => reportError(...args),
}));

import { quiesceLiveSession } from "./quiesceSession";

describe("quiesceLiveSession (#601)", () => {
	beforeEach(() => {
		order.length = 0;
		vi.clearAllMocks();
	});

	it("quiets the chime, the call and the signal, in that order", async () => {
		await quiesceLiveSession("on the way out");
		expect(order).toEqual([
			"closeNotificationSound",
			"endActiveCall",
			"setActiveCallRoomId",
		]);
	});

	it("names the exit in its log labels", async () => {
		endActiveCall.mockImplementationOnce(async () => {
			throw new Error("nope");
		});
		await quiesceLiveSession("while leaving the account");
		expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
			logLabel: "Could not end the call while leaving the account",
		});
	});

	it.each([
		["stopping the chime throws", "closeNotificationSound"],
		["the call teardown throws", "endActiveCall"],
		["clearing the call signal throws", "setActiveCallRoomId"],
	])("still finishes when %s", async (_label, step) => {
		// No step may abort the ones after it: an exit that has already ended
		// the user's call must not then leave the account alive on this device.
		const boom = new Error("boom");
		// Push first, then throw: the step DID run, and what is being locked is
		// that the ones after it still do.
		if (step === "closeNotificationSound") {
			closeNotificationSound.mockImplementationOnce(() => {
				order.push("closeNotificationSound");
				throw boom;
			});
		} else if (step === "endActiveCall") {
			endActiveCall.mockImplementationOnce(async () => {
				order.push("endActiveCall");
				throw boom;
			});
		} else {
			setActiveCallRoomId.mockImplementationOnce(() => {
				order.push("setActiveCallRoomId");
				throw boom;
			});
		}

		await expect(quiesceLiveSession("on the way out")).resolves.toBeUndefined();

		expect(order).toEqual([
			"closeNotificationSound",
			"endActiveCall",
			"setActiveCallRoomId",
		]);
		expect(reportError).toHaveBeenCalledWith(boom, expect.anything());
	});
});
