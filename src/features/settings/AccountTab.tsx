import { type Component, createSignal, For, Show } from "solid-js";
import { useClient } from "../../client/client";
import { SectionHeading } from "./SettingsControls";

const AccountTab: Component = () => {
	const { client } = useClient();
	const userId = () => client.getUserId() ?? "";

	// Refresh counter — bump after profile mutations to force re-read
	const [profileVersion, setProfileVersion] = createSignal(0);

	const currentDisplayName = (): string => {
		profileVersion(); // subscribe to refreshes
		const user = client.getUser(userId());
		return user?.displayName ?? userId();
	};

	const currentAvatarUrl = (): string | null => {
		profileVersion(); // subscribe to refreshes
		const user = client.getUser(userId());
		const mxc = user?.avatarUrl;
		if (!mxc) return null;
		return client.mxcUrlToHttp(mxc, 80, 80, "crop") ?? null;
	};

	const initial = (): string =>
		(currentDisplayName().trim() || "?").charAt(0).toUpperCase();

	// --- Display name editing ---
	const [editingName, setEditingName] = createSignal(false);
	const [nameValue, setNameValue] = createSignal("");
	const [nameSaving, setNameSaving] = createSignal(false);
	const [nameError, setNameError] = createSignal("");

	const startEditingName = (): void => {
		setNameValue(currentDisplayName());
		setEditingName(true);
		setNameError("");
	};

	const cancelEditingName = (): void => {
		setEditingName(false);
		setNameError("");
	};

	const saveName = async (): Promise<void> => {
		const name = nameValue().trim();
		if (!name) {
			setNameError("Display name cannot be empty");
			return;
		}
		setNameSaving(true);
		setNameError("");
		try {
			await client.setDisplayName(name);
			setProfileVersion((v) => v + 1);
			setEditingName(false);
		} catch (e) {
			setNameError(
				e instanceof Error ? e.message : "Failed to update display name",
			);
		} finally {
			setNameSaving(false);
		}
	};

	const handleNameKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter") saveName();
		if (e.key === "Escape") cancelEditingName();
	};

	// --- Avatar upload ---
	const [avatarUploading, setAvatarUploading] = createSignal(false);
	const [avatarError, setAvatarError] = createSignal("");
	let fileInputRef!: HTMLInputElement;

	const MAX_AVATAR_BYTES = 10 * 1024 * 1024; // 10 MB

	const handleAvatarFile = async (file: File): Promise<void> => {
		if (!file.type.startsWith("image/")) {
			setAvatarError("File must be an image");
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setAvatarError("Image must be under 10 MB");
			return;
		}
		setAvatarUploading(true);
		setAvatarError("");
		try {
			const response = await client.uploadContent(file);
			await client.setAvatarUrl(response.content_uri);
			setProfileVersion((v) => v + 1);
		} catch (e) {
			setAvatarError(
				e instanceof Error ? e.message : "Failed to upload avatar",
			);
		} finally {
			setAvatarUploading(false);
		}
	};

	const onFileSelect = (): void => {
		const file = fileInputRef.files?.[0];
		if (file) handleAvatarFile(file);
		// Reset so re-selecting the same file triggers onChange
		fileInputRef.value = "";
	};

	// --- Ignored users ---
	const [ignoredUsers, setIgnoredUsers] = createSignal<string[]>(
		client.getIgnoredUsers() ?? [],
	);
	const [unblockingUser, setUnblockingUser] = createSignal<string | null>(null);
	const [blockInput, setBlockInput] = createSignal("");
	const [blockError, setBlockError] = createSignal("");
	const [unblockError, setUnblockError] = createSignal("");

	const refreshIgnored = (): void => {
		setIgnoredUsers(client.getIgnoredUsers() ?? []);
	};

	// Matrix user IDs: @localpart:server — localpart is [a-z0-9._=\-/]+
	const MATRIX_USER_ID_RE = /^@[a-z0-9._=\-/]+:[a-z0-9._\-]+$/i;

	const blockUser = async (): Promise<void> => {
		const id = blockInput().trim();
		if (!MATRIX_USER_ID_RE.test(id)) {
			setBlockError("Enter a valid user ID (e.g. @user:server.com)");
			return;
		}
		setBlockError("");
		const current = client.getIgnoredUsers() ?? [];
		if (current.includes(id)) {
			setBlockError("User is already blocked");
			return;
		}
		try {
			await client.setIgnoredUsers([...current, id]);
			setBlockInput("");
			refreshIgnored();
		} catch (e) {
			setBlockError(e instanceof Error ? e.message : "Failed to block user");
		}
	};

	const unblockUser = async (userIdToUnblock: string): Promise<void> => {
		setUnblockingUser(userIdToUnblock);
		setUnblockError("");
		try {
			const current = client.getIgnoredUsers() ?? [];
			await client.setIgnoredUsers(
				current.filter((id) => id !== userIdToUnblock),
			);
			refreshIgnored();
		} catch (e) {
			setUnblockError(
				e instanceof Error ? e.message : "Failed to unblock user",
			);
		} finally {
			setUnblockingUser(null);
		}
	};

	const handleBlockKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter") blockUser();
	};

	return (
		<div class="space-y-8">
			{/* Profile */}
			<section>
				<SectionHeading>Profile</SectionHeading>

				<div class="flex items-start gap-6">
					{/* Avatar */}
					<div class="flex flex-col items-center gap-2">
						<button
							type="button"
							onClick={() => fileInputRef.click()}
							disabled={avatarUploading()}
							class="relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-2xl font-semibold text-text-secondary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Change avatar"
						>
							<Show
								when={currentAvatarUrl()}
								fallback={<span>{initial()}</span>}
							>
								{(url) => (
									<img
										src={url()}
										alt="Avatar"
										class="h-full w-full object-cover"
									/>
								)}
							</Show>
							<Show when={avatarUploading()}>
								<div class="absolute inset-0 flex items-center justify-center bg-black/40">
									<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
								</div>
							</Show>
						</button>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							class="hidden"
							onChange={onFileSelect}
						/>
						<button
							type="button"
							onClick={() => fileInputRef.click()}
							disabled={avatarUploading()}
							class="text-xs text-accent-text transition-colors hover:text-accent-text-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						>
							Change avatar
						</button>
						<Show when={avatarError()}>
							<div class="text-xs text-danger-text">{avatarError()}</div>
						</Show>
					</div>

					{/* Display name */}
					<div class="flex-1">
						<div class="mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
							Display Name
						</div>
						<Show
							when={editingName()}
							fallback={
								<div class="flex items-center gap-2">
									<span class="text-sm text-text-primary">
										{currentDisplayName()}
									</span>
									<button
										type="button"
										onClick={startEditingName}
										class="rounded px-2 py-0.5 text-xs text-accent-text transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Edit
									</button>
								</div>
							}
						>
							<div class="flex items-center gap-2">
								<input
									type="text"
									value={nameValue()}
									onInput={(e) => setNameValue(e.currentTarget.value)}
									onKeyDown={handleNameKeyDown}
									disabled={nameSaving()}
									class="flex-1 rounded bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder-text-disabled outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									placeholder="Display name"
									aria-label="Display name"
								/>
								<button
									type="button"
									onClick={saveName}
									disabled={nameSaving()}
									class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									{nameSaving() ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									onClick={cancelEditingName}
									disabled={nameSaving()}
									class="rounded px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									Cancel
								</button>
							</div>
							<Show when={nameError()}>
								<div class="mt-1 text-xs text-danger-text">{nameError()}</div>
							</Show>
						</Show>

						<div class="mt-2 text-xs text-text-disabled">{userId()}</div>
					</div>
				</div>
			</section>

			{/* Blocked users */}
			<section>
				<SectionHeading>Blocked Users</SectionHeading>
				<p class="mb-3 text-xs text-text-muted">
					Blocked users cannot send you invites or messages. You won't see their
					messages in rooms you share.
				</p>

				{/* Add block input */}
				<div class="mb-4 flex items-center gap-2">
					<input
						type="text"
						value={blockInput()}
						onInput={(e) => setBlockInput(e.currentTarget.value)}
						onKeyDown={handleBlockKeyDown}
						class="flex-1 rounded bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder-text-disabled outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						placeholder="@user:server.com"
						aria-label="User ID to block"
					/>
					<button
						type="button"
						onClick={blockUser}
						class="rounded bg-surface-3 px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Block
					</button>
				</div>
				<Show when={blockError()}>
					<div class="mb-3 text-xs text-danger-text">{blockError()}</div>
				</Show>

				{/* List */}
				<Show
					when={ignoredUsers().length > 0}
					fallback={
						<div class="py-4 text-center text-sm text-text-disabled">
							No blocked users
						</div>
					}
				>
					<div class="space-y-1">
						<For each={ignoredUsers()}>
							{(blockedId) => (
								<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-2.5">
									<span class="min-w-0 truncate text-sm text-text-secondary">
										{blockedId}
									</span>
									<button
										type="button"
										onClick={() => unblockUser(blockedId)}
										disabled={unblockingUser() === blockedId}
										class="shrink-0 rounded px-2 py-1 text-xs text-danger-text transition-colors hover:bg-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										{unblockingUser() === blockedId ? "Unblocking…" : "Unblock"}
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
				<Show when={unblockError()}>
					<div class="mt-2 text-xs text-danger-text">{unblockError()}</div>
				</Show>
			</section>
		</div>
	);
};

export { AccountTab };
