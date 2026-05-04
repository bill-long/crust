import { type Component, createSignal } from "solid-js";

interface UiaDialogProps {
	/** Called with the password when user submits */
	onSubmit: (password: string) => void;
	onCancel: () => void;
}

/**
 * User-Interactive Authentication panel. Prompts for password re-entry
 * when the server requires authentication for sensitive operations like
 * uploading cross-signing keys. Rendered inline within a parent dialog
 * — does not create its own modal overlay.
 */
const UiaDialog: Component<UiaDialogProps> = (props) => {
	const [password, setPassword] = createSignal("");

	const handleSubmit = (e: Event): void => {
		e.preventDefault();
		// Password is forwarded verbatim — no trimming, since valid
		// passwords may contain leading/trailing whitespace.
		const pwd = password();
		if (pwd.length > 0) {
			props.onSubmit(pwd);
		}
	};

	return (
		<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
			<h2 class="mb-2 text-lg font-semibold text-text-primary">
				Confirm your identity
			</h2>
			<p class="mb-4 text-sm text-text-muted">
				Re-enter your password to continue with this security operation.
			</p>

			<form onSubmit={handleSubmit} class="space-y-4">
				<div>
					<label for="uia-password" class="mb-1 block text-sm text-text-muted">
						Password
					</label>
					<input
						id="uia-password"
						type="password"
						value={password()}
						onInput={(e) => setPassword(e.currentTarget.value)}
						placeholder="••••••••"
						autocomplete="current-password"
						class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder-text-disabled outline-none focus:ring-2 focus:ring-accent-hover"
						autofocus
						required
					/>
				</div>

				{/* Error display reserved for future UIA retry flows */}

				<div class="flex justify-end gap-2">
					<button
						type="button"
						onClick={props.onCancel}
						class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={password().length === 0}
						class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50"
					>
						Continue
					</button>
				</div>
			</form>
		</div>
	);
};

export default UiaDialog;
