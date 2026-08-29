import {
	type Component,
	createEffect,
	createSignal,
	Match,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { changePassword } from "../../client/accountSecurity";
import { useClient } from "../../client/client";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";

interface ChangePasswordDialogProps {
	onClose: () => void;
}

type Step = "form" | "working" | "done";

/**
 * Change the account password (#451). Password sessions only - the form
 * collects the current password, which doubles as the endpoint's UIA
 * answer, so there is no separate confirmation prompt. OIDC sessions
 * never reach this dialog (AccountTab links them to the server's
 * account-management page instead).
 *
 * The "sign out my other sessions" checkbox stays even though the Devices
 * tab now has its own bulk sign-out (#557): the two are not the same
 * operation. `logout_devices` rides along in `POST /account/password`, so
 * the old sessions die in the same request that changes the password -
 * the property you want when the reason for changing it is that it may be
 * known. Doing it as two operations leaves a window in which the password
 * is new and the old tokens are still live, and the second half can fail
 * on its own.
 */
const ChangePasswordDialog: Component<ChangePasswordDialogProps> = (props) => {
	const { client } = useClient();

	const [step, setStep] = createSignal<Step>("form");
	const [current, setCurrent] = createSignal("");
	const [next, setNext] = createSignal("");
	const [confirm, setConfirm] = createSignal("");
	const [signOutOthers, setSignOutOthers] = createSignal(false);
	const [error, setError] = createSignal("");

	let overlayEl!: HTMLDivElement;
	let currentEl: HTMLInputElement | undefined;
	onMount(() => currentEl?.focus());
	// A step swap can strand focus on the body (the focused submit button
	// disables, or the form unmounts for the done panel), which kills the
	// overlay-scoped Escape/Tab handling - reclaim it, but only when it
	// was actually lost (VerificationDialog's rule).
	createEffect(() => {
		step();
		const active = document.activeElement;
		if (!active || active === document.body) overlayEl.focus();
	});

	const submit = async (e: Event): Promise<void> => {
		e.preventDefault();
		if (next() !== confirm()) {
			setError("The new passwords don't match.");
			return;
		}
		setError("");
		setStep("working");
		try {
			await changePassword(client, {
				currentPassword: current(),
				newPassword: next(),
				logoutOtherDevices: signOutOthers(),
			});
			setStep("done");
		} catch (err) {
			setError(
				userFacingErrorMessage(
					err,
					"Could not change the password. Try again.",
				),
			);
			setStep("form");
		}
	};

	const onDismiss = (): void => {
		if (step() === "working") return;
		props.onClose();
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Change password"
			tabIndex={-1}
			ref={overlayEl}
			onClick={(e) => {
				if (e.target === e.currentTarget) onDismiss();
			}}
			onKeyDown={(e) => {
				if (e.key === "Tab") {
					trapTabKey(overlayEl, e);
					return;
				}
				if (e.key === "Escape") onDismiss();
			}}
		>
			<Switch>
				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Password changed
						</h2>
						<p class="mb-6 text-sm text-text-muted">
							{signOutOthers()
								? "Your other sessions have been signed out."
								: "Your other sessions stay signed in."}
						</p>
						<div class="flex justify-end">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Done
							</button>
						</div>
					</div>
				</Match>

				<Match when={true}>
					<form
						onSubmit={(e) => void submit(e)}
						class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl"
					>
						<h2 class="mb-4 text-lg font-semibold text-text-primary">
							Change password
						</h2>

						<div class="space-y-3">
							<div>
								<label
									for="cp-current"
									class="mb-1 block text-sm text-text-muted"
								>
									Current password
								</label>
								<input
									id="cp-current"
									ref={currentEl}
									type="password"
									value={current()}
									onInput={(e) => setCurrent(e.currentTarget.value)}
									autocomplete="current-password"
									required
									class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
								/>
							</div>
							<div>
								<label for="cp-new" class="mb-1 block text-sm text-text-muted">
									New password
								</label>
								<input
									id="cp-new"
									type="password"
									value={next()}
									onInput={(e) => setNext(e.currentTarget.value)}
									autocomplete="new-password"
									required
									class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
								/>
							</div>
							<div>
								<label
									for="cp-confirm"
									class="mb-1 block text-sm text-text-muted"
								>
									Confirm new password
								</label>
								<input
									id="cp-confirm"
									type="password"
									value={confirm()}
									onInput={(e) => setConfirm(e.currentTarget.value)}
									autocomplete="new-password"
									required
									class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
								/>
							</div>

							<label class="flex items-start gap-2 py-1 text-sm text-text-secondary">
								<input
									type="checkbox"
									checked={signOutOthers()}
									onChange={(e) => setSignOutOthers(e.currentTarget.checked)}
									class="mt-0.5 accent-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								/>
								<span>
									Sign out my other sessions
									<span class="block text-xs text-text-muted">
										Leaving this off keeps your other devices signed in and
										their encrypted messages readable.
									</span>
								</span>
							</label>
						</div>

						<Show when={error()}>
							<p
								id="cp-error"
								role="alert"
								class="mt-3 text-sm text-danger-text-bright"
							>
								{error()}
							</p>
						</Show>

						<div class="mt-5 flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								disabled={step() === "working"}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Cancel
							</button>
							<button
								type="submit"
								aria-describedby={error() ? "cp-error" : undefined}
								disabled={
									step() === "working" ||
									current().length === 0 ||
									next().length === 0 ||
									confirm().length === 0
								}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								{step() === "working" ? "Changing…" : "Change password"}
							</button>
						</div>
					</form>
				</Match>
			</Switch>
		</div>
	);
};

export { ChangePasswordDialog };
