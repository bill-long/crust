import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetNativeUpdateForTests,
	dismissNativeUpdate,
	pendingUpdateVersion,
	restartForUpdate,
	watchNativeUpdates,
} from "./nativeUpdate";

type Handler = (payload: unknown) => void;

/**
 * Stand in for the Tauri internals `listenTauri`/`invokeTauri` reach for, and
 * capture the handler registered for an event so a test can fire it.
 */
function installTauri(): {
	invoke: ReturnType<typeof vi.fn>;
	fire: (event: string, payload: unknown) => void;
} {
	const handlers = new Map<string, Handler>();
	let nextCallbackId = 0;
	const callbacks = new Map<number, Handler>();

	const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "plugin:event|listen") {
			const { event, handler } = args as { event: string; handler: number };
			const cb = callbacks.get(handler);
			if (cb) handlers.set(event, cb);
			return 1;
		}
		return undefined;
	});

	(window as { isTauri?: boolean }).isTauri = true;
	(
		window as {
			__TAURI_INTERNALS__?: unknown;
		}
	).__TAURI_INTERNALS__ = {
		invoke,
		transformCallback: (cb: Handler) => {
			nextCallbackId += 1;
			callbacks.set(nextCallbackId, cb);
			return nextCallbackId;
		},
	};

	return {
		invoke,
		fire: (event, payload) => handlers.get(event)?.({ payload }),
	};
}

describe("nativeUpdate", () => {
	afterEach(() => {
		(window as { isTauri?: boolean }).isTauri = undefined;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
			undefined;
		_resetNativeUpdateForTests();
		vi.restoreAllMocks();
	});

	it("surfaces the version from a staged-update event", async () => {
		const { fire } = installTauri();
		await watchNativeUpdates();
		expect(pendingUpdateVersion()).toBeNull();

		fire("crust://update-ready", "0.1.1");
		expect(pendingUpdateVersion()).toBe("0.1.1");
	});

	it("dismissing clears the prompt without cancelling the update", async () => {
		const { fire, invoke } = installTauri();
		await watchNativeUpdates();
		fire("crust://update-ready", "0.1.1");

		dismissNativeUpdate();

		expect(pendingUpdateVersion()).toBeNull();
		// Dismissal is display-only: nothing is sent to the shell, so the staged
		// update still installs when the app exits.
		expect(invoke).not.toHaveBeenCalledWith(
			"restart_for_update",
			expect.anything(),
		);
	});

	it("restarting asks the shell to exit, which applies the update", async () => {
		const { invoke } = installTauri();
		await restartForUpdate();
		expect(invoke).toHaveBeenCalledWith("restart_for_update", undefined);
	});

	it("does nothing outside the native shell", async () => {
		// No isTauri, no internals: a plain browser tab.
		const unlisten = await watchNativeUpdates();
		await restartForUpdate();
		expect(pendingUpdateVersion()).toBeNull();
		expect(() => unlisten()).not.toThrow();
	});
});
