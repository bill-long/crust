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
import { trapTabKey } from "../../../lib/focusTrap";
import { cryptoDialogOpen } from "../../../stores/cryptoActions";
import { trackAppModalOpen } from "../../../stores/modalStack";
import { uploadEventImage } from "../composer/media/uploadMedia";
import {
	buildEventBlock,
	buildEventQuestion,
	EVENT_ANSWERS,
	EVENT_BLOCK_KEY,
} from "./eventBlock";
import {
	POLL_KIND_DISCLOSED,
	PollStartEvent,
	sendSerializedPollEvent,
} from "./pollSdk";

interface CreateEventDialogProps {
	client: MatrixClient;
	roomId: string;
	open: () => boolean;
	onClose: () => void;
}

/** One pickable target room for the event's location. */
interface RoomChoice {
	roomId: string;
	name: string;
}

/**
 * Modal for composing an event card (#418): a disclosed MSC3381 poll with
 * fixed Going/Maybe/Can't answers plus the namespaced event block. The
 * poll's question text carries the human-readable time so every other
 * client renders a usable poll; Crust renders the card.
 *
 * Unlike CreatePollDialog, submit is NOT fire-and-forget when a cover
 * image is attached: the image must upload first (the event references
 * the resulting mxc/EncryptedFile), so the dialog shows a sending state
 * and stays open on upload failure with a retry. Without an image it
 * follows the same optimistic close pattern as polls.
 */
const CreateEventDialog: Component<CreateEventDialogProps> = (props) => {
	trackAppModalOpen(props.open);

	let overlayRef!: HTMLDivElement;
	let titleRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;
	let imageInputRef: HTMLInputElement | undefined;

	const titleId = createUniqueId();

	const [title, setTitle] = createSignal("");
	/** datetime-local field values (wall time in the viewer's timezone;
	 *  parsed to epoch ms at submit). */
	const [startRaw, setStartRaw] = createSignal("");
	const [endRaw, setEndRaw] = createSignal("");
	const [roomQuery, setRoomQuery] = createSignal("");
	const [chosenRoomId, setChosenRoomId] = createSignal<string | null>(null);
	const [imageFile, setImageFile] = createSignal<File | null>(null);
	const [imagePreviewUrl, setImagePreviewUrl] = createSignal<string | null>(
		null,
	);
	const [sending, setSending] = createSignal(false);
	const [sendError, setSendError] = createSignal<string | null>(null);
	const [snapshotRoomId, setSnapshotRoomId] = createSignal("");

	/** Joined, non-DM, non-space rooms as location candidates. Spaces are
	 *  structural containers, not event venues. Gated on the dialog being
	 *  open: memos evaluate eagerly, and enumerating every room (plus its
	 *  membership counts) on each composer mount is wasted work for a
	 *  dialog that usually stays closed. */
	const roomChoices = createMemo<RoomChoice[]>(() => {
		if (!props.open()) return [];
		const choices: RoomChoice[] = [];
		for (const room of props.client.getRooms()) {
			if (room.isSpaceRoom()) continue;
			if (room.getMyMembership() !== "join") continue;
			// DMs are 1:1 conversations; an event "in" a DM makes no sense as
			// a shared location.
			if (room.getInvitedAndJoinedMemberCount() <= 2) continue;
			// Trimmed like every other room-name label in the app: a
			// whitespace-only name falls back to the room id rather than
			// rendering as a blank, selectable row.
			const name = room.name?.trim() || room.roomId;
			choices.push({ roomId: room.roomId, name });
		}
		choices.sort((a, b) => a.name.localeCompare(b.name));
		return choices;
	});
	const filteredRooms = createMemo(() => {
		const q = roomQuery().trim().toLowerCase();
		const all = roomChoices();
		if (!q) return all.slice(0, 8);
		return all.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 8);
	});
	const chosenRoomName = createMemo(() => {
		const id = chosenRoomId();
		if (!id) return null;
		return (
			roomChoices().find((r) => r.roomId === id)?.name ??
			(props.client.getRoom(id)?.name?.trim() || id)
		);
	});

	const startTs = createMemo(() => {
		const ms = new Date(startRaw()).getTime();
		return Number.isFinite(ms) ? ms : null;
	});
	const endTs = createMemo(() => {
		if (!endRaw()) return null;
		const ms = new Date(endRaw()).getTime();
		return Number.isFinite(ms) ? ms : null;
	});
	const canSubmit = createMemo(() => {
		const start = startTs();
		const end = endTs();
		return (
			title().trim().length > 0 &&
			start !== null &&
			(end === null || end > start) &&
			!sending()
		);
	});

	function clearImage(): void {
		const url = imagePreviewUrl();
		if (url) URL.revokeObjectURL(url);
		setImagePreviewUrl(null);
		setImageFile(null);
		if (imageInputRef) imageInputRef.value = "";
	}

	function resetForm(): void {
		setTitle("");
		setStartRaw("");
		setEndRaw("");
		setRoomQuery("");
		setChosenRoomId(null);
		clearImage();
		setSending(false);
		setSendError(null);
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				resetForm();
				setSnapshotRoomId(props.roomId);
				queueMicrotask(() => titleRef?.focus());
			} else if (!isOpen && wasOpen) {
				clearImage();
				if (previousFocus && document.body.contains(previousFocus)) {
					previousFocus.focus();
				}
				previousFocus = null;
			}
		}),
	);
	onCleanup(() => {
		clearImage();
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
		previousFocus = null;
	});

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			if (!sending()) props.onClose();
			return;
		}
		if (e.key === "Tab") {
			trapTabKey(overlayRef, e);
		}
	};

	const onImageChosen = (e: Event): void => {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (!file.type.startsWith("image/")) {
			setSendError("Cover image must be an image file.");
			input.value = "";
			return;
		}
		clearImage();
		setImageFile(file);
		setImagePreviewUrl(URL.createObjectURL(file));
		setSendError(null);
	};

	const handleSubmit = async (e: SubmitEvent): Promise<void> => {
		e.preventDefault();
		if (!canSubmit()) return;
		const roomId = snapshotRoomId();
		const start = startTs();
		if (start === null) return;
		setSendError(null);

		// The cover image must upload before the event exists on the wire
		// (the block references its mxc/EncryptedFile), so an imaged event
		// can't use the poll dialog's fire-and-forget close.
		let image: Awaited<ReturnType<typeof uploadEventImage>> | null = null;
		const picked = imageFile();
		if (picked) {
			setSending(true);
			try {
				image = await uploadEventImage(props.client, roomId, picked);
			} catch (err) {
				setSending(false);
				setSendError(
					err instanceof Error
						? err.message
						: "Couldn't upload the cover image.",
				);
				return;
			}
		}

		const blockInput = {
			title: title().trim(),
			startTs: start,
			endTs: endTs(),
			roomId: chosenRoomId(),
			image,
		};
		const poll = PollStartEvent.from(
			buildEventQuestion({
				title: blockInput.title,
				startTs: start,
				roomName: chosenRoomName(),
			}),
			[...EVENT_ANSWERS],
			POLL_KIND_DISCLOSED,
			1,
		);
		// Fire-and-forget send like a message: the local echo renders the
		// card and failures surface through the timeline NOT_SENT retry.
		sendSerializedPollEvent(props.client, roomId, poll, {
			[EVENT_BLOCK_KEY]: buildEventBlock(blockInput),
		}).catch((err: unknown) => {
			console.error(`Event create failed in ${roomId}:`, err);
		});
		setSending(false);
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
					if (e.target === e.currentTarget && !sending()) props.onClose();
				}}
			>
				<form
					class="my-auto max-h-full w-full max-w-md overflow-y-auto rounded-lg bg-surface-1 p-6 shadow-xl"
					onSubmit={handleSubmit}
				>
					<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
						Create event
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						A card in chat with the time, place, and RSVPs.
					</p>

					<label class="mb-3 block text-sm">
						<span class="mb-1 block font-medium text-text-secondary">
							Title
						</span>
						<input
							ref={titleRef}
							type="text"
							required
							maxLength={140}
							value={title()}
							onInput={(e) => setTitle(e.currentTarget.value)}
							class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							placeholder="Game night"
						/>
					</label>

					<div class="mb-3 flex gap-3">
						<label class="block min-w-0 flex-1 text-sm">
							<span class="mb-1 block font-medium text-text-secondary">
								Starts
							</span>
							<input
								type="datetime-local"
								required
								value={startRaw()}
								onInput={(e) => setStartRaw(e.currentTarget.value)}
								class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							/>
						</label>
						<label class="block min-w-0 flex-1 text-sm">
							<span class="mb-1 block font-medium text-text-secondary">
								Ends <span class="text-text-faint">(optional)</span>
							</span>
							<input
								type="datetime-local"
								value={endRaw()}
								min={startRaw() || undefined}
								onInput={(e) => setEndRaw(e.currentTarget.value)}
								class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							/>
						</label>
					</div>

					<fieldset class="mb-3">
						<legend class="mb-1 block text-sm font-medium text-text-secondary">
							Location <span class="text-text-faint">(optional)</span>
						</legend>
						<Show
							when={chosenRoomId() === null}
							fallback={
								<div class="flex items-center gap-2">
									<span class="min-w-0 flex-1 truncate rounded border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary">
										{chosenRoomName()}
									</span>
									<button
										type="button"
										class="rounded px-2 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
										onClick={() => setChosenRoomId(null)}
									>
										Change
									</button>
								</div>
							}
						>
							<input
								type="text"
								value={roomQuery()}
								onInput={(e) => setRoomQuery(e.currentTarget.value)}
								placeholder="Search rooms…"
								aria-label="Search rooms for the event location"
								class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							/>
							<Show when={filteredRooms().length > 0}>
								<ul
									class="mt-1 max-h-40 overflow-y-auto rounded border border-border-subtle bg-surface-2"
									aria-label="Matching rooms"
								>
									<For each={filteredRooms()}>
										{(room) => (
											<li>
												<button
													type="button"
													class="w-full truncate px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
													onClick={() => {
														setChosenRoomId(room.roomId);
														setRoomQuery("");
													}}
												>
													{room.name}
												</button>
											</li>
										)}
									</For>
								</ul>
							</Show>
						</Show>
					</fieldset>

					<div class="mb-3">
						<span class="mb-1 block text-sm font-medium text-text-secondary">
							Cover image <span class="text-text-faint">(optional)</span>
						</span>
						<Show
							when={imagePreviewUrl()}
							fallback={
								<button
									type="button"
									class="rounded border border-dashed border-border-default px-3 py-2 text-sm text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={() => imageInputRef?.click()}
								>
									Choose an image…
								</button>
							}
						>
							{(url) => (
								<div class="flex items-center gap-3">
									<img
										src={url()}
										alt="Selected cover preview"
										class="h-16 w-28 rounded object-cover"
									/>
									<button
										type="button"
										class="rounded px-1 text-sm text-text-muted transition-colors hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
										onClick={clearImage}
									>
										Remove
									</button>
								</div>
							)}
						</Show>
						<input
							ref={imageInputRef}
							type="file"
							accept="image/*"
							class="hidden"
							aria-hidden="true"
							tabIndex={-1}
							onChange={onImageChosen}
						/>
					</div>

					<Show when={sendError()}>
						{(msg) => (
							<p class="mb-3 text-sm text-danger-text" role="alert">
								{msg()}
							</p>
						)}
					</Show>

					<div class="mt-4 flex justify-end gap-2">
						<button
							type="button"
							disabled={sending()}
							onClick={() => props.onClose()}
							class="rounded px-4 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60 any-pointer-coarse:min-h-11"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!canSubmit()}
							class="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60 any-pointer-coarse:min-h-11"
						>
							{sending() ? "Uploading…" : "Create event"}
						</button>
					</div>
				</form>
			</div>
		</Show>
	);
};

export { CreateEventDialog };
