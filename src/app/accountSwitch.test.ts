import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const endActiveCallMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../features/room/call/rtc/endCall", () => ({
	endActiveCall: () => endActiveCallMock(),
}));

const closeNotificationSoundMock = vi.hoisted(() => vi.fn());
vi.mock("../features/room/notificationSound", () => ({
	closeNotificationSound: () => closeNotificationSoundMock(),
}));

import { setActiveCallRoomId } from "../stores/activeCall";
import {
	addSession,
	clearSession,
	isAccountScopeFrozen,
	loadSession,
	type Session,
	saveSession,
	unfreezeAccountScope,
} from "../stores/session";
import { leaveLoggedOutAccount, switchToAccount } from "./accountSwitch";

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

/** Calls in the order they happened, so ordering can be asserted. */
const calls: string[] = [];
const assign = vi.fn(() => calls.push("assign"));

beforeEach(() => {
	localStorage.clear();
	calls.length = 0;
	assign.mockClear();
	endActiveCallMock.mockClear();
	endActiveCallMock.mockImplementation(async () => {
		// Resolve on a later tick, so a teardown that is fired but NOT awaited
		// records itself after the reload instead of before it.
		await Promise.resolve();
		await Promise.resolve();
		calls.push("endActiveCall");
	});
	closeNotificationSoundMock.mockClear();
	closeNotificationSoundMock.mockImplementation(() => {
		calls.push("closeNotificationSound");
	});
	vi.stubGlobal("location", { assign });
	unfreezeAccountScope();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	setActiveCallRoomId(null);
	unfreezeAccountScope();
	localStorage.clear();
});

describe("switchToAccount", () => {
	it("ends the call, flips the active account, and reloads", async () => {
		saveSession(ALICE);
		addSession(BOB);

		await expect(switchToAccount(ALICE.userId)).resolves.toBe("switching");

		expect(loadSession()?.userId).toBe(ALICE.userId);
		expect(assign).toHaveBeenCalledOnce();
	});

	it("awaits the call teardown BEFORE reloading", async () => {
		// The MatrixRTC withdrawal has to reach the server on the outgoing
		// token (#474); a reload started first would kill it in flight.
		saveSession(ALICE);
		addSession(BOB);

		await switchToAccount(ALICE.userId);

		expect(calls).toEqual([
			"closeNotificationSound",
			"endActiveCall",
			"assign",
		]);
	});

	it("keeps the outgoing account logged in", async () => {
		// The whole point of a switch: nothing destructive happens to the
		// account being left.
		saveSession(ALICE);
		addSession(BOB);

		await switchToAccount(ALICE.userId);

		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.sessions).toHaveLength(2);
		expect(
			stored.sessions.find((s: Session) => s.userId === BOB.userId)
				?.accessToken,
		).toBe(BOB.accessToken);
	});

	it("does not tear anything down for a stale switcher row", async () => {
		// The row can go stale (the account was removed in another tab, or while
		// the menu was open). Validating only after the teardown would cost the
		// user their live call for a switch that then refuses to happen.
		saveSession(ALICE);

		await expect(switchToAccount("@ghost:example.com")).resolves.toBe(
			"unknown-account",
		);

		expect(endActiveCallMock).not.toHaveBeenCalled();
		expect(closeNotificationSoundMock).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
		expect(loadSession()?.userId).toBe(ALICE.userId);
	});

	it("is a no-op for the account already active", async () => {
		saveSession(ALICE);

		await expect(switchToAccount(ALICE.userId)).resolves.toBe("switching");

		expect(endActiveCallMock).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});

	it("freezes account-scoped storage before the pointer moves", async () => {
		// `location.assign` only STARTS the navigation, so this document keeps
		// running as the OUTGOING account. Its scoped stores must not rebind, or
		// the UI re-zooms and any write lands under the incoming account's key.
		saveSession(ALICE);
		addSession(BOB);

		await switchToAccount(ALICE.userId);

		expect(isAccountScopeFrozen()).toBe(true);
	});

	it("unfreezes when the switch could not be persisted", async () => {
		saveSession(ALICE);
		addSession(BOB);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceeded");
		});

		await expect(switchToAccount(ALICE.userId)).resolves.toBe("failed");

		vi.restoreAllMocks();
		expect(isAccountScopeFrozen()).toBe(false);
		expect(assign).not.toHaveBeenCalled();
	});

	it("switches anyway when the call teardown fails", async () => {
		// A withdrawal that cannot land (the server is unreachable) must not
		// trap the user in the account they are trying to leave.
		saveSession(ALICE);
		addSession(BOB);
		endActiveCallMock.mockRejectedValueOnce(new Error("network down"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(switchToAccount(ALICE.userId)).resolves.toBe("switching");

		expect(loadSession()?.userId).toBe(ALICE.userId);
		expect(assign).toHaveBeenCalledOnce();
	});

	it("drops a call signal raised during the teardown", async () => {
		// endActiveCall clears the signal only for the room it tore down, and
		// the signal is module-global: a call joined mid-switch would otherwise
		// be inherited by the incoming account.
		saveSession(ALICE);
		addSession(BOB);
		endActiveCallMock.mockImplementationOnce(async () => {
			await Promise.resolve();
			calls.push("endActiveCall");
			setActiveCallRoomId("!late:example.com");
		});

		await switchToAccount(ALICE.userId);

		const { activeCallRoomId } = await import("../stores/activeCall");
		expect(activeCallRoomId()).toBeNull();
	});
});

describe("leaveLoggedOutAccount", () => {
	it("reloads into the account promoted by the logout", () => {
		// /login would be wrong here: the promoted account is live in storage,
		// and logging in on that page REPLACES it, discarding its token unrevoked.
		saveSession(ALICE);
		addSession(BOB);
		clearSession();
		const goToLogin = vi.fn();

		leaveLoggedOutAccount(goToLogin);

		expect(assign).toHaveBeenCalledOnce();
		expect(goToLogin).not.toHaveBeenCalled();
	});

	it("hands back to the login page when no account is left", () => {
		saveSession(ALICE);
		clearSession();
		const goToLogin = vi.fn();

		leaveLoggedOutAccount(goToLogin);

		expect(goToLogin).toHaveBeenCalledOnce();
		expect(assign).not.toHaveBeenCalled();
	});
});
