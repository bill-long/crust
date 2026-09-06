import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import {
	ACCOUNT_MANAGEMENT_ACTIONS,
	type AccountManagementAction,
	type AccountManagementDeeplinkOptions,
} from "../../client/accountManagement";
import { useClient } from "../../client/client";
import {
	signOutDevice,
	signOutOtherDevices,
} from "../../client/deviceManagement";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";
import { createUiaOverlayFocus, UiaPrompts } from "./UiaDialog";
import { createUiaDialogFlow } from "./uiaDialogFlow";

type SignOutStep = "confirm" | "working" | "error";

/**
 * What a sign-out is about to revoke: one named session (#556), or the
 * whole set of other sessions in one request (#557).
 *
 * `others` carries the ids rather than recomputing them when the user
 * confirms, so what is revoked is exactly the set the confirmation
 * counted. A session that signs in while this dialog is open is not
 * silently swept up in a number the user never saw; it shows up in the
 * refetched list afterwards.
 */
export type SignOutTarget =
	| { kind: "device"; deviceId: string; deviceName: string }
	| { kind: "others"; deviceIds: string[] };

interface SignOutSessionsDialogProps {
	target: SignOutTarget;
	/**
	 * Portal link for this exact target, when the session's management
	 * lives at the provider rather than in-app. Three states, and the
	 * middle one matters: `undefined` while the lookup is still in flight,
	 * `null` once it has come back with no account-management page, a
	 * string once it has come back with one. Collapsing the first two
	 * would tell every OIDC user their server offers no link during the
	 * round-trip that is about to produce one.
	 */
	portalUrl?: string | null | undefined;
	/** True for a session the server won't let confirm this in-app (OIDC). */
	viaPortal?: boolean;
	onClose: () => void;
	/** The devices are gone server-side - the list must refetch. */
	onSignedOut: () => void;
}

/**
 * Confirm-and-revoke for other sessions - one of them (#556) or all of
 * them (#557). Two completion paths, chosen by session type rather than
 * by interpreting a failure:
 *
 * - Password sessions run `DELETE /devices/{id}` or `POST /delete_devices`
 *   through the UIA flow, which prompts for the password the server
 *   challenges for. Neither destroys anything before that dict lands, so
 *   there is no preflight here (see `client/deviceManagement.ts`).
 * - OIDC sessions never attempt it: the server refuses password-UIA
 *   management routes for them outright (#451), which is the whole of
 *   cinnyapp/cinny#2376. They get a deeplink instead - MSC2965's
 *   account-management URL carrying an MSC4191 action: this device's own
 *   removal page (`org.matrix.device_delete` plus a `device_id`) for one
 *   session, the session list (`org.matrix.devices_list`) for the bulk
 *   case, which MSC4191 gives no single "delete these" action for.
 *
 * A password session whose server refuses in some way we can't answer
 * falls back to that same deeplink rather than a dead end.
 */
const SignOutSessionsDialog: Component<SignOutSessionsDialogProps> = (
	props,
) => {
	const { client } = useClient();

	const [step, setStep] = createSignal<SignOutStep>("confirm");
	const [errorMessage, setErrorMessage] = createSignal("");

	// The metadata fallback deeplink must point at what this dialog is
	// actually revoking, not at the cross-signing reset the signing-key
	// dialogs use. Read once: the flow is built at mount and the list
	// mounts this component `keyed`, so a different target is a different
	// instance rather than a prop swap under a running flow.
	const deeplink: {
		action: AccountManagementAction;
	} & AccountManagementDeeplinkOptions =
		props.target.kind === "device"
			? {
					action: ACCOUNT_MANAGEMENT_ACTIONS.deviceDelete,
					deviceId: props.target.deviceId,
				}
			: { action: ACCOUNT_MANAGEMENT_ACTIONS.devicesList };

	// No preflight half here: neither route destroys anything before its
	// UIA, so the unauthenticated attempt IS the challenge discovery and
	// `run` is called alone (see UiaDialogFlow).
	const uia = createUiaDialogFlow(client, { deeplink });

	let overlayEl!: HTMLDivElement;
	createUiaOverlayFocus({ flow: uia.flow, overlay: () => overlayEl, step });

	/** The target when it names one session, else undefined. Narrowing
	 *  does not survive into a JSX callback, so hand the narrowed value
	 *  through `<Show>` rather than re-testing `kind` inside it. */
	const deviceTarget = ():
		| Extract<SignOutTarget, { kind: "device" }>
		| undefined => (props.target.kind === "device" ? props.target : undefined);

	/** How many sessions the `others` target covers. */
	const otherCount = (): number =>
		props.target.kind === "others" ? props.target.deviceIds.length : 0;

	const dialogLabel = (): string =>
		props.target.kind === "device"
			? "Sign out session"
			: "Sign out other sessions";

	const doSignOut = async (): Promise<void> => {
		// Read once, before the first await, because the failure branch
		// reads it again after several: the flow suspends on a password
		// prompt in between. The list mounts this dialog `keyed`, so the
		// prop cannot actually change identity underneath - this keeps that
		// from being something the error copy silently depends on.
		const target = props.target;
		setStep("working");
		setErrorMessage("");
		const done = await uia.run(async () => {
			if (target.kind === "device") {
				await signOutDevice(client, target.deviceId, uia.flow.uiaCallback);
			} else {
				await signOutOtherDevices(
					client,
					target.deviceIds,
					uia.flow.uiaCallback,
				);
			}
		});
		if (uia.disposed()) return;
		if (done.status === "ok") {
			props.onSignedOut();
			props.onClose();
			return;
		}
		if (done.status === "cancelled") {
			// Nothing happened - the request was never authorised - so this
			// is not a failure to report. Close rather than step back: a
			// cancelled flow is aborted for good (only preflight clears that,
			// and this operation has none), so a second attempt on the same
			// flow could never prompt again. Reopening builds a fresh one.
			props.onClose();
			return;
		}
		console.error("Signing sessions out failed:", done.error);
		setErrorMessage(
			userFacingErrorMessage(
				done.error,
				target.kind === "device"
					? "Couldn't sign this session out."
					: "Couldn't sign those sessions out.",
			),
		);
		setStep("error");
	};

	// The shared policy (see UiaDialogFlow.dismiss). Cancelling a pending
	// identity prompt abandons the sign-out: the flow rejects, and
	// doSignOut's cancel branch is the single place that closes. With no
	// preflight half, the only in-flight state here is the revoke itself,
	// which the policy refuses to dismiss.
	const dismiss = (): void => uia.dismiss(props.onClose);

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
			aria-label={dialogLabel()}
			tabIndex={-1}
			ref={overlayEl}
			onClick={handleBackdropClick}
			onKeyDown={handleKeyDown}
		>
			<Switch>
				{/* Identity prompts shadow the working state while the flow
				    suspends waiting on the user. */}
				<Match when={uia.flow.prompt()}>
					<UiaPrompts flow={uia.flow} />
				</Match>

				<Match when={step() === "confirm"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							<Show
								when={deviceTarget()}
								fallback="Sign out all other sessions?"
							>
								Sign out this session?
							</Show>
						</h2>
						<Show
							when={deviceTarget()}
							fallback={
								<>
									<p class="mb-2 text-sm text-text-secondary">
										<span class="font-medium text-text-primary">
											{otherCount()} other session
											{otherCount() === 1 ? "" : "s"}
										</span>{" "}
										will be signed out. This session stays signed in.
									</p>
									<p class="mb-2 text-sm text-text-muted">
										Signing back in on those devices creates new sessions, which
										start out unverified until you verify each one.
									</p>
									<p class="mb-6 text-sm text-text-muted">
										Encrypted messages they hold keys for may become unreadable
										on those devices.
									</p>
								</>
							}
						>
							{(target) => (
								<>
									<p class="mb-2 text-sm text-text-secondary">
										{/* break-words, not truncate: the name is the whole point
										    of the sentence. displayNameOr caps absurd lengths, but
										    a long unbroken name under that cap would still push the
										    Cancel / Sign out buttons out of this max-w-md box. */}
										<span class="font-medium break-words text-text-primary">
											{target().deviceName}
										</span>{" "}
										will be signed out and will need to sign in again.
									</p>
									<p class="mb-6 text-sm text-text-muted">
										Encrypted messages it holds keys for may become unreadable
										on that device.
									</p>
								</>
							)}
						</Show>

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
							{/* "you sign … out there", not "… is signed out there":
							    nothing has happened yet, and the passive reads as a
							    report of a revoke this dialog cannot perform. The
							    only thing past this point is a link. */}
							<p class="mb-4 text-sm text-text-muted">
								<Show
									when={deviceTarget()}
									fallback="Your account provider manages your sessions, so you sign them out there - one at a time, from its session list."
								>
									Your account provider manages your sessions, so you sign this
									one out there.
								</Show>
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
										<Show
											when={deviceTarget()}
											fallback="You can sign those sessions out in your account settings instead."
										>
											You can sign this session out in your account settings
											instead.
										</Show>
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

export { SignOutSessionsDialog };
