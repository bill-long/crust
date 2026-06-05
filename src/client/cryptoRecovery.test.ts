import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CRYPTO_DB_PREFIX,
	CRYPTO_RECOVERY_KEY,
	type CryptoInitDeps,
	type CryptoRecoveryStage,
	clearCryptoStores,
	clearRecoveryStage,
	initCryptoStore,
	nextCryptoRecoveryStage,
	persistRecoveryStage,
	readRecoveryStage,
	recoveryIdentity,
	runCryptoInit,
	shouldClearStoreBeforeInit,
	withTimeout,
} from "./cryptoRecovery";

const ID_A = recoveryIdentity({
	homeserverUrl: "https://strange.pizza",
	userId: "@amon:strange.pizza",
	deviceId: "DEVICE_A",
});
const ID_B = recoveryIdentity({
	homeserverUrl: "https://strange.pizza",
	userId: "@test:strange.pizza",
	deviceId: "DEVICE_B",
});

describe("crypto store helpers", () => {
	it("uses a non-default prefix to avoid colliding with co-hosted apps", () => {
		expect(CRYPTO_DB_PREFIX).toBe("crust");
		expect(CRYPTO_DB_PREFIX).not.toBe("matrix-js-sdk");
	});

	it("initCryptoStore initializes with indexeddb + the Crust prefix", async () => {
		const initRustCrypto = vi.fn(() => Promise.resolve());
		await initCryptoStore({ initRustCrypto });
		expect(initRustCrypto).toHaveBeenCalledWith({
			useIndexedDB: true,
			cryptoDatabasePrefix: CRYPTO_DB_PREFIX,
		});
	});

	it("clearCryptoStores scopes the wipe to the Crust prefix", async () => {
		const clearStores = vi.fn(() => Promise.resolve());
		await clearCryptoStores({ clearStores });
		expect(clearStores).toHaveBeenCalledWith({
			cryptoDatabasePrefix: CRYPTO_DB_PREFIX,
		});
	});
});

describe("recoveryIdentity", () => {
	it("is stable and distinguishes users/devices/homeservers", () => {
		expect(ID_A).toBe(ID_A);
		expect(ID_A).not.toBe(ID_B);
		expect(
			recoveryIdentity({
				homeserverUrl: "https://other.example",
				userId: "@amon:strange.pizza",
				deviceId: "DEVICE_A",
			}),
		).not.toBe(ID_A);
	});
});

describe("nextCryptoRecoveryStage", () => {
	it("escalates null -> reload -> clear -> give-up", () => {
		expect(nextCryptoRecoveryStage(null)).toBe("reload");
		expect(nextCryptoRecoveryStage("reload")).toBe("clear");
		expect(nextCryptoRecoveryStage("clear")).toBe("give-up");
	});
});

describe("shouldClearStoreBeforeInit", () => {
	it("only clears once the stage has escalated to 'clear'", () => {
		expect(shouldClearStoreBeforeInit(null)).toBe(false);
		expect(shouldClearStoreBeforeInit("reload")).toBe(false);
		expect(shouldClearStoreBeforeInit("clear")).toBe(true);
	});
});

describe("recovery stage persistence", () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it("round-trips reload and clear stages for an identity", () => {
		expect(readRecoveryStage(ID_A)).toBeNull();

		expect(persistRecoveryStage("reload", ID_A)).toBe(true);
		expect(readRecoveryStage(ID_A)).toBe("reload");

		expect(persistRecoveryStage("clear", ID_A)).toBe(true);
		expect(readRecoveryStage(ID_A)).toBe("clear");

		clearRecoveryStage();
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("ignores a stage persisted for a different identity", () => {
		expect(persistRecoveryStage("clear", ID_A)).toBe(true);
		// A different account logged in to the same tab must not inherit the
		// destructive "clear" stage.
		expect(readRecoveryStage(ID_B)).toBeNull();
		expect(readRecoveryStage(ID_A)).toBe("clear");
	});

	it("treats malformed persisted values as null", () => {
		sessionStorage.setItem(CRYPTO_RECOVERY_KEY, "not json");
		expect(readRecoveryStage(ID_A)).toBeNull();

		sessionStorage.setItem(
			CRYPTO_RECOVERY_KEY,
			JSON.stringify({ stage: "bogus", id: ID_A }),
		);
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("reports failure when storage throws and never loops", () => {
		const spy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("storage unavailable");
			});
		try {
			expect(persistRecoveryStage("reload", ID_A)).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("reads as null when storage throws", () => {
		const spy = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("storage unavailable");
			});
		try {
			expect(readRecoveryStage(ID_A)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

describe("staged recovery flow", () => {
	// Mirrors the bounded escalation: a failure can never loop because the
	// stage always advances toward "give-up".
	it("terminates after at most two reloads", () => {
		let stage: CryptoRecoveryStage = null;
		const actions: string[] = [];
		for (let i = 0; i < 5; i++) {
			const next = nextCryptoRecoveryStage(stage);
			actions.push(next);
			if (next === "give-up") break;
			stage = next;
		}
		expect(actions).toEqual(["reload", "clear", "give-up"]);
	});
});

describe("withTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves when the promise settles before the timeout", async () => {
		const result = withTimeout(Promise.resolve("ok"), 1000, "op");
		await expect(result).resolves.toBe("ok");
	});

	it("rejects with the original error when the promise rejects", async () => {
		const result = withTimeout(Promise.reject(new Error("boom")), 1000, "op");
		await expect(result).rejects.toThrow("boom");
	});

	it("rejects with a timeout error when the promise hangs", async () => {
		const result = withTimeout(new Promise<never>(() => {}), 1000, "crypto");
		const assertion = expect(result).rejects.toThrow(
			"crypto timed out after 1000ms",
		);
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
	});

	it("does not reject after the promise already resolved", async () => {
		const result = withTimeout(Promise.resolve("done"), 1000, "op");
		await expect(result).resolves.toBe("done");
		// Advancing past the timeout must not produce a late rejection.
		await vi.advanceTimersByTimeAsync(2000);
	});
});

describe("runCryptoInit", () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	interface Harness {
		deps: CryptoInitDeps;
		reload: ReturnType<typeof vi.fn>;
		clearStores: ReturnType<typeof vi.fn>;
		initCrypto: ReturnType<typeof vi.fn>;
	}

	function harness(overrides: Partial<CryptoInitDeps> = {}): Harness {
		const reload = vi.fn();
		const clearStores = vi.fn(() => Promise.resolve());
		const initCrypto = vi.fn(() => Promise.resolve());
		const deps: CryptoInitDeps = {
			identity: ID_A,
			readStage: readRecoveryStage,
			persistStage: persistRecoveryStage,
			clearStage: clearRecoveryStage,
			clearStores,
			initCrypto,
			isAborted: () => false,
			reload,
			timeoutMs: 1000,
			logger: { warn: vi.fn(), error: vi.fn() },
			...overrides,
		};
		return { deps, reload, clearStores, initCrypto };
	}

	it("returns 'ready' and clears the stage on success", async () => {
		const h = harness();
		await expect(runCryptoInit(h.deps)).resolves.toBe("ready");
		expect(h.reload).not.toHaveBeenCalled();
		expect(h.clearStores).not.toHaveBeenCalled();
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("reloads and persists 'reload' on first failure", async () => {
		const h = harness({
			initCrypto: vi.fn(() => Promise.reject(new Error("init failed"))),
		});
		await expect(runCryptoInit(h.deps)).resolves.toBe("reloading");
		expect(h.reload).toHaveBeenCalledOnce();
		expect(readRecoveryStage(ID_A)).toBe("reload");
	});

	it("escalates 'reload' -> 'clear' and reloads on a second failure", async () => {
		persistRecoveryStage("reload", ID_A);
		const h = harness({
			initCrypto: vi.fn(() => Promise.reject(new Error("init failed"))),
		});
		await expect(runCryptoInit(h.deps)).resolves.toBe("reloading");
		expect(h.reload).toHaveBeenCalledOnce();
		expect(readRecoveryStage(ID_A)).toBe("clear");
	});

	it("wipes the store before init when staged 'clear'", async () => {
		persistRecoveryStage("clear", ID_A);
		const order: string[] = [];
		const h = harness({
			clearStores: vi.fn(() => {
				order.push("clear");
				return Promise.resolve();
			}),
			initCrypto: vi.fn(() => {
				order.push("init");
				return Promise.resolve();
			}),
		});
		await expect(runCryptoInit(h.deps)).resolves.toBe("ready");
		expect(order).toEqual(["clear", "init"]);
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("gives up with 'error' when init fails at the 'clear' stage", async () => {
		persistRecoveryStage("clear", ID_A);
		const h = harness({
			initCrypto: vi.fn(() => Promise.reject(new Error("still broken"))),
		});
		await expect(runCryptoInit(h.deps)).resolves.toBe("error");
		expect(h.reload).not.toHaveBeenCalled();
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("returns 'aborted' before init when disposed during the 'clear' wipe", async () => {
		// Guards the abort check after clearStores resolves: a disposal during
		// the wipe must skip init and clear the stage.
		persistRecoveryStage("clear", ID_A);
		const initCrypto = vi.fn(() => Promise.resolve());
		const h = harness({ initCrypto, isAborted: () => true });
		await expect(runCryptoInit(h.deps)).resolves.toBe("aborted");
		expect(h.clearStores).toHaveBeenCalledOnce();
		expect(initCrypto).not.toHaveBeenCalled();
		expect(h.reload).not.toHaveBeenCalled();
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("gives up with 'error' (no reload loop) when storage is unavailable", async () => {
		const h = harness({
			initCrypto: vi.fn(() => Promise.reject(new Error("init failed"))),
			persistStage: () => false,
		});
		await expect(runCryptoInit(h.deps)).resolves.toBe("error");
		expect(h.reload).not.toHaveBeenCalled();
	});

	it("returns 'aborted' and clears the stage when disposed mid-init", async () => {
		// A prior failed attempt left a stage; init then succeeds but the
		// provider is disposed during the await. The stage must be cleared so
		// the next same-identity login is not biased toward a premature wipe.
		persistRecoveryStage("reload", ID_A);
		const h = harness({ isAborted: () => true });
		await expect(runCryptoInit(h.deps)).resolves.toBe("aborted");
		expect(h.reload).not.toHaveBeenCalled();
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("returns 'aborted' (no reload) when init fails after disposal", async () => {
		// Guards the top-of-catch abort check: a logout/disposal coinciding
		// with a FAILING init must not persist a stage or reload a torn-down
		// session.
		persistRecoveryStage("reload", ID_A);
		const h = harness({
			initCrypto: vi.fn(() => Promise.reject(new Error("init failed"))),
			isAborted: () => true,
		});
		await expect(runCryptoInit(h.deps)).resolves.toBe("aborted");
		expect(h.reload).not.toHaveBeenCalled();
		expect(readRecoveryStage(ID_A)).toBeNull();
	});

	it("treats a hung init as a failure and reloads", async () => {
		vi.useFakeTimers();
		try {
			const h = harness({
				initCrypto: vi.fn(() => new Promise<void>(() => {})),
			});
			const result = runCryptoInit(h.deps);
			await vi.advanceTimersByTimeAsync(1000);
			await expect(result).resolves.toBe("reloading");
			expect(readRecoveryStage(ID_A)).toBe("reload");
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives up with 'error' when clearStores hangs at the 'clear' stage", async () => {
		vi.useFakeTimers();
		try {
			persistRecoveryStage("clear", ID_A);
			const initCrypto = vi.fn(() => Promise.resolve());
			const h = harness({
				clearStores: vi.fn(() => new Promise<void>(() => {})),
				initCrypto,
			});
			const result = runCryptoInit(h.deps);
			await vi.advanceTimersByTimeAsync(1000);
			await expect(result).resolves.toBe("error");
			expect(initCrypto).not.toHaveBeenCalled();
			expect(h.reload).not.toHaveBeenCalled();
			expect(readRecoveryStage(ID_A)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
