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
function installTauri(staged: string | null = null): {
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
		if (cmd === "pending_update_version") return staged;
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
	it("picks up an update staged before the webview mounted", async () => {
		// The shell checks during startup, so the download can finish before any
		// listener exists and the event is dropped; the mount-time query is the
		// only thing that surfaces it.
		installTauri("0.2.0");
		await watchNativeUpdates();
		expect(pendingUpdateVersion()).toBe("0.2.0");
	});

	it("stays silent in the overlay window", async () => {
		const { fire, invoke } = installTauri("0.2.0");
		const pathname = window.location.pathname;
		Object.defineProperty(window, "location", {
			value: { ...window.location, pathname: "/overlay" },
			writable: true,
			configurable: true,
		});
		try {
			await watchNativeUpdates();
			fire("crust://update-ready", "0.2.0");
			// The overlay is a transparent click-through window over a game; a
			// card there would be undismissable at best.
			expect(pendingUpdateVersion()).toBeNull();
			expect(invoke).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(window, "location", {
				value: { ...window.location, pathname },
				writable: true,
				configurable: true,
			});
		}
	});

	it("survives a failed subscription without an unhandled rejection", async () => {
		(window as { isTauri?: boolean }).isTauri = true;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke: vi.fn().mockRejectedValue(new Error("ipc denied")),
			transformCallback: () => 1,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		const unlisten = await watchNativeUpdates();
		expect(pendingUpdateVersion()).toBeNull();
		expect(() => unlisten()).not.toThrow();
	});
	it("unsubscribes when the staged-version query fails", async () => {
		// The query runs after the listener is live, so a failure there must not
		// leave the subscription behind for the life of the webview.
		(window as { isTauri?: boolean }).isTauri = true;
		const invoke = vi.fn(async (cmd: string) => {
			if (cmd === "plugin:event|listen") return 1;
			if (cmd === "pending_update_version") throw new Error("boom");
			return undefined;
		});
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke,
			transformCallback: () => 1,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});

		await watchNativeUpdates();

		expect(invoke).toHaveBeenCalledWith(
			"plugin:event|unlisten",
			expect.objectContaining({ event: "crust://update-ready" }),
		);
	});
});
