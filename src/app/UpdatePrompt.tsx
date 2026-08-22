import { useRegisterSW } from "virtual:pwa-register/solid";
import { type Component, type JSX, onCleanup, onMount, Show } from "solid-js";
import { isNativeShell, isOverlayWindow } from "./nativeShell";
import {
	dismissNativeUpdate,
	pendingUpdateVersion,
	restartError,
	restartForUpdate,
	restartingForUpdate,
	watchNativeUpdates,
} from "./nativeUpdate";

/** One card. Shared by both update sources so they cannot drift apart. */
const UpdateCard: Component<{
	title: string;
	body: JSX.Element;
	actionLabel: string;
	onAction: () => void;
	onDismiss: () => void;
	pending?: boolean;
	error?: string | null;
}> = (props) => (
	// Positioned by the stack below, not by itself: two cards both claiming
	// `fixed bottom-4 … z-50` sat exactly on top of each other, and the second in
	// DOM order hid the first's buttons entirely.
	<div
		class="rounded-lg border border-border-subtle bg-surface-3 p-4 shadow-xl"
		role="status"
		aria-live="polite"
	>
		{/* Distinct per source: both cards can be on screen at once, and two
		    identical "Update available" live regions with two identical "Later"
		    buttons give a screen-reader user no way to tell them apart. */}
		<h3 class="mb-1 text-sm font-semibold text-text-primary">{props.title}</h3>
		<p class="mb-3 text-xs text-text-muted">{props.body}</p>
		{/* No role="alert" of its own. The card above is already a live region,
		    and an assertive alert nested inside a polite status region is
		    announced once by some screen readers and twice by others - inserting
		    this paragraph is simultaneously the alert AND a mutation of the
		    enclosing region. Letting the card carry it keeps one announcement. */}
		<Show when={props.error}>
			{(message) => <p class="mb-3 text-xs text-danger-text">{message()}</p>}
		</Show>
		<div class="flex justify-end gap-2">
			<button
				type="button"
				onClick={() => {
					if (props.pending) return;
					props.onDismiss();
				}}
				aria-disabled={props.pending ?? false}
				class={`rounded px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover ${
					props.pending
						? "cursor-default text-text-disabled"
						: "text-text-muted hover:bg-surface-2 hover:text-text-primary"
				}`}
			>
				Later
			</button>
			<button
				type="button"
				onClick={() => {
					if (props.pending) return;
					props.onAction();
				}}
				aria-disabled={props.pending ?? false}
				// Dimmed via the background, not `opacity-*`: element opacity also
				// fades the box-shadow the focus ring is drawn with, and this button
				// stays tab-focusable while pending (that is the point of
				// aria-disabled), so the indicator has to keep its full contrast.
				class={`rounded px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover ${
					props.pending
						? "cursor-default bg-accent/60"
						: "bg-accent hover:bg-accent/90"
				}`}
			>
				{props.actionLabel}
			</button>
		</div>
	</div>
);

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
 * In the desktop shell there is ALSO the Tauri updater (#261), already
 * downloaded and signature-verified by the shell before its card appears; there
 * "Restart" quits, which is what lets the installer run.
 *
 * Both can show in the shell, and suppressing the service worker one there was
 * a mistake worth not repeating: the worker still registers (tauri.localhost is
 * a secure context) and precaches, so after a native update replaces `dist/` the
 * old worker can still serve the previous build's assets on the next launch.
 * Hiding its prompt removed the only way out of that, for a webview stuck on
 * stale assets inside an app that had already updated itself.
 */
const UpdatePrompt: Component = () => {
	// Registration happens in every window, including the overlay: this is the
	// app's only useRegisterSW caller, so skipping it here would leave a browser
	// cold-load of /overlay with no service worker at all. Only the CARDS are
	// suppressed there - see the guard on the returned JSX.
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

	// Nothing renders in the overlay window, which mounts this same App root: it
	// is 320x420, transparent, always on top of a game, and click-through leaves
	// any card visible with dead buttons. watchNativeUpdates skips it too, but
	// the service worker path reaches `needRefresh` regardless.
	const showCards = (): boolean => !isOverlayWindow();

	// Nothing at all when there is nothing to show: the wrapper is zero-height
	// today, but rendering it in the overlay contradicts the guard above.
	const anyCard = (): boolean =>
		showCards() && Boolean(pendingUpdateVersion() || needRefresh());

	return (
		// One stack, so a second card sits above the first instead of on it.
		<Show when={anyCard()}>
			<div class="fixed bottom-4 left-4 right-4 z-50 flex flex-col gap-2 sm:right-auto sm:w-80">
				<Show when={showCards() && native() && pendingUpdateVersion()}>
					{(version) => (
						<UpdateCard
							title="Desktop update"
							body={`Crust ${version()} has been downloaded. It installs when you quit, and Crust reopens - or restart now to get it over with.`}
							actionLabel={restartingForUpdate() ? "Restarting…" : "Restart"}
							onAction={restart}
							onDismiss={dismissNativeUpdate}
							pending={restartingForUpdate()}
							error={restartError()}
						/>
					)}
				</Show>
				<Show when={showCards() && needRefresh()}>
					<UpdateCard
						title="App update"
						body="A new version of Crust is ready. Refresh to update."
						actionLabel="Refresh"
						onAction={refresh}
						onDismiss={dismiss}
					/>
				</Show>
			</div>
		</Show>
	);
};

export { UpdatePrompt };
