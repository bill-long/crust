import type { CrossSigningStatus } from "matrix-js-sdk/lib/crypto-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requiredAt } from "../../../test/assertions";
import {
	verifySessionWithRecoveryKey,
	waitForDevicesUpdated,
} from "./verifyWithRecoveryKey";

type Crypto = Parameters<typeof verifySessionWithRecoveryKey>[0];

function makeCrypto(
	overrides: Partial<{
		inSecretStorage: boolean;
		cachedLocally: boolean;
	}> = {},
) {
	const cached = overrides.cachedLocally ?? false;
	const status: CrossSigningStatus = {
		publicKeysOnDevice: true,
		privateKeysInSecretStorage: overrides.inSecretStorage ?? true,
		privateKeysCachedLocally: {
			masterKey: cached,
			selfSigningKey: cached,
			userSigningKey: cached,
		},
	};
	const crypto = {
		getCrossSigningStatus: vi.fn(async () => status),
		bootstrapCrossSigning: vi.fn(
			async (_opts?: Parameters<Crypto["bootstrapCrossSigning"]>[0]) => {},
		),
		crossSignDevice: vi.fn(async () => {}),
	};
	return crypto as unknown as Crypto & typeof crypto;
}

describe("verifySessionWithRecoveryKey", () => {
	it("imports the keys via bootstrap, which signs the device itself", async () => {
		// Keys in secret storage only: bootstrap's import path signs the
		// device, so a second signature upload would be redundant.
		const crypto = makeCrypto();
		await verifySessionWithRecoveryKey(crypto, "DEV");
		expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(1);
		expect(crypto.crossSignDevice).not.toHaveBeenCalled();
	});

	it("signs the device explicitly when the keys were already cached locally", async () => {
		// Bootstrap's "nothing to do" path skips the device signature, so the
		// helper must sign rather than report a verification that did not
		// happen.
		const crypto = makeCrypto({ cachedLocally: true });
		await verifySessionWithRecoveryKey(crypto, "DEV");
		expect(crypto.crossSignDevice).toHaveBeenCalledWith("DEV");
	});

	it("refuses to run when the keys are not in secret storage", async () => {
		// Bootstrap would otherwise create a NEW identity and orphan every
		// other session.
		const crypto = makeCrypto({ inSecretStorage: false });
		await expect(verifySessionWithRecoveryKey(crypto, "DEV")).rejects.toThrow(
			/not in secret storage/,
		);
		expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
		expect(crypto.crossSignDevice).not.toHaveBeenCalled();
	});

	it("hands bootstrap an upload callback that refuses to publish a new identity", async () => {
		const crypto = makeCrypto();
		await verifySessionWithRecoveryKey(crypto, "DEV");
		const opts = requiredAt(
			requiredAt(crypto.bootstrapCrossSigning.mock.calls, 0, "bootstrap call"),
			0,
			"bootstrap options",
		);
		await expect(
			opts?.authUploadDeviceSigningKeys?.(async () => {}),
		).rejects.toThrow(/Refusing to replace/);
	});

	it("propagates a failed import (cancelled or wrong recovery key)", async () => {
		const crypto = makeCrypto();
		crypto.bootstrapCrossSigning.mockRejectedValueOnce(
			new Error("getSecretStorageKey callback returned falsey"),
		);
		await expect(verifySessionWithRecoveryKey(crypto, "DEV")).rejects.toThrow(
			/falsey/,
		);
		expect(crypto.crossSignDevice).not.toHaveBeenCalled();
	});
});

describe("waitForDevicesUpdated", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	type Listener = (users: string[]) => void;
	function makeEmitter() {
		const listeners = new Map<string, Set<Listener>>();
		return {
			on: vi.fn((event: string, fn: Listener) => {
				if (!listeners.has(event)) listeners.set(event, new Set());
				listeners.get(event)?.add(fn);
			}),
			removeListener: vi.fn((event: string, fn: Listener) => {
				listeners.get(event)?.delete(fn);
			}),
			emit(event: string, users: string[]) {
				for (const fn of [...(listeners.get(event) ?? [])]) fn(users);
			},
			count(event: string) {
				return listeners.get(event)?.size ?? 0;
			},
		};
	}
	const asClient = (c: ReturnType<typeof makeEmitter>) =>
		c as unknown as Parameters<typeof waitForDevicesUpdated>[0];

	it("resolves on a DevicesUpdated for our user and detaches", async () => {
		vi.useFakeTimers();
		const client = makeEmitter();
		const p = waitForDevicesUpdated(asClient(client), "@me:hs", 5000);
		client.emit("crypto.devicesUpdated", ["@me:hs"]);
		await p;
		expect(client.count("crypto.devicesUpdated")).toBe(0);
	});

	it("ignores updates for other users", async () => {
		// Another user's query must not release the wait before our own
		// signature is visible.
		vi.useFakeTimers();
		const client = makeEmitter();
		let settled = false;
		const p = waitForDevicesUpdated(asClient(client), "@me:hs", 5000).then(
			() => {
				settled = true;
			},
		);
		client.emit("crypto.devicesUpdated", ["@other:hs"]);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(client.count("crypto.devicesUpdated")).toBe(1);
		client.emit("crypto.devicesUpdated", ["@other:hs", "@me:hs"]);
		await p;
		expect(settled).toBe(true);
	});

	it("resolves on timeout and detaches, so the caller never hangs", async () => {
		// The status hook re-runs on the same event, so a late query still
		// heals the card; the wait only exists to avoid a premature "done".
		vi.useFakeTimers();
		const client = makeEmitter();
		const p = waitForDevicesUpdated(asClient(client), "@me:hs", 5000);
		vi.advanceTimersByTime(5000);
		await p;
		expect(client.count("crypto.devicesUpdated")).toBe(0);
	});
});
