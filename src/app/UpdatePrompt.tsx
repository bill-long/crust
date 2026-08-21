import { useRegisterSW } from "virtual:pwa-register/solid";
import { type Component, type JSX, onCleanup, onMount, Show } from "solid-js";
import { isNativeShell } from "./nativeShell";
import {
	dismissNativeUpdate,
	pendingUpdateVersion,
	restartForUpdate,
	watchNativeUpdates,
} from "./nativeUpdate";

/**
 * Subtle, dismissible "update available" toast (issue #230 item 3), for both
 * kinds of update this app can receive.
 *
 * In a browser this is the service worker. It deliberately does not
 * `skipWaiting()` (so deploys never force-reload a live session — e.g.
 * mid-call), which means a new build normally activates only on the next cold
 * start. For users who keep the app open for long stretches, this surfaces a
 * non-intrusive prompt when a new worker is waiting. Refreshing is strictly
 * user-initiated: clicking "Refresh" messages the waiting worker to skip
 * waiting and reloads once it takes control (see the SKIP_WAITING handler in
 * src/sw.ts). Dismissing keeps the current session untouched; the update still
 * applies on the next cold start.
 *
 * In the desktop shell it is the Tauri updater instead (#261), already
 * downloaded and signature-verified by the shell before this appears; there
 * "Restart" quits, which is what lets the installer run. The two sources are
 * mutually exclusive on purpose: refreshing the webview would do nothing for a
 * native update, so inside the shell only the native prompt shows.
 */

const UpdateCard: Component<{
	body: JSX.Element;
	actionLabel: string;
	onAction: () => void;
	onDismiss: () => void;
}> = (props) => (
	<div
		class="fixed bottom-4 left-4 right-4 z-50 rounded-lg border border-border-subtle bg-surface-3 p-4 shadow-xl sm:right-auto sm:w-80"
		role="status"
		aria-live="polite"
	>
		<h3 class="mb-1 text-sm font-semibold text-text-primary">
			Update available
		</h3>
		<p class="mb-3 text-xs text-text-muted">{props.body}</p>
		<div class="flex justify-end gap-2">
			<button
				type="button"
				onClick={props.onDismiss}
				class="rounded px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
			>
				Later
			</button>
			<button
				type="button"
				onClick={props.onAction}
				class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent/90"
			>
				{props.actionLabel}
			</button>
		</div>
	</div>
);

const UpdatePrompt: Component = () => {
	const {
		needRefresh: [needRefresh, setNeedRefresh],
		updateServiceWorker,
	} = useRegisterSW();

	onMount(() => {
		const unlisten = watchNativeUpdates();
		onCleanup(() => void unlisten.then((off) => off()));
	});

	const refresh = (): void => {
		void updateServiceWorker(true);
	};

	const dismiss = (): void => {
		setNeedRefresh(false);
	};

	const restart = (): void => {
		void restartForUpdate();
	};

	const native = (): boolean => isNativeShell();

	return (
		<>
			<Show when={native() && pendingUpdateVersion()}>
				{(version) => (
					<UpdateCard
						body={`Crust ${version()} has been downloaded. Restart to finish updating.`}
						actionLabel="Restart"
						onAction={restart}
						onDismiss={dismissNativeUpdate}
					/>
				)}
			</Show>
			<Show when={!native() && needRefresh()}>
				<UpdateCard
					body="A new version of Crust is ready. Refresh to update."
					actionLabel="Refresh"
					onAction={refresh}
					onDismiss={dismiss}
				/>
			</Show>
		</>
	);
};

export { UpdatePrompt };
