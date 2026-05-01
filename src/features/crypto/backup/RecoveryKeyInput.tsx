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
	const errorId = "recovery-key-error";

	// All pending resolve functions for concurrent SDK requests
	let pendingResolvers: Array<(key: Uint8Array<ArrayBuffer> | null) => void> =
		[];

	const resolveWith = (key: Uint8Array<ArrayBuffer> | null): void => {
		const resolvers = pendingResolvers;
		pendingResolvers = [];
		setIsPrompting(false);
		setInputValue("");
		setErrorText("");
		for (const resolve of resolvers) {
			resolve(key);
		}
	};

	const resolver = (): Promise<Uint8Array<ArrayBuffer> | null> => {
		return new Promise((resolve) => {
			pendingResolvers.push(resolve);
			if (pendingResolvers.length === 1) {
				// First request — show the dialog
				setIsPrompting(true);
				setInputValue("");
				setErrorText("");
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

	const handleSubmit = (): void => {
		const raw = inputValue().replace(/\s+/g, " ").trim();
		if (!raw) {
			setErrorText("Please enter your recovery key.");
			return;
		}

		try {
			const keyBytes = decodeRecoveryKey(raw);
			resolveWith(keyBytes);
		} catch {
			setErrorText(
				"Invalid recovery key. Check that you entered it correctly.",
			);
		}
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
				<div class="w-full max-w-md rounded-lg bg-neutral-900 p-6 shadow-xl">
					<h2 class="mb-3 text-lg font-semibold text-white">
						Enter recovery key
					</h2>
					<p class="mb-4 text-sm text-neutral-400">
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
							if (e.key === "Enter") handleSubmit();
						}}
						placeholder="Enter your recovery key"
						aria-label="Recovery key"
						aria-describedby={errorText() ? errorId : undefined}
						autocomplete="off"
						ref={(el) => el.focus()}
						spellcheck={false}
						class="mb-2 w-full rounded bg-neutral-800 px-3 py-2 font-mono text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-pink-500"
					/>

					<Show when={errorText()}>
						<p id={errorId} class="mb-2 text-sm text-red-400" role="alert">
							{errorText()}
						</p>
					</Show>

					<div class="mt-4 flex justify-end gap-2">
						<button
							type="button"
							onClick={handleCancel}
							class="rounded px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleSubmit}
							class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
						>
							Unlock
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export default RecoveryKeyInput;
