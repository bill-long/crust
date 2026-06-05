import { type Component, createSignal, onCleanup } from "solid-js";

interface RecoveryKeyDisplayProps {
	recoveryKey: string;
}

/**
 * Shows a recovery key in a monospace block with Copy and Download actions.
 * Shared by the key-backup setup and recovery-key reset flows so their
 * presentation and copy/download behavior stay consistent.
 */
export const RecoveryKeyDisplay: Component<RecoveryKeyDisplayProps> = (
	props,
) => {
	const [copied, setCopied] = createSignal(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	onCleanup(() => {
		disposed = true;
		if (copiedTimer !== undefined) clearTimeout(copiedTimer);
	});

	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(props.recoveryKey);
			setCopied(true);
			if (copiedTimer !== undefined) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copiedTimer = undefined;
				if (!disposed) setCopied(false);
			}, 2000);
		} catch {
			// Clipboard API not available; user can manually select + copy
		}
	};

	const download = (): void => {
		const blob = new Blob([`Recovery Key\n\n${props.recoveryKey}\n`], {
			type: "text/plain",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "crust-recovery-key.txt";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	};

	return (
		<>
			<div class="mb-4 rounded-lg bg-surface-2 p-4">
				<code class="block break-all font-mono text-sm leading-relaxed text-success-text">
					{props.recoveryKey}
				</code>
			</div>

			<div class="mb-6 flex gap-2">
				<button
					type="button"
					onClick={copy}
					class="flex-1 rounded bg-surface-3 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-4"
				>
					{copied() ? "Copied \u2713" : "Copy"}
				</button>
				<button
					type="button"
					onClick={download}
					class="flex-1 rounded bg-surface-3 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-4"
				>
					Download
				</button>
			</div>
		</>
	);
};
