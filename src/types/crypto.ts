/** Crypto setup state — also used as the action payload for triggerCryptoAction. */
export type CryptoAction =
	| "loading"
	| "setup-cross-signing"
	| "verify-session"
	| "setup-backup"
	| "unlock-backup"
	| "reset-recovery-key"
	| "reset-encryption"
	| "hidden";

/**
 * What triggerCryptoAction accepts: a bare CryptoAction, or a flow that
 * needs a target — verifying one of the user's OTHER sessions from its row
 * in the device list, which has to say which one.
 */
export type CryptoActionRequest =
	| CryptoAction
	| { action: "verify-device"; deviceId: string };
