import { AuthType } from "matrix-js-sdk";
import { type Component, createSignal, Match, Switch } from "solid-js";
import { useClient } from "../../client/client";
import UiaDialog from "./UiaDialog";

type SetupStep = "intro" | "uia" | "working" | "done" | "error";

interface CrossSigningSetupProps {
	onClose: () => void;
}

/**
 * Dialog for bootstrapping cross-signing on this account. This is the
 * first-device setup flow: creates master, self-signing, and user-signing
 * keys, then uploads them with UIA.
 */
export const CrossSigningSetup: Component<CrossSigningSetupProps> = (props) => {
	const { client, cryptoStatus, clearSecretStorageCache } = useClient();

	const [step, setStep] = createSignal<SetupStep>("intro");
	const [errorMessage, setErrorMessage] = createSignal("");

	const startSetup = (): void => {
		setStep("uia");
	};

	const doBootstrap = async (password: string): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}

		setErrorMessage("");
		setStep("working");

		try {
			const userId = client.getUserId();
			if (!userId) {
				setErrorMessage("Unable to determine user ID.");
				setStep("error");
				return;
			}

			await crypto.bootstrapCrossSigning({
				authUploadDeviceSigningKeys: async (makeRequest) => {
					// First attempt without auth to get the session ID
					try {
						await makeRequest(null);
						return;
					} catch (uiaError: unknown) {
						// Expected: server returns 401 with UIA flow info
						const err = uiaError as {
							httpStatus?: number;
							data?: { session?: string };
						};
						if (err.httpStatus !== 401 || !err.data?.session) {
							throw uiaError;
						}

						// Use the password provided by the UIA dialog
						await makeRequest({
							type: AuthType.Password,
							identifier: {
								type: "m.id.user",
								user: userId,
							},
							password,
							session: err.data.session,
						});
					}
				},
			});

			await cryptoStatus.refresh();
			setStep("done");
		} catch (e) {
			console.error("Cross-signing bootstrap failed:", e);
			clearSecretStorageCache();
			setErrorMessage(
				e instanceof Error ? e.message : "Setup failed. Please try again.",
			);
			setStep("error");
		}
	};

	const onUiaPassword = (password: string): void => {
		doBootstrap(password);
	};

	const onUiaCancel = (): void => {
		setStep("intro");
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Set up secure messaging"
			tabIndex={-1}
			ref={(el) => el.focus()}
			onClick={(e) => {
				if (e.target === e.currentTarget && step() !== "working") {
					if (step() === "uia") {
						onUiaCancel();
					} else {
						props.onClose();
					}
				}
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && step() !== "working") {
					if (step() === "uia") {
						onUiaCancel();
					} else {
						props.onClose();
					}
				}
			}}
		>
			<Switch>
				<Match when={step() === "intro"}>
					<div class="w-full max-w-md rounded-lg bg-neutral-900 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-white">
							Set up secure messaging
						</h2>
						<p class="mb-2 text-sm text-neutral-300">
							Cross-signing lets you verify your devices and other users. Once
							set up, your devices can trust each other and you can read
							encrypted messages across all your sessions.
						</p>
						<p class="mb-6 text-sm text-neutral-400">
							You'll be asked to re-enter your password to confirm this action.
						</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
							>
								Later
							</button>
							<button
								type="button"
								onClick={startSetup}
								class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
							>
								Continue
							</button>
						</div>
					</div>
				</Match>

				<Match when={step() === "uia"}>
					<UiaDialog onSubmit={onUiaPassword} onCancel={onUiaCancel} />
				</Match>

				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-neutral-900 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-pink-500" />
							<p class="text-sm text-neutral-300">Setting up cross-signing…</p>
						</div>
					</div>
				</Match>

				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-neutral-900 p-6 shadow-xl">
						<div class="mb-4 text-center">
							<span class="text-4xl" role="img" aria-label="Success">
								✅
							</span>
						</div>
						<h2 class="mb-2 text-center text-lg font-semibold text-white">
							Secure messaging is set up
						</h2>
						<p class="mb-6 text-center text-sm text-neutral-400">
							Your cross-signing keys have been created. You can now verify your
							other devices.
						</p>
						<div class="flex justify-center">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
							>
								Done
							</button>
						</div>
					</div>
				</Match>

				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-neutral-900 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-white">Setup failed</h2>
						<p class="mb-4 text-sm text-red-300">{errorMessage()}</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
							>
								Close
							</button>
							<button
								type="button"
								onClick={startSetup}
								class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
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
