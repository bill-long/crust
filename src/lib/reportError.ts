import { pushNotice } from "../stores/notices";

export interface ReportErrorOptions {
	/**
	 * Short, human-readable message shown to the user as an error toast. Omit for
	 * background failures that should be logged but never surfaced (console-only).
	 */
	userMessage?: string;
	/**
	 * Developer-facing label prefixed to the `console.error` line, e.g.
	 * `"Reaction failed"`. Kept separate from `userMessage` so log greps stay
	 * stable and the toast text can be user-friendly. Defaults to
	 * `"Unhandled error"`.
	 */
	logLabel?: string;
}

/**
 * App-wide funnel for a caught error. Always `console.error`s for debugging;
 * additionally shows a user-facing error toast when `userMessage` is set.
 *
 * Convention (see AGENTS.md "Error handling"): dialogs render errors inline via
 * `userFacingErrorMessage`; everything else routes failures here. Pass a
 * `userMessage` when a user-initiated action failed with no other visible
 * feedback (a reaction the server rejected, a settings save, ...); omit it for
 * background noise that only needs a log line.
 */
export function reportError(
	err: unknown,
	options: ReportErrorOptions = {},
): void {
	const { userMessage, logLabel } = options;
	console.error(`${logLabel ?? "Unhandled error"}:`, err);
	if (userMessage !== undefined) {
		pushNotice(userMessage, "error");
	}
}
