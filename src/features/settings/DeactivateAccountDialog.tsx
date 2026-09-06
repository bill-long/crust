import { type Component, createEffect, createSignal, on, Show } from "solid-js";
import { deactivateAccount } from "../../client/accountSecurity";
import { useClient } from "../../client/client";
import { Modal } from "../../components/Modal";
import { userFacingErrorMessage } from "../../lib/errorMessage";

interface DeactivateAccountDialogProps {
	onClose: () => void;
	/**
	 * Called after the server confirms the deactivation. Every token is
	 * already invalid at that point - the handler must sign this session
	 * out locally (the caller wires the app's logout path here).
	 */
	onDeactivated: () => void;
}

/**
 * Permanently deactivate the account (#451). Password sessions only -
 * the password doubles as the endpoint's UIA answer. Guarded by a typed
 * confirmation of the full user ID, Element-style, because there is no
 * undo. OIDC sessions are linked to the server's account-management page
 * instead (AccountTab).
 */
const DeactivateAccountDialog: Component<DeactivateAccountDialogProps> = (
	props,
) => {
	const { client } = useClient();
	const userId = client.getUserId() ?? "";

	const [confirmText, setConfirmText] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [erase, setErase] = createSignal(false);
	const [working, setWorking] = createSignal(false);
	const [error, setError] = createSignal("");

	let overlayEl!: HTMLDivElement;
	let confirmEl: HTMLInputElement | undefined;
	// The focused submit button disables while working; a failure would
	// otherwise leave focus on the body and kill Escape/Tab handling -
	// reclaim it, but only when it was actually lost.
	createEffect(
		on(
			working,
			() => {
				const active = document.activeElement;
				if (!active || active === document.body) overlayEl.focus();
			},
			{ defer: true },
		),
	);

	// Fails closed when the user ID is unknown: an empty userId must never
	// let an untouched confirm field satisfy the gate.
	const ready = (): boolean =>
		userId.length > 0 &&
		confirmText() === userId &&
		password().length > 0 &&
		!working();

	const submit = async (e: Event): Promise<void> => {
		e.preventDefault();
		if (!ready()) return;
		setError("");
		setWorking(true);
		try {
			await deactivateAccount(client, {
				password: password(),
				erase: erase(),
			});
			// No local state to keep: the server has invalidated everything.
			props.onDeactivated();
		} catch (err) {
			setError(
				userFacingErrorMessage(
					err,
					"Could not deactivate the account. Try again.",
				),
			);
			setWorking(false);
		}
	};

	const onDismiss = (): void => {
		if (working()) return;
		props.onClose();
	};

	return (
		<Modal
			open
			onClose={onDismiss}
			dismissible={!working()}
			label="Deactivate account"
			initialFocus={() => confirmEl}
			contentRef={(element) => {
				overlayEl = element;
			}}
		>
			<form
				onSubmit={(e) => void submit(e)}
				class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl"
			>
				<h2 class="mb-3 text-lg font-semibold text-danger-text-bright">
					Deactivate account
				</h2>
				<p class="mb-2 text-sm text-text-secondary">
					This permanently deactivates <strong>{userId}</strong>. You will be
					signed out everywhere, the account can never be used or re-registered
					again, and it will leave all of its rooms.
				</p>
				<p class="mb-4 text-sm text-text-muted">
					Messages you sent are not deleted unless you ask for that below;
					people you talked to keep their copy of the conversation either way.
				</p>

				<div class="space-y-3">
					<label class="flex items-start gap-2 py-1 text-sm text-text-secondary">
						<input
							type="checkbox"
							checked={erase()}
							onChange={(e) => setErase(e.currentTarget.checked)}
							class="mt-0.5 accent-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
						/>
						<span>
							Also request removal of my messages
							<span class="block text-xs text-text-muted">
								Best-effort: asks this server to hide your past messages from
								people who join rooms later.
							</span>
						</span>
					</label>

					<div>
						<label for="da-confirm" class="mb-1 block text-sm text-text-muted">
							Type <span class="font-mono">{userId}</span> to confirm
						</label>
						<input
							id="da-confirm"
							ref={confirmEl}
							type="text"
							value={confirmText()}
							onInput={(e) => setConfirmText(e.currentTarget.value)}
							autocomplete="off"
							class="w-full rounded bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-disabled focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
						/>
					</div>

					<div>
						<label for="da-password" class="mb-1 block text-sm text-text-muted">
							Password
						</label>
						<input
							id="da-password"
							type="password"
							value={password()}
							onInput={(e) => setPassword(e.currentTarget.value)}
							autocomplete="current-password"
							class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
						/>
					</div>
				</div>

				<Show when={error()}>
					<p
						id="da-error"
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
						disabled={working()}
						class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Cancel
					</button>
					<button
						type="submit"
						aria-describedby={error() ? "da-error" : undefined}
						disabled={!ready()}
						class="rounded bg-danger px-4 py-2 text-sm font-semibold text-danger-foreground transition-colors hover:bg-danger/90 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						{working() ? "Deactivating…" : "Deactivate forever"}
					</button>
				</div>
			</form>
		</Modal>
	);
};

export { DeactivateAccountDialog };
