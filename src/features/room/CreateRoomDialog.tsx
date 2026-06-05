import { useNavigate } from "@solidjs/router";
import { type MatrixClient, Preset, Visibility } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../client/client";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { trackAppModalOpen } from "../../stores/modalStack";
import { linkRoomToSpace } from "../space/spaceChildLink";
import { parseInvites } from "./inviteParsing";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Local-part of a Matrix room alias. Server adds ":server" + leading "#". */
const ALIAS_LOCAL_PART_RE = /^[A-Za-z0-9._=/+-]+$/;

interface CreateRoomDialogProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
	/**
	 * If set, the dialog shows an "Add to this space" checkbox (default
	 * checked) and, on submit, sends an `m.space.child` state event on the
	 * space pointing at the new room. Snapshotted at open time so route
	 * changes during submit don't redirect the child relation.
	 */
	spaceId?: string;
}

const CreateRoomDialog: Component<CreateRoomDialogProps> = (props) => {
	trackAppModalOpen(props.open);
	const navigate = useNavigate();
	const { optimisticallyMarkJoined } = useClient();

	let overlayRef!: HTMLDivElement;
	let nameRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;
	let mounted = true;
	/**
	 * Monotonic counter bumped on every reset (open transition). An async
	 * submit captures the value at start and verifies it after each await,
	 * so a close→reopen→new-submit cycle can't allow an earlier still-in-
	 * flight submit to commit side effects.
	 */
	let submitGeneration = 0;
	onCleanup(() => {
		mounted = false;
	});

	const titleId = createUniqueId();
	const aliasHintId = createUniqueId();
	const inviteHintId = createUniqueId();
	const errorId = createUniqueId();

	const [name, setName] = createSignal("");
	const [topic, setTopic] = createSignal("");
	const [alias, setAlias] = createSignal("");
	const [isPublic, setIsPublic] = createSignal(false);
	const [encryption, setEncryption] = createSignal(true);
	/** Once the user toggles encryption manually, stop auto-defaulting. */
	const [encryptionTouched, setEncryptionTouched] = createSignal(false);
	const [addToSpace, setAddToSpace] = createSignal(true);
	const [inviteRaw, setInviteRaw] = createSignal("");
	const [submitting, setSubmitting] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	/** spaceId captured at dialog-open time so route changes don't poison submit. */
	const [snapshotSpaceId, setSnapshotSpaceId] = createSignal<string | null>(
		null,
	);

	// Default encryption follows visibility (on for invite-only, off for
	// public) until the user manually toggles it.
	createEffect(() => {
		const pub = isPublic();
		if (!encryptionTouched()) {
			setEncryption(!pub);
		}
	});

	const selfId = createMemo(() => props.client.getUserId() ?? null);
	const parsedInvites = createMemo(() => parseInvites(inviteRaw(), selfId()));

	const trimmedAlias = createMemo(() => alias().trim());
	const aliasValid = createMemo(() => {
		const a = trimmedAlias();
		if (!a) return true;
		return ALIAS_LOCAL_PART_RE.test(a);
	});

	const homeserverDomain = createMemo(() => props.client.getDomain() ?? "");

	const canSubmit = createMemo(() => {
		if (submitting()) return false;
		if (name().trim().length === 0) return false;
		if (!aliasValid()) return false;
		if (parsedInvites().error) return false;
		return true;
	});

	function resetForm(): void {
		submitGeneration++;
		setName("");
		setTopic("");
		setAlias("");
		setIsPublic(false);
		setEncryption(true);
		setEncryptionTouched(false);
		setAddToSpace(true);
		setInviteRaw("");
		setError(null);
		setSubmitting(false);
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				resetForm();
				setSnapshotSpaceId(props.spaceId ?? null);
				queueMicrotask(() => nameRef?.focus());
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

	const tryClose = (): void => {
		if (submitting()) return;
		props.onClose();
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			tryClose();
			return;
		}
		if (e.key === "Tab") {
			const focusable = Array.from(
				overlayRef.querySelectorAll<HTMLElement>(FOCUSABLE),
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	};

	async function handleSubmit(e: Event): Promise<void> {
		e.preventDefault();
		if (!canSubmit()) return;
		const myGeneration = submitGeneration;
		setSubmitting(true);
		setError(null);
		const trimmedName = name().trim();
		const trimmedTopic = topic().trim();
		const aliasLocal = trimmedAlias();
		const pub = isPublic();
		const encrypt = encryption();
		const invites = parsedInvites().mxids;
		const capturedSpaceId = snapshotSpaceId();
		const shouldAddToSpace = capturedSpaceId !== null && addToSpace();

		try {
			const opts: Parameters<MatrixClient["createRoom"]>[0] = {
				name: trimmedName,
				visibility: pub ? Visibility.Public : Visibility.Private,
				preset: pub ? Preset.PublicChat : Preset.PrivateChat,
			};
			if (trimmedTopic) opts.topic = trimmedTopic;
			if (aliasLocal) opts.room_alias_name = aliasLocal;
			if (invites.length > 0) opts.invite = invites;
			if (encrypt) {
				opts.initial_state = [
					{
						type: "m.room.encryption",
						state_key: "",
						content: { algorithm: "m.megolm.v1.aes-sha2" },
					},
				];
			}
			const { room_id } = await props.client.createRoom(opts);
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;

			optimisticallyMarkJoined(room_id, {
				name: trimmedName,
				avatarUrl: null,
			});

			// Post-create space linking is best-effort: if it fails the room
			// was still created and the user is navigated into it; we just
			// log the failure to the console. Retrying the whole submit
			// would create a second room. Both sides of the relationship
			// (m.space.child on the parent + m.space.parent on the child) are
			// sent — see linkRoomToSpace.
			if (shouldAddToSpace && capturedSpaceId) {
				await linkRoomToSpace(props.client, capturedSpaceId, room_id);
			}

			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;

			if (shouldAddToSpace && capturedSpaceId) {
				navigate(
					`/space/${encodeURIComponent(capturedSpaceId)}/${encodeURIComponent(room_id)}`,
				);
			} else {
				navigate(`/home/${encodeURIComponent(room_id)}`);
			}
			props.onClose();
		} catch (err) {
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			const msg =
				err instanceof Error ? err.message : "Failed to create the room.";
			setError(msg);
			setSubmitting(false);
		}
	}

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
					if (e.target === e.currentTarget) tryClose();
				}}
			>
				<form
					class="my-auto max-h-full w-full max-w-md overflow-y-auto rounded-lg bg-surface-1 p-6 shadow-xl"
					onSubmit={handleSubmit}
				>
					<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
						Create room
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						A new room on your homeserver.
					</p>

					<label class="mb-3 block text-sm">
						<span class="mb-1 block font-medium text-text-secondary">Name</span>
						<input
							ref={nameRef}
							type="text"
							required
							maxLength={255}
							value={name()}
							onInput={(e) => setName(e.currentTarget.value)}
							disabled={submitting()}
							class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
							placeholder="general"
						/>
					</label>

					<label class="mb-3 block text-sm">
						<span class="mb-1 block font-medium text-text-secondary">
							Topic <span class="text-text-faint font-normal">(optional)</span>
						</span>
						<textarea
							rows={2}
							maxLength={1000}
							value={topic()}
							onInput={(e) => setTopic(e.currentTarget.value)}
							disabled={submitting()}
							class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
							placeholder="What's this room about?"
						/>
					</label>

					<label class="mb-3 block text-sm">
						<span class="mb-1 block font-medium text-text-secondary">
							Alias <span class="text-text-faint font-normal">(optional)</span>
						</span>
						<div class="flex items-center gap-1 rounded border border-border-subtle bg-surface-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-hover">
							<span class="pl-3 text-text-faint" aria-hidden="true">
								#
							</span>
							<input
								type="text"
								value={alias()}
								onInput={(e) => setAlias(e.currentTarget.value)}
								disabled={submitting()}
								aria-describedby={aliasHintId}
								aria-invalid={!aliasValid()}
								class="flex-1 bg-transparent py-2 text-text-primary placeholder-text-faint focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
								placeholder="general"
							/>
							<Show when={homeserverDomain()}>
								<span class="pr-3 text-text-faint" aria-hidden="true">
									:{homeserverDomain()}
								</span>
							</Show>
						</div>
						<span
							id={aliasHintId}
							class={`mt-1 block text-xs ${aliasValid() ? "text-text-faint" : "text-danger-text"}`}
						>
							<Show
								when={aliasValid()}
								fallback="Aliases may contain letters, numbers, and . _ = - / +"
							>
								Letters, numbers, and . _ = - / + only. Server adds the suffix.
							</Show>
						</span>
					</label>

					<fieldset class="mb-3 text-sm">
						<legend class="mb-1 font-medium text-text-secondary">
							Visibility
						</legend>
						<label class="mr-4 inline-flex items-center gap-2">
							<input
								type="radio"
								name="visibility"
								checked={!isPublic()}
								onChange={() => setIsPublic(false)}
								disabled={submitting()}
								class="accent-accent"
							/>
							<span class="text-text-primary">Invite-only</span>
						</label>
						<label class="inline-flex items-center gap-2">
							<input
								type="radio"
								name="visibility"
								checked={isPublic()}
								onChange={() => setIsPublic(true)}
								disabled={submitting()}
								class="accent-accent"
							/>
							<span class="text-text-primary">Public</span>
						</label>
					</fieldset>

					<label class="mb-3 inline-flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={encryption()}
							onChange={(e) => {
								setEncryptionTouched(true);
								setEncryption(e.currentTarget.checked);
							}}
							disabled={submitting()}
							class="accent-accent"
						/>
						<span class="text-text-primary">End-to-end encryption</span>
					</label>

					<Show when={snapshotSpaceId()}>
						<label class="mb-3 flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={addToSpace()}
								onChange={(e) => setAddToSpace(e.currentTarget.checked)}
								disabled={submitting()}
								class="accent-accent"
							/>
							<span class="text-text-primary">Add to this space</span>
						</label>
					</Show>

					<label class="mb-3 block text-sm">
						<span class="mb-1 block font-medium text-text-secondary">
							Invite users{" "}
							<span class="text-text-faint font-normal">(optional)</span>
						</span>
						<textarea
							rows={2}
							value={inviteRaw()}
							onInput={(e) => setInviteRaw(e.currentTarget.value)}
							disabled={submitting()}
							aria-describedby={inviteHintId}
							aria-invalid={parsedInvites().error !== null}
							class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
							placeholder="@alice:server, @bob:server"
						/>
						<span
							id={inviteHintId}
							class={`mt-1 block text-xs ${parsedInvites().error ? "text-danger-text" : "text-text-faint"}`}
						>
							<Show
								when={parsedInvites().error}
								fallback="Separate Matrix IDs with spaces, commas, or newlines."
							>
								{parsedInvites().error}
							</Show>
						</span>
					</label>

					<Show when={error()}>
						<div
							id={errorId}
							role="alert"
							class="mb-3 rounded border border-danger/30 bg-danger-bg/30 px-3 py-2 text-sm text-danger-text"
						>
							{error()}
						</div>
					</Show>

					<div class="mt-2 flex justify-end gap-2">
						<button
							type="button"
							onClick={tryClose}
							disabled={submitting()}
							class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!canSubmit()}
							class="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							<Show when={!submitting()} fallback="Creating…">
								Create
							</Show>
						</button>
					</div>
				</form>
			</div>
		</Show>
	);
};

export { CreateRoomDialog };
