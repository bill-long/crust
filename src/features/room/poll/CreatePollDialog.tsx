import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { trapTabKey } from "../../../lib/focusTrap";
import { cryptoDialogOpen } from "../../../stores/cryptoActions";
import { trackAppModalOpen } from "../../../stores/modalStack";
import {
	POLL_KIND_DISCLOSED,
	POLL_KIND_UNDISCLOSED,
	PollStartEvent,
	sendSerializedPollEvent,
} from "./pollSdk";

/** MSC3381 caps a poll at 20 answers (the SDK serializer truncates beyond). */
const MAX_ANSWERS = 20;
const MIN_ANSWERS = 2;

interface CreatePollDialogProps {
	client: MatrixClient;
	roomId: string;
	open: () => boolean;
	onClose: () => void;
}

interface AnswerRow {
	text: string;
}

/**
 * Modal for composing an MSC3381 poll, modeled on CreateRoomDialog's
 * stay-mounted dialog pattern (open accessor + <Show> gate, focus trap,
 * Escape, reset-on-open, focus restore).
 *
 * Submit is optimistic like a message send: the poll start event is
 * dispatched fire-and-forget and the dialog closes immediately - the local
 * echo renders the poll in the timeline (read-only until confirmed), and a
 * failed send surfaces through the timeline's existing NOT_SENT
 * retry/discard affordances rather than a dialog error state.
 */
const CreatePollDialog: Component<CreatePollDialogProps> = (props) => {
	trackAppModalOpen(props.open);

	let overlayRef!: HTMLDivElement;
	let questionRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const titleId = createUniqueId();
	const maxSelectionsId = createUniqueId();

	const [question, setQuestion] = createSignal("");
	const [answers, setAnswers] = createStore<AnswerRow[]>([]);
	const [showLive, setShowLive] = createSignal(true);
	const [multiSelect, setMultiSelect] = createSignal(false);
	/** Raw field text, not eagerly clamped: binding the input to a clamped
	 *  memo would rewrite intermediate keystrokes (typing "10" becomes "2"
	 *  after the "1"), silently submitting a different cap than typed.
	 *  Native min/max constraints validate; the clamp applies at submit. */
	const [maxSelectionsRaw, setMaxSelectionsRaw] = createSignal("2");
	/** roomId captured at dialog-open time: the composer is one reused
	 *  instance across room switches, so props.roomId at submit time could
	 *  point at a different room than the one the user composed the poll
	 *  for (same race CreateRoomDialog snapshots spaceId against). */
	const [snapshotRoomId, setSnapshotRoomId] = createSignal("");

	const validAnswers = createMemo(() =>
		answers.map((a) => a.text.trim()).filter((text) => text.length > 0),
	);
	const canSubmit = createMemo(
		() => question().trim().length > 0 && validAnswers().length >= MIN_ANSWERS,
	);
	/** Upper bound for the multi-select cap: the usable answer count. */
	const answerCap = createMemo(() =>
		Math.max(validAnswers().length, MIN_ANSWERS),
	);
	/** Effective cap at submit: the raw field clamped into 2..answerCap. */
	const maxSelections = createMemo(() =>
		Math.min(
			Math.max(
				MIN_ANSWERS,
				Math.floor(Number(maxSelectionsRaw())) || MIN_ANSWERS,
			),
			answerCap(),
		),
	);

	function resetForm(): void {
		setQuestion("");
		setAnswers([{ text: "" }, { text: "" }]);
		setShowLive(true);
		setMultiSelect(false);
		setMaxSelectionsRaw("2");
	}

	/** Focus an option input by 1-based position, post-render. */
	function focusOption(position: number): void {
		queueMicrotask(() => {
			overlayRef
				.querySelector<HTMLInputElement>(`[aria-label="Option ${position}"]`)
				?.focus();
		});
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				resetForm();
				setSnapshotRoomId(props.roomId);
				queueMicrotask(() => questionRef?.focus());
			} else if (!isOpen && wasOpen) {
				if (previousFocus && document.body.contains(previousFocus)) {
					previousFocus.focus();
				}
				previousFocus = null;
			}
		}),
	);

	onCleanup(() => {
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
		previousFocus = null;
	});

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			props.onClose();
			return;
		}
		if (e.key === "Tab") {
			trapTabKey(overlayRef, e);
		}
	};

	const handleSubmit = (e: SubmitEvent): void => {
		e.preventDefault();
		if (!canSubmit()) return;
		const poll = PollStartEvent.from(
			question().trim(),
			validAnswers(),
			showLive() ? POLL_KIND_DISCLOSED : POLL_KIND_UNDISCLOSED,
			multiSelect() ? maxSelections() : 1,
		);
		// Fire-and-forget, like a message send: the local echo renders the
		// poll immediately and a failure surfaces via the timeline's
		// NOT_SENT retry affordances. The console.error mirrors the
		// reaction-send precedent. Sends to the open-time room snapshot.
		const roomId = snapshotRoomId();
		sendSerializedPollEvent(props.client, roomId, poll).catch(
			(err: unknown) => {
				console.error(`Poll create failed in ${roomId}:`, err);
			},
		);
		props.onClose();
	};

	return (
		<Show when={props.open()}>
			<div
				ref={overlayRef}
				class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				inert={cryptoDialogOpen() || undefined}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				onClick={(e) => {
					if (e.target === e.currentTarget) props.onClose();
				}}
			>
				<form
					class="my-auto max-h-full w-full max-w-md overflow-y-auto rounded-lg bg-surface-1 p-6 shadow-xl"
					onSubmit={handleSubmit}
				>
					<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
						Create poll
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						Ask the room a question with fixed answer options.
					</p>

					<label class="mb-3 block text-sm">
						<span class="mb-1 block font-medium text-text-secondary">
							Question
						</span>
						<input
							ref={questionRef}
							type="text"
							required
							maxLength={340}
							value={question()}
							onInput={(e) => setQuestion(e.currentTarget.value)}
							class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							placeholder="What should we have for lunch?"
						/>
					</label>

					<fieldset class="mb-3">
						<legend class="mb-1 block text-sm font-medium text-text-secondary">
							Options
						</legend>
						<div class="flex flex-col gap-2">
							<For each={answers}>
								{(answer, index) => (
									<div class="flex items-center gap-2">
										<input
											type="text"
											maxLength={340}
											value={answer.text}
											onInput={(e) =>
												setAnswers(index(), "text", e.currentTarget.value)
											}
											aria-label={`Option ${index() + 1}`}
											class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
											placeholder={`Option ${index() + 1}`}
										/>
										<Show when={answers.length > MIN_ANSWERS}>
											<button
												type="button"
												class="rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
												aria-label={`Remove option ${index() + 1}`}
												onClick={() => {
													const removed = index();
													setAnswers((rows) =>
														rows.filter((_, i) => i !== removed),
													);
													// The focused Remove button just left the
													// DOM; keep keyboard focus inside the trap
													// by moving to the row that took its place
													// (or the new last row).
													focusOption(Math.min(removed + 1, answers.length));
												}}
											>
												<svg
													class="h-4 w-4"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													aria-hidden="true"
												>
													<path d="M18 6 6 18" />
													<path d="m6 6 12 12" />
												</svg>
											</button>
										</Show>
									</div>
								)}
							</For>
						</div>
						<button
							type="button"
							class="mt-2 rounded px-1 text-sm text-accent-text transition-colors hover:text-accent-text-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
							disabled={answers.length >= MAX_ANSWERS}
							onClick={() => {
								setAnswers(answers.length, { text: "" });
								// Focus the new row; also keeps focus in the trap when
								// this button self-disables at the answer cap.
								focusOption(answers.length);
							}}
						>
							+ Add option
						</button>
					</fieldset>

					<label class="mb-2 flex items-center gap-2 text-sm text-text-primary">
						<input
							type="checkbox"
							checked={showLive()}
							onChange={(e) => setShowLive(e.currentTarget.checked)}
							class="accent-accent"
						/>
						Show results while voting
					</label>

					<label class="mb-2 flex items-center gap-2 text-sm text-text-primary">
						<input
							type="checkbox"
							checked={multiSelect()}
							onChange={(e) => setMultiSelect(e.currentTarget.checked)}
							class="accent-accent"
						/>
						Allow choosing multiple answers
					</label>
					<Show when={multiSelect()}>
						<label
							class="mb-3 ml-6 flex items-center gap-2 text-sm text-text-secondary"
							for={maxSelectionsId}
						>
							Up to
							<input
								id={maxSelectionsId}
								type="number"
								required
								min={MIN_ANSWERS}
								max={answerCap()}
								value={maxSelectionsRaw()}
								onInput={(e) => setMaxSelectionsRaw(e.currentTarget.value)}
								class="w-16 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-text-primary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							/>
							answers
						</label>
					</Show>

					<div class="mt-4 flex justify-end gap-2">
						<button
							type="button"
							onClick={() => props.onClose()}
							class="rounded px-4 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:min-h-11"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!canSubmit()}
							class="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60 any-pointer-coarse:min-h-11"
						>
							Create poll
						</button>
					</div>
				</form>
			</div>
		</Show>
	);
};

export { CreatePollDialog };
