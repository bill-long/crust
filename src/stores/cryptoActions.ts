import { createSignal } from "solid-js";
import type { CryptoAction } from "../types/crypto";

type CryptoActionHandler = (action: CryptoAction) => void;

const [handler, setHandler] = createSignal<CryptoActionHandler | null>(null);

/**
 * Number of currently open crypto dialogs. Reference-counted rather than a
 * boolean because several independent owners (the banner's setup flows, the
 * Devices tab's export/import dialogs) can hold it at once — a boolean's
 * last-writer-wins would clear the flag while another dialog is still open.
 */
const [cryptoDialogHolds, setCryptoDialogHolds] = createSignal(0);

/** Whether any crypto dialog is currently open (inert gating for content beneath it). */
export const cryptoDialogOpen = (): boolean => cryptoDialogHolds() > 0;

/**
 * Mark a crypto dialog open. Returns an idempotent disposer that releases
 * the hold; the open flag clears only once every hold is released.
 */
export function acquireCryptoDialog(): () => void {
	setCryptoDialogHolds((n) => n + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		setCryptoDialogHolds((n) => Math.max(0, n - 1));
	};
}

/** The element that had focus when the crypto dialog was triggered. */
let triggerElement: HTMLElement | null = null;

/** Register the crypto action handler. Returns an unregister function for cleanup. */
export function registerCryptoHandler(h: CryptoActionHandler): () => void {
	setHandler(() => h);
	return () => {
		if (handler() === h) setHandler(null);
	};
}

/** Trigger a crypto setup flow from anywhere (called by user panel). */
export function triggerCryptoAction(action: CryptoAction): void {
	setCryptoTriggerElement(document.activeElement);
	handler()?.(action);
}

/**
 * Set the focus restoration target for paths that bypass triggerCryptoAction
 * (e.g. accepting an incoming verification toast). Validates that the element
 * is a meaningful focus target — rejects null, body, and detached elements.
 */
export function setCryptoTriggerElement(el: Element | null): void {
	triggerElement =
		el instanceof HTMLElement &&
		el !== document.body &&
		document.body.contains(el)
			? el
			: null;
}

/** Restore focus to the element that triggered the crypto dialog. */
export function restoreCryptoTriggerFocus(): void {
	if (triggerElement && document.body.contains(triggerElement)) {
		triggerElement.focus();
	}
	triggerElement = null;
}
