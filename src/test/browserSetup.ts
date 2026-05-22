/**
 * Setup applied to every browser-mode test file. Filters the harmless
 * "ResizeObserver loop completed with undelivered notifications"
 * Chromium console error that virtualizers (including virtua) routinely
 * produce when a RO callback triggers another layout in the same frame.
 * The message is informational and does not represent an exception, but
 * it pollutes stderr and can mask real errors in CI logs.
 */

const RO_LOOP = /ResizeObserver loop/;

const origError = console.error;
console.error = (...args: unknown[]): void => {
	const first = args[0];
	const text =
		first instanceof Error
			? first.message
			: typeof first === "string"
				? first
				: "";
	if (RO_LOOP.test(text)) return;
	origError(...args);
};

window.addEventListener("error", (e) => {
	if (RO_LOOP.test(e.message)) {
		e.preventDefault();
		e.stopImmediatePropagation();
	}
});
