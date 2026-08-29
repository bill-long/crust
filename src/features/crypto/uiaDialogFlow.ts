import type { MatrixClient } from "matrix-js-sdk";
import { onCleanup } from "solid-js";
import {
	createUiaFlow,
	UiaCancelledError,
	type UiaFlow,
	type UiaFlowOptions,
} from "./uiaFlow";

/**
 * How one preflight or operation ended.
 *
 * Deliberately says nothing about whether the dialog is still mounted -
 * that is {@link UiaDialogFlow.disposed}, and the two are independent.
 * An operation that failed after an unmount still has cleanup its dialog
 * owes (dropping a stale secret-storage cache), so the failure is
 * reported rather than swallowed and the caller decides what survives
 * disposal.
 */
export type UiaRunOutcome<T> =
	| { status: "ok"; value: T }
	/**
	 * The user cancelled an identity prompt, or the dialog unmounted
	 * while one was pending (the cleanup below aborts the flow). What a
	 * cancel *means* differs per operation - a preflight cancel leaves
	 * the account untouched, a mid-operation one may not - so the dialog
	 * maps it, not this module.
	 */
	| { status: "cancelled" }
	| { status: "failed"; error: unknown };

/**
 * A {@link UiaFlow} plus the dialog lifecycle every UIA-gated dialog was
 * hand-rolling around it (#545): unmount tracking, which half is in
 * flight, and the Escape/backdrop policy that depends on it.
 *
 * The two halves stay separable. {@link UiaDialogFlow.preflight} is only
 * for an operation that destroys something BEFORE its UIA-gated request
 * (`resetEncryption` tears down backups and secret storage first); an
 * operation whose unauthenticated attempt IS the challenge discovery - a
 * device sign-out - calls {@link UiaDialogFlow.run} alone and never
 * preflights. This is a pair of independent runners, not a
 * preflight-then-op pipeline.
 *
 * Separable, but sequential: at most one half runs at a time, and
 * overlapping them throws rather than corrupting the in-flight phase that
 * {@link UiaDialogFlow.dismiss} reads.
 */
export interface UiaDialogFlow {
	/**
	 * The underlying flow: hand `flow.uiaCallback` to the operation and
	 * `flow` itself to `<UiaPrompts>`.
	 */
	flow: UiaFlow;
	/**
	 * Whether the dialog has unmounted. Not reactive, and not a substitute
	 * for the outcome: read it after every await, before touching any UI
	 * state, exactly as the hand-rolled `disposed` flags did.
	 */
	disposed: () => boolean;
	/**
	 * Run {@link UiaFlow.preflight} - collect and verify the identity
	 * confirmation while the account is still untouched - reporting how it
	 * ended instead of throwing. Only for operations with a destructive
	 * window before their UIA; see the interface docs.
	 */
	preflight: () => Promise<UiaRunOutcome<void>>;
	/**
	 * Run the UIA-gated operation itself, reporting how it ended instead
	 * of throwing. Marks the flow as mid-operation for {@link dismiss},
	 * which is the whole reason this is not a plain try/catch at the call
	 * site.
	 */
	run: <T>(op: () => Promise<T>) => Promise<UiaRunOutcome<T>>;
	/**
	 * The Escape / backdrop-click policy every UIA dialog shares. Calls
	 * `close` only when the dialog should actually close now.
	 *
	 * - A **pending identity prompt** is cancelled and nothing else
	 *   happens. The flow's rejection surfaces as a `cancelled` outcome at
	 *   the call site, which is the single place that decides whether that
	 *   steps back, closes, or reports an interruption.
	 * - A **preflight in flight** does not block the close: it is the
	 *   non-destructive probe, nothing has happened yet, so a hung request
	 *   must not trap the user. The probe itself is not cancellable - the
	 *   close aborts the flow's prompts, and the caller's `disposed()`
	 *   check between the halves is what stops the operation from starting
	 *   even if the probe later resolves.
	 * - An **operation in flight** is not. It either completed
	 *   server-side or it did not, and dismissing the UI would not change
	 *   which.
	 *
	 * A dialog with a further terminal state of its own (the recovery key
	 * `ResetEncryptionDialog` shows exactly once) guards that BEFORE
	 * calling this. Such a state cannot coexist with a prompt or an
	 * in-flight phase, so checking it first is the same policy in a
	 * different order, not a second one.
	 */
	dismiss: (close: () => void) => void;
}

/**
 * Build a {@link UiaDialogFlow} for the dialog calling it. Call from a
 * component body: it registers an `onCleanup` that aborts the flow, so a
 * prompt nobody can answer any more rejects instead of leaving the
 * operation suspended forever.
 */
export function createUiaDialogFlow(
	client: MatrixClient,
	options?: UiaFlowOptions,
): UiaDialogFlow {
	const flow = createUiaFlow(client, options);
	let disposed = false;
	// Which half is in flight, or null when nothing is. The dismissal
	// policy is its only reader - the two halves answer Escape
	// differently - and it is cleared in a `finally` so a settled
	// operation never leaves the dialog undismissable.
	let phase: "preflight" | "op" | null = null;

	onCleanup(() => {
		disposed = true;
		flow.cancel();
	});

	const settle = async <T>(
		which: "preflight" | "op",
		body: () => Promise<T>,
	): Promise<UiaRunOutcome<T>> => {
		// `phase` is a single slot, so overlapping the two halves would let
		// whichever settles first clear it while the other is still
		// running - and `dismiss` would then close over a live destructive
		// operation. No dialog can reach this (each switches to a step that
		// unmounts its own trigger before awaiting); it is here so that a
		// future one fails loudly instead of silently.
		if (phase) throw new Error(`A UIA ${phase} is already in flight.`);
		phase = which;
		try {
			return { status: "ok", value: await body() };
		} catch (e) {
			if (e instanceof UiaCancelledError) return { status: "cancelled" };
			return { status: "failed", error: e };
		} finally {
			phase = null;
		}
	};

	const dismiss = (close: () => void): void => {
		if (flow.prompt()) {
			flow.cancel();
			return;
		}
		if (phase === "op") return;
		if (phase === "preflight") flow.cancel();
		close();
	};

	return {
		flow,
		disposed: () => disposed,
		preflight: () => settle("preflight", () => flow.preflight()),
		run: <T>(op: () => Promise<T>) => settle("op", op),
		dismiss,
	};
}
