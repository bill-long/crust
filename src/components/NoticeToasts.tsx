import { type Component, For, onCleanup, onMount } from "solid-js";
import {
	clearNotices,
	dismissNotice,
	type Notice,
	notices,
} from "../stores/notices";

/** How long a notice stays (while the tab is visible) before auto-dismissing. */
const NOTICE_TIMEOUT_MS = 8000;

const NoticeToast: Component<{ notice: Notice }> = (props) => {
	onMount(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const clear = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};
		const arm = (): void => {
			clear();
			timer = setTimeout(
				() => dismissNotice(props.notice.id),
				NOTICE_TIMEOUT_MS,
			);
		};
		// Only count down while the tab is visible, and restart on return: a
		// backgrounded tab pauses paint and throttles timers (see #324), so a
		// notice must not silently expire before the user has had a chance to see
		// it - the exact tab-away case #381 targets.
		const onVisibility = (): void => {
			if (document.visibilityState === "visible") arm();
			else clear();
		};
		if (document.visibilityState === "visible") arm();
		document.addEventListener("visibilitychange", onVisibility);
		onCleanup(() => {
			clear();
			document.removeEventListener("visibilitychange", onVisibility);
		});
	});

	return (
		<div
			class={`notice-in pointer-events-auto flex w-fit max-w-md items-start gap-3 rounded-lg border bg-surface-1 px-4 py-3 text-sm text-text-primary shadow-xl ${
				props.notice.tone === "error"
					? "border-danger-strong"
					: "border-border-default"
			}`}
		>
			<span class="min-w-0 break-words">{props.notice.message}</span>
			<button
				type="button"
				class="-mr-1 shrink-0 rounded p-0.5 text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
				aria-label="Dismiss notification"
				onClick={() => dismissNotice(props.notice.id)}
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					aria-hidden="true"
				>
					<path d="M6 6l12 12M18 6L6 18" />
				</svg>
			</button>
		</div>
	);
};

/**
 * App-root renderer for transient notices (see stores/notices.ts). Fixed at the
 * top center - clear of the bottom composer and the bottom-right verification
 * toast - so a notice survives room/route changes and a disposed emitter, e.g. a
 * GIF send that fails after the user switched rooms (#381).
 *
 * The container is the single aria-live region (children are not `role=status`,
 * to avoid a double screen-reader announcement).
 */
export const NoticeToasts: Component = () => {
	// Drop any notice left over from a previous session: this renderer mounts
	// once per authenticated session, and a notice pushed while it was unmounted
	// (e.g. a send that rejected after logout) has no timer and would otherwise
	// resurface stale on the next login.
	onMount(() => clearNotices());

	return (
		<div
			class="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4"
			aria-live="polite"
			aria-relevant="additions"
		>
			<For each={notices()}>{(notice) => <NoticeToast notice={notice} />}</For>
		</div>
	);
};
