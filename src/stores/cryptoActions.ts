import { createSignal } from "solid-js";
import type { CryptoAction } from "../features/crypto/CryptoStatusBanner";

type CryptoActionHandler = (action: CryptoAction) => void;

const [handler, setHandler] = createSignal<CryptoActionHandler | null>(null);

/** Register the crypto action handler. Returns an unregister function for cleanup. */
export function registerCryptoHandler(h: CryptoActionHandler): () => void {
	setHandler(() => h);
	return () => setHandler(null);
}

/** Trigger a crypto setup flow from anywhere (called by user panel). */
export function triggerCryptoAction(action: CryptoAction): void {
	handler()?.(action);
}
