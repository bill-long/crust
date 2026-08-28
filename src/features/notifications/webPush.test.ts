import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushConfig } from "../../types/config";
import { currentPushKey, disableWebPush } from "./webPush";

const CONFIG: PushConfig = {
	vapidPublicKey: "key",
	gatewayUrl: "https://push.example.com/_matrix/push/v1/notify",
	appId: "pizza.strange.crust",
};

/** A push subscription whose keys are what a pusher is registered under. */
function subscription(p256dh: string | undefined): PushSubscription {
	return {
		toJSON: () => ({ keys: p256dh ? { p256dh, auth: "auth" } : undefined }),
	} as unknown as PushSubscription;
}

/** Stub the browser push surface `currentPushKey` reads. `pushApi: false`
 *  leaves the Push API undeclared - a browser with a service worker but no
 *  background push, which must not be probed for a subscription. */
function stubPushEnvironment(
	getSubscription: () => Promise<PushSubscription | null>,
	options: {
		ready?: Promise<ServiceWorkerRegistration>;
		pushApi?: boolean;
		registered?: boolean;
	} = {},
): void {
	const ready =
		options.ready ??
		Promise.resolve({
			pushManager: { getSubscription },
		} as unknown as ServiceWorkerRegistration);
	// Declared only when supported: `vi.stubGlobal(name, undefined)` still
	// DEFINES the property, which `isPushSupported`'s `in` check would accept.
	if (options.pushApi !== false) vi.stubGlobal("PushManager", class {});
	vi.stubGlobal("Notification", class {});
	vi.stubGlobal("navigator", {
		serviceWorker: {
			ready,
			// `disableWebPush` asks for the registration before waiting on
			// `ready`; `registered: false` is a browser with no worker at all.
			getRegistration: async () =>
				options.registered === false ? undefined : {},
		},
		language: "en",
	});
}

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("currentPushKey", () => {
	it("is the pushkey the device's pusher is registered under", async () => {
		stubPushEnvironment(async () => subscription("P256DH"));

		await expect(currentPushKey()).resolves.toBe("P256DH");
	});

	it("is null when the browser cannot do background push at all", async () => {
		// A service worker on its own is not enough: without the Push API there
		// is no subscription to be reachable at, and asking for one is how the
		// unsupported path used to throw.
		stubPushEnvironment(async () => subscription("P256DH"), {
			pushApi: false,
		});

		await expect(currentPushKey()).resolves.toBeNull();
	});

	it("is null when the device has no subscription", async () => {
		stubPushEnvironment(async () => null);

		await expect(currentPushKey()).resolves.toBeNull();
	});

	it("is null for a subscription with no encryption keys", async () => {
		stubPushEnvironment(async () => subscription(undefined));

		await expect(currentPushKey()).resolves.toBeNull();
	});

	it("is null when reading the subscription fails", async () => {
		stubPushEnvironment(async () => {
			throw new Error("storage is restricted");
		});

		await expect(currentPushKey()).resolves.toBeNull();
	});

	it("is null rather than hanging when no service worker becomes ready", async () => {
		// The boot sweep runs ahead of the active account's own pusher refresh,
		// so this cannot wait forever; in dev - and wherever the worker is
		// disabled - `ready` simply never settles.
		vi.useFakeTimers();
		try {
			stubPushEnvironment(async () => null, { ready: new Promise(() => {}) });

			const key = currentPushKey();
			await vi.advanceTimersByTimeAsync(30_000);

			await expect(key).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("disableWebPush", () => {
	/** A client whose pusher removal never answers, like a dead homeserver. */
	function hangingClient(): {
		client: MatrixClient;
		removePusher: ReturnType<typeof vi.fn>;
	} {
		const removePusher = vi.fn(() => new Promise<unknown>(() => {}));
		return {
			client: { removePusher } as unknown as MatrixClient,
			removePusher,
		};
	}

	it("unsubscribes the browser before asking the server", async () => {
		// Callers reach this where the server is expected to be unreachable or
		// the token already dead (an expired session, the force-logout escape
		// hatch, a switch made offline), and it is the unsubscribe that stops
		// delivery to this device. Behind the round trip, a hung or bounded call
		// would leave the device subscribed - the leak this closes (#534).
		const unsubscribe = vi.fn(async () => true);
		const sub = {
			toJSON: () => ({ keys: { p256dh: "P256DH", auth: "auth" } }),
			unsubscribe,
		} as unknown as PushSubscription;
		stubPushEnvironment(async () => sub);
		const { client, removePusher } = hangingClient();

		// The server call never answers, so the device is only unsubscribed if
		// that step does not wait on it.
		void disableWebPush(client, CONFIG);

		await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
		expect(removePusher).toHaveBeenCalledOnce();
	});

	it("still removes the pusher once the browser is unsubscribed", async () => {
		const sub = {
			toJSON: () => ({ keys: { p256dh: "P256DH", auth: "auth" } }),
			unsubscribe: vi.fn(async () => true),
		} as unknown as PushSubscription;
		stubPushEnvironment(async () => sub);
		const removePusher = vi.fn(async () => ({}));

		await disableWebPush({ removePusher } as unknown as MatrixClient, CONFIG);

		expect(removePusher).toHaveBeenCalledWith("P256DH", CONFIG.appId);
	});

	it("unsubscribes even when the server-side removal fails", async () => {
		const unsubscribe = vi.fn(async () => true);
		const sub = {
			toJSON: () => ({ keys: { p256dh: "P256DH", auth: "auth" } }),
			unsubscribe,
		} as unknown as PushSubscription;
		stubPushEnvironment(async () => sub);
		const removePusher = vi.fn(async () => {
			throw new Error("M_UNKNOWN_TOKEN");
		});

		await expect(
			disableWebPush({ removePusher } as unknown as MatrixClient, CONFIG),
		).resolves.toBeUndefined();

		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});

describe("a device with no service worker registered", () => {
	it("returns at once instead of waiting on one that never arrives", async () => {
		// `navigator.serviceWorker.ready` never settles when nothing is
		// registered - the dev server registers no worker, and a production
		// install can fail to. Every account exit calls this, and waiting out the
		// caller's whole timeout budget there would put seconds between the click
		// and the switch.
		vi.useFakeTimers();
		try {
			stubPushEnvironment(async () => null, {
				ready: new Promise(() => {}),
				registered: false,
			});
			const removePusher = vi.fn(async () => ({}));

			const done = disableWebPush(
				{ removePusher } as unknown as MatrixClient,
				CONFIG,
			);
			// No timers advanced: this must not depend on anything timing out.
			await expect(done).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
