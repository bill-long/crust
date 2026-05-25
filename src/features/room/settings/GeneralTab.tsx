import { EventType, type MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	on,
	Show,
} from "solid-js";
import { FieldStatus } from "./FieldStatus";
import { Tooltip } from "./Tooltip";
import { useOptimisticState } from "./useOptimisticState";
import { useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

interface GeneralTabProps {
	client: MatrixClient;
	roomId: string;
}

const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

const GeneralTab: Component<GeneralTabProps> = (props) => {
	const roomId = () => props.roomId;
	const perms = useRoomPermissions(props.client, roomId);

	// ----- m.room.name -----
	const nameContent = useRoomStateContent<{ name?: string }>(
		props.client,
		roomId,
		"m.room.name",
	);
	const serverName = createMemo<string>(() => nameContent()?.name ?? "");
	const nameOpt = useOptimisticState<string>({ serverValue: serverName });
	const [nameDraft, setNameDraft] = createSignal("");
	const [nameDirty, setNameDirty] = createSignal(false);
	const [nameConflict, setNameConflict] = createSignal<string | null>(null);

	createEffect(
		on(serverName, (next) => {
			if (!nameDirty()) {
				setNameDraft(next);
				setNameConflict(null);
			} else if (next !== nameDraft()) {
				setNameConflict(next);
			}
		}),
	);

	const handleSaveName = async (): Promise<void> => {
		const value = nameDraft();
		await nameOpt.apply(value, async () => {
			await props.client.sendStateEvent(
				props.roomId,
				EventType.RoomName,
				{ name: value },
				"",
			);
		});
		// apply() never rejects — failures land in lastError(). Only mark
		// the field clean on success; otherwise keep the draft so the
		// inline Save/Cancel control stays visible and a later server
		// echo doesn't silently overwrite the typed value.
		if (!nameOpt.lastError()) {
			setNameDirty(false);
			setNameConflict(null);
		}
	};

	const cancelName = (): void => {
		setNameDraft(serverName());
		setNameDirty(false);
		setNameConflict(null);
	};

	const nameState = (): "idle" | "saving" | "error" => {
		if (nameOpt.pending()) return "saving";
		if (nameOpt.lastError()) return "error";
		return "idle";
	};

	// ----- m.room.topic -----
	const topicContent = useRoomStateContent<{ topic?: string }>(
		props.client,
		roomId,
		"m.room.topic",
	);
	const serverTopic = createMemo<string>(() => topicContent()?.topic ?? "");
	const topicOpt = useOptimisticState<string>({ serverValue: serverTopic });
	const [topicDraft, setTopicDraft] = createSignal("");
	const [topicDirty, setTopicDirty] = createSignal(false);
	const [topicConflict, setTopicConflict] = createSignal<string | null>(null);

	createEffect(
		on(serverTopic, (next) => {
			if (!topicDirty()) {
				setTopicDraft(next);
				setTopicConflict(null);
			} else if (next !== topicDraft()) {
				setTopicConflict(next);
			}
		}),
	);

	const handleSaveTopic = async (): Promise<void> => {
		const value = topicDraft();
		await topicOpt.apply(value, async () => {
			await props.client.sendStateEvent(
				props.roomId,
				EventType.RoomTopic,
				{ topic: value },
				"",
			);
		});
		if (!topicOpt.lastError()) {
			setTopicDirty(false);
			setTopicConflict(null);
		}
	};

	const cancelTopic = (): void => {
		setTopicDraft(serverTopic());
		setTopicDirty(false);
		setTopicConflict(null);
	};

	const topicState = (): "idle" | "saving" | "error" => {
		if (topicOpt.pending()) return "saving";
		if (topicOpt.lastError()) return "error";
		return "idle";
	};

	// ----- m.room.canonical_alias -----
	const aliasContent = useRoomStateContent<{ alias?: string }>(
		props.client,
		roomId,
		"m.room.canonical_alias",
	);
	const serverAlias = createMemo<string>(() => aliasContent()?.alias ?? "");

	// ----- m.room.avatar -----
	const avatarContent = useRoomStateContent<{ url?: string }>(
		props.client,
		roomId,
		"m.room.avatar",
	);
	const serverAvatarMxc = createMemo<string>(() => avatarContent()?.url ?? "");
	const avatarOpt = useOptimisticState<string>({
		serverValue: serverAvatarMxc,
	});
	const [avatarError, setAvatarError] = createSignal<string | null>(null);
	let lastFile: File | null = null;
	// Cached content_uri from the most recent successful upload of `lastFile`.
	// Lets a retry skip the (potentially large) re-upload when only
	// sendStateEvent failed. Cleared whenever a new file is selected.
	let lastUploadedUrl: string | null = null;
	// Monotonic counter that lets out-of-order upload completions be
	// dropped. If the user picks file A, then quickly picks file B,
	// A's promise (even if it resolves later) must not clobber B.
	let uploadGen = 0;
	let fileInputRef!: HTMLInputElement;

	const avatarHttp = createMemo<string | null>(() => {
		const mxc = avatarOpt.value();
		if (!mxc) return null;
		return props.client.mxcUrlToHttp(mxc, 96, 96, "crop") ?? null;
	});

	const uploadAvatar = async (file: File): Promise<void> => {
		if (!file.type.startsWith("image/")) {
			setAvatarError("File must be an image");
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setAvatarError("Image must be under 10 MB");
			return;
		}
		setAvatarError(null);
		// New file invalidates any cached upload from a previous selection.
		if (lastFile !== file) lastUploadedUrl = null;
		lastFile = file;
		const myGen = ++uploadGen;
		try {
			let url = lastUploadedUrl;
			if (url === null) {
				const response = await props.client.uploadContent(file);
				if (myGen !== uploadGen) return;
				url = response.content_uri;
				lastUploadedUrl = url;
			}
			await avatarOpt.apply(url, async () => {
				await props.client.sendStateEvent(
					props.roomId,
					EventType.RoomAvatar,
					{ url },
					"",
				);
			});
		} catch (e) {
			if (myGen !== uploadGen) return;
			setAvatarError(
				e instanceof Error ? e.message : "Failed to upload avatar",
			);
		}
	};

	const retryAvatar = (): void => {
		if (lastFile) void uploadAvatar(lastFile);
	};

	const onFileSelect = (): void => {
		const file = fileInputRef.files?.[0];
		if (file) void uploadAvatar(file);
		fileInputRef.value = "";
	};

	const avatarState = (): "idle" | "saving" | "error" => {
		if (avatarOpt.pending()) return "saving";
		if (avatarOpt.lastError() || avatarError()) return "error";
		return "idle";
	};

	const aliasTooltip = (): string =>
		perms.canSetCanonicalAlias()
			? ""
			: "You don't have permission to change the canonical alias.";
	const nameTooltip = (): string =>
		perms.canSetName()
			? ""
			: "You don't have permission to change the room name.";
	const topicTooltip = (): string =>
		perms.canSetTopic()
			? ""
			: "You don't have permission to change the room topic.";
	const avatarTooltip = (): string =>
		perms.canSetAvatar()
			? ""
			: "You don't have permission to change the room avatar.";

	return (
		<div class="space-y-8">
			{/* Avatar */}
			<section>
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Avatar
				</h3>
				<div class="flex items-center gap-4">
					<div class="flex h-24 w-24 items-center justify-center overflow-hidden rounded-lg bg-surface-2">
						<Show
							when={avatarHttp()}
							fallback={
								<span class="text-2xl font-semibold text-text-muted">
									{(props.client.getRoom(props.roomId)?.name ?? "?")
										.trim()
										.charAt(0)
										.toUpperCase() || "?"}
								</span>
							}
						>
							<img
								src={avatarHttp() ?? ""}
								alt=""
								class="h-full w-full object-cover"
							/>
						</Show>
					</div>
					<div class="flex-1">
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							class="hidden"
							onChange={onFileSelect}
						/>
						<Tooltip content={avatarTooltip()} disabled={perms.canSetAvatar()}>
							<button
								type="button"
								aria-disabled={perms.canSetAvatar() ? undefined : "true"}
								onClick={() => {
									if (perms.canSetAvatar()) fileInputRef.click();
								}}
								class="rounded bg-surface-2 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								classList={{
									"opacity-60 cursor-not-allowed": !perms.canSetAvatar(),
								}}
							>
								Upload image
							</button>
						</Tooltip>
						<FieldStatus
							state={avatarState()}
							error={avatarError() ?? avatarOpt.lastError()}
							onRetry={retryAvatar}
							onDismiss={() => {
								setAvatarError(null);
								avatarOpt.clearError();
							}}
						/>
					</div>
				</div>
			</section>

			{/* Name */}
			<section>
				<label
					for="room-name-input"
					class="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-muted"
				>
					Name
				</label>
				<Tooltip content={nameTooltip()} disabled={perms.canSetName()}>
					<input
						id="room-name-input"
						type="text"
						value={nameDraft()}
						disabled={!perms.canSetName()}
						onInput={(e) => {
							setNameDraft(e.currentTarget.value);
							setNameDirty(true);
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") cancelName();
						}}
						class="w-full rounded bg-surface-2 px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
					/>
				</Tooltip>
				<Show when={nameConflict() !== null}>
					<p class="mt-1 text-xs text-text-muted">
						Updated by someone else —{" "}
						<button
							type="button"
							onClick={cancelName}
							class="underline hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						>
							view
						</button>
					</p>
				</Show>
				<Show when={nameDirty() && perms.canSetName()}>
					<div class="mt-2 flex gap-2">
						<button
							type="button"
							onClick={handleSaveName}
							disabled={nameOpt.pending()}
							class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-text-primary hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							Save
						</button>
						<button
							type="button"
							onClick={cancelName}
							disabled={nameOpt.pending()}
							class="rounded px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							Cancel
						</button>
					</div>
				</Show>
				<FieldStatus
					state={nameState()}
					error={nameOpt.lastError()}
					onRetry={handleSaveName}
					onDismiss={() => nameOpt.clearError()}
				/>
			</section>

			{/* Topic */}
			<section>
				<label
					for="room-topic-input"
					class="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-muted"
				>
					Topic
				</label>
				<Tooltip content={topicTooltip()} disabled={perms.canSetTopic()}>
					<textarea
						id="room-topic-input"
						rows="3"
						value={topicDraft()}
						disabled={!perms.canSetTopic()}
						onInput={(e) => {
							setTopicDraft(e.currentTarget.value);
							setTopicDirty(true);
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") cancelTopic();
						}}
						class="w-full rounded bg-surface-2 px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
					/>
				</Tooltip>
				<Show when={topicConflict() !== null}>
					<p class="mt-1 text-xs text-text-muted">
						Updated by someone else —{" "}
						<button
							type="button"
							onClick={cancelTopic}
							class="underline hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						>
							view
						</button>
					</p>
				</Show>
				<Show when={topicDirty() && perms.canSetTopic()}>
					<div class="mt-2 flex gap-2">
						<button
							type="button"
							onClick={handleSaveTopic}
							disabled={topicOpt.pending()}
							class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-text-primary hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							Save
						</button>
						<button
							type="button"
							onClick={cancelTopic}
							disabled={topicOpt.pending()}
							class="rounded px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						>
							Cancel
						</button>
					</div>
				</Show>
				<FieldStatus
					state={topicState()}
					error={topicOpt.lastError()}
					onRetry={handleSaveTopic}
					onDismiss={() => topicOpt.clearError()}
				/>
			</section>

			{/* Canonical alias (read-only display in v1; editable iff PL permits — but
			    we render as read-only for now to avoid the alias-mapping flow). */}
			<section>
				<h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Canonical alias
				</h3>
				<Tooltip
					content={aliasTooltip()}
					disabled={perms.canSetCanonicalAlias()}
				>
					<p class="rounded bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary">
						<Show
							when={serverAlias()}
							fallback={
								<span class="text-text-muted">No canonical alias set.</span>
							}
						>
							{serverAlias()}
						</Show>
					</p>
				</Tooltip>
			</section>
		</div>
	);
};

export { GeneralTab };
