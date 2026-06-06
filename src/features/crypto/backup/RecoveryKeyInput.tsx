import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import {
	type Component,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";

/**
 * Recovery key input dialog. Registers as the recovery key resolver via
 * setRecoveryKeyResolver so the SDK can prompt the user when it needs to
 * unlock secret storage.
 *
 * Renders nothing when idle. When the SDK triggers a request, shows a
 * modal with a text input for the Base58-encoded recovery key.
 */
const RecoveryKeyInput: Component = () => {
	const { setRecoveryKeyResolver } = useClient();

	const [isPrompting, setIsPrompting] = createSignal(false);
	const [inputValue, setInputValue] = createSignal("");
	const [errorText, setErrorText] = createSignal("");
	const [isChecking, setIsChecking] = createSignal(false);
	const errorId = "recovery-key-error";

	// All pending resolve functions for concurrent SDK requests
	let pendingResolvers: Array<(key: Uint8Array<ArrayBuffer> | null) => void> =
		[];
	// Validator supplied with the first request of a batch; used to reject a
	// well-formed but incorrect key before resolving (issue #205).
	let pendingValidate:
		| ((key: Uint8Array<ArrayBuffer>) => Promise<boolean>)
		| null = null;
	// Generation token: bumped whenever a prompt batch opens or settles, so an
	// in-flight async validation from a superseded batch cannot resolve a newer
	// one if the user cancels and a fresh SDK request arrives mid-check.
	let batchId = 0;

	const resolveWith = (key: Uint8Array<ArrayBuffer> | null): void => {
		const resolvers = pendingResolvers;
		pendingResolvers = [];
		pendingValidate = null;
		batchId++;
		setIsPrompting(false);
		setInputValue("");
		setErrorText("");
		setIsChecking(false);
		for (const resolve of resolvers) {
			resolve(key);
		}
	};

	const resolver = (
		validate?: (key: Uint8Array<ArrayBuffer>) => Promise<boolean>,
	): Promise<Uint8Array<ArrayBuffer> | null> => {
		return new Promise((resolve) => {
			pendingResolvers.push(resolve);
			if (pendingResolvers.length === 1) {
				// First request — show the dialog
				pendingValidate = validate ?? null;
				batchId++;
				setIsPrompting(true);
				setInputValue("");
				setErrorText("");
				setIsChecking(false);
			}
		});
	};

	onMount(() => {
		setRecoveryKeyResolver(resolver);
	});

	onCleanup(() => {
		setRecoveryKeyResolver(null);
		// Resolve pending with null so the SDK doesn't hang
		resolveWith(null);
	});

	const handleSubmit = async (): Promise<void> => {
		if (isChecking()) return;
		const raw = inputValue().replace(/\s+/g, " ").trim();
		if (!raw) {
			setErrorText("Please enter your recovery key.");
			return;
		}

		let keyBytes: Uint8Array<ArrayBuffer>;
		try {
			keyBytes = decodeRecoveryKey(raw);
		} catch {
			setErrorText(
				"Invalid recovery key. Check that you entered it correctly.",
			);
			return;
		}

		const validate = pendingValidate;
		if (validate) {
			const submittedBatch = batchId;
			setIsChecking(true);
			let valid = false;
			try {
				valid = await validate(keyBytes);
			} catch {
				valid = false;
			}
			// A concurrent cancel/cleanup (and possibly a fresh SDK request)
			// may have superseded this prompt while we were checking; bail out
			// without resolving so we never hand a stale key to a newer batch.
			if (batchId !== submittedBatch) return;
			setIsChecking(false);
			if (!valid) {
				setErrorText(
					"Incorrect recovery key. Check that you entered it correctly.",
				);
				return;
			}
		}

		resolveWith(keyBytes);
	};

	const handleCancel = (): void => {
		resolveWith(null);
	};

	return (
		<Show when={isPrompting()}>
			<div
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
				role="dialog"
				aria-modal="true"
				aria-label="Enter recovery key"
				onClick={(e) => {
					if (e.target === e.currentTarget) handleCancel();
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") handleCancel();
				}}
			>
				<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
					<h2 class="mb-3 text-lg font-semibold text-text-primary">
						Enter recovery key
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						Enter your recovery key to unlock your encrypted message history.
					</p>

					<input
						type="text"
						value={inputValue()}
						onInput={(e) => {
							setInputValue(e.currentTarget.value);
							setErrorText("");
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleSubmit();
						}}
						placeholder="Enter your recovery key"
						aria-label="Recovery key"
						aria-describedby={errorText() ? errorId : undefined}
						autocomplete="off"
						ref={(el) => el.focus()}
						spellcheck={false}
						class="mb-2 w-full rounded bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-accent-hover"
					/>

					<Show when={errorText()}>
						<p id={errorId} class="mb-2 text-sm text-danger-text" role="alert">
							{errorText()}
						</p>
					</Show>

					<div class="mt-4 flex justify-end gap-2">
						<button
							type="button"
							onClick={handleCancel}
							class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void handleSubmit()}
							aria-busy={isChecking()}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
						>
							<Show when={isChecking()} fallback="Unlock">
								Checking…
							</Show>
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export { RecoveryKeyInput };
