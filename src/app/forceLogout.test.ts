import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../stores/session";
import type { PushConfig } from "../types/config";

/**
 * Every step is recorded here in the order it actually ran. The escape's
 * correctness IS this order - each step needs something the next one takes
 * away - so the assertions below are about sequence, not about calls happening.
 */
const order: string[] = [];

const endActiveCall = vi.fn(async () => {
	order.push("endActiveCall");
});
const disableBackgroundNotifications = vi.fn(async () => {
	order.push("disableBackgroundNotifications");
});
const finishAccountLogout = vi.fn(async () => {
	order.push("finishAccountLogout");
	return "left" as const;
});
const clearCryptoStores = vi.fn(async () => {
	order.push("clearCryptoStores");
});
const setActiveCallRoomId = vi.fn(() => {
	order.push("setActiveCallRoomId");
});

vi.mock("../features/room/call/rtc/endCall", () => ({
	endActiveCall: () => endActiveCall(),
}));
vi.mock("../features/notifications/accountPush", () => ({
	disableBackgroundNotifications: (...args: unknown[]) =>
		disableBackgroundNotifications(...(args as [])),
}));
vi.mock("./accountSwitch", () => ({
	finishAccountLogout: async (
		_exit: unknown,
		_userId: string,
		wipe: () => Promise<void>,
		goToLogin: () => void,
	) => {
		// The real one runs the wipe before it leaves; mirror that so a test can
		// see the wipe's position in the order.
		await wipe();
		goToLogin();
		return finishAccountLogout();
	},
}));
vi.mock("../client/cryptoRecovery", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../client/cryptoRecovery")>();
	return {
		...actual,
		clearCryptoStores: () => clearCryptoStores(),
	};
});
vi.mock("../stores/activeCall", () => ({
	setActiveCallRoomId: () => setActiveCallRoomId(),
}));
vi.mock("../features/room/notificationSound", () => ({
	closeNotificationSound: () => {},
}));

import { FORCE_LOGOUT_REVOKE_TIMEOUT_MS, runForceLogout } from "./forceLogout";

const SESSION: Session = {
	accessToken: "token",
	userId: "@alice:example.com",
	deviceId: "DEVICE1",
	homeserverUrl: "https://example.com",
};

const PUSH_CONFIG = {} as PushConfig;

function makeClient(
	logout: () => Promise<unknown> = async () => {
		order.push("logout");
	},
) {
	return {
		logout: vi.fn(logout),
		stopClient: vi.fn(() => {
			order.push("stopClient");
		}),
	};
}

function run(client: ReturnType<typeof makeClient>) {
	return runForceLogout({
		client: client as unknown as MatrixClient,
		pushConfig: PUSH_CONFIG,
		session: SESSION,
		goToLogin: () => order.push("goToLogin"),
	});
}

describe("runForceLogout (#551)", () => {
	beforeEach(() => {
		order.length = 0;
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does everything the server needs before the revoke that ends the session", async () => {
		const client = makeClient();
		await expect(run(client)).resolves.toBe("left");

		// The withdrawal needs a token that can still write to the room (#474),
		// and the pusher can only be named server-side by a credential that still
		// works (#534) - so both precede the revoke. The wipe needs nothing from
		// the network and follows it.
		expect(order).toEqual([
			"endActiveCall",
			"setActiveCallRoomId",
			"disableBackgroundNotifications",
			"logout",
			"clearCryptoStores",
			"goToLogin",
			"finishAccountLogout",
		]);
		// Stops the client as it revokes, rather than leaving that to a later
		// failure path.
		expect(client.logout).toHaveBeenCalledWith(true);
	});

	it("waits for the withdrawal to land before the revoke cancels it", async () => {
		// Ordering alone cannot show this: a fire-and-forget teardown starts in
		// the same place an awaited one does. So hold the withdrawal open and
		// check that nothing has revoked yet - `logout(true)` aborts the client's
		// in-flight requests, so a revoke issued here would cancel the very write
		// being waited on (#474).
		let landWithdrawal!: () => void;
		endActiveCall.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					landWithdrawal = () => {
						order.push("endActiveCall");
						resolve();
					};
				}),
		);
		const client = makeClient();
		const pending = run(client);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(client.logout).not.toHaveBeenCalled();
		expect(disableBackgroundNotifications).not.toHaveBeenCalled();

		landWithdrawal();
		await pending;
		expect(order.indexOf("endActiveCall")).toBeLessThan(
			order.indexOf("logout"),
		);
	});

	it("still leaves the account when the call teardown throws", async () => {
		endActiveCall.mockImplementationOnce(async () => {
			order.push("endActiveCall");
			throw new Error("a subscriber threw");
		});
		const client = makeClient();

		await expect(run(client)).resolves.toBe("left");
		// The first step failing must not skip the three that take the account off
		// this device: the alternative is the orphaned, still-push-capable device
		// this escape exists to prevent.
		expect(order).toContain("disableBackgroundNotifications");
		expect(order).toContain("logout");
		expect(order).toContain("clearCryptoStores");
	});

	it("still leaves the account when clearing the call signal throws", async () => {
		// The same hazard as the teardown above, one line later: this write runs
		// its Solid subscribers synchronously, so a throwing effect surfaces here
		// rather than inside `endCall`.
		setActiveCallRoomId.mockImplementationOnce(() => {
			order.push("setActiveCallRoomId");
			throw new Error("a subscriber threw");
		});
		const client = makeClient();

		await expect(run(client)).resolves.toBe("left");
		expect(order).toContain("disableBackgroundNotifications");
		expect(order).toContain("logout");
		expect(order).toContain("clearCryptoStores");
	});

	it("still leaves the account when the push release throws", async () => {
		// `disableBackgroundNotifications` writes a Solid setting before its own
		// try, and those subscribers run synchronously - so this step can throw
		// like the two before it, and must not abort the revoke or the wipe.
		disableBackgroundNotifications.mockImplementationOnce(async () => {
			order.push("disableBackgroundNotifications");
			throw new Error("a subscriber threw");
		});
		const client = makeClient();

		await expect(run(client)).resolves.toBe("left");
		expect(order).toContain("logout");
		expect(order).toContain("clearCryptoStores");
	});

	it("leaves without the revoke when the server never answers it", async () => {
		vi.useFakeTimers();
		const client = makeClient(() => new Promise<never>(() => {}));
		const settled = vi.fn();
		const pending = run(client).then(settled);

		await vi.advanceTimersByTimeAsync(FORCE_LOGOUT_REVOKE_TIMEOUT_MS - 1);
		expect(settled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await pending;
		// The way out of a hang cannot itself hang: the revoke is given up on and
		// the account still leaves the device.
		expect(order).toContain("clearCryptoStores");
		expect(order).toContain("finishAccountLogout");
	});

	it("still leaves the account when the recovery stop also throws", async () => {
		// The likeliest reason to be on this path is that the stop inside
		// `logout(true)` is what threw - so the recovery stop is the call most
		// likely to throw again, and it sits after the point where giving up
		// would leave the account fully alive on the device.
		const client = {
			logout: vi.fn(async () => {
				order.push("logout");
				throw new Error("stop failed inside logout");
			}),
			stopClient: vi.fn(() => {
				order.push("stopClient");
				throw new Error("and again here");
			}),
		};

		await expect(run(client)).resolves.toBe("left");
		expect(order).toContain("clearCryptoStores");
		expect(order).toContain("finishAccountLogout");
	});

	it("stops the client itself when the revoke fails outright", async () => {
		const client = makeClient(async () => {
			order.push("logout");
			throw new Error("network down");
		});

		await expect(run(client)).resolves.toBe("left");
		expect(order).toContain("stopClient");
		expect(order.indexOf("stopClient")).toBeLessThan(
			order.indexOf("clearCryptoStores"),
		);
	});
});
