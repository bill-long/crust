/**
 * Stub a fixed element height for windowing tests: jsdom has no layout
 * engine (clientHeight is always 0 and ResizeObserver may be absent), so
 * tests exercising VirtualList's scroll window patch a viewport in.
 *
 * Returns the restore function; call it in afterEach. Shared by the
 * VirtualList and Picker suites so a jsdom workaround or leak fix lands in
 * one place - this is a global HTMLElement.prototype monkeypatch, and a
 * missed restore would leak into the rest of the suite.
 */
export function stubViewport(heightPx: number): () => void {
	const restore: Array<() => void> = [];
	const desc = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"clientHeight",
	);
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => heightPx,
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
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
		restore.push(() => {
			delete g.ResizeObserver;
		});
	}
	return () => {
		for (const f of restore.splice(0)) f();
	};
}
