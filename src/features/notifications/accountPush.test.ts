import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.hoisted(() => vi.fn());
vi.mock("matrix-js-sdk", () => ({
	createClient: (...args: unknown[]) => createClientMock(...args),
}));

const currentPushKeyMock = vi.hoisted(() =>
	vi.fn(async (): Promise<string | null> => "PUSHKEY"),
);
const disableWebPushMock = vi.hoisted(() =>
	vi.fn(async (_client: unknown, _cfg: unknown) => {}),
);
const enableWebPushMock = vi.hoisted(() =>
	vi.fn(async (_client: unknown, _cfg: unknown) => {}),
);
const isPushSupportedMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("./webPush", () => ({
	currentPushKey: () => currentPushKeyMock(),
	disableWebPush: (client: unknown, cfg: unknown) =>
		disableWebPushMock(client, cfg),
	enableWebPush: (client: unknown, cfg: unknown) =>
		enableWebPushMock(client, cfg),
	isPushSupported: () => isPushSupportedMock(),
}));

import type { MatrixClient } from "matrix-js-sdk";
import {
	addSession,
	type Session,
	saveSession,
	setActiveAccount,
} from "../../stores/session";
import { updateSetting } from "../../stores/settings";
import type { PushConfig } from "../../types/config";
import {
	releaseWebPush,
	removeOtherAccountPushers,
	restoreWebPush,
} from "./accountPush";

const ALICE: Session = {
	accessToken: "syt_a",
	userId: "@alice:example.com",
	deviceId: "DEV_A",
	homeserverUrl: "https://matrix.example.com",
};
const BOB: Session = {
	...ALICE,
	accessToken: "syt_b",
	userId: "@bob:example.com",
	deviceId: "DEV_B",
};

const CONFIG: PushConfig = {
	vapidPublicKey: "key",
	gatewayUrl: "https://push.example.com/_matrix/push/v1/notify",
	appId: "pizza.strange.crust",
};

/** The running account's client; only ever forwarded to disableWebPush. */
const CLIENT = {} as MatrixClient;

let removePusher: ReturnType<typeof vi.fn>;

beforeEach(() => {
	localStorage.clear();
	removePusher = vi.fn(async () => ({}));
	createClientMock.mockReset();
	createClientMock.mockReturnValue({ removePusher });
	currentPushKeyMock.mockClear();
	currentPushKeyMock.mockResolvedValue("PUSHKEY");
	disableWebPushMock.mockClear();
	disableWebPushMock.mockImplementation(async () => {});
	enableWebPushMock.mockClear();
	enableWebPushMock.mockImplementation(async () => {});
	isPushSupportedMock.mockReturnValue(true);
	vi.stubGlobal("Notification", { permission: "granted" });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
});

/** The user IDs whose credentials the sweep built a client from. */
const sweptAccounts = (): string[] =>
	createClientMock.mock.calls.map(
		(call) => (call[0] as { userId: string }).userId,
	);

describe("releaseWebPush", () => {
	it("hands the registration back", async () => {
		saveSession(ALICE);
		updateSetting("backgroundNotifications", true);

		await releaseWebPush(CLIENT, CONFIG);

		expect(disableWebPushMock).toHaveBeenCalledWith(CLIENT, CONFIG);
	});

	it("releases even when THIS tab's settings say push is off", async () => {
		// `backgroundNotifications` is a per-tab signal that no storage event
		// refreshes (#533, invariant 2): a second tab that enabled background
		// notifications is invisible here. Gating on it would skip the release
		// for an account that does have a live pusher, on the logout path where
		// nothing can ever clean up afterwards. Whether there is anything to hand
		// back is the device's answer, and `disableWebPush` asks it.
		saveSession(ALICE);
		updateSetting("backgroundNotifications", false);

		await releaseWebPush(CLIENT, CONFIG);

		expect(disableWebPushMock).toHaveBeenCalledWith(CLIENT, CONFIG);
	});

	it("does nothing when the deployment has no push gateway", async () => {
		saveSession(ALICE);
		updateSetting("backgroundNotifications", true);

		await releaseWebPush(CLIENT, { ...CONFIG, gatewayUrl: "" });

		expect(disableWebPushMock).not.toHaveBeenCalled();
	});

	it("gives up rather than blocking the exit when the removal hangs", async () => {
		// An account exit sits between the user's click and the switch actually
		// happening; an unreachable homeserver must not hold them in the account
		// they asked to leave. The boot sweep is what makes giving up safe.
		vi.useFakeTimers();
		try {
			saveSession(ALICE);
			updateSetting("backgroundNotifications", true);
			disableWebPushMock.mockImplementation(() => new Promise<void>(() => {}));

			const done = releaseWebPush(CLIENT, CONFIG);
			await vi.advanceTimersByTimeAsync(30_000);

			await expect(done).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not throw when the removal fails", async () => {
		saveSession(ALICE);
		updateSetting("backgroundNotifications", true);
		disableWebPushMock.mockRejectedValue(new Error("network down"));

		await expect(releaseWebPush(CLIENT, CONFIG)).resolves.toBeUndefined();
	});
});

describe("restoreWebPush", () => {
	it("re-registers the account a failed switch left running", async () => {
		saveSession(ALICE);
		updateSetting("backgroundNotifications", true);

		await restoreWebPush(CLIENT, CONFIG);

		expect(enableWebPushMock).toHaveBeenCalledWith(CLIENT, CONFIG);
	});

	it("does not register one the account never asked for", async () => {
		saveSession(ALICE);
		updateSetting("backgroundNotifications", false);

		await restoreWebPush(CLIENT, CONFIG);

		expect(enableWebPushMock).not.toHaveBeenCalled();
	});

	it("does not prompt for a permission that was never granted", async () => {
		// The restore runs without the user asking for anything, so it can only
		// put back what was already there - `enableWebPush` would otherwise pop a
		// permission request out of a failed account switch.
		saveSession(ALICE);
		updateSetting("backgroundNotifications", true);
		vi.stubGlobal("Notification", { permission: "default" });

		await restoreWebPush(CLIENT, CONFIG);

		expect(enableWebPushMock).not.toHaveBeenCalled();
	});

	it("gives up rather than hanging on a failed switch", async () => {
		vi.useFakeTimers();
		try {
			saveSession(ALICE);
			updateSetting("backgroundNotifications", true);
			enableWebPushMock.mockImplementation(() => new Promise<void>(() => {}));

			const done = restoreWebPush(CLIENT, CONFIG);
			await vi.advanceTimersByTimeAsync(30_000);

			await expect(done).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("removeOtherAccountPushers", () => {
	it("takes the device's pushkey off every account that is not running", async () => {
		saveSession(ALICE);
		addSession(BOB);

		await removeOtherAccountPushers(BOB.userId, CONFIG);

		expect(sweptAccounts()).toEqual([ALICE.userId]);
		expect(removePusher).toHaveBeenCalledWith("PUSHKEY", CONFIG.appId);
	});

	it("uses each account's own credentials", async () => {
		// The pusher can only be removed by the account that owns it, and an
		// inactive account's client is not running - so the sweep builds one from
		// its stored credentials, exactly as a background logout does.
		saveSession(ALICE);
		addSession(BOB);

		await removeOtherAccountPushers(BOB.userId, CONFIG);

		expect(createClientMock.mock.calls[0]?.[0]).toMatchObject({
			accessToken: ALICE.accessToken,
			userId: ALICE.userId,
			deviceId: ALICE.deviceId,
			baseUrl: ALICE.homeserverUrl,
		});
	});

	it("never touches the account this document is running", async () => {
		// It is the account the same hook is about to register a pusher for.
		saveSession(ALICE);
		addSession(BOB);

		await removeOtherAccountPushers(BOB.userId, CONFIG);

		expect(sweptAccounts()).not.toContain(BOB.userId);
	});

	it("keeps the account on screen even when storage calls another one active", async () => {
		// Another tab switched since this document booted. Reading the pointer
		// here would remove the pusher this document is about to register.
		saveSession(ALICE);
		addSession(BOB);
		setActiveAccount(ALICE.userId);

		await removeOtherAccountPushers(BOB.userId, CONFIG);

		expect(sweptAccounts()).toEqual([ALICE.userId]);
	});

	it("sees an account another tab added, which this tab never mirrored", async () => {
		saveSession(BOB);
		const store = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		store.sessions.push({ ...ALICE, cryptoPrefix: "crust:@alice:example.com" });
		localStorage.setItem("crust:session", JSON.stringify(store));

		await removeOtherAccountPushers(BOB.userId, CONFIG);

		expect(sweptAccounts()).toEqual([ALICE.userId]);
	});

	it("does not wait on the service worker for a single-account install", async () => {
		// The common case: no other account can hold a pusher, so nothing is
		// asked of the push subscription at all.
		saveSession(ALICE);

		await removeOtherAccountPushers(ALICE.userId, CONFIG);

		expect(currentPushKeyMock).not.toHaveBeenCalled();
		expect(createClientMock).not.toHaveBeenCalled();
	});

	it("does nothing when this device has no push subscription", async () => {
		// No pushkey means no account can be pushing here, so there is nothing to
		// remove - and a pusher for some earlier, dead subscription is the push
		// service's to expire (410 -> the gateway drops it).
		saveSession(ALICE);
		addSession(BOB);
		currentPushKeyMock.mockResolvedValue(null);

		await removeOtherAccountPushers(BOB.userId, CONFIG);

		expect(createClientMock).not.toHaveBeenCalled();
	});

	it("does nothing when the deployment has no push gateway", async () => {
		saveSession(ALICE);
		addSession(BOB);

		await removeOtherAccountPushers(BOB.userId, { ...CONFIG, appId: "" });

		expect(currentPushKeyMock).not.toHaveBeenCalled();
		expect(createClientMock).not.toHaveBeenCalled();
	});

	it("gives up on an account whose homeserver never answers", async () => {
		// The sweep runs ahead of the active account's own pusher refresh, so an
		// unbounded removal against a black-holing homeserver would take that
		// refresh down with it for the whole boot - the refresh exists precisely
		// for the case where the subscription rotated overnight.
		vi.useFakeTimers();
		try {
			const CAROL: Session = {
				...ALICE,
				userId: "@carol:example.com",
				deviceId: "DEV_C",
			};
			saveSession(ALICE);
			addSession(CAROL);
			addSession(BOB);
			removePusher.mockImplementationOnce(() => new Promise<unknown>(() => {}));

			const done = removeOtherAccountPushers(BOB.userId, CONFIG);
			await vi.advanceTimersByTimeAsync(30_000);
			await done;

			// The hung account cost only its own timeout; the next one was still
			// swept.
			expect(sweptAccounts()).toEqual([ALICE.userId, CAROL.userId]);
			expect(removePusher).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps sweeping after an account whose credential no longer works", async () => {
		// A stale token on one account must not leave the next account's pusher
		// in place - that one is the leak.
		const CAROL: Session = {
			...ALICE,
			userId: "@carol:example.com",
			deviceId: "DEV_C",
		};
		saveSession(ALICE);
		addSession(CAROL);
		addSession(BOB);
		removePusher
			.mockRejectedValueOnce(new Error("M_UNKNOWN_TOKEN"))
			.mockResolvedValue({});

		await removeOtherAccountPushers(BOB.userId, CONFIG);

		expect(sweptAccounts()).toEqual([ALICE.userId, CAROL.userId]);
		expect(removePusher).toHaveBeenCalledTimes(2);
	});
});
