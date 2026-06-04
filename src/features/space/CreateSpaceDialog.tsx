import { useNavigate } from "@solidjs/router";
import {
	EventType,
	type MatrixClient,
	Preset,
	RoomType,
	Visibility,
} from "matrix-js-sdk";
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
import { validateMatrixUserId } from "../room/inviteValidation";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Local-part of a Matrix room alias. Server adds ":server" + leading "#". */
const ALIAS_LOCAL_PART_RE = /^[A-Za-z0-9._=/+-]+$/;

const MAX_AVATAR_BYTES = 10 * 1024 * 1024; // 10 MB (matches AccountTab/GeneralTab)

interface CreateSpaceDialogProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
}

interface ParsedInvites {
	mxids: string[];
	error: string | null;
}

function parseInvites(raw: string, selfId: string | null): ParsedInvites {
	const tokens = raw
		.split(/[\s,;]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (tokens.length === 0) return { mxids: [], error: null };
	const out = new Set<string>();
	for (const tok of tokens) {
		const r = validateMatrixUserId(tok);
		if (!r.ok) return { mxids: [], error: `${tok}: ${r.error}` };
		if (r.userId === selfId) continue;
		out.add(r.userId);
	}
	return { mxids: Array.from(out), error: null };
}

const CreateSpaceDialog: Component<CreateSpaceDialogProps> = (props) => {
	trackAppModalOpen(props.open);
	const navigate = useNavigate();
	const { optimisticallyMarkJoined } = useClient();

	let overlayRef!: HTMLDivElement;
	let nameRef: HTMLInputElement | undefined;
	let fileInputRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;
	let mounted = true;
	/**
	 * Monotonic counter bumped on every reset (open transition). An async
	 * submit captures the value at start and verifies it after each await,
	 * so a close→reopen→new-submit cycle can't allow an earlier still-in-
	 * flight submit to commit side effects.
	 */
	let submitGeneration = 0;
	/**
	 * Separate counter for avatar uploads. Bumped on every file selection
	 * AND on every form reset, so a stale upload that resolves after the
	 * user picks a different file or reopens the dialog cannot overwrite
	 * the current avatar mxc.
	 */
	let uploadGeneration = 0;
	onCleanup(() => {
		mounted = false;
	});

	const titleId = createUniqueId();
	const aliasHintId = createUniqueId();
	const inviteHintId = createUniqueId();
	const avatarHintId = createUniqueId();
	const errorId = createUniqueId();

	const [name, setName] = createSignal("");
	const [topic, setTopic] = createSignal("");
	const [alias, setAlias] = createSignal("");
	const [isPublic, setIsPublic] = createSignal(false);
	const [inviteRaw, setInviteRaw] = createSignal("");
	const [avatarMxc, setAvatarMxc] = createSignal<string | null>(null);
	const [avatarUploading, setAvatarUploading] = createSignal(false);
	const [avatarError, setAvatarError] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const selfId = createMemo(() => props.client.getUserId() ?? null);
	const parsedInvites = createMemo(() => parseInvites(inviteRaw(), selfId()));

	const trimmedAlias = createMemo(() => alias().trim());
	const aliasValid = createMemo(() => {
		const a = trimmedAlias();
		if (!a) return true;
		return ALIAS_LOCAL_PART_RE.test(a);
	});

	const homeserverDomain = createMemo(() => props.client.getDomain() ?? "");

	const avatarHttp = createMemo<string | null>(() => {
		const mxc = avatarMxc();
		if (!mxc) return null;
		return props.client.mxcUrlToHttp(mxc, 96, 96, "crop") ?? null;
	});

	const canSubmit = createMemo(() => {
		if (submitting()) return false;
		if (avatarUploading()) return false;
		if (name().trim().length === 0) return false;
		if (!aliasValid()) return false;
		if (parsedInvites().error) return false;
		return true;
	});

	function resetForm(): void {
		submitGeneration++;
		uploadGeneration++;
		setName("");
		setTopic("");
		setAlias("");
		setIsPublic(false);
		setInviteRaw("");
		setAvatarMxc(null);
		setAvatarUploading(false);
		setAvatarError(null);
		setError(null);
		setSubmitting(false);
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				resetForm();
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
			).filter((el) => el.offsetParent !== null);
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

	async function uploadAvatar(file: File): Promise<void> {
		if (!file.type.startsWith("image/")) {
			setAvatarError("File must be an image");
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setAvatarError("Image must be under 10 MB");
			return;
		}
		const myGen = ++uploadGeneration;
		setAvatarError(null);
		setAvatarUploading(true);
		try {
			const response = await props.client.uploadContent(file);
			if (!mounted || !props.open() || myGen !== uploadGeneration) return;
			setAvatarMxc(response.content_uri);
		} catch (e) {
			if (!mounted || !props.open() || myGen !== uploadGeneration) return;
			setAvatarError(
				e instanceof Error ? e.message : "Failed to upload avatar",
			);
		} finally {
			if (mounted && props.open() && myGen === uploadGeneration) {
				setAvatarUploading(false);
			}
		}
	}

	const onFileSelect = (): void => {
		const file = fileInputRef?.files?.[0];
		if (file) void uploadAvatar(file);
		if (fileInputRef) fileInputRef.value = "";
	};

	const removeAvatar = (): void => {
		// Bump upload generation so any in-flight upload's result is dropped.
		uploadGeneration++;
		setAvatarMxc(null);
		setAvatarError(null);
		setAvatarUploading(false);
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
		const invites = parsedInvites().mxids;
		const mxc = avatarMxc();

		try {
			const initialState: Array<{
				type: string;
				state_key: string;
				content: Record<string, unknown>;
			}> = [
				{
					type: EventType.RoomHistoryVisibility,
					state_key: "",
					content: {
						history_visibility: pub ? "world_readable" : "shared",
					},
				},
				{
					type: EventType.RoomGuestAccess,
					state_key: "",
					content: { guest_access: "forbidden" },
				},
			];
			if (mxc) {
				initialState.push({
					type: EventType.RoomAvatar,
					state_key: "",
					content: { url: mxc },
				});
			}

			const opts: Parameters<MatrixClient["createRoom"]>[0] = {
				name: trimmedName,
				visibility: pub ? Visibility.Public : Visibility.Private,
				preset: pub ? Preset.PublicChat : Preset.PrivateChat,
				creation_content: { type: RoomType.Space },
				power_level_content_override: {
					// Space PL floor: only admins post events (spaces don't
					// carry chat messages anyway), only admins set state,
					// moderators (PL≥50) can invite and add child rooms.
					events_default: 100,
					state_default: 100,
					users_default: 0,
					invite: 50,
					events: {
						[EventType.SpaceChild]: 50,
					},
				},
				initial_state: initialState,
			};
			if (trimmedTopic) opts.topic = trimmedTopic;
			if (aliasLocal) opts.room_alias_name = aliasLocal;
			if (invites.length > 0) opts.invite = invites;

			const { room_id } = await props.client.createRoom(opts);
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;

			optimisticallyMarkJoined(room_id, {
				name: trimmedName,
				avatarUrl: avatarHttp(),
				isSpace: true,
			});

			navigate(`/space/${encodeURIComponent(room_id)}`);
			props.onClose();
		} catch (err) {
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			const msg =
				err instanceof Error ? err.message : "Failed to create the space.";
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
						Create space
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						Spaces group rooms and people. You can add rooms later.
					</p>

					<div class="mb-4 flex items-center gap-3">
						<Show
							when={avatarHttp()}
							fallback={
								<div class="flex h-16 w-16 items-center justify-center rounded-full bg-surface-3 text-text-secondary">
									<svg
										class="h-7 w-7"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
										stroke-width="2"
										aria-hidden="true"
									>
										<title>Avatar placeholder</title>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M4 7h3l2-2h6l2 2h3v12H4V7z"
										/>
										<circle cx="12" cy="13" r="3.5" />
									</svg>
								</div>
							}
						>
							<img
								src={avatarHttp() ?? ""}
								alt=""
								class="h-16 w-16 rounded-full object-cover"
							/>
						</Show>
						<div class="flex flex-col gap-1">
							<div class="flex gap-2">
								<input
									ref={fileInputRef}
									type="file"
									accept="image/*"
									class="hidden"
									onChange={onFileSelect}
									aria-describedby={avatarHintId}
								/>
								<button
									type="button"
									onClick={() => fileInputRef?.click()}
									disabled={submitting() || avatarUploading()}
									class="rounded border border-border-subtle bg-surface-2 px-3 py-1 text-sm text-text-primary transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
								>
									<Show when={avatarHttp()} fallback="Add avatar">
										Replace
									</Show>
								</button>
								<Show when={avatarHttp()}>
									<button
										type="button"
										onClick={removeAvatar}
										disabled={submitting()}
										class="rounded px-3 py-1 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
									>
										Remove
									</button>
								</Show>
							</div>
							<span
								id={avatarHintId}
								class={`text-xs ${avatarError() ? "text-danger-text" : "text-text-faint"}`}
								role={avatarError() ? "alert" : undefined}
							>
								<Show
									when={avatarError()}
									fallback={
										<Show
											when={avatarUploading()}
											fallback="Optional. PNG, JPG, GIF, or WEBP up to 10 MB."
										>
											Uploading…
										</Show>
									}
								>
									{avatarError()}
								</Show>
							</span>
						</div>
					</div>

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
							placeholder="My space"
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
							placeholder="What's this space about?"
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
								placeholder="my-space"
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

export { CreateSpaceDialog };
