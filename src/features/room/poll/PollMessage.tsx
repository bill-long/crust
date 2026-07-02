import { type Component, createMemo, For, Show } from "solid-js";
import type { PollSnapshot } from "./pollSnapshot";

interface PollMessageProps {
	poll: PollSnapshot;
}

/**
 * Timeline renderer for an MSC3381 poll, driven entirely by the projected
 * {@link PollSnapshot} (no SDK access). Read-only for now: it shows the
 * question, options, and live tallies for polls sent from other clients;
 * voting and closing land in a follow-up.
 *
 * Result visibility follows the poll kind: disclosed polls show counts and
 * bars live, undisclosed polls hide them until the poll ends. The bar track
 * is always rendered (zero-width fill while hidden) so revealing results
 * never shifts layout.
 */
export const PollMessage: Component<PollMessageProps> = (props) => {
	const showResults = createMemo(
		() => props.poll.kind === "disclosed" || props.poll.isEnded,
	);
	const maxCount = createMemo(() => {
		let max = 0;
		for (const answer of props.poll.answers) {
			const count = props.poll.counts[answer.id] ?? 0;
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

	return (
		<div class="max-w-md rounded-lg border border-border-subtle bg-surface-2 p-3">
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
					<p class="text-xs text-text-muted">{statusLine()}</p>
				</div>
			</div>
			<ul class="mt-2 flex flex-col gap-2" aria-label="Poll options">
				<For each={props.poll.answers}>
					{(answer) => {
						const count = () => props.poll.counts[answer.id] ?? 0;
						const isMine = () => props.poll.myAnswers.includes(answer.id);
						const isWinner = () =>
							props.poll.isEnded && count() > 0 && count() === maxCount();
						return (
							<li>
								<div class="flex items-baseline justify-between gap-2 text-sm">
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
								</div>
								<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
									<div
										class="h-full rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
										style={{
											width: showResults() ? `${percent(count())}%` : "0%",
										}}
									/>
								</div>
							</li>
						);
					}}
				</For>
			</ul>
			<p class="mt-2 text-xs text-text-muted">{votesLine()}</p>
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
