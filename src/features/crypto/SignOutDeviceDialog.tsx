import {
	type Component,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { ACCOUNT_MANAGEMENT_ACTIONS } from "../../client/accountManagement";
import { useClient } from "../../client/client";
import { signOutDevice } from "../../client/deviceManagement";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";
import { createUiaOverlayFocus, UiaPrompts } from "./UiaDialog";
import { createUiaFlow, UiaCancelledError } from "./uiaFlow";

type SignOutStep = "confirm" | "working" | "error";

interface SignOutDeviceDialogProps {
	deviceId: string;
	/** What the list shows for this device, for the confirmation copy. */
	deviceName: string;
	/**
	 * Portal link for this exact device, when the session's management
	 * lives at the provider rather than in-app. Three states, and the
	 * middle one matters: `undefined` while the lookup is still in flight,
	 * `null` once it has come back with no account-management page, a
	 * string once it has come back with one. Collapsing the first two
	 * would tell every OIDC user their server offers no link during the
	 * round-trip that is about to produce one.
	 */
	portalUrl?: string | null;
	/** True for a session the server won't let confirm this in-app (OIDC). */
	viaPortal?: boolean;
	onClose: () => void;
	/** The device is gone server-side - the list must refetch. */
	onSignedOut: () => void;
}

/**
 * Confirm-and-revoke for one other session (#556). Two completion paths,
 * chosen by session type rather than by interpreting a failure:
 *
 * - Password sessions run `DELETE /devices/{id}` through the UIA flow,
 *   which prompts for the password the server challenges for. Nothing is
 *   destroyed before that dict lands, so there is no preflight here (see
 *   `signOutDevice`).
 * - OIDC sessions never attempt it: the server refuses password-UIA
 *   management routes for them outright (#451), which is the whole of
 *   cinnyapp/cinny#2376. They get the MSC2965 deeplink to this device's
 *   own removal page instead.
 *
 * A password session whose server refuses in some way we can't answer
 * falls back to that same deeplink rather than a dead end.
 */
const SignOutDeviceDialog: Component<SignOutDeviceDialogProps> = (props) => {
	const { client } = useClient();

	const [step, setStep] = createSignal<SignOutStep>("confirm");
	const [errorMessage, setErrorMessage] = createSignal("");
	let disposed = false;

	// The metadata fallback deeplink must point at THIS device's removal,
	// not at the cross-signing reset the signing-key dialogs use.
	const uia = createUiaFlow(client, {
		deeplink: {
			action: ACCOUNT_MANAGEMENT_ACTIONS.deviceDelete,
			deviceId: props.deviceId,
		},
	});

	onCleanup(() => {
		disposed = true;
		uia.cancel();
	});

	let overlayEl!: HTMLDivElement;
	createUiaOverlayFocus({ flow: uia, overlay: () => overlayEl, step });

	const doSignOut = async (): Promise<void> => {
		setStep("working");
		setErrorMessage("");
		try {
			await signOutDevice(client, props.deviceId, uia.uiaCallback);
			if (disposed) return;
			props.onSignedOut();
			props.onClose();
		} catch (e) {
			if (disposed) return;
			if (e instanceof UiaCancelledError) {
				// Nothing happened - the request was never authorised - so
				// this is not a failure to report. Close rather than step
				// back: a cancelled flow is aborted for good (only preflight
				// clears that, and this operation has none), so a second
				// attempt on the same flow could never prompt again. Reopening
				// builds a fresh one.
				props.onClose();
				return;
			}
			console.error("Signing out a device failed:", e);
			setErrorMessage(
				userFacingErrorMessage(e, "Couldn't sign this session out."),
			);
			setStep("error");
		}
	};

	// Cancelling a pending identity prompt abandons the sign-out: the flow
	// rejects, and doSignOut's cancel branch is the single place that
	// closes. The in-flight request is not interruptible from here - the
	// sign-out either completed server-side or it did not, and dismissing
	// the UI would not change which.
	const dismiss = (): void => {
		if (uia.prompt()) {
			uia.cancel();
			return;
		}
		if (step() === "working") return;
		props.onClose();
	};

	const handleBackdropClick = (e: MouseEvent): void => {
		if (e.target !== e.currentTarget) return;
		dismiss();
	};

	// Unlike the other crypto dialogs (mounted at App level under
	// CryptoStatusBanner), this one renders INSIDE SettingsOverlay, whose
	// root has its own Escape-closes and Tab-trap handlers. Solid delegates
	// keydown, so without stopping propagation an Escape here would also
	// close the whole Settings modal, and both focus traps would fight over
	// the same Tab. This dialog owns both keys while it is open.
	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Tab") {
			e.stopPropagation();
			trapTabKey(overlayEl, e);
			return;
		}
		if (e.key !== "Escape") return;
		e.stopPropagation();
		dismiss();
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Sign out session"
			tabIndex={-1}
			ref={overlayEl}
			onClick={handleBackdropClick}
			onKeyDown={handleKeyDown}
		>
			<Switch>
				{/* Identity prompts shadow the working state while the flow
				    suspends waiting on the user. */}
				<Match when={uia.prompt()}>
					<UiaPrompts flow={uia} />
				</Match>

				<Match when={step() === "confirm"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Sign out this session?
						</h2>
						<p class="mb-2 text-sm text-text-secondary">
							<span class="font-medium text-text-primary">
								{props.deviceName}
							</span>{" "}
							will be signed out and will need to sign in again.
						</p>
						<p class="mb-6 text-sm text-text-muted">
							Encrypted messages it holds keys for may become unreadable on that
							device.
						</p>

						<Show
							when={props.viaPortal}
							fallback={
								<div class="flex justify-end gap-2">
									<button
										type="button"
										onClick={props.onClose}
										class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={() => void doSignOut()}
										class="rounded bg-danger px-4 py-2 text-sm font-semibold text-danger-foreground transition-colors hover:bg-danger/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Sign out
									</button>
								</div>
							}
						>
							<p class="mb-4 text-sm text-text-muted">
								Your account provider manages your sessions, so this one is
								signed out there.
							</p>
							<Switch>
								<Match when={props.portalUrl}>
									{(url) => (
										<a
											href={url()}
											target="_blank"
											rel="noopener noreferrer"
											class="block rounded bg-accent px-4 py-2 text-center text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
										>
											Open account settings
										</a>
									)}
								</Match>
								<Match when={props.portalUrl === null}>
									<p class="mb-4 text-sm text-text-muted">
										Your homeserver did not provide a link to its account
										settings - open them the way you usually do.
									</p>
								</Match>
								{/* Still looking the link up. Same box as the button it
								    becomes, so the dialog does not jump when it lands. */}
								<Match when={props.portalUrl === undefined}>
									<div
										class="block rounded bg-surface-2 px-4 py-2 text-center text-sm font-semibold text-text-disabled"
										aria-live="polite"
									>
										Finding your account settings…
									</div>
								</Match>
							</Switch>
							<div class="mt-4 flex justify-end">
								<button
									type="button"
									onClick={props.onClose}
									class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									Close
								</button>
							</div>
						</Show>
					</div>
				</Match>

				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-sm text-text-secondary">Signing out…</p>
						</div>
					</div>
				</Match>

				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Sign-out failed
						</h2>
						<p class="mb-4 text-sm text-danger-text-bright" role="alert">
							{errorMessage()}
						</p>
						{/* Offered for any failure, not just a refusal: the portal
						    is a second route to the same outcome, and a user who
						    just watched this fail should not have to go hunting for
						    it. Absent when the server advertises no such page. */}
						<Show when={props.portalUrl}>
							{(url) => (
								<div class="mb-4">
									<p class="mb-2 text-sm text-text-muted">
										You can sign this session out in your account settings
										instead.
									</p>
									<a
										href={url()}
										target="_blank"
										rel="noopener noreferrer"
										class="block rounded bg-surface-2 px-4 py-2 text-center text-sm font-semibold text-text-primary transition-colors hover:bg-surface-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Open account settings
									</a>
								</div>
							)}
						</Show>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Close
							</button>
							<button
								type="button"
								onClick={() => setStep("confirm")}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Try again
							</button>
						</div>
					</div>
				</Match>
			</Switch>
		</div>
	);
};

export { SignOutDeviceDialog };
