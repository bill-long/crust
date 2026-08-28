import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const removeOtherAccountPushersMock = vi.hoisted(() =>
	vi.fn(async (_userId: string, _cfg: unknown) => {}),
);
const releaseWebPushMock = vi.hoisted(() =>
	vi.fn(async (_client: unknown, _cfg: unknown) => {}),
);
vi.mock("./accountPush", () => ({
	removeOtherAccountPushers: (userId: string, cfg: unknown) =>
		removeOtherAccountPushersMock(userId, cfg),
	releaseWebPush: (client: unknown, cfg: unknown) =>
		releaseWebPushMock(client, cfg),
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
	releaseWebPushMock.mockClear();
	enableWebPushMock.mockClear();
	// The implementation too, not just the calls: a test that makes the refresh
	// change the setting under itself would otherwise do so in every test after
	// it (`vi.restoreAllMocks` leaves a `vi.fn()`'s implementation alone).
	enableWebPushMock.mockImplementation(async () => {});
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
	it("hands back a pusher the user turned off while it was registering", async () => {
		// The setting is read before `enableWebPush`, which awaits the service
		// worker and can subscribe afresh - so a toggle-off or a logout that
		// started in between would find nothing to release, and this would then
		// register a pusher on a live endpoint for an account on its way out of
		// storage, where nothing can ever remove it.
		enableWebPushMock.mockImplementation(async () => {
			updateSetting("backgroundNotifications", false);
		});

		mount();

		await vi.waitFor(() =>
			expect(releaseWebPushMock).toHaveBeenCalledWith(client, CONFIG),
		);
		expect(enableWebPushMock).toHaveBeenCalledOnce();
	});

	it("leaves the pusher alone when nothing changed under it", async () => {
		mount();

		await vi.waitFor(() => expect(enableWebPushMock).toHaveBeenCalledOnce());
		expect(releaseWebPushMock).not.toHaveBeenCalled();
	});

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

	it("still sweeps, but registers nothing, once push is unconfigured", async () => {
		// The refresh registers a pusher and so needs the deployment's VAPID key
		// and gateway; the sweep only removes pushers, and the ones left pointing
		// at this device outlive the config that created them.
		mount({ ...CONFIG, vapidPublicKey: "" });
		await Promise.resolve();
		await Promise.resolve();

		expect(removeOtherAccountPushersMock).toHaveBeenCalledOnce();
		expect(enableWebPushMock).not.toHaveBeenCalled();
	});
});
