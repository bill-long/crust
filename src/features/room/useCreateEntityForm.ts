import { EventType, Preset, Visibility } from "matrix-js-sdk";
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { avatarHttpUrl } from "../../lib/avatar";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { parseInvites } from "../../lib/inviteParsing";
import { useAvatarUpload } from "../../lib/useAvatarUpload";
import type {
	CreateEntityFormProps,
	CreateEntitySubmission,
} from "./CreateEntityForm";

/** Local-part of a Matrix room alias. Server adds ":server" + leading "#". */
const ALIAS_LOCAL_PART_RE = /^[A-Za-z0-9._=/+-]+$/;

export function useCreateEntityForm(props: CreateEntityFormProps) {
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

	const [name, setName] = createSignal("");
	const [topic, setTopic] = createSignal("");
	const [alias, setAlias] = createSignal("");
	const [isPublic, setIsPublic] = createSignal(false);
	const [encryption, setEncryption] = createSignal(true);
	/** Once the user toggles encryption manually, stop auto-defaulting. */
	const [encryptionTouched, setEncryptionTouched] = createSignal(false);
	const [addToSpace, setAddToSpace] = createSignal(true);
	const [inviteRaw, setInviteRaw] = createSignal("");
	const avatarUpload = useAvatarUpload(props.client, { scope: props.open });
	const avatarMxc = avatarUpload.mxc;
	const avatarUploading = avatarUpload.uploading;
	const avatarError = avatarUpload.error;
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

	const avatarHttp = createMemo<string | null>(() =>
		avatarHttpUrl(props.client, avatarMxc(), 96),
	);

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
		setName("");
		setTopic("");
		setAlias("");
		setIsPublic(false);
		setEncryption(true);
		setEncryptionTouched(false);
		setAddToSpace(true);
		setInviteRaw("");
		avatarUpload.remove();
		setError(null);
		setSubmitting(false);
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				resetForm();
				setSnapshotSpaceId(props.spaceId ?? null);
			}
		}),
	);

	const tryClose = (): void => {
		if (submitting()) return;
		props.onClose();
	};

	const uploadAvatar = avatarUpload.pickFile;
	const removeAvatar = avatarUpload.remove;

	async function handleSubmit(e: Event): Promise<void> {
		e.preventDefault();
		if (!canSubmit()) return;
		const myGeneration = submitGeneration;
		const isCurrent = () =>
			mounted && props.open() && myGeneration === submitGeneration;
		setSubmitting(true);
		setError(null);
		const opts: CreateEntitySubmission["options"] = {
			name: name().trim(),
			visibility: isPublic() ? Visibility.Public : Visibility.Private,
			preset: isPublic() ? Preset.PublicChat : Preset.PrivateChat,
		};
		if (topic().trim()) opts.topic = topic().trim();
		if (trimmedAlias()) opts.room_alias_name = trimmedAlias();
		if (parsedInvites().mxids.length) opts.invite = parsedInvites().mxids;
		if (avatarMxc())
			opts.initial_state = [
				{
					type: EventType.RoomAvatar,
					state_key: "",
					content: { url: avatarMxc() },
				},
			];
		try {
			await props.onSubmit({
				options: opts,
				encryption: encryption(),
				spaceId: addToSpace() ? snapshotSpaceId() : null,
				avatarUrl: avatarHttp(),
				isCurrent,
			});
		} catch (err) {
			if (!isCurrent()) return;
			setError(userFacingErrorMessage(err, props.failureMessage));
			setSubmitting(false);
		}
	}

	return {
		name,
		setName,
		topic,
		setTopic,
		alias,
		setAlias,
		isPublic,
		setIsPublic,
		encryption,
		setEncryption,
		setEncryptionTouched,
		addToSpace,
		setAddToSpace,
		inviteRaw,
		setInviteRaw,
		avatarUploading,
		avatarError,
		submitting,
		error,
		snapshotSpaceId,
		parsedInvites,
		aliasValid,
		homeserverDomain,
		avatarHttp,
		canSubmit,
		tryClose,
		uploadAvatar,
		removeAvatar,
		handleSubmit,
	};
}
