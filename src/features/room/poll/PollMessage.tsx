import { useNavigate } from "@solidjs/router";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	on,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { Tooltip } from "../../../components/Tooltip";
import { formatVoterNames } from "../../../lib/pollCopy";
import { useThirtySecondTick } from "../../../lib/relativeTime";
import { createDecryptedObjectUrl } from "../composer/media/useDecryptedMedia";
import {
	type EventImage,
	type EventInfo,
	formatEventRelative,
	formatEventTime,
} from "./eventBlock";
import type { PollSnapshot, PollVoter } from "./pollSnapshot";

interface PollMessageProps {
	poll: PollSnapshot;
	/** Cast/change the local user's vote. Empty array = MSC3381 retraction
	 *  (spoiled ballot); only reachable for multi-select polls. */
	onVote: (answerIds: string[]) => void;
	/** Close the poll. Only invoked when the snapshot says canEnd. */
	onEndPoll: () => void;
}

/** Cap on rendered avatars per RSVP option; the rest collapse into "+N". */
const MAX_VOTER_AVATARS = 6;

/** 20px voter avatar for the event RSVP stacks (#418): image with the
 *  same error-fallback-to-initial policy as the shared Avatar, at the
 *  smaller size the compact row needs. The ring matches the card surface
 *  so overlapping avatars read as a Discord-style stack. Exported for
 *  direct unit tests of the error/reset behaviour. */
export const VoterAvatar: Component<{ voter: PollVoter }> = (props) => {
	const [imgFailed, setImgFailed] = createSignal(false);
	// Reset on voter identity as well as URL: <For> keys on the voter
	// object, and the watcher's identity cache keeps one object per
	// userId, but two different voters can legitimately share an avatar
	// URL string - without userId in the sources that swap would keep
	// the failed fallback stuck on.
	createEffect(
		on([() => props.voter.userId, () => props.voter.avatarUrl], () =>
			setImgFailed(false),
		),
	);
	const initial = () =>
		// The name falls back to the raw user id; strip its leading @ like
		// the MemberList sibling does so avatar-less voters get a letter.
		(props.voter.name.trim().replace(/^@/, "").charAt(0) || "?").toUpperCase();
	return (
		<Show
			when={!imgFailed() && props.voter.avatarUrl}
			fallback={
				<div
					class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-[10px] text-text-secondary ring-2 ring-surface-2"
					aria-hidden="true"
				>
					{initial()}
				</div>
			}
		>
			{(url) => (
				<img
					src={url()}
					alt=""
					class="h-5 w-5 shrink-0 rounded-full object-cover ring-2 ring-surface-2"
					loading="lazy"
					onError={() => setImgFailed(true)}
				/>
			)}
		</Show>
	);
};

/** The selected-vote check + screen-reader marker shared by the standard
 *  poll list and the compact event RSVP row. */
const VoteCheck: Component = () => (
	<>
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
	</>
);

/**
 * Cover image for an event card (#418). Resolves the mxc URL (plain rooms)
 * or decrypts via the shared attachment path (E2EE), reserving the exact
 * layout box from info.w/h while loading so the card never shifts. Any
 * failure renders nothing - an event without its image is still a complete
 * card, and the poll fallback is unaffected.
 */
const EventCoverImage: Component<{
	image: EventImage;
	alt: string;
}> = (props) => {
	const { client } = useClient();
	const MAX_W = 400;
	const MAX_H = 160;
	const httpUrl = createMemo(() =>
		props.image.url
			? // Ask the server for a scaled variant - the card caps display at
				// MAX_W x MAX_H, so fetching the original is wasted bandwidth.
				// (Encrypted attachments can't be server-scaled.)
				client.mxcUrlToHttp(props.image.url, MAX_W, MAX_H, "scale")
			: null,
	);
	const cipherUrl = createMemo(() =>
		props.image.file ? client.mxcUrlToHttp(props.image.file.url) : null,
	);
	const decrypted = createDecryptedObjectUrl(
		cipherUrl,
		() => props.image.file,
		() => props.image.info.mimetype,
	);
	const src = createMemo(() =>
		props.image.file ? decrypted.url() : httpUrl(),
	);
	// Fail closed on fetch/decode errors (404, network, bad bytes): the
	// browser would otherwise paint a broken-image icon inside the card.
	// Keyed to src() so an edited event with a fresh image resets the
	// error state instead of staying blank forever.
	const [loadFailedSrc, setLoadFailedSrc] = createSignal<string | null>(null);
	const loadFailed = createMemo(() => {
		const s = src();
		return s !== null && s === loadFailedSrc();
	});
	const failed = createMemo(
		() =>
			loadFailed() ||
			((props.image.file ? !cipherUrl() || decrypted.failed() : !httpUrl()) ??
				true),
	);
	// Cap the box like Discord's event banners; w/h reserve the ratio.
	const box = createMemo(() => {
		const { w, h } = props.image.info;
		const scale = Math.min(MAX_W / w, MAX_H / h, 1);
		return {
			width: `${Math.round(w * scale)}px`,
			height: `${Math.round(h * scale)}px`,
		};
	});
	return (
		// The reserved box renders while the image loads so the card never
		// shifts when it lands. On failure the image (and its box) is
		// simply absent - the card is complete without it, and the poll
		// fallback is unaffected.
		<Show when={!failed()}>
			<Show
				when={src()}
				keyed
				fallback={
					<div
						style={box()}
						class="mb-2 flex items-center justify-center rounded bg-surface-3 text-xs text-text-disabled"
						aria-busy="true"
					>
						Loading…
					</div>
				}
			>
				{(url) => (
					<img
						src={url}
						alt={props.alt}
						width={props.image.info.w}
						height={props.image.info.h}
						style={box()}
						class="mb-2 block rounded object-cover"
						loading="lazy"
						// Capture the URL bound to THIS img (keyed Show passes the
						// plain value, not a live accessor) so a late error event
						// can't mark a freshly edited image's new src as failed.
						onError={() => setLoadFailedSrc(url)}
					/>
				)}
			</Show>
		</Show>
	);
};

/**
 * Event-card chrome (#418) around the standard poll vote UI: title,
 * viewer-local start time, a live relative line, and the target room as a
 * navigation pill. Rendered only for polls carrying a validated event
 * block; everything malformed degrades to the plain poll presentation.
 */
const EventCardHeader: Component<{ event: EventInfo }> = (props) => {
	const navigate = useNavigate();
	const { client } = useClient();
	// Shared 30s ticker (one interval for the whole timeline, ref-counted)
	// rather than a per-card setInterval.
	const now = useThirtySecondTick();

	const roomName = createMemo(() => {
		const id = props.event.roomId;
		if (!id) return null;
		// Trimmed like every other room-name label in the app: a
		// whitespace-only name must not render as a blank pill.
		return client.getRoom(id)?.name?.trim() || null;
	});

	return (
		<div class="mb-2">
			<Show when={props.event.image}>
				{(image) => <EventCoverImage image={image()} alt={props.event.title} />}
			</Show>
			<div class="flex items-start gap-2">
				<svg
					class="mt-0.5 h-4 w-4 shrink-0 text-accent-text"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="3" y="4" width="18" height="18" rx="2" />
					<path d="M16 2v4" />
					<path d="M8 2v4" />
					<path d="M3 10h18" />
				</svg>
				<div class="min-w-0">
					<p class="break-words text-sm font-semibold text-text-emphasis">
						{props.event.title}
					</p>
					<p class="text-xs text-text-secondary">
						{formatEventTime(props.event.startTs)}
						{" · "}
						<span class="text-accent-text">
							{formatEventRelative(
								props.event.startTs,
								props.event.endTs,
								now(),
							)}
						</span>
					</p>
					<Show when={props.event.roomId}>
						{(roomId) => (
							<button
								type="button"
								class="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-surface-3 px-2 py-0.5 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								title={roomId()}
								onClick={() =>
									// No /room route exists; /home/:roomId is the canonical
									// room path (DMs canonicalize/redirect from there).
									navigate(`/home/${encodeURIComponent(roomId())}`)
								}
							>
								<svg
									class="h-3 w-3 shrink-0"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M11 5 6 9H2v6h4l5 4V5z" />
									<path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
								</svg>
								<span class="truncate">{roomName() ?? roomId()}</span>
							</button>
						)}
					</Show>
				</div>
			</div>
		</div>
	);
};

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
			<Show when={props.poll.event}>
				{(event) => <EventCardHeader event={event()} />}
			</Show>
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
			<Show
				when={props.poll.event}
				fallback={
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
												isMultiSelect() && !props.poll.isEnded
													? hintId
													: undefined
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
														<VoteCheck />
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
														width: showResults()
															? `${percent(count())}%`
															: "0%",
													}}
												/>
											</span>
										</button>
									</li>
								);
							}}
						</For>
					</ul>
				}
			>
				{/* Event cards (#418): the fixed Going/Maybe/Can't answers render
			    as one compact row - a count per option, no percentages or
			    bars - with the voters' avatars stacked under each option. */}
				<ul
					class="mt-2 flex items-stretch gap-2"
					aria-label="Poll options"
					role={isMultiSelect() ? "group" : "radiogroup"}
					onKeyDown={onGroupKeyDown}
				>
					<For each={props.poll.answers}>
						{(answer) => {
							const count = () => props.poll.counts[answer.id];
							const isMine = () => props.poll.myAnswers.includes(answer.id);
							const capLocked = () =>
								isMultiSelect() &&
								!isMine() &&
								props.poll.myAnswers.length >= props.poll.maxSelections;
							const locked = () => votingDisabled() || capLocked();
							// voters is zero-filled for every answer id (see
							// PollSnapshot.voters), so direct indexing is safe.
							const voters = () => props.poll.voters[answer.id];
							const shownVoters = () => voters().slice(0, MAX_VOTER_AVATARS);
							// The snapshot caps voters at MAX_VOTER_NAMES; counts
							// carries the true total, so "+N" derives from it (also
							// avoids copying the array just to measure overflow).
							const overflowCount = () => count() - shownVoters().length;
							const voterNamesLabel = () =>
								formatVoterNames(
									voters().map((v) => v.name),
									count(),
								);
							return (
								<li class="min-w-0 flex-1">
									{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the
								    role is dynamically "radio" or "checkbox", both of which
								    support aria-checked; Biome can only see the implicit
								    button role through the conditional expression. */}
									<button
										type="button"
										role={isMultiSelect() ? "checkbox" : "radio"}
										aria-checked={isMine()}
										aria-disabled={locked()}
										aria-describedby={
											isMultiSelect() && !props.poll.isEnded
												? hintId
												: undefined
										}
										tabindex={
											isMultiSelect() || rovingId() === answer.id ? 0 : -1
										}
										class={`flex w-full items-center justify-between gap-1 rounded-md border px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover ${
											isMine()
												? "border-accent/60 bg-accent/10 text-text-primary"
												: "border-border-subtle bg-surface-3/50 text-text-secondary"
										} ${locked() ? "cursor-default" : "hover:border-border-strong hover:text-text-primary"}`}
										onClick={() => {
											if (!capLocked()) toggleAnswer(answer.id);
										}}
									>
										<span class="min-w-0 truncate" title={answer.text}>
											{answer.text}
											<Show when={isMine()}>
												<VoteCheck />
											</Show>
										</span>
										<Show when={showResults()}>
											<span class="shrink-0 text-xs tabular-nums text-text-muted">
												{count()}
											</span>
										</Show>
									</button>
									{/* The stack row is always rendered while results are
									    visible (filled or empty) so its geometry is reserved
									    before the async relations fetch lands - the same
									    no-layout-shift rule the plain list's bar track
									    follows. */}
									<Show when={showResults()}>
										<div class="mt-1 flex h-5 items-center">
											<Show when={voters().length > 0}>
												{/* One tooltip per stack (Discord-reaction style):
												    hover or focus anywhere on the stack lists every
												    voter. triggerTabIndex makes it keyboard-reachable
												    without a tab stop per avatar. */}
												<Tooltip
													content={voterNamesLabel()}
													triggerTabIndex={0}
													triggerClass="flex items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
												>
													{/* The tooltip is live-region-only while open,
													    so keep the names reachable to AT as text. */}
													<span class="sr-only">{voterNamesLabel()}</span>
													<span class="flex -space-x-1.5">
														<For each={shownVoters()}>
															{(voter) => <VoterAvatar voter={voter} />}
														</For>
													</span>
													<Show when={overflowCount() > 0}>
														<span class="ml-1 text-xs text-text-muted">
															+{overflowCount()}
														</span>
													</Show>
												</Tooltip>
											</Show>
										</div>
									</Show>
								</li>
							);
						}}
					</For>
				</ul>
			</Show>
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
