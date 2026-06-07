import { useRegisterSW } from "virtual:pwa-register/solid";
import { type Component, Show } from "solid-js";

/**
 * Subtle, dismissible "update available" toast (issue #230 item 3).
 *
 * The service worker deliberately does not `skipWaiting()` (so deploys never
 * force-reload a live session — e.g. mid-call), which means a new build
 * normally activates only on the next cold start. For users who keep the app
 * open for long stretches, this surfaces a non-intrusive prompt when a new
 * worker is waiting. Refreshing is strictly user-initiated: clicking "Refresh"
 * messages the waiting worker to skip waiting and reloads once it takes
 * control (see the SKIP_WAITING handler in src/sw.ts). Dismissing keeps the
 * current session untouched; the update still applies on the next cold start.
 */
const UpdatePrompt: Component = () => {
	const {
		needRefresh: [needRefresh, setNeedRefresh],
		updateServiceWorker,
	} = useRegisterSW();

	const refresh = (): void => {
		void updateServiceWorker(true);
	};

	const dismiss = (): void => {
		setNeedRefresh(false);
	};

	return (
		<Show when={needRefresh()}>
			<div
				class="fixed bottom-4 left-4 z-50 w-80 rounded-lg border border-border-subtle bg-surface-3 p-4 shadow-xl"
				role="status"
				aria-live="polite"
			>
				<h3 class="mb-1 text-sm font-semibold text-text-primary">
					Update available
				</h3>
				<p class="mb-3 text-xs text-text-muted">
					A new version of Crust is ready. Refresh to update.
				</p>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onClick={dismiss}
						class="rounded px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
					>
						Later
					</button>
					<button
						type="button"
						onClick={refresh}
						class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent/90"
					>
						Refresh
					</button>
				</div>
			</div>
		</Show>
	);
};

export { UpdatePrompt };
