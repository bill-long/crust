import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeTauri, listenTauri, tauriIpcAvailable } from "./tauri";

interface TauriWindow extends Window {
	__TAURI_INTERNALS__?: {
		invoke?: unknown;
		transformCallback?: unknown;
	};
	__TAURI__?: {
		core?: {
			invoke?: unknown;
		};
	};
}

const tauriWindow = window as TauriWindow;

afterEach(() => {
	delete tauriWindow.__TAURI_INTERNALS__;
	delete tauriWindow.__TAURI__;
	vi.restoreAllMocks();
});

describe("tauriIpcAvailable", () => {
	it("is false when neither Tauri invoke global is callable", () => {
		expect(tauriIpcAvailable()).toBe(false);

		tauriWindow.__TAURI_INTERNALS__ = { invoke: "not a function" };
		tauriWindow.__TAURI__ = { core: { invoke: 42 } };
		expect(tauriIpcAvailable()).toBe(false);
	});

	it("recognizes both the internals and higher-level invoke globals", () => {
		tauriWindow.__TAURI_INTERNALS__ = { invoke: vi.fn() };
		expect(tauriIpcAvailable()).toBe(true);

		delete tauriWindow.__TAURI_INTERNALS__;
		tauriWindow.__TAURI__ = { core: { invoke: vi.fn() } };
		expect(tauriIpcAvailable()).toBe(true);
	});
});

describe("invokeTauri", () => {
	it("prefers the internals invoke and forwards command arguments and results", async () => {
		const internalsInvoke = vi.fn(async () => ({ open: true }));
		const globalInvoke = vi.fn(async () => ({ open: false }));
		tauriWindow.__TAURI_INTERNALS__ = { invoke: internalsInvoke };
		tauriWindow.__TAURI__ = { core: { invoke: globalInvoke } };

		const result = await invokeTauri<{ open: boolean }>("overlay_state", {
			roomId: "!room:example.org",
		});

		expect(result).toEqual({ open: true });
		expect(internalsInvoke).toHaveBeenCalledWith("overlay_state", {
			roomId: "!room:example.org",
		});
		expect(globalInvoke).not.toHaveBeenCalled();
	});

	it("falls back to the higher-level global and is a no-op without IPC", async () => {
		const globalInvoke = vi.fn(async () => "fallback result");
		tauriWindow.__TAURI__ = { core: { invoke: globalInvoke } };

		expect(await invokeTauri<string>("fallback")).toBe("fallback result");
		expect(globalInvoke).toHaveBeenCalledWith("fallback", undefined);

		delete tauriWindow.__TAURI__;
		expect(await invokeTauri("plain_browser")).toBeUndefined();
	});
});

describe("listenTauri", () => {
	it("returns a safe no-op unless both internals functions exist", async () => {
		const invoke = vi.fn();
		tauriWindow.__TAURI_INTERNALS__ = { invoke };

		const withoutTransform = await listenTauri("event", vi.fn());
		expect(() => withoutTransform()).not.toThrow();
		expect(invoke).not.toHaveBeenCalled();

		tauriWindow.__TAURI_INTERNALS__ = {
			transformCallback: vi.fn(),
		};
		const withoutInvoke = await listenTauri("event", vi.fn());
		expect(() => withoutInvoke()).not.toThrow();
	});

	it("registers an any-window listener, forwards payloads, and unsubscribes", async () => {
		let callback: ((payload: unknown) => void) | undefined;
		const transformCallback = vi.fn((value: (payload: unknown) => void) => {
			callback = value;
			return 41;
		});
		const invoke = vi.fn(async (cmd: string) => {
			if (cmd === "plugin:event|listen") return 73;
			return undefined;
		});
		tauriWindow.__TAURI_INTERNALS__ = { invoke, transformCallback };
		const handler = vi.fn();

		const unlisten = await listenTauri<string>("crust://ready", handler);

		expect(invoke).toHaveBeenCalledWith("plugin:event|listen", {
			event: "crust://ready",
			target: { kind: "Any" },
			handler: 41,
		});
		callback?.({ payload: "version-1" });
		expect(handler).toHaveBeenCalledWith("version-1");

		unlisten();
		expect(invoke).toHaveBeenCalledWith("plugin:event|unlisten", {
			event: "crust://ready",
			eventId: 73,
		});
	});
});
