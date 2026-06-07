import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetCallOverlayForTests,
	closeOverlay,
	overlayOpen,
	requestOpenOverlay,
} from "../../../../stores/callOverlay";
import { CallOverlayController } from "./CallOverlayController";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function makeFakeWindow(): Window & { close: ReturnType<typeof vi.fn> } {
	const doc = document.implementation.createHTMLDocument("pip");
	return {
		document: doc,
		closed: false,
		innerWidth: 280,
		innerHeight: 360,
		focus: vi.fn(),
		close: vi.fn(function (this: { closed: boolean }) {
			this.closed = true;
		}),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	} as unknown as Window & { close: ReturnType<typeof vi.fn> };
}

function installPip(requestWindow: () => Promise<Window>): void {
	(
		window as unknown as { documentPictureInPicture: unknown }
	).documentPictureInPicture = { window: null, requestWindow };
}

afterEach(() => {
	cleanup();
	_resetCallOverlayForTests();
	delete (window as unknown as { documentPictureInPicture?: unknown })
		.documentPictureInPicture;
});

describe("CallOverlayController", () => {
	it("opens a PiP window, renders into it, and reflects open state", async () => {
		const win = makeFakeWindow();
		installPip(() => Promise.resolve(win));
		render(() => <CallOverlayController />);

		requestOpenOverlay();
		await flush();

		expect(overlayOpen()).toBe(true);
		// The panel was rendered into the PiP document body.
		expect(win.document.body.childNodes.length).toBeGreaterThan(0);
		expect(win.document.title).toBe("Crust — Voice");
	});

	it("closes the window and resets state on closeOverlay()", async () => {
		const win = makeFakeWindow();
		installPip(() => Promise.resolve(win));
		render(() => <CallOverlayController />);

		requestOpenOverlay();
		await flush();
		closeOverlay();

		expect(win.close).toHaveBeenCalledTimes(1);
		expect(overlayOpen()).toBe(false);
	});

	it("discards a window that resolves after the controller unmounts", async () => {
		const win = makeFakeWindow();
		const d = deferred<Window>();
		installPip(() => d.promise);
		render(() => <CallOverlayController />);

		requestOpenOverlay(); // requestWindow now in flight
		cleanup(); // call ended → controller unmounts before resolution
		d.resolve(win); // late resolution
		await flush();

		// The orphaned window is closed, never rendered into, and state stays
		// closed (no stale overlay survives a call switch).
		expect(win.close).toHaveBeenCalledTimes(1);
		expect(win.document.body.childNodes.length).toBe(0);
		expect(overlayOpen()).toBe(false);
	});

	it("ignores re-entrant open requests while one is in flight", async () => {
		const requestWindow = vi.fn(() => new Promise<Window>(() => {}));
		installPip(requestWindow);
		render(() => <CallOverlayController />);

		requestOpenOverlay();
		requestOpenOverlay();
		await flush();

		expect(requestWindow).toHaveBeenCalledTimes(1);
	});

	it("closes the window and stays closed if setup throws after open", async () => {
		const win = makeFakeWindow();
		// Simulate a failure during post-open setup (e.g. listener wiring).
		(win as unknown as { addEventListener: () => void }).addEventListener =
			vi.fn(() => {
				throw new Error("boom");
			});
		installPip(() => Promise.resolve(win));
		render(() => <CallOverlayController />);

		requestOpenOverlay();
		await flush();

		// The orphaned window is closed and state is reset, not leaked.
		expect(win.close).toHaveBeenCalledTimes(1);
		expect(overlayOpen()).toBe(false);
	});
});
