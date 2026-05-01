import { type Component, Match, Show, Switch } from "solid-js";
import EmojiDisplay from "./EmojiDisplay";
import type { VerificationHandle } from "./useVerification";

interface VerificationDialogProps {
	verification: VerificationHandle;
	onClose: () => void;
}

/**
 * Modal dialog for SAS emoji verification. Shows the appropriate UI
 * for each verification state: waiting, emoji comparison, done, or error.
 */
const VerificationDialog: Component<VerificationDialogProps> = (props) => {
	const v = props.verification;
	const canClose = (): boolean =>
		v.state() === "done" ||
		v.state() === "cancelled" ||
		v.state() === "error" ||
		v.state() === "idle";

	const handleClose = (): void => {
		if (canClose()) {
			v.reset();
			props.onClose();
		} else {
			v.cancel();
		}
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Device verification"
			tabIndex={-1}
			ref={(el) => el.focus()}
			onClick={(e) => {
				if (e.target === e.currentTarget) handleClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") handleClose();
			}}
		>
			<div class="w-full max-w-md rounded-lg bg-neutral-900 p-6 shadow-xl">
				<Switch>
					{/* Waiting for other side */}
					<Match when={v.state() === "requested" || v.state() === "ready"}>
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-pink-500" />
							<h2 class="text-lg font-semibold text-white">
								Waiting for the other device
							</h2>
							<p class="text-center text-sm text-neutral-400">
								<Show
									when={v.isSelfVerification()}
									fallback="Accept the verification request on the other device."
								>
									Open your other session and accept the verification request.
								</Show>
							</p>
							<button
								type="button"
								onClick={() => v.cancel()}
								class="mt-2 rounded px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
							>
								Cancel
							</button>
						</div>
					</Match>

					{/* Emoji comparison */}
					<Match when={v.state() === "sas-showing"}>
						<h2 class="mb-4 text-center text-lg font-semibold text-white">
							Compare emoji
						</h2>
						<p class="mb-6 text-center text-sm text-neutral-400">
							Verify that the following emoji appear on both devices, in the
							same order.
						</p>

						<Show when={v.emoji()}>
							{(emojiList) => (
								<div class="mb-6 rounded-lg bg-neutral-800/50 p-4">
									<EmojiDisplay emoji={emojiList()} />
								</div>
							)}
						</Show>

						<div class="flex justify-center gap-3">
							<button
								type="button"
								onClick={() => v.rejectSas()}
								class="rounded bg-red-900/50 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900/70"
							>
								They don't match
							</button>
							<button
								type="button"
								onClick={() => v.confirmSas()}
								class="rounded bg-green-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600"
							>
								They match
							</button>
						</div>
					</Match>

					{/* Confirming */}
					<Match when={v.state() === "sas-confirmed"}>
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-green-500" />
							<h2 class="text-lg font-semibold text-white">
								Waiting for confirmation
							</h2>
							<p class="text-sm text-neutral-400">
								Confirm the emoji on your other device too.
							</p>
						</div>
					</Match>

					{/* Done */}
					<Match when={v.state() === "done"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Verified">
								✅
							</span>
							<h2 class="text-lg font-semibold text-white">
								Verification complete
							</h2>
							<p class="text-center text-sm text-neutral-400">
								<Show
									when={v.isSelfVerification()}
									fallback="The device has been verified."
								>
									This session is now verified. Your devices trust each other.
								</Show>
							</p>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
							>
								Done
							</button>
						</div>
					</Match>

					{/* Cancelled */}
					<Match when={v.state() === "cancelled"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Cancelled">
								❌
							</span>
							<h2 class="text-lg font-semibold text-white">
								Verification cancelled
							</h2>
							<p class="text-sm text-neutral-400">
								The verification was cancelled.
							</p>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded bg-neutral-700 px-3 py-2 text-sm text-white transition-colors hover:bg-neutral-600"
							>
								Close
							</button>
						</div>
					</Match>

					{/* Error */}
					<Match when={v.state() === "error"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Error">
								⚠️
							</span>
							<h2 class="text-lg font-semibold text-white">
								Verification failed
							</h2>
							<p class="text-sm text-red-300">{v.error()}</p>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded bg-neutral-700 px-3 py-2 text-sm text-white transition-colors hover:bg-neutral-600"
							>
								Close
							</button>
						</div>
					</Match>
				</Switch>
			</div>
		</div>
	);
};

export default VerificationDialog;
