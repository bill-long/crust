import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import type { UiaFlow } from "./uiaFlow";

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
						class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
						autofocus
						required
					/>
				</div>

				{/* Error display reserved for future UIA retry flows */}

				<div class="flex justify-end gap-2">
					<button
						type="button"
						onClick={props.onCancel}
						class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={password().length === 0}
						class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Continue
					</button>
				</div>
			</form>
		</div>
	);
};

interface UiaOauthDialogProps {
	/** Approval page at the user's account provider; null when unknown. */
	url: string | null;
	/** True when a previous retry found no approval granted yet. */
	notYetApproved: boolean;
	/** The user says they approved at the provider - retry the operation. */
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * UIA panel for the `m.oauth` stage (#467): OAuth sessions have no
 * password to re-enter, so the server wants this operation approved
 * out-of-band on its account-management page. Rendered inline within a
 * parent dialog, like {@link UiaDialog}.
 */
const UiaOauthDialog: Component<UiaOauthDialogProps> = (props) => {
	return (
		<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
			<h2 class="mb-2 text-lg font-semibold text-text-primary">
				Approve in your account settings
			</h2>
			<p class="mb-4 text-sm text-text-muted">
				Your account provider needs to approve this security operation. Open
				your account settings, approve it there, then come back and continue.
			</p>

			<Show when={props.notYetApproved}>
				<p
					class="mb-4 rounded-lg bg-warning-bg/60 px-3 py-2 text-sm text-warning-text-bright"
					role="alert"
				>
					The server hasn't seen an approval yet. Approve the operation in your
					account settings, then continue again.
				</p>
			</Show>

			<Show
				when={props.url}
				fallback={
					<p class="mb-4 text-sm text-text-muted">
						Your homeserver did not provide a link to its account settings -
						open them the way you usually do.
					</p>
				}
			>
				{(url) => (
					<a
						href={url()}
						target="_blank"
						rel="noopener noreferrer"
						class="mb-4 block rounded bg-surface-2 px-4 py-2 text-center text-sm font-semibold text-text-primary transition-colors hover:bg-surface-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Open account settings
					</a>
				)}
			</Show>

			<div class="flex justify-end gap-2">
				<button
					type="button"
					onClick={props.onCancel}
					class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={props.onConfirm}
					class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
				>
					I've approved it
				</button>
			</div>
		</div>
	);
};

interface UiaPromptsProps {
	/** The flow whose pending prompt these panels render and answer. */
	flow: UiaFlow;
}

/**
 * Renders whichever identity prompt `flow` is waiting on - the password
 * re-entry panel or the account-management approval panel - wired to the
 * flow's answer/cancel handles. Renders nothing while no prompt is
 * pending, so parents can list it in their step `Switch` ahead of the
 * working state.
 */
const UiaPrompts: Component<UiaPromptsProps> = (props) => {
	const oauthPrompt = () => {
		const p = props.flow.prompt();
		return p?.kind === "oauth" ? p : null;
	};
	return (
		<Switch>
			<Match when={props.flow.prompt()?.kind === "password"}>
				<UiaDialog
					onSubmit={props.flow.submitPassword}
					onCancel={props.flow.cancel}
				/>
			</Match>
			<Match when={oauthPrompt()}>
				{(oauth) => (
					<UiaOauthDialog
						url={oauth().url}
						notYetApproved={oauth().notYetApproved}
						onConfirm={props.flow.confirmOauthApproved}
						onCancel={props.flow.cancel}
					/>
				)}
			</Match>
		</Switch>
	);
};

export { UiaDialog, UiaOauthDialog, UiaPrompts };
