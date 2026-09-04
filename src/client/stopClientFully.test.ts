import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopClientFully } from "./stopClientFully";

function makeClient(stopClient: () => void) {
	return {
		clientRunning: true,
		stopClient: vi.fn(stopClient),
	};
}

describe("stopClientFully (#551)", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops once when the SDK stop succeeds", () => {
		const client = makeClient(function (this: { clientRunning: boolean }) {
			this.clientRunning = false;
		});

		stopClientFully(client as unknown as MatrixClient);

		expect(client.stopClient).toHaveBeenCalledOnce();
		expect(client.clientRunning).toBe(false);
	});

	it("retries when the crypto stop throws, so the flag is really cleared", () => {
		// `stopClient` runs the crypto backend's stop BEFORE it clears
		// `clientRunning`; `RustCrypto.stop()` sets its own `stopped` flag before
		// the call that can throw, so the second attempt gets past it.
		let attempts = 0;
		const client = makeClient(function (this: { clientRunning: boolean }) {
			attempts += 1;
			if (attempts === 1) throw new Error("crypto backend stop failed");
			this.clientRunning = false;
		});

		stopClientFully(client as unknown as MatrixClient);

		expect(client.stopClient).toHaveBeenCalledTimes(2);
		expect(client.clientRunning).toBe(false);
	});

	it("clears the flag itself when the client refuses to stop twice", () => {
		// A flag left set fails every later wipe (`clearStores` throws on it),
		// which is worse than the sync loop it would otherwise keep stoppable.
		const client = makeClient(() => {
			throw new Error("refuses to stop");
		});

		expect(() =>
			stopClientFully(client as unknown as MatrixClient),
		).not.toThrow();

		expect(client.stopClient).toHaveBeenCalledTimes(2);
		expect(client.clientRunning).toBe(false);
	});
});
