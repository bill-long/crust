/**
 * Stub a fixed (or dynamic) element height for windowing tests: jsdom has
 * no layout engine (clientHeight is always 0 and ResizeObserver may be
 * absent), so tests exercising VirtualList's scroll window patch a
 * viewport in. Pass a getter for tests that grow the viewport mid-test
 * (the popover-lays-out-late case) and fire `triggerStubbedResize` to
 * deliver the change to observers.
 *
 * Returns the restore function; call it in afterEach. Shared by the
 * VirtualList and Picker suites so a jsdom workaround or leak fix lands in
 * one place - this is a global HTMLElement.prototype monkeypatch, and a
 * missed restore would leak into the rest of the suite.
 */

const resizeCallbacks: Array<() => void> = [];
let stubbedObserverInstalls = 0;

/**
 * Invoke every ResizeObserver created while the stub was active. Throws
 * when no stubbed ResizeObserver is installed (a real one already existed,
 * e.g. browser-mode vitest, or stubViewport wasn't called) - a silent
 * no-op there would fail the caller's assertions for an opaque reason.
 */
export function triggerStubbedResize(): void {
	if (stubbedObserverInstalls === 0) {
		throw new Error(
			"triggerStubbedResize: no stubbed ResizeObserver installed - the environment has a real ResizeObserver (resize it for real) or stubViewport was not called",
		);
	}
	for (const cb of [...resizeCallbacks]) cb();
}

export function stubViewport(height: number | (() => number)): () => void {
	const restore: Array<() => void> = [];
	const desc = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"clientHeight",
	);
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => (typeof height === "function" ? height() : height),
	});
	restore.push(() => {
		if (desc) {
			Object.defineProperty(HTMLElement.prototype, "clientHeight", desc);
		} else {
			delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
		}
	});
	const g = globalThis as { ResizeObserver?: unknown };
	if (typeof g.ResizeObserver === "undefined") {
		g.ResizeObserver = class {
			constructor(cb: ResizeObserverCallback) {
				resizeCallbacks.push(() => cb([], this as unknown as ResizeObserver));
			}
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
		stubbedObserverInstalls++;
		restore.push(() => {
			stubbedObserverInstalls--;
			resizeCallbacks.length = 0;
			delete g.ResizeObserver;
		});
	}
	return () => {
		for (const f of restore.splice(0)) f();
	};
}
