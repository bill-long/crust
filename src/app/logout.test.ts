import type { MatrixClient } from "matrix-js-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../stores/session";
import type { PushConfig } from "../types/config";

/**
 * Every step is recorded here in the order it actually ran. The logout's
 * correctness IS this order - each step needs something the next one takes
 * away - so the assertions below are about sequence, not about calls happening.
 *
 * Every step is mocked, the revoke included: what it does on the wire (stop,
 * abort, bounded keepalive request) is `revokeSession`'s own contract, locked
 * in `client/accountLogout.test.ts`.
 */
const order: string[] = [];

const endActiveCall = vi.fn(async () => {
	order.push("endActiveCall");
});
const disableBackgroundNotifications = vi.fn(async () => {
	order.push("disableBackgroundNotifications");
});
const revokeSession = vi.fn(async (_client: MatrixClient) => {
	order.push("revokeSession");
});
const finishAccountLogout = vi.fn(async (_userId: string) => {
	order.push("finishAccountLogout");
	return "left" as const;
});
const clearCryptoStores = vi.fn(
	async (_client: MatrixClient, _session: Session) => {
		order.push("clearCryptoStores");
	},
);
const setActiveCallRoomId = vi.fn(() => {
	order.push("setActiveCallRoomId");
});
const closeNotificationSound = vi.fn(() => {
	order.push("closeNotificationSound");
});

vi.mock("../features/room/call/rtc/endCall", () => ({
	endActiveCall: () => endActiveCall(),
}));
vi.mock("../features/notifications/accountPush", () => ({
	disableBackgroundNotifications: (...args: unknown[]) =>
		disableBackgroundNotifications(...(args as [])),
}));
vi.mock("../client/accountLogout", () => ({
	revokeSession: (client: MatrixClient) => revokeSession(client),
}));
vi.mock("./accountSwitch", () => ({
	finishAccountLogout: async (
		_exit: unknown,
		userId: string,
		wipe: () => Promise<void>,
		goToLogin: () => void,
	) => {
		// The real one runs the wipe before it leaves; mirror that so a test can
		// see the wipe's position in the order.
		await wipe();
		goToLogin();
		return finishAccountLogout(userId);
	},
}));
vi.mock("../client/cryptoRecovery", () => ({
	clearCryptoStores: (client: MatrixClient, session: Session) =>
		clearCryptoStores(client, session),
}));
vi.mock("../stores/activeCall", () => ({
	setActiveCallRoomId: () => setActiveCallRoomId(),
}));
vi.mock("../features/room/notificationSound", () => ({
	closeNotificationSound: () => closeNotificationSound(),
}));

import { finishSessionExit, runLogout } from "./logout";

const SESSION: Session = {
	accessToken: "token",
	userId: "@alice:example.com",
	deviceId: "DEVICE1",
	homeserverUrl: "https://example.com",
};

const CLIENT = {} as MatrixClient;
const PUSH_CONFIG = {} as PushConfig;

function run() {
	return runLogout({
		client: CLIENT,
		pushConfig: PUSH_CONFIG,
		session: SESSION,
		goToLogin: () => order.push("goToLogin"),
	});
}

describe("runLogout (#551, #555)", () => {
	beforeEach(() => {
		order.length = 0;
		vi.clearAllMocks();
	});

	it("does everything the server needs before the revoke that ends the session", async () => {
		await expect(run()).resolves.toBe("left");

		// The withdrawal needs a token that can still write to the room (#474),
		// and the pusher can only be named server-side by a credential that still
		// works (#534) - so both precede the revoke. The wipe needs nothing from
		// the network and follows it.
		expect(order).toEqual([
			"closeNotificationSound",
			"endActiveCall",
			"setActiveCallRoomId",
			"disableBackgroundNotifications",
			"revokeSession",
			// Again, deliberately: the network steps above take a bounded but
			// real while, and a call started behind the screen in that time would
			// otherwise be inherited by the next account on this tab (#601).
			"setActiveCallRoomId",
			"closeNotificationSound",
			"clearCryptoStores",
			"goToLogin",
			"finishAccountLogout",
		]);
		// This document's RUNNING client is the one revoked and wiped - not a
		// throwaway built from the session, which would leave the running one's
		// sync and MatrixRTC on a token about to 401 (#474).
		expect(revokeSession).toHaveBeenCalledWith(CLIENT);
		expect(clearCryptoStores).toHaveBeenCalledWith(CLIENT, SESSION);
		// This document's own account leaves, not whoever storage calls active:
		// another tab may have switched since this one booted.
		expect(finishAccountLogout).toHaveBeenCalledWith(SESSION.userId);
	});

	it("waits for the withdrawal to land before the revoke cancels it", async () => {
		// Ordering alone cannot show this: a fire-and-forget teardown starts in
		// the same place an awaited one does. So hold the withdrawal open and
		// check that nothing has revoked yet - the revoke aborts the client's
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
		const pending = run();

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(revokeSession).not.toHaveBeenCalled();
		expect(disableBackgroundNotifications).not.toHaveBeenCalled();

		landWithdrawal();
		await pending;
		expect(order.indexOf("endActiveCall")).toBeLessThan(
			order.indexOf("revokeSession"),
		);
	});

	it("still leaves the account when the call teardown throws", async () => {
		endActiveCall.mockImplementationOnce(async () => {
			order.push("endActiveCall");
			throw new Error("a subscriber threw");
		});

		await expect(run()).resolves.toBe("left");
		// The first step failing must not skip the three that take the account off
		// this device: the alternative is the orphaned, still-push-capable device
		// the logout exists to prevent.
		expect(order).toContain("disableBackgroundNotifications");
		expect(order).toContain("revokeSession");
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

		await expect(run()).resolves.toBe("left");
		expect(order).toContain("disableBackgroundNotifications");
		expect(order).toContain("revokeSession");
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

		await expect(run()).resolves.toBe("left");
		expect(order).toContain("revokeSession");
		expect(order).toContain("clearCryptoStores");
	});

	it("waits for the revoke to settle before the wipe", async () => {
		// Same shape as the withdrawal test above: an un-awaited revoke would
		// let the wipe and the clear run under it, and a remaining account's
		// reload would then replace the document with the bound not yet paid.
		let settleRevoke!: () => void;
		revokeSession.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					settleRevoke = () => {
						order.push("revokeSession");
						resolve();
					};
				}),
		);
		const pending = run();

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(clearCryptoStores).not.toHaveBeenCalled();

		settleRevoke();
		await pending;
		expect(order.indexOf("revokeSession")).toBeLessThan(
			order.indexOf("clearCryptoStores"),
		);
	});

	it("still leaves the account when the revoke fails or times out", async () => {
		// `revokeSession` rejects on a network failure and on its bound alike;
		// either way the account still leaves the device. The escape used to
		// skip revoking altogether, and a revoke that fails is the same outcome
		// with a better chance of having landed.
		revokeSession.mockImplementationOnce(async () => {
			order.push("revokeSession");
			throw new Error("server never answered");
		});

		await expect(run()).resolves.toBe("left");
		expect(order.indexOf("revokeSession")).toBeLessThan(
			order.indexOf("clearCryptoStores"),
		);
		expect(order).toContain("finishAccountLogout");
	});
});

describe("finishSessionExit (#601)", () => {
	beforeEach(() => {
		order.length = 0;
		vi.clearAllMocks();
	});

	it("runs the post-network tail, and only it", async () => {
		// The entry point the expired-session effect uses: on a token the server
		// has already invalidated there is no withdrawal, release or revoke left
		// to land, and ending the call properly would only spend its bound
		// failing to reach a server that has stopped listening.
		await expect(
			finishSessionExit({
				client: CLIENT,
				pushConfig: PUSH_CONFIG,
				session: SESSION,
				goToLogin: () => order.push("goToLogin"),
			}),
		).resolves.toBe("left");

		expect(order).toEqual([
			"setActiveCallRoomId",
			"closeNotificationSound",
			"clearCryptoStores",
			"goToLogin",
			"finishAccountLogout",
		]);
		expect(endActiveCall).not.toHaveBeenCalled();
		expect(disableBackgroundNotifications).not.toHaveBeenCalled();
		expect(revokeSession).not.toHaveBeenCalled();
		// This document's own account, and its running client - the same rule
		// runLogout keeps.
		expect(clearCryptoStores).toHaveBeenCalledWith(CLIENT, SESSION);
		expect(finishAccountLogout).toHaveBeenCalledWith(SESSION.userId);
	});

	it("still wipes and redirects when clearing the call signal throws", async () => {
		// A Solid setter runs its subscribers synchronously, so a throwing
		// effect here would otherwise leave an expired session with its stores
		// unwiped, its account still in storage, and no redirect.
		setActiveCallRoomId.mockImplementationOnce(() => {
			order.push("setActiveCallRoomId");
			throw new Error("subscriber blew up");
		});

		await expect(
			finishSessionExit({
				client: CLIENT,
				pushConfig: PUSH_CONFIG,
				session: SESSION,
				goToLogin: () => order.push("goToLogin"),
			}),
		).resolves.toBe("left");

		expect(order).toEqual([
			"setActiveCallRoomId",
			"closeNotificationSound",
			"clearCryptoStores",
			"goToLogin",
			"finishAccountLogout",
		]);
	});
});
