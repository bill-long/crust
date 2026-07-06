import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cryptoDialogOpen,
	registerCryptoHandler,
	restoreCryptoTriggerFocus,
	setCryptoDialogOpen,
	setCryptoTriggerElement,
	triggerCryptoAction,
} from "./cryptoActions";

// The store is a module-level singleton; reset the shared state between tests.
afterEach(() => {
	// Clear any registered handler (register-then-unregister sets it back to null
	// since the unregister only fires while it is still the current handler).
	registerCryptoHandler(() => {})();
	setCryptoTriggerElement(null);
	setCryptoDialogOpen(false);
	document.body.replaceChildren();
});

/** Attach a focusable element to the document and return it. */
function attachInput(): HTMLInputElement {
	const el = document.createElement("input");
	document.body.appendChild(el);
	return el;
}

describe("crypto action handler", () => {
	it("invokes the registered handler with the action", () => {
		const handler = vi.fn();
		registerCryptoHandler(handler);
		triggerCryptoAction("verify-session");
		expect(handler).toHaveBeenCalledWith("verify-session");
	});

	it("stops invoking the handler after it is unregistered", () => {
		const handler = vi.fn();
		const unregister = registerCryptoHandler(handler);
		unregister();
		triggerCryptoAction("setup-backup");
		expect(handler).not.toHaveBeenCalled();
	});

	it("does not clobber a newer handler when an older one unregisters", () => {
		const first = vi.fn();
		const second = vi.fn();
		const unregisterFirst = registerCryptoHandler(first);
		registerCryptoHandler(second);
		// The first registration's cleanup must be a no-op now that `second` owns
		// the slot, so the newer handler stays live.
		unregisterFirst();
		triggerCryptoAction("reset-recovery-key");
		expect(second).toHaveBeenCalledWith("reset-recovery-key");
		expect(first).not.toHaveBeenCalled();
	});

	it("is a no-op to trigger when no handler is registered", () => {
		expect(() => triggerCryptoAction("loading")).not.toThrow();
	});
});

describe("crypto trigger focus target", () => {
	// Focus is moved to a REAL second element (not document.body, whose .focus()
	// is a no-op in jsdom and would make these assertions vacuous), so a broken
	// capture/restore leaves focus on `elsewhere` and the test fails.
	it("restores focus to an attached element set as the trigger", () => {
		const el = attachInput();
		const elsewhere = attachInput();
		setCryptoTriggerElement(el);
		elsewhere.focus();
		expect(document.activeElement).toBe(elsewhere);
		restoreCryptoTriggerFocus();
		expect(document.activeElement).toBe(el);
	});

	it("clears any prior trigger when set to null, document.body, or a detached element", () => {
		const valid = attachInput();
		const elsewhere = attachInput();

		for (const candidate of [
			null,
			document.body,
			document.createElement("input"), // never attached
		]) {
			// Store a valid trigger, then an invalid one: setting an invalid value
			// must overwrite it with null. If it were kept (invalid input ignored),
			// restore would move focus back to `valid` instead of leaving it on
			// `elsewhere`.
			setCryptoTriggerElement(valid);
			setCryptoTriggerElement(candidate);
			elsewhere.focus();
			restoreCryptoTriggerFocus();
			expect(document.activeElement).toBe(elsewhere);
		}
	});

	it("clears the trigger without focusing when it detached before restore", () => {
		const el = attachInput();
		const elsewhere = attachInput();
		setCryptoTriggerElement(el);
		el.remove();
		elsewhere.focus();
		expect(() => restoreCryptoTriggerFocus()).not.toThrow();
		// Focus stays on `elsewhere`; the stale (detached) trigger is not focused.
		expect(document.activeElement).toBe(elsewhere);
	});

	it("captures the active element as the trigger on triggerCryptoAction", () => {
		const el = attachInput();
		const elsewhere = attachInput();
		el.focus();
		registerCryptoHandler(() => {});
		triggerCryptoAction("verify-session");
		// The action should have captured `el`. Move focus away to a real element;
		// restore must bring it back to `el` (proving the capture happened).
		elsewhere.focus();
		expect(document.activeElement).toBe(elsewhere);
		restoreCryptoTriggerFocus();
		expect(document.activeElement).toBe(el);
	});
});

describe("cryptoDialogOpen signal", () => {
	it("reflects setCryptoDialogOpen", () => {
		expect(cryptoDialogOpen()).toBe(false);
		setCryptoDialogOpen(true);
		expect(cryptoDialogOpen()).toBe(true);
		setCryptoDialogOpen(false);
		expect(cryptoDialogOpen()).toBe(false);
	});
});
