/** Crypto setup state — also used as the action payload for triggerCryptoAction. */
export type CryptoAction =
	| "loading"
	| "setup-cross-signing"
	| "verify-session"
	| "setup-backup"
	| "reset-recovery-key"
	| "hidden";
