import { afterEach, beforeEach, expect, it } from "vitest";
import {
	clearLogoutResidue,
	logoutResidue,
	rememberLogoutSession,
} from "../../stores/logoutResidue";
import {
	commitLoginSession,
	loadSessions,
	rememberAccountDisplayName,
	type Session,
	saveSession,
	unfreezeAccountScope,
} from "../../stores/session";
import { withSessionLock } from "../../stores/sessionLock";
import { persistLogin } from "./persistLogin";

const alice: Session = {
	userId: "@alice:example.org",
	deviceId: "A",
	accessToken: "secret-alice-token",
	homeserverUrl: "https://example.org",
};
const bob: Session = {
	...alice,
	userId: "@bob:example.org",
	deviceId: "B",
	accessToken: "secret-bob-token",
};

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	clearLogoutResidue();
	unfreezeAccountScope();
});
afterEach(() => {
	clearLogoutResidue();
	unfreezeAccountScope();
	localStorage.clear();
});

it("waits for another window's login commit, then preserves that account", async () => {
	const frame = document.createElement("iframe");
	document.body.append(frame);
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const other = (
		frame.contentWindow as Window & typeof globalThis
	).navigator.locks.request("crust:session", async () => {
		entered();
		await gate;
		saveSession(alice);
	});
	try {
		await held;
		const pending = persistLogin(bob, false);
		const rename = withSessionLock(() =>
			rememberAccountDisplayName(alice.userId, "Alice renamed"),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(loadSessions()).toHaveLength(0);
		release();
		await other;
		expect(await pending).toBe(true);
		await rename;
		expect(loadSessions().map((s) => s.userId)).toEqual([
			alice.userId,
			bob.userId,
		]);
		expect(loadSessions()[0]?.displayName).toBe("Alice renamed");
	} finally {
		release();
		await other;
		frame.remove();
	}
});

it("a queued legacy migration cannot overwrite a concurrent login", async () => {
	const frame = document.createElement("iframe");
	document.body.append(frame);
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const other = (
		frame.contentWindow as Window & typeof globalThis
	).navigator.locks.request("crust:session", async () => {
		entered();
		await gate;
		commitLoginSession(bob, []);
	});
	try {
		await held;
		localStorage.setItem("crust_session", JSON.stringify(alice));
		expect(loadSessions()[0]?.userId).toBe(alice.userId);
		expect(localStorage.getItem("crust:session")).toBeNull();
		release();
		await other;
		await withSessionLock(() => {});
		expect(loadSessions().map((s) => s.userId)).toEqual([
			alice.userId,
			bob.userId,
		]);
		expect(localStorage.getItem("crust_session")).toBeNull();
	} finally {
		release();
		await other;
		frame.remove();
	}
});

it("uses real WebCrypto to distinguish exact logout credentials without stashing tokens", async () => {
	await rememberLogoutSession(alice);
	const stored = sessionStorage.getItem("crust:logout-residue");
	const hashes: string[] = JSON.parse(stored ?? "[]");
	expect(hashes).toHaveLength(1);
	expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
	expect(stored).not.toContain(alice.accessToken);
	expect(
		await logoutResidue([alice, bob, { ...alice, accessToken: "rotated" }]),
	).toEqual([alice]);
});
