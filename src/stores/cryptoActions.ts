import { createSignal } from "solid-js";
import type { CryptoAction } from "../types/crypto";

type CryptoActionHandler = (action: CryptoAction) => void;

const [handler, setHandler] = createSignal<CryptoActionHandler | null>(null);

/** Whether a crypto dialog is currently open (used by SettingsOverlay for inert). */
const [cryptoDialogOpen, setCryptoDialogOpen] = createSignal(false);

export { cryptoDialogOpen, setCryptoDialogOpen };

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
	triggerElement = document.activeElement as HTMLElement | null;
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
