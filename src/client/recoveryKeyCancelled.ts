/**
 * Thrown out of the crypto `getSecretStorageKey` callback when the
 * recovery-key prompt closes without a key (the user cancelled it, or nothing
 * was mounted to ask). The SDK turns a null return into an opaque
 * "getSecretStorageKey callback returned falsey" error; throwing this instead
 * lets the dialog that started the operation recognise a cancel and step
 * back instead of showing that text as a failure.
 */
export class RecoveryKeyCancelledError extends Error {
	constructor() {
		super("Recovery key entry was cancelled.");
		this.name = "RecoveryKeyCancelledError";
	}
}

export function isRecoveryKeyCancelled(e: unknown): boolean {
	return e instanceof RecoveryKeyCancelledError;
}
