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
	loadSessions,
	type Session,
	saveSession,
	unfreezeAccountScope,
} from "../stores/session";
import { finishAccountLogout, switchToAccount } from "./accountSwitch";

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

/** Move the persisted pointer the way another tab would, behind this tab's back. */
function setActiveAccountForOtherTab(userId: string): void {
	const store = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
	store.activeUserId = userId;
	localStorage.setItem("crust:session", JSON.stringify(store));
}

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

	it("accepts an account another tab added, which this tab never saw", async () => {
		// The reactive mirrors only reflect THIS tab's writes. Validating against
		// them would refuse a perfectly good account and, worse, trust a row for
		// one that another tab has already removed.
		saveSession(ALICE);
		const store = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		store.sessions.push({ ...BOB, cryptoPrefix: "crust:@bob:example.com" });
		localStorage.setItem("crust:session", JSON.stringify(store));

		await expect(switchToAccount(BOB.userId)).resolves.toBe("switching");

		expect(assign).toHaveBeenCalledOnce();
	});

	it("refuses a row for an account another tab removed, before any teardown", async () => {
		// This tab runs ALICE and its switcher still lists BOB...
		saveSession(BOB);
		addSession(ALICE);
		// ...but another tab has logged BOB out since.
		localStorage.setItem(
			"crust:session",
			JSON.stringify({ activeUserId: ALICE.userId, sessions: [ALICE] }),
		);

		await expect(switchToAccount(BOB.userId)).resolves.toBe("unknown-account");

		expect(endActiveCallMock).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});

	it("is a no-op for the account already active", async () => {
		saveSession(ALICE);

		await expect(switchToAccount(ALICE.userId)).resolves.toBe("switching");

		expect(endActiveCallMock).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});

	it("still switches to the account ANOTHER tab made active", async () => {
		// "Already active" is a property of the client THIS document runs, not of
		// the persisted pointer. Reading storage here would make a tab that is
		// still running Alice decline a switch to Bob - silently, forever.
		saveSession(ALICE);
		addSession(BOB);
		setActiveAccountForOtherTab(ALICE.userId);
		// This tab is still running BOB (its mirror says so); storage says ALICE.
		await expect(switchToAccount(ALICE.userId)).resolves.toBe("switching");

		expect(assign).toHaveBeenCalledOnce();
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

describe("finishAccountLogout", () => {
	/** A wipe that records when it ran, relative to leaving. */
	const wipe = vi.fn(async () => {
		await Promise.resolve();
		calls.push("wipe");
	});

	beforeEach(() => {
		wipe.mockClear();
	});

	it("reloads into the account promoted by the logout", () => {
		// /login would be wrong here: the promoted account is live in storage,
		// and logging in on that page REPLACES it, discarding its token unrevoked.
		saveSession(ALICE);
		addSession(BOB);
		const goToLogin = vi.fn();

		return finishAccountLogout(
			() => clearSession(ALICE.userId),
			wipe,
			goToLogin,
		).then(() => {
			expect(assign).toHaveBeenCalledOnce();
			expect(goToLogin).not.toHaveBeenCalled();
		});
	});

	it("finishes the wipe BEFORE replacing the document", async () => {
		// A reload aborts a delete in flight, leaving the departing account's
		// IndexedDB data on disk.
		saveSession(ALICE);
		addSession(BOB);

		await finishAccountLogout(() => clearSession(ALICE.userId), wipe, vi.fn());

		expect(calls).toEqual(["wipe", "assign"]);
	});

	it("routes to the login page BEFORE the wipe when nothing is left", async () => {
		// The document survives a route change, so the wipe still completes - and
		// the user never watches the stopped app UI while it awaits.
		saveSession(ALICE);
		const goToLogin = vi.fn(() => calls.push("login"));

		await finishAccountLogout(
			() => clearSession(ALICE.userId),
			wipe,
			goToLogin,
		);

		expect(calls).toEqual(["login", "wipe"]);
		expect(assign).not.toHaveBeenCalled();
	});

	it("reloads into an account another tab left behind", async () => {
		// This tab's mirror says "nobody is logged in"; storage - which the
		// logout just wrote, and which another tab may also have written - says
		// otherwise. Storage is the authority, or the user is dumped on a login
		// form with a live session behind it.
		saveSession(ALICE);
		clearSession(ALICE.userId);
		localStorage.setItem(
			"crust:session",
			JSON.stringify({ activeUserId: BOB.userId, sessions: [BOB] }),
		);
		const goToLogin = vi.fn();

		await finishAccountLogout(() => true, wipe, goToLogin);

		expect(assign).toHaveBeenCalledOnce();
		expect(goToLogin).not.toHaveBeenCalled();
	});

	it("hands back to the login page when the logout could not be persisted", async () => {
		// Storage still names the account whose token was just revoked. Reloading
		// into it would boot a dead session, log out again, and loop.
		saveSession(ALICE);
		addSession(BOB);
		const goToLogin = vi.fn();

		await finishAccountLogout(() => false, wipe, goToLogin);

		expect(goToLogin).toHaveBeenCalledOnce();
		expect(assign).not.toHaveBeenCalled();
	});

	it("leaves anyway when the wipe never settles", async () => {
		// `deleteDatabase` BLOCKS while another window holds the store open, and
		// the SDK only logs that - the promise never resolves. Waiting forever
		// would strand the user on a stopped UI holding a revoked token.
		vi.useFakeTimers();
		try {
			saveSession(ALICE);
			addSession(BOB);
			const hangs = vi.fn(() => new Promise<void>(() => {}));
			vi.spyOn(console, "error").mockImplementation(() => {});

			const done = finishAccountLogout(
				() => clearSession(BOB.userId),
				hangs,
				vi.fn(),
			);
			await vi.advanceTimersByTimeAsync(60_000);
			await done;

			expect(assign).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("freezes account-scoped storage while the outgoing account is on screen", async () => {
		// `clear` moves the pointer; until this document is replaced its stores
		// must not rebind to the promoted account (a visible re-zoom, and writes
		// filed under the wrong key).
		saveSession(ALICE);
		addSession(BOB);

		await finishAccountLogout(() => clearSession(BOB.userId), wipe, vi.fn());

		expect(isAccountScopeFrozen()).toBe(true);
	});

	it("lifts the freeze when the document stays for the login page", async () => {
		// A route to /login does not replace the document, and the next login
		// happens in it - a freeze left on would strand that account's stores.
		saveSession(ALICE);

		await finishAccountLogout(() => clearSession(ALICE.userId), wipe, vi.fn());

		expect(isAccountScopeFrozen()).toBe(false);
	});

	it("logs out the account it was given, not whoever storage calls active", async () => {
		// Another tab switched since this document booted. Logging out here must
		// not sign out the account the user never touched.
		saveSession(ALICE);
		addSession(BOB);
		setActiveAccountForOtherTab(ALICE.userId);

		await finishAccountLogout(() => clearSession(BOB.userId), wipe, vi.fn());

		expect(loadSessions().map((a) => a.userId)).toEqual([ALICE.userId]);
	});

	it("hands back to the login page when no account is left", async () => {
		saveSession(ALICE);
		const goToLogin = vi.fn();

		await finishAccountLogout(
			() => clearSession(ALICE.userId),
			wipe,
			goToLogin,
		);

		expect(goToLogin).toHaveBeenCalledOnce();
		expect(assign).not.toHaveBeenCalled();
	});
});
