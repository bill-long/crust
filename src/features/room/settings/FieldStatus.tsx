import { type Component, Match, Show, Switch } from "solid-js";

export type FieldState = "idle" | "saving" | "error";

interface FieldStatusProps {
	state: FieldState;
	error?: string | null;
	onRetry?: () => void;
	onDismiss?: () => void;
	/** Optional saving label override. Default: "Saving…". */
	savingLabel?: string;
}

/**
 * Inline per-field status indicator for state-event writes.
 *
 * State events have no SDK local-echo; the caller drives the lifecycle
 * via `useOptimisticState`. This component just renders the visual
 * feedback (saving, error + Retry / Dismiss).
 */
const FieldStatus: Component<FieldStatusProps> = (props) => {
	return (
		<Switch>
			<Match when={props.state === "saving"}>
				<p
					class="mt-1 text-xs text-text-muted"
					role="status"
					aria-live="polite"
				>
					{props.savingLabel ?? "Saving…"}
				</p>
			</Match>
			<Match when={props.state === "error"}>
				<div
					class="mt-1 flex items-start justify-between gap-3 rounded bg-danger-bg/30 px-3 py-1.5 text-xs text-danger-text"
					role="alert"
				>
					<span>{props.error || "Save failed."}</span>
					<div class="flex shrink-0 items-center gap-2">
						<Show when={props.onRetry}>
							<button
								type="button"
								onClick={() => props.onRetry?.()}
								class="rounded px-2 py-0.5 font-semibold text-danger-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text"
							>
								Retry
							</button>
						</Show>
						<Show when={props.onDismiss}>
							<button
								type="button"
								onClick={() => props.onDismiss?.()}
								class="rounded px-2 py-0.5 text-danger-text/80 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text"
								aria-label="Dismiss error"
							>
								Dismiss
							</button>
						</Show>
					</div>
				</div>
			</Match>
		</Switch>
	);
};

export { FieldStatus };
