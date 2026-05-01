import { type Component, createSignal } from "solid-js";

interface UiaDialogProps {
	/** Called with the password when user submits, or null if cancelled */
	onSubmit: (password: string) => void;
	onCancel: () => void;
	error?: string;
	loading?: boolean;
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
		const pwd = password();
		if (pwd.length > 0) {
			props.onSubmit(pwd);
		}
	};

	return (
		<div class="w-full max-w-sm rounded-lg bg-neutral-900 p-6 shadow-xl">
			<h2 class="mb-2 text-lg font-semibold text-white">
				Confirm your identity
			</h2>
			<p class="mb-4 text-sm text-neutral-400">
				Re-enter your password to continue with this security operation.
			</p>

			<form onSubmit={handleSubmit} class="space-y-4">
				<div>
					<label for="uia-password" class="mb-1 block text-sm text-neutral-400">
						Password
					</label>
					<input
						id="uia-password"
						type="password"
						value={password()}
						onInput={(e) => setPassword(e.currentTarget.value)}
						placeholder="••••••••"
						autocomplete="current-password"
						class="w-full rounded bg-neutral-800 px-3 py-2 text-white placeholder-neutral-500 outline-none focus:ring-2 focus:ring-pink-500"
						autofocus
						required
					/>
				</div>

				{props.error && (
					<p class="rounded bg-red-900/50 px-3 py-2 text-sm text-red-300">
						{props.error}
					</p>
				)}

				<div class="flex justify-end gap-2">
					<button
						type="button"
						onClick={props.onCancel}
						disabled={props.loading}
						class="rounded px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={props.loading || password().length === 0}
						class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500 disabled:opacity-50"
					>
						{props.loading ? "Verifying…" : "Continue"}
					</button>
				</div>
			</form>
		</div>
	);
};

export default UiaDialog;
