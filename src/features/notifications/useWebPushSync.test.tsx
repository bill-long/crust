import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const removeOtherAccountPushersMock = vi.hoisted(() =>
	vi.fn(async (_userId: string, _cfg: unknown) => {}),
);
vi.mock("./accountPush", () => ({
	removeOtherAccountPushers: (userId: string, cfg: unknown) =>
		removeOtherAccountPushersMock(userId, cfg),
}));

const enableWebPushMock = vi.hoisted(() =>
	vi.fn(async (_client: unknown, _cfg: unknown) => {}),
);
const isPushSupportedMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("./webPush", () => ({
	enableWebPush: (client: unknown, cfg: unknown) =>
		enableWebPushMock(client, cfg),
	isPushSupported: () => isPushSupportedMock(),
}));

import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { updateSetting } from "../../stores/settings";
import type { PushConfig } from "../../types/config";
import { useWebPushSync } from "./useWebPushSync";

const CONFIG: PushConfig = {
	vapidPublicKey: "key",
	gatewayUrl: "https://push.example.com/_matrix/push/v1/notify",
	appId: "pizza.strange.crust",
};

const client = {
	getUserId: () => "@alice:example.com",
} as unknown as MatrixClient;

/** Mount the hook the way the shell does. */
function mount(pushConfig: PushConfig = CONFIG): void {
	render(() => {
		useWebPushSync(client, pushConfig);
		return <div />;
	});
}

beforeEach(() => {
	localStorage.clear();
	removeOtherAccountPushersMock.mockClear();
	enableWebPushMock.mockClear();
	isPushSupportedMock.mockReturnValue(true);
	vi.stubGlobal("Notification", { permission: "granted" });
	updateSetting("backgroundNotifications", true);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
});

describe("useWebPushSync", () => {
	it("refreshes this account's pusher", async () => {
		mount();
		await Promise.resolve();

		expect(enableWebPushMock).toHaveBeenCalledWith(client, CONFIG);
	});

	it("finishes the sweep before refreshing this account's pusher", async () => {
		// They share one push subscription, and the refresh replaces it outright
		// when the VAPID key has changed. A sweep still resolving its pushkey
		// would then read the NEW one and remove that from the other accounts - a
		// no-op, leaving their pushers in place on the one boot meant to be the
		// backstop.
		const order: string[] = [];
		let finishSweep: () => void = () => {};
		removeOtherAccountPushersMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishSweep = () => {
						order.push("sweep");
						resolve();
					};
				}),
		);
		enableWebPushMock.mockImplementation(async () => {
			order.push("refresh");
		});

		mount();
		await Promise.resolve();
		expect(enableWebPushMock).not.toHaveBeenCalled();

		finishSweep();
		await Promise.resolve();
		await Promise.resolve();

		expect(order).toEqual(["sweep", "refresh"]);
	});

	it("takes the device off the other accounts' pushers", async () => {
		mount();
		await Promise.resolve();

		expect(removeOtherAccountPushersMock).toHaveBeenCalledWith(
			"@alice:example.com",
			CONFIG,
		);
	});

	it("sweeps even when this account does not want background push", async () => {
		// The stale pusher belongs to the account that LEFT, so the incoming
		// account's own preference has nothing to say about it. Gating the sweep
		// on it would leave the leak in place for exactly the user who turned
		// background notifications off.
		updateSetting("backgroundNotifications", false);

		mount();
		await Promise.resolve();
		await Promise.resolve();

		expect(removeOtherAccountPushersMock).toHaveBeenCalledOnce();
		expect(enableWebPushMock).not.toHaveBeenCalled();
	});

	it("sweeps even when notification permission was never granted", async () => {
		vi.stubGlobal("Notification", { permission: "denied" });

		mount();
		await Promise.resolve();
		await Promise.resolve();

		expect(removeOtherAccountPushersMock).toHaveBeenCalledOnce();
		expect(enableWebPushMock).not.toHaveBeenCalled();
	});

	it("does nothing when the browser cannot do background push", async () => {
		isPushSupportedMock.mockReturnValue(false);

		mount();
		await Promise.resolve();
		await Promise.resolve();

		expect(removeOtherAccountPushersMock).not.toHaveBeenCalled();
		expect(enableWebPushMock).not.toHaveBeenCalled();
	});

	it("does nothing when the deployment has no push gateway", async () => {
		mount({ ...CONFIG, vapidPublicKey: "" });

		expect(removeOtherAccountPushersMock).not.toHaveBeenCalled();
		expect(enableWebPushMock).not.toHaveBeenCalled();
	});
});
