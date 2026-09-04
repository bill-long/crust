import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
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

import { withPathname } from "../test/withPathname";
import { _resetNativeUpdateForTests } from "./nativeUpdate";
import { UpdatePrompt } from "./UpdatePrompt";

afterEach(() => {
	cleanup();
	pwa.setNeedRefresh?.(false);
	pwa.updateServiceWorker.mockClear();
	pwa.useRegisterSW.mockClear();
	(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
	_resetNativeUpdateForTests();
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
	// Tauri marks its webviews with `window.isTauri` (see isNativeShell).
	beforeEach(() => {
		(window as { isTauri?: boolean }).isTauri = true;
	});
	afterEach(() => {
		Reflect.deleteProperty(window, "isTauri");
	});

	it("does not register the browser worker and shows no refresh card", () => {
		// The shell's worker is registered at bootstrap
		// (registerNativeServiceWorker), under a URL WebView2 can re-fetch;
		// useRegisterSW would register the fixed browser URL it never updates.
		render(() => <UpdatePrompt />);
		expect(pwa.useRegisterSW).not.toHaveBeenCalled();
		expect(screen.queryByText("App update")).toBeNull();
	});

	it("shows and dismisses the previous install failure", async () => {
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke: vi.fn(async (cmd: string) => {
				if (cmd === "plugin:event|listen") return 1;
				if (cmd === "pending_update_version") return null;
				if (cmd === "pending_update_install_failure") return "0.2.4";
				return undefined;
			}),
			transformCallback: () => 1,
		};

		render(() => <UpdatePrompt />);

		await waitFor(() =>
			expect(screen.getByText("Desktop update didn't install")).toBeTruthy(),
		);
		expect(screen.getByText(/Crust 0\.2\.4 did not finish/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("Desktop update didn't install")).toBeNull();
	});

	it("explains why a failed dismissal returned the warning", async () => {
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke: vi.fn(async (cmd: string) => {
				if (cmd === "plugin:event|listen") return 1;
				if (cmd === "pending_update_version") return null;
				if (cmd === "pending_update_install_failure") return "0.2.4";
				if (cmd === "dismiss_update_install_failure") {
					throw new Error("read-only data directory");
				}
				return undefined;
			}),
			transformCallback: () => 1,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});

		render(() => <UpdatePrompt />);
		await waitFor(() =>
			expect(screen.getByText("Desktop update didn't install")).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		await waitFor(() =>
			expect(screen.getByText(/Couldn't dismiss this warning/)).toBeTruthy(),
		);
	});
});
