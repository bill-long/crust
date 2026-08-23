import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Controllable stand-in for vite-plugin-pwa's useRegisterSW: a real Solid
// signal drives needRefresh so the component reacts, and updateServiceWorker is
// a spy. The setter is surfaced on a hoisted handle so tests can toggle it.
const pwa = vi.hoisted(() => ({
	setNeedRefresh: undefined as undefined | ((v: boolean) => void),
	updateServiceWorker: vi.fn(() => Promise.resolve()),
	// A spy, so the desktop-shell tests can assert the browser registration is
	// NOT what runs there.
	useRegisterSW: vi.fn(),
}));

vi.mock("virtual:pwa-register/solid", async () => {
	const { createSignal } = await import("solid-js");
	const [needRefresh, setNeedRefresh] = createSignal(false);
	pwa.setNeedRefresh = setNeedRefresh;
	pwa.useRegisterSW.mockImplementation(() => ({
		needRefresh: [needRefresh, setNeedRefresh],
		offlineReady: [() => false, () => {}],
		updateServiceWorker: pwa.updateServiceWorker,
	}));
	return { useRegisterSW: pwa.useRegisterSW };
});

import {
	digestServiceWorkerScript,
	nativeServiceWorkerUrl,
} from "../lib/nativeServiceWorker";
import { withPathname } from "../test/withPathname";
import { UpdatePrompt } from "./UpdatePrompt";

afterEach(() => {
	cleanup();
	pwa.setNeedRefresh?.(false);
	pwa.updateServiceWorker.mockClear();
	pwa.useRegisterSW.mockClear();
});

describe("UpdatePrompt", () => {
	it("renders nothing until a new worker is waiting", () => {
		render(() => <UpdatePrompt />);
		expect(screen.queryByText("App update")).toBeNull();
	});

	it("shows the toast when needRefresh becomes true", () => {
		render(() => <UpdatePrompt />);
		pwa.setNeedRefresh?.(true);
		expect(screen.getByText("App update")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
	});

	it("refresh triggers the service-worker update", () => {
		render(() => <UpdatePrompt />);
		pwa.setNeedRefresh?.(true);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(pwa.updateServiceWorker).toHaveBeenCalledWith(true);
	});

	it("renders nothing in the overlay window", () => {
		// The overlay mounts this same App root: 320x420, transparent, over a
		// game, and click-through leaves any card visible with dead buttons.
		withPathname("/overlay", () => {
			render(() => <UpdatePrompt />);
			pwa.setNeedRefresh?.(true);
			expect(screen.queryByText("App update")).toBeNull();
		});
	});

	it("dismiss hides the toast without updating", () => {
		render(() => <UpdatePrompt />);
		pwa.setNeedRefresh?.(true);
		fireEvent.click(screen.getByRole("button", { name: "Later" }));
		expect(screen.queryByText("App update")).toBeNull();
		expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
	});
});

describe("UpdatePrompt in the desktop shell", () => {
	// Tauri marks its webviews with `window.isTauri` (see isNativeShell); jsdom
	// has no serviceWorker container, so stand one in with a register spy, and
	// answer the worker-script fetch the registration digests.
	const SW_SCRIPT = "self.addEventListener('fetch', () => {});";
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
		Reflect.deleteProperty(navigator, "serviceWorker");
		Reflect.deleteProperty(window, "isTauri");
	});

	const registered = async (): Promise<string> => {
		await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
		return register.mock.calls[0]?.[0] as string;
	};

	it("registers the native worker under its script digest, not the browser one", async () => {
		render(() => <UpdatePrompt />);
		expect(pwa.useRegisterSW).not.toHaveBeenCalled();
		const url = await registered();
		expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}sw.js`, {
			cache: "no-store",
		});
		expect(url).toBe(
			nativeServiceWorkerUrl(
				import.meta.env.BASE_URL,
				await digestServiceWorkerScript(SW_SCRIPT),
			),
		);
		expect(screen.queryByText("App update")).toBeNull();
	});

	it("registers nothing when the worker script cannot be read", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		render(() => <UpdatePrompt />);
		await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
		expect(register).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("registers nothing in dev, where no worker is built", async () => {
		vi.stubEnv("DEV", true);
		render(() => <UpdatePrompt />);
		await Promise.resolve();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
		expect(pwa.useRegisterSW).not.toHaveBeenCalled();
	});
});
