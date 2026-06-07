import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("virtual:pwa-register/solid", async () => {
	const { createSignal } = await import("solid-js");
	const [needRefresh, setNeedRefresh] = createSignal(false);
	pwa.setNeedRefresh = setNeedRefresh;
	return {
		useRegisterSW: () => ({
			needRefresh: [needRefresh, setNeedRefresh],
			offlineReady: [() => false, () => {}],
			updateServiceWorker: pwa.updateServiceWorker,
		}),
	};
});

import { UpdatePrompt } from "./UpdatePrompt";

afterEach(() => {
	cleanup();
	pwa.setNeedRefresh?.(false);
	pwa.updateServiceWorker.mockClear();
});

describe("UpdatePrompt", () => {
	it("renders nothing until a new worker is waiting", () => {
		render(() => <UpdatePrompt />);
		expect(screen.queryByText("Update available")).toBeNull();
	});

	it("shows the toast when needRefresh becomes true", () => {
		render(() => <UpdatePrompt />);
		pwa.setNeedRefresh?.(true);
		expect(screen.getByText("Update available")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
	});

	it("refresh triggers the service-worker update", () => {
		render(() => <UpdatePrompt />);
		pwa.setNeedRefresh?.(true);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(pwa.updateServiceWorker).toHaveBeenCalledWith(true);
	});

	it("dismiss hides the toast without updating", () => {
		render(() => <UpdatePrompt />);
		pwa.setNeedRefresh?.(true);
		fireEvent.click(screen.getByRole("button", { name: "Later" }));
		expect(screen.queryByText("Update available")).toBeNull();
		expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
	});
});
