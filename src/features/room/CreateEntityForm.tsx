import type { MatrixClient } from "matrix-js-sdk";
import { createUniqueId, Show } from "solid-js";
import { Avatar } from "../../components/Avatar";
import { Modal } from "../../components/Modal";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { useCreateEntityForm } from "./useCreateEntityForm";

export interface CreateEntitySubmission {
	options: NonNullable<Parameters<MatrixClient["createRoom"]>[0]> & {
		name: string;
	};
	encryption: boolean;
	spaceId: string | null;
	avatarUrl: string | null;
	/** Check after every await before applying side effects to the current opening. */
	isCurrent: () => boolean;
}

export interface CreateEntityFormProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
	title: string;
	description: string;
	namePlaceholder: string;
	topicPlaceholder: string;
	aliasPlaceholder: string;
	failureMessage: string;
	showEncryption?: boolean;
	/** Parent space is snapshotted at open time. */
	spaceId?: string | undefined;
	onSubmit: (submission: CreateEntitySubmission) => Promise<void>;
}

/** Public form shared by room and space creation; submission stays with its owner. */
export function CreateEntityForm(props: CreateEntityFormProps) {
	const form = useCreateEntityForm(props);
	let nameRef: HTMLInputElement | undefined;
	let fileInputRef: HTMLInputElement | undefined;
	const titleId = createUniqueId();
	const aliasHintId = createUniqueId();
	const inviteHintId = createUniqueId();
	const avatarHintId = createUniqueId();
	const errorId = createUniqueId();
	const onFileSelect = () => {
		const file = fileInputRef?.files?.[0];
		if (file) void form.uploadAvatar(file);
		if (fileInputRef) fileInputRef.value = "";
	};

	return (
		<Modal
			class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-surface-0/60 p-4"
			open={props.open()}
			onClose={form.tryClose}
			dismissible={!form.submitting()}
			labelledBy={titleId}
			suspended={cryptoDialogOpen()}
			initialFocus={() => nameRef}
		>
			<form
				class="my-auto max-h-full w-full max-w-md overflow-y-auto rounded-lg bg-surface-1 p-6 shadow-xl"
				onSubmit={form.handleSubmit}
			>
				<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
					{props.title}
				</h2>
				<p class="mb-4 text-sm text-text-muted">{props.description}</p>

				<div class="mb-4 flex items-center gap-3">
					<Avatar
						url={form.avatarHttp()}
						size="xl"
						initial={
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
						}
					/>
					<div class="flex flex-col gap-1">
						<div class="flex gap-2">
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								class="hidden"
								tabIndex={-1}
								onChange={onFileSelect}
							/>
							<button
								type="button"
								onClick={() => fileInputRef?.click()}
								disabled={form.submitting() || form.avatarUploading()}
								aria-describedby={avatarHintId}
								class="rounded border border-border-subtle bg-surface-2 px-3 py-1 text-sm text-text-primary transition-colors hover:bg-surface-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60 any-pointer-coarse:min-h-11"
							>
								<Show when={form.avatarHttp()} fallback="Add avatar">
									Replace
								</Show>
							</button>
							<Show when={form.avatarHttp()}>
								<button
									type="button"
									onClick={form.removeAvatar}
									disabled={form.submitting()}
									class="rounded px-3 py-1 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60 any-pointer-coarse:min-h-11"
								>
									Remove
								</button>
							</Show>
						</div>
						<span
							id={avatarHintId}
							class={`text-xs ${form.avatarError() ? "text-danger-text" : "text-text-faint"}`}
							role={form.avatarError() ? "alert" : undefined}
						>
							<Show
								when={form.avatarError()}
								fallback={
									<Show
										when={form.avatarUploading()}
										fallback="Optional. PNG, JPG, GIF, or WEBP up to 10 MB."
									>
										Uploading…
									</Show>
								}
							>
								{form.avatarError()}
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
						value={form.name()}
						onInput={(e) => form.setName(e.currentTarget.value)}
						disabled={form.submitting()}
						class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						placeholder={props.namePlaceholder}
					/>
				</label>

				<label class="mb-3 block text-sm">
					<span class="mb-1 block font-medium text-text-secondary">
						Topic <span class="text-text-faint font-normal">(optional)</span>
					</span>
					<textarea
						rows={2}
						maxLength={1000}
						value={form.topic()}
						onInput={(e) => form.setTopic(e.currentTarget.value)}
						disabled={form.submitting()}
						class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						placeholder={props.topicPlaceholder}
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
							value={form.alias()}
							onInput={(e) => form.setAlias(e.currentTarget.value)}
							disabled={form.submitting()}
							aria-describedby={aliasHintId}
							aria-invalid={!form.aliasValid()}
							class="flex-1 bg-transparent py-2 text-text-primary placeholder-text-faint focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
							placeholder={props.aliasPlaceholder}
						/>
						<Show when={form.homeserverDomain()}>
							<span class="pr-3 text-text-faint" aria-hidden="true">
								:{form.homeserverDomain()}
							</span>
						</Show>
					</div>
					<span
						id={aliasHintId}
						class={`mt-1 block text-xs ${form.aliasValid() ? "text-text-faint" : "text-danger-text"}`}
					>
						<Show
							when={form.aliasValid()}
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
							checked={!form.isPublic()}
							onChange={() => form.setIsPublic(false)}
							disabled={form.submitting()}
							class="accent-accent"
						/>
						<span class="text-text-primary">Invite-only</span>
					</label>
					<label class="inline-flex items-center gap-2">
						<input
							type="radio"
							name="visibility"
							checked={form.isPublic()}
							onChange={() => form.setIsPublic(true)}
							disabled={form.submitting()}
							class="accent-accent"
						/>
						<span class="text-text-primary">Public</span>
					</label>
				</fieldset>

				<Show when={props.showEncryption}>
					<label class="mb-3 inline-flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={form.encryption()}
							onChange={(e) => {
								form.setEncryptionTouched(true);
								form.setEncryption(e.currentTarget.checked);
							}}
							disabled={form.submitting()}
							class="accent-accent"
						/>
						<span class="text-text-primary">End-to-end encryption</span>
					</label>
				</Show>

				<Show when={form.snapshotSpaceId()}>
					<label class="mb-3 flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={form.addToSpace()}
							onChange={(e) => form.setAddToSpace(e.currentTarget.checked)}
							disabled={form.submitting()}
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
						value={form.inviteRaw()}
						onInput={(e) => form.setInviteRaw(e.currentTarget.value)}
						disabled={form.submitting()}
						aria-describedby={inviteHintId}
						aria-invalid={form.parsedInvites().error !== null}
						class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-2 text-text-primary placeholder-text-faint focus-visible:border-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						placeholder="@alice:server, @bob:server"
					/>
					<span
						id={inviteHintId}
						class={`mt-1 block text-xs ${form.parsedInvites().error ? "text-danger-text" : "text-text-faint"}`}
					>
						<Show
							when={form.parsedInvites().error}
							fallback="Separate Matrix IDs with spaces, commas, or newlines."
						>
							{form.parsedInvites().error}
						</Show>
					</span>
				</label>

				<Show when={form.error()}>
					<div
						id={errorId}
						role="alert"
						class="mb-3 rounded border border-danger/30 bg-danger-bg/30 px-3 py-2 text-sm text-danger-text"
					>
						{form.error()}
					</div>
				</Show>

				<div class="mt-2 flex justify-end gap-2">
					<button
						type="button"
						onClick={form.tryClose}
						disabled={form.submitting()}
						class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!form.canSubmit()}
						class="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
					>
						<Show when={!form.submitting()} fallback="Creating…">
							Create
						</Show>
					</button>
				</div>
			</form>
		</Modal>
	);
}
