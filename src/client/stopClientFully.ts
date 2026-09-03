import type { MatrixClient } from "matrix-js-sdk";
import { reportError } from "../lib/reportError";

/**
 * Stop the client so that it is really stopped, whatever `stopClient` does on
 * the way (#551).
 *
 * Two SDK details make the plain call unreliable, and both bite on the paths
 * this app stops a client from. `stopClient` runs `cryptoBackend?.stop()`
 * BEFORE it clears `clientRunning` and before it touches the sync API, so a
 * throw there stops nothing and leaves the flag set - and `clearStores`
 * throws synchronously on that flag, so the account wipe every logout depends
 * on would fail for the life of the document. The retry is what gets past it:
 * `RustCrypto.stop()` sets its own `stopped` flag before the calls that can
 * throw, so a second attempt returns from it immediately and goes on to reach
 * the sync API the first never did.
 *
 * The `finally` is the last resort for a client that refuses to stop twice: a
 * flag left set fails every later wipe, which is worse than the sync loop it
 * would otherwise keep stoppable.
 *
 * The retry covers the crypto step and only that step, which is the one that
 * matters here: it runs BEFORE the flag is cleared, so it is the only throw
 * that leaves the flag set, and it is idempotent so a second attempt gets
 * past it. A throw from a step AFTER the flag is cleared (`matrixRTC.stop()`,
 * say) is a different animal: the retry is turned away by `stopClient`'s own
 * early return, and restoring the flag to force it back in would only
 * re-enter the same deterministic throw while re-stopping what already
 * stopped. Those later steps are then left running - a residual accepted
 * here, because the flag, which is what the account wipe depends on, is
 * already correct by that point.
 *
 * Used by the provider's own stops (`client.tsx`) and by the revoke every
 * logout runs (`accountLogout.ts`), so the rule has one home.
 */
export function stopClientFully(client: MatrixClient): void {
	try {
		client.stopClient();
	} catch (e) {
		reportError(e, { logLabel: "Failed to stop the client" });
		try {
			client.stopClient();
		} catch (retryError) {
			reportError(retryError, {
				logLabel: "Failed to stop the client on the second attempt",
			});
		}
	} finally {
		client.clientRunning = false;
	}
}
