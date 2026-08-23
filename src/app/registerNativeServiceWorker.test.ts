import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	digestServiceWorkerScript,
	nativeServiceWorkerUrl,
} from "../lib/nativeServiceWorker";
import { registerNativeServiceWorker } from "./registerNativeServiceWorker";

// Tauri marks its webviews with `window.isTauri` (see isNativeShell); jsdom has
// no serviceWorker container, so stand one in with a register spy, and answer
// the worker-script fetch the registration digests.
const SW_SCRIPT = "self.addEventListener('fetch', () => {});";

describe("registerNativeServiceWorker", () => {
	let register: ReturnType<typeof vi.fn>;
	let fetchMock: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		(window as { isTauri?: boolean }).isTauri = true;
		register = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "serviceWorker", {
			value: { register },
			configurable: true,
		});
		fetchMock = vi.fn(() => Promise.resolve(new Response(SW_SCRIPT)));
		vi.stubGlobal("fetch", fetchMock);
		// The worker only exists in production builds; registration is gated on
		// that and vitest runs with DEV on.
		vi.stubEnv("DEV", false);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		Reflect.deleteProperty(navigator, "serviceWorker");
		Reflect.deleteProperty(window, "isTauri");
	});

	it("registers the worker under a digest of the script the exe serves", async () => {
		await registerNativeServiceWorker();
		expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}sw.js`, {
			cache: "no-store",
		});
		expect(register).toHaveBeenCalledOnce();
		expect(register.mock.calls[0]?.[0]).toBe(
			nativeServiceWorkerUrl(
				import.meta.env.BASE_URL,
				await digestServiceWorkerScript(SW_SCRIPT),
			),
		);
	});

	it("logs and registers nothing when the worker script cannot be read", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await registerNativeServiceWorker();
		expect(register).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			"Desktop service worker registration failed:",
			expect.any(Error),
		);
	});

	it("does nothing outside the desktop shell", async () => {
		Reflect.deleteProperty(window, "isTauri");
		await registerNativeServiceWorker();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
	});

	it("does nothing in dev, where no worker is built", async () => {
		vi.stubEnv("DEV", true);
		await registerNativeServiceWorker();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
	});
});
