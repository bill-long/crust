import {
	type Component,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	Show,
} from "solid-js";
import type { PollSnapshot } from "./pollSnapshot";

interface PollMessageProps {
	poll: PollSnapshot;
	/** Cast/change the local user's vote. Empty array = MSC3381 retraction
	 *  (spoiled ballot); only reachable for multi-select polls. */
	onVote: (answerIds: string[]) => void;
	/** Close the poll. Only invoked when the snapshot says canEnd. */
	onEndPoll: () => void;
}

/**
 * Timeline renderer for an MSC3381 poll, driven entirely by the projected
 * {@link PollSnapshot} (no SDK access).
 *
 * Voting is optimistic: clicks call onVote and the watcher re-projects the
 * row with the pending ballot applied, so the UI updates immediately.
 * Single-select renders as a radiogroup (re-clicking the selected option is
 * a no-op, no retraction - Element parity) with roving tabindex and
 * arrow-key focus movement; selection stays on click/Enter/Space so
 * browsing options never fires votes. Multi-select renders as checkboxes
 * capped at maxSelections, and unchecking the last selection sends the
 * MSC3381 spoiled-ballot retraction.
 *
 * Non-votable states (ended, ending, no live SDK model yet, cap reached)
 * use aria-disabled with a click guard rather than the disabled attribute,
 * so the options stay in the tab order and remain perceivable.
 *
 * Result visibility follows the poll kind: disclosed polls show counts and
 * bars live, undisclosed polls hide them until the poll ends. The bar track
 * is always rendered (zero-width fill while hidden) so revealing results
 * never shifts layout. Undisclosed results reveal only on a CONFIRMED end
 * (isEnded), never optimistically while endPending.
 */
export const PollMessage: Component<PollMessageProps> = (props) => {
	const hintId = createUniqueId();
	const [confirmingEnd, setConfirmingEnd] = createSignal(false);
	let cardRef: HTMLDivElement | undefined;
	let endButtonRef: HTMLButtonElement | undefined;
	let confirmButtonRef: HTMLButtonElement | undefined;
	const showResults = createMemo(
		() => props.poll.kind === "disclosed" || props.poll.isEnded,
	);
	const votingDisabled = createMemo(
		() => !props.poll.canVote || props.poll.isEnded || props.poll.endPending,
	);
	const isMultiSelect = () => props.poll.maxSelections > 1;
	const maxCount = createMemo(() => {
		let max = 0;
		for (const answer of props.poll.answers) {
			const count = props.poll.counts[answer.id];
			if (count > max) max = count;
		}
		return max;
	});
	const percent = (count: number): number =>
		props.poll.totalVotes > 0
			? Math.round((count / props.poll.totalVotes) * 100)
			: 0;
	const statusLine = createMemo(() => {
		if (props.poll.isEnded) return "Final results";
		return props.poll.kind === "disclosed"
			? "Live results"
			: "Results hidden until the poll ends";
	});
	const votesLine = createMemo(() => {
		if (
			props.poll.loadingResults &&
			props.poll.totalVotes === 0 &&
			!props.poll.isEnded
		) {
			return "Loading results…";
		}
		return props.poll.totalVotes === 1
			? "1 vote"
			: `${props.poll.totalVotes} votes`;
	});
	/** Roving tabindex home for the single-select radiogroup: the checked
	 *  option, or the first option before any vote. */
	const rovingId = createMemo(() =>
		isMultiSelect()
			? null
			: (props.poll.myAnswers[0] ?? props.poll.answers[0]?.id ?? null),
	);

	const toggleAnswer = (answerId: string): void => {
		if (votingDisabled()) return;
		const mine = props.poll.myAnswers;
		const selected = mine.includes(answerId);
		if (!isMultiSelect()) {
			// Radio semantics: re-clicking the selected option is a no-op.
			if (!selected) props.onVote([answerId]);
			return;
		}
		if (selected) {
			// Unchecking the last selection sends [] - the spoiled-ballot
			// retraction.
			props.onVote(mine.filter((id) => id !== answerId));
		} else if (mine.length < props.poll.maxSelections) {
			props.onVote([...mine, answerId]);
		}
	};

	/** Arrow-key focus movement within the single-select radiogroup.
	 *  Deliberately moves focus WITHOUT selecting: the WAI-ARIA APG's
	 *  "selection follows focus" guidance explicitly exempts widgets where
	 *  selection triggers significant side effects, and here selecting
	 *  sends a vote over the network. Selection stays on explicit
	 *  Enter/Space/click. */
	const onGroupKeyDown = (event: KeyboardEvent): void => {
		if (isMultiSelect()) return;
		const delta =
			event.key === "ArrowDown" || event.key === "ArrowRight"
				? 1
				: event.key === "ArrowUp" || event.key === "ArrowLeft"
					? -1
					: 0;
		if (delta === 0) return;
		event.preventDefault();
		const group = event.currentTarget as HTMLElement;
		const radios = [...group.querySelectorAll<HTMLButtonElement>("button")];
		const current = radios.indexOf(document.activeElement as HTMLButtonElement);
		if (current === -1 || radios.length === 0) return;
		radios[(current + delta + radios.length) % radios.length].focus();
	};

	return (
		<div
			ref={cardRef}
			tabindex="-1"
			aria-busy={props.poll.hasPendingVote}
			class="max-w-md rounded-lg border border-border-subtle bg-surface-2 p-3 focus-visible:outline-none"
		>
			<div class="flex items-start gap-2">
				<svg
					class="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					aria-hidden="true"
				>
					<path d="M6 20V10" />
					<path d="M12 20V4" />
					<path d="M18 20v-6" />
				</svg>
				<div class="min-w-0">
					<p class="whitespace-pre-wrap break-words text-sm font-medium text-text-primary">
						{props.poll.question}
					</p>
					<p class="text-xs text-text-muted">
						{statusLine()}
						<Show when={isMultiSelect() && !props.poll.isEnded}>
							<span id={hintId}>
								{" "}
								· Choose up to {props.poll.maxSelections}
							</span>
						</Show>
					</p>
				</div>
			</div>
			<ul
				class="mt-2 flex flex-col gap-2"
				aria-label="Poll options"
				role={isMultiSelect() ? "group" : "radiogroup"}
				onKeyDown={onGroupKeyDown}
			>
				<For each={props.poll.answers}>
					{(answer) => {
						// counts is zero-filled for every answer id (see
						// PollSnapshot.counts), so direct indexing is safe.
						const count = () => props.poll.counts[answer.id];
						const isMine = () => props.poll.myAnswers.includes(answer.id);
						const isWinner = () =>
							props.poll.isEnded && count() > 0 && count() === maxCount();
						// Multi-select cap: unchecked options lock once the cap
						// is reached (checked ones stay clickable to uncheck).
						const capLocked = () =>
							isMultiSelect() &&
							!isMine() &&
							props.poll.myAnswers.length >= props.poll.maxSelections;
						const locked = () => votingDisabled() || capLocked();
						return (
							<li>
								{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the
								    role is dynamically "radio" or "checkbox", both of which
								    support aria-checked; Biome can only see the implicit
								    button role through the conditional expression. */}
								<button
									type="button"
									role={isMultiSelect() ? "checkbox" : "radio"}
									aria-checked={isMine()}
									// aria-disabled (not the disabled attribute) keeps
									// locked options in the tab order and perceivable;
									// toggleAnswer guards the actual interaction.
									aria-disabled={locked()}
									aria-describedby={
										isMultiSelect() && !props.poll.isEnded ? hintId : undefined
									}
									tabindex={
										isMultiSelect() || rovingId() === answer.id ? 0 : -1
									}
									class={`w-full rounded p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover ${
										locked() ? "cursor-default" : "hover:bg-surface-3/60"
									}`}
									onClick={() => {
										if (!capLocked()) toggleAnswer(answer.id);
									}}
								>
									<span class="flex items-baseline justify-between gap-2 text-sm">
										<span
											class={`min-w-0 break-words ${
												isWinner()
													? "font-medium text-text-emphasis"
													: "text-text-secondary"
											}`}
										>
											{answer.text}
											<Show when={isMine()}>
												<svg
													class="ml-1 inline h-3.5 w-3.5 text-accent-text"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="3"
													stroke-linecap="round"
													stroke-linejoin="round"
													aria-hidden="true"
												>
													<path d="M20 6 9 17l-5-5" />
												</svg>
												<span class="sr-only">(your vote)</span>
											</Show>
										</span>
										<Show when={showResults()}>
											<span class="shrink-0 text-xs tabular-nums text-text-muted">
												{count()} · {percent(count())}%
											</span>
										</Show>
									</span>
									<span class="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-3">
										<span
											class="block h-full rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
											style={{
												width: showResults() ? `${percent(count())}%` : "0%",
											}}
										/>
									</span>
								</button>
							</li>
						);
					}}
				</For>
			</ul>
			<Show when={props.poll.failedAnswers}>
				{(failed) => (
					<p class="mt-2 text-xs text-danger-text" role="alert">
						Couldn't record your vote.{" "}
						<button
							type="button"
							class="font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							onClick={() => props.onVote(failed())}
						>
							Retry
						</button>
					</p>
				)}
			</Show>
			<div class="mt-2 flex items-baseline justify-between gap-2">
				<p class="text-xs text-text-muted">{votesLine()}</p>
				<Show when={props.poll.canEnd && !props.poll.isEnded}>
					<Show
						when={!props.poll.endPending}
						fallback={<p class="text-xs text-text-disabled">Ending…</p>}
					>
						<Show
							when={confirmingEnd()}
							fallback={
								<button
									ref={endButtonRef}
									type="button"
									class="rounded px-1 text-xs text-text-muted transition-colors hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={() => {
										setConfirmingEnd(true);
										// The clicked button unmounts; keep keyboard
										// focus in the flow by moving it to Confirm.
										queueMicrotask(() => confirmButtonRef?.focus());
									}}
								>
									End poll
								</button>
							}
						>
							<span class="flex items-baseline gap-2 text-xs">
								<span class="text-text-secondary">
									End poll? Voting will stop.
								</span>
								<button
									ref={confirmButtonRef}
									type="button"
									class="rounded px-1 font-medium text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={() => {
										setConfirmingEnd(false);
										props.onEndPoll();
										// Both confirm controls unmount ("Ending…" text
										// replaces them); park focus on the card so
										// keyboard users don't fall back to <body>.
										queueMicrotask(() => cardRef?.focus());
									}}
								>
									Confirm
								</button>
								<button
									type="button"
									class="rounded px-1 text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={() => {
										setConfirmingEnd(false);
										queueMicrotask(() => endButtonRef?.focus());
									}}
								>
									Cancel
								</button>
							</span>
						</Show>
					</Show>
				</Show>
			</div>
			<Show when={props.poll.endFailed}>
				<p class="mt-1 text-xs text-danger-text" role="alert">
					Couldn't end the poll.{" "}
					<button
						type="button"
						class="font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						onClick={() => props.onEndPoll()}
					>
						Retry
					</button>
				</p>
			</Show>
			<Show when={props.poll.undecryptableCount > 0}>
				<p class="mt-1 text-xs text-warning-text" role="status">
					{props.poll.undecryptableCount === 1
						? "1 vote couldn't be decrypted - results may be incomplete"
						: `${props.poll.undecryptableCount} votes couldn't be decrypted - results may be incomplete`}
				</p>
			</Show>
		</div>
	);
};
