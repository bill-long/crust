import { UserEvent } from "matrix-js-sdk";
import {
	type Component,
	createMemo,
	createResource,
	createSignal,
	For,
	onCleanup,
	Show,
	Suspense,
} from "solid-js";
import {
	ACCOUNT_MANAGEMENT_ACTIONS,
	accountManagementDeeplink,
	fetchAccountManagement,
} from "../../client/accountManagement";
import { fetchThreePids } from "../../client/accountSecurity";
import { useClient } from "../../client/client";
import {
	MAX_STATUS_MSG_LENGTH,
	presenceOf,
	statusMsgLength,
} from "../../client/presence";
import {
	fetchStatusMessage,
	setStatusMessage,
} from "../../client/presencePublish";
import { avatarHttpUrl, avatarInitial } from "../../lib/avatar";
import { displayNameOr } from "../../lib/displayName";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { createImageFallback } from "../../lib/imageFallback";
import { loadSession } from "../../stores/session";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { DeactivateAccountDialog } from "./DeactivateAccountDialog";
import { SectionHeading } from "./SettingsControls";

/**
 * Focus an inline editor's input once it has rendered, but only if the user
 * has not already moved focus somewhere else.
 *
 * The Edit button that opened the editor unmounts as it does, so focus falls
 * back to the document - body, or the root element in the environments that
 * use that instead - and reclaiming it there is right. A frame is long enough
 * for a click or a Tab to have gone somewhere real, and stealing focus back
 * from that would be worse than not moving it at all.
 */
function focusWhenIdle(
	el: HTMLInputElement,
	stillEditing: () => boolean,
): void {
	requestAnimationFrame(() => {
		if (!el.isConnected || !stillEditing()) return;
		const active = document.activeElement;
		const unfocused =
			!active ||
			active === document.body ||
			active === document.documentElement;
		if (!unfocused && active !== el) return;
		el.focus();
	});
}

interface AccountTabProps {
	/** Signs this session out after a successful account deactivation
	 *  (every token is already invalid server-side by then). */
	onDeactivated: () => void;
}

const AccountTab: Component<AccountTabProps> = (props) => {
	const { client } = useClient();
	const userId = () => client.getUserId() ?? "";

	// OAuth (MSC3861) sessions have no account password: the server refuses
	// the password-UIA management endpoints outright and its own
	// account-management page owns them (#451). Session type can't change
	// without a full re-login, so one read at mount is enough. A password
	// session can hit the same wall when the server disables password
	// changes (the m.change_password capability), so that routes to the
	// provider too.
	const oidcSession = loadSession()?.oidc !== undefined;

	const [security] = createResource(async () => {
		let passwordDisabled = false;
		if (!oidcSession) {
			try {
				const caps = await client.getCapabilities();
				passwordDisabled =
					(caps as { "m.change_password"?: { enabled?: boolean } })[
						"m.change_password"
					]?.enabled === false;
			} catch {
				// Capability probe failing must not hide the section; the
				// submit path reports a server that refuses anyway.
			}
		}
		// The capability governs only password changes: a password session
		// on a server that disables them still deactivates in-app. OIDC
		// sessions do neither in-app (the server refuses their password
		// UIA outright).
		const passwordViaProvider = oidcSession || passwordDisabled;
		if (!passwordViaProvider && !oidcSession) {
			return {
				passwordViaProvider: false,
				deactivateViaProvider: false,
				manage: null,
				deactivate: null,
			};
		}
		// One metadata round-trip serves both links. Null entries render as
		// plain explanatory text.
		const mgmt = await fetchAccountManagement(client);
		return {
			passwordViaProvider,
			deactivateViaProvider: oidcSession,
			manage: mgmt && accountManagementDeeplink(mgmt),
			deactivate:
				mgmt &&
				accountManagementDeeplink(
					mgmt,
					ACCOUNT_MANAGEMENT_ACTIONS.accountDeactivate,
				),
		};
	});

	// Bound third-party identifiers, read-only (the server's m.3pid_changes
	// capability governs mutation, which Crust doesn't offer yet).
	const [threePids] = createResource(() => fetchThreePids(client));

	const [showChangePassword, setShowChangePassword] = createSignal(false);
	const [showDeactivate, setShowDeactivate] = createSignal(false);

	// Refresh counter — bump after profile mutations or SDK events to force re-read
	const [profileVersion, setProfileVersion] = createSignal(0);

	// Subscribe to SDK user events for external profile changes (e.g. from
	// another session). Listens on the client (which re-emits User events)
	// so we don't depend on getUser() being available at mount time.
	const onProfileChange = (_event: unknown, user: { userId: string }): void => {
		if (user.userId === userId()) {
			setProfileVersion((v) => v + 1);
		}
	};

	client.on(UserEvent.DisplayName, onProfileChange);
	client.on(UserEvent.AvatarUrl, onProfileChange);

	onCleanup(() => {
		client.removeListener(UserEvent.DisplayName, onProfileChange);
		client.removeListener(UserEvent.AvatarUrl, onProfileChange);
	});

	const currentDisplayName = (): string => {
		profileVersion(); // subscribe to refreshes
		// `User.displayName` is raw profile data - no `RoomMember` normalizes
		// it - and this is the same value `Layout` wraps for the sidebar. Left
		// unwrapped the two surfaces disagreed about the same string.
		const user = client.getUser(userId());
		return displayNameOr(user?.displayName, userId());
	};

	const currentAvatarUrl = (): string | null => {
		profileVersion(); // subscribe to refreshes
		const user = client.getUser(userId());
		return avatarHttpUrl(client, user?.avatarUrl, 80);
	};

	const initial = (): string => avatarInitial(currentDisplayName());

	// --- Display name editing ---
	const [editingName, setEditingName] = createSignal(false);
	const [nameValue, setNameValue] = createSignal("");
	const [nameSaving, setNameSaving] = createSignal(false);
	const [nameError, setNameError] = createSignal("");

	const startEditingName = (): void => {
		// The RAW stored name, never the resolved one. `currentDisplayName` is
		// for rendering: it strips bidi scope controls and substitutes the
		// MXID when a name would not render. Seeding the editor with that and
		// pressing Save would silently rewrite your real profile - stripping
		// characters you meant to keep, or setting your display name to your
		// own MXID.
		setNameValue(client.getUser(userId())?.displayName ?? "");
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

	// Escape stops here: the settings overlay closes on an Escape that
	// reaches it, and abandoning an edit must not throw the user out of
	// Settings. Enter during IME composition is the candidate commit, not a
	// save (the composer keeps the same rule).
	const handleNameKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter" && !e.isComposing) saveName();
		if (e.key === "Escape") {
			e.stopPropagation();
			cancelEditingName();
		}
	};

	// --- Status message editing (#538) ---
	// Display comes from the presence store, which /sync keeps current for
	// our own account too. The editor is prefilled from the RAW server value
	// (`fetchStatusMessage`), never from that rendering: `sanitizeStatusMsg`
	// collapses, cleans and cuts for display, so saving it back unedited
	// would silently rewrite a status set from another client.
	const currentStatusMsg = (): string | null => presenceOf(userId()).statusMsg;
	const [editingStatus, setEditingStatus] = createSignal(false);
	const [statusLoading, setStatusLoading] = createSignal(false);
	const [statusValue, setStatusValue] = createSignal("");
	const [statusSaving, setStatusSaving] = createSignal(false);
	const [statusError, setStatusError] = createSignal("");
	// Bumped when a prefill is superseded (Cancel, or a newer Edit) so a
	// slow fetch cannot overwrite what the user has since typed.
	let statusEditGen = 0;

	// Memoised: read at six render sites per keystroke, over a raw prefill
	// that is unbounded. The comparison below is not worth a node.

	const statusLength = createMemo((): number => statusMsgLength(statusValue()));
	const statusTooLong = (): boolean => statusLength() > MAX_STATUS_MSG_LENGTH;

	const startEditingStatus = async (): Promise<void> => {
		const gen = ++statusEditGen;
		setStatusError("");
		setStatusValue("");
		setEditingStatus(true);
		setStatusLoading(true);
		try {
			const raw = await fetchStatusMessage();
			if (gen !== statusEditGen) return;
			setStatusValue(raw);
		} catch (e) {
			if (gen !== statusEditGen) return;
			// Without the raw value there is nothing safe to prefill, and an
			// empty editor would offer to clear a status the user cannot see.
			setEditingStatus(false);
			setStatusError(
				userFacingErrorMessage(e, "Couldn't load your current status."),
			);
		} finally {
			if (gen === statusEditGen) setStatusLoading(false);
		}
	};

	const cancelEditingStatus = (): void => {
		statusEditGen++;
		setEditingStatus(false);
		setStatusLoading(false);
		setStatusError("");
	};

	const saveStatus = async (raw: string): Promise<void> => {
		// Enter reaches a focused readOnly input: saving the still-empty
		// editor during the prefill would clear the real status.
		if (statusLoading()) return;
		if (statusMsgLength(raw) > MAX_STATUS_MSG_LENGTH) {
			setStatusError(
				`Status messages can be at most ${MAX_STATUS_MSG_LENGTH} characters.`,
			);
			return;
		}
		setStatusSaving(true);
		setStatusError("");
		try {
			// Verbatim, whitespace and all; the publisher sends a status that
			// renders as nothing as a clear.
			await setStatusMessage(raw);
			setEditingStatus(false);
		} catch (e) {
			setStatusError(userFacingErrorMessage(e, "Couldn't update your status."));
		} finally {
			setStatusSaving(false);
		}
	};

	const handleStatusKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter" && !e.isComposing) void saveStatus(statusValue());
		if (e.key === "Escape") {
			e.stopPropagation();
			cancelEditingStatus();
		}
	};

	// --- Avatar upload ---
	const [avatarUploading, setAvatarUploading] = createSignal(false);
	const [avatarError, setAvatarError] = createSignal("");
	const avatarImg = createImageFallback(currentAvatarUrl);
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
	const MATRIX_USER_ID_RE = /^@[a-z0-9._=\-/]+:[a-z0-9._-]+$/i;

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
							class="relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-2xl font-semibold text-text-secondary transition-opacity hover:opacity-80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Change avatar"
							aria-describedby={avatarError() ? "avatar-error" : undefined}
						>
							<Show
								when={!avatarImg.failed() && currentAvatarUrl()}
								fallback={<span>{initial()}</span>}
							>
								{(url) => (
									<img
										ref={avatarImg.ref}
										src={url()}
										alt="Avatar"
										class="h-full w-full object-cover"
										onError={avatarImg.onError}
										onLoad={avatarImg.onLoad}
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
							tabIndex={-1}
							onChange={onFileSelect}
						/>
						<button
							type="button"
							onClick={() => fileInputRef.click()}
							disabled={avatarUploading()}
							class="text-xs text-accent-text transition-colors hover:text-accent-text-bright focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-describedby={avatarError() ? "avatar-error" : undefined}
						>
							Change avatar
						</button>
						<Show when={avatarError()}>
							<div
								id="avatar-error"
								role="alert"
								class="text-xs text-danger-text"
							>
								{avatarError()}
							</div>
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
										class="rounded px-2 py-0.5 text-xs text-accent-text transition-colors hover:bg-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Edit
									</button>
								</div>
							}
						>
							<div class="flex items-center gap-2">
								<input
									ref={(el) => focusWhenIdle(el, editingName)}
									type="text"
									value={nameValue()}
									onInput={(e) => {
										setNameValue(e.currentTarget.value);
										setNameError("");
									}}
									onKeyDown={handleNameKeyDown}
									disabled={nameSaving()}
									class="flex-1 rounded bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder-text-disabled outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									placeholder="Display name"
									aria-label="Display name"
									aria-describedby={nameError() ? "name-error" : undefined}
								/>
								<button
									type="button"
									onClick={saveName}
									disabled={nameSaving()}
									class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									{nameSaving() ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									onClick={cancelEditingName}
									disabled={nameSaving()}
									class="rounded px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									Cancel
								</button>
							</div>
							<Show when={nameError()}>
								<div
									id="name-error"
									role="alert"
									class="mt-1 text-xs text-danger-text"
								>
									{nameError()}
								</div>
							</Show>
						</Show>

						<div class="mt-2 text-xs text-text-disabled">{userId()}</div>

						{/* Status message */}
						<div class="mt-4 mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
							Status message
						</div>
						<Show
							when={editingStatus()}
							fallback={
								<div class="flex items-center gap-2">
									<span
										class="min-w-0 truncate text-sm"
										classList={{
											"text-text-primary": currentStatusMsg() !== null,
											"text-text-muted": currentStatusMsg() === null,
										}}
									>
										{currentStatusMsg() ?? "No status set"}
									</span>
									<button
										type="button"
										onClick={() => void startEditingStatus()}
										class="rounded px-2 py-0.5 text-xs text-accent-text transition-colors hover:bg-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Edit
									</button>
								</div>
							}
						>
							<div class="flex items-center gap-2">
								<input
									ref={(el) => focusWhenIdle(el, editingStatus)}
									type="text"
									value={statusValue()}
									onInput={(e) => {
										setStatusValue(e.currentTarget.value);
										setStatusError("");
									}}
									onKeyDown={handleStatusKeyDown}
									disabled={statusSaving()}
									// readOnly, not disabled, while the raw prefill is in flight:
									// a disabled control refuses focus, and the fetch is usually
									// far under the 200 ms that would justify a loading state.
									readOnly={statusLoading()}
									class="flex-1 rounded bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder-text-disabled outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									placeholder="What's up?"
									aria-label="Status message"
									aria-invalid={statusTooLong() ? "true" : undefined}
									// The counter is always rendered beside the input, so it is
									// always a valid description; an error joins it.
									aria-describedby={
										statusError() ? "status-error status-count" : "status-count"
									}
								/>
								<span
									id="status-count"
									class="shrink-0 text-xs tabular-nums"
									classList={{
										"text-text-muted": !statusTooLong(),
										"text-danger-text": statusTooLong(),
									}}
								>
									{statusLength()}/{MAX_STATUS_MSG_LENGTH}
								</span>
								<button
									type="button"
									onClick={() => void saveStatus(statusValue())}
									disabled={
										statusSaving() || statusLoading() || statusTooLong()
									}
									class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
								>
									{statusSaving() ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									onClick={() => void saveStatus("")}
									disabled={statusSaving() || statusLoading()}
									class="rounded px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
								>
									Clear
								</button>
								<button
									type="button"
									onClick={cancelEditingStatus}
									disabled={statusSaving()}
									class="rounded px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									Cancel
								</button>
							</div>
						</Show>
						<Show when={statusError()}>
							<div
								id="status-error"
								role="alert"
								class="mt-1 text-xs text-danger-text"
							>
								{statusError()}
							</div>
						</Show>
					</div>
				</div>
			</section>

			{/* Account security (#451) */}
			<section>
				<SectionHeading>Account Security</SectionHeading>
				<Suspense fallback={null}>
					<Show
						when={security()?.passwordViaProvider === false}
						fallback={
							<div class="rounded-lg bg-surface-2/50 px-4 py-3">
								<div class="text-sm font-medium text-text-primary">
									Password managed outside Crust
								</div>
								<p class="mt-1 text-xs text-text-muted">
									This account's password is managed by your account provider or
									homeserver, not from this app.
								</p>
								<Show when={security()?.manage}>
									{(url) => (
										<a
											href={url()}
											target="_blank"
											rel="noopener noreferrer"
											class="mt-2 inline-block rounded bg-surface-3 px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
										>
											Open account settings
										</a>
									)}
								</Show>
							</div>
						}
					>
						<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
							<div class="min-w-0">
								<div class="text-sm font-medium text-text-primary">
									Password
								</div>
								<div class="text-xs text-text-muted">
									Change the password used to sign in.
								</div>
							</div>
							<button
								type="button"
								onClick={() => setShowChangePassword(true)}
								class="shrink-0 rounded bg-surface-3 px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Change…
							</button>
						</div>
					</Show>
				</Suspense>

				{/* Bound email addresses / phone numbers, read-only */}
				<div class="mt-3">
					<div class="mb-1 text-xs font-medium text-text-muted uppercase">
						Email & phone
					</div>
					<Suspense fallback={null}>
						<Show
							when={!threePids.error}
							fallback={
								<div class="py-2 text-sm text-text-disabled">
									Couldn't load the linked email addresses.
								</div>
							}
						>
							<Show
								when={(threePids() ?? []).length > 0}
								fallback={
									<div class="py-2 text-sm text-text-disabled">
										No email addresses or phone numbers are linked to this
										account.
									</div>
								}
							>
								<div class="space-y-1">
									<For each={threePids()}>
										{(tp) => (
											<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-2.5">
												<span class="min-w-0 truncate text-sm text-text-secondary">
													{tp.address}
												</span>
												<span class="shrink-0 text-xs text-text-muted">
													{tp.medium === "email"
														? "Email"
														: tp.medium === "msisdn"
															? "Phone"
															: tp.medium}
												</span>
											</div>
										)}
									</For>
								</div>
							</Show>
						</Show>
					</Suspense>
				</div>
			</section>

			{/* Blocked users */}
			<section>
				<SectionHeading>Blocked Users</SectionHeading>
				<p class="mb-3 text-xs text-text-muted">
					Blocked users cannot send you invites. Their messages will be hidden
					once client-side filtering is implemented.
				</p>

				{/* Add block input */}
				<div class="mb-4 flex items-center gap-2">
					<input
						type="text"
						value={blockInput()}
						onInput={(e) => {
							setBlockInput(e.currentTarget.value);
							setBlockError("");
						}}
						onKeyDown={handleBlockKeyDown}
						class="flex-1 rounded bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder-text-disabled outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
						placeholder="@user:server.com"
						aria-label="User ID to block"
						aria-describedby={blockError() ? "block-error" : undefined}
					/>
					<button
						type="button"
						onClick={blockUser}
						class="rounded bg-surface-3 px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Block
					</button>
				</div>
				<Show when={blockError()}>
					<div
						id="block-error"
						role="alert"
						class="mb-3 text-xs text-danger-text"
					>
						{blockError()}
					</div>
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
										class="shrink-0 rounded px-2 py-1 text-xs text-danger-text transition-colors hover:bg-danger-bg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
										aria-label={`Unblock ${blockedId}`}
									>
										{unblockingUser() === blockedId ? "Unblocking…" : "Unblock"}
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
				<Show when={unblockError()}>
					<div role="alert" class="mt-2 text-xs text-danger-text">
						{unblockError()}
					</div>
				</Show>
			</section>

			{/* Danger zone (#451) */}
			<section>
				<SectionHeading>Danger Zone</SectionHeading>
				<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
					<div class="min-w-0">
						<div class="text-sm font-medium text-text-primary">
							Deactivate account
						</div>
						<div class="text-xs text-text-muted">
							Permanently disable this account. This cannot be undone.
						</div>
					</div>
					<Suspense fallback={null}>
						<Show
							when={security()?.deactivateViaProvider === false}
							fallback={
								<Show
									when={security()?.deactivate}
									fallback={
										<span class="shrink-0 text-xs text-text-muted">
											At your account provider
										</span>
									}
								>
									{(url) => (
										<a
											href={url()}
											target="_blank"
											rel="noopener noreferrer"
											class="shrink-0 rounded px-3 py-1.5 text-xs font-medium text-danger-text transition-colors hover:bg-danger-bg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
										>
											Deactivate…
										</a>
									)}
								</Show>
							}
						>
							<button
								type="button"
								onClick={() => setShowDeactivate(true)}
								class="shrink-0 rounded px-3 py-1.5 text-xs font-medium text-danger-text transition-colors hover:bg-danger-bg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Deactivate…
							</button>
						</Show>
					</Suspense>
				</div>
			</section>

			<Show when={showChangePassword()}>
				<ChangePasswordDialog onClose={() => setShowChangePassword(false)} />
			</Show>
			<Show when={showDeactivate()}>
				<DeactivateAccountDialog
					onClose={() => setShowDeactivate(false)}
					onDeactivated={props.onDeactivated}
				/>
			</Show>
		</div>
	);
};

export { AccountTab };
