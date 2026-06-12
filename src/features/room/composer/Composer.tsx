import type { RoomMember } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { createPicker } from "../../../components/picker/Picker";
import { EmojiPicker } from "../../emoji/EmojiPicker";
import type { ImagePack, PickerEmoji, ResolvedEmote } from "../../emoji/types";
import { buildShortcodeLookup } from "../../emoji/useImagePacks";
import { GifPicker } from "../../gif/GifPicker";
import { useGifConfig } from "../../gif/gifConfig";
import type { GifItem } from "../../gif/types";
import type { TimelineEvent } from "../timeline/useTimeline";
import { AttachmentTray } from "./AttachmentTray";
import {
	type CustomEmoji,
	escapeHtml,
	formatMarkdown,
	type Mention,
} from "./markdown";
import { ENCRYPTED_UNSUPPORTED_MESSAGE } from "./media/mediaContent";
import type { PendingAttachment } from "./media/types";
import { createPendingAttachment, uploadAndSend } from "./media/uploadMedia";

function buildReplyFallback(
	replyTo: TimelineEvent,
	roomId: string,
): {
	bodyPrefix: string;
	htmlPrefix: string;
} {
	const quotedLines = replyTo.body
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	const bodyPrefix = `> <${replyTo.senderId}> ${replyTo.body.split("\n")[0]}\n${
		replyTo.body.includes("\n")
			? `${quotedLines.split("\n").slice(1).join("\n")}\n`
			: ""
	}\n`;

	const escapedSender = escapeHtml(replyTo.senderId);
	const escapedBody = escapeHtml(replyTo.body).replace(/\n/g, "<br>");
	const eventPermalink = `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(replyTo.eventId)}`;
	const senderPermalink = `https://matrix.to/#/${encodeURIComponent(replyTo.senderId)}`;
	const htmlPrefix =
		`<mx-reply><blockquote>` +
		`<a href="${eventPermalink}">In reply to</a> ` +
		`<a href="${senderPermalink}">${escapedSender}</a><br>` +
		`${escapedBody}` +
		`</blockquote></mx-reply>`;

	return { bodyPrefix, htmlPrefix };
}

const SHORTCODE_RE = /(?:^|[^:\w]):([a-zA-Z0-9_-]{2,50}):(?![\w:])/g;

/** Extract custom emoji shortcodes present in text using a prebuilt lookup. */
function findCustomEmoji(
	text: string,
	lookup: Map<string, ResolvedEmote>,
): CustomEmoji[] {
	if (lookup.size === 0) return [];

	const found: CustomEmoji[] = [];
	const seen = new Set<string>();

	// Strip code blocks before scanning
	const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");

	for (const match of stripped.matchAll(SHORTCODE_RE)) {
		const shortcode = match[1];
		if (seen.has(shortcode)) continue;
		const emote = lookup.get(shortcode);
		if (emote) {
			seen.add(shortcode);
			found.push({ shortcode, mxcUrl: emote.mxcUrl });
		}
	}
	return found;
}

const TYPING_TIMEOUT_MS = 30_000;
const TYPING_RESEND_MS = 25_000;

const Composer: Component<{
	roomId: string;
	replyTo?: TimelineEvent | null;
	editingEvent?: TimelineEvent | null;
	onCancelReply?: () => void;
	onCancelEdit?: () => void;
	onSent?: () => void;
	packs: ImagePack[];
	/**
	 * Hands the parent the composer's file-queue seam so out-of-composer
	 * entry points (e.g. TimelineView's drag-and-drop overlay) can enqueue
	 * files into the same queue the attach button and paste use. Registered
	 * once on mount; the closure reads `props` reactively, so the single
	 * registration stays correct across room switches (the composer is one
	 * reused instance).
	 */
	onEnqueueReady?: (enqueue: (files: Iterable<File>) => void) => void;
}> = (props) => {
	const { client } = useClient();
	const [text, setText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [mentions, setMentions] = createSignal<Mention[]>([]);
	const [mentionQuery, setMentionQuery] = createSignal<string | null>(null);
	const [emojiPickerOpen, setEmojiPickerOpen] = createSignal(false);
	const [gifPickerOpen, setGifPickerOpen] = createSignal(false);
	const [attachments, setAttachments] = createSignal<PendingAttachment[]>([]);
	const gifConfig = useGifConfig();

	/** Queue raw files for upload. The shared seam for paste / attach / drop. */
	const enqueueFiles = (files: Iterable<File>): void => {
		if (props.editingEvent) return;
		const list = Array.from(files);
		if (list.length === 0) return;
		// Gate encrypted rooms here, at the single seam all entry points share,
		// so the file is rejected with immediate feedback rather than queuing,
		// captioning, and only failing at send time. (Phase 4 lifts this.)
		if (client.getRoom(props.roomId)?.hasEncryptionStateEvent()) {
			setError(ENCRYPTED_UNSUPPORTED_MESSAGE);
			return;
		}
		setAttachments((prev) => [...prev, ...list.map(createPendingAttachment)]);
	};

	// Expose the enqueue seam to the parent so the room view's drag-and-drop
	// overlay can feed dropped files into this same queue.
	onMount(() => props.onEnqueueReady?.(enqueueFiles));

	let fileInputRef: HTMLInputElement | undefined;

	/** Queue files chosen via the attach button's hidden file input. */
	const onFileInputChange = (
		e: Event & { currentTarget: HTMLInputElement },
	): void => {
		const input = e.currentTarget;
		if (input.files) enqueueFiles(input.files);
		// Reset so picking the same file again still fires `change`.
		input.value = "";
	};

	const updateAttachment = (
		id: string,
		patch: Partial<PendingAttachment>,
	): void => {
		setAttachments((prev) =>
			prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
		);
	};

	const removeAttachment = (id: string): void => {
		setAttachments((prev) => {
			const found = prev.find((a) => a.id === id);
			if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
			return prev.filter((a) => a.id !== id);
		});
	};

	const clearAttachments = (): void => {
		setAttachments((prev) => {
			for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
			return [];
		});
	};

	/** Pull any image blobs out of a paste and queue them. */
	const onPaste = (e: ClipboardEvent): void => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		let hasText = false;
		// DataTransferItemList is index-accessed, not reliably iterable.
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === "string") hasText = true;
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (files.length === 0) return;
		// Only suppress the textarea's default when the clipboard is image-only;
		// if text was pasted alongside the image, let the native paste insert it.
		if (!hasText) e.preventDefault();
		enqueueFiles(files);
	};

	// Memoize shortcode lookup to avoid rebuilding on every send
	const shortcodeLookup = createMemo(() => buildShortcodeLookup(props.packs));

	let textareaRef: HTMLTextAreaElement | undefined;
	let emojiButtonRef: HTMLButtonElement | undefined;
	let gifButtonRef: HTMLButtonElement | undefined;
	let lastTypingSentAt = 0;
	let typingRoomId: string | null = null;

	// Mention picker
	const {
		Picker: MentionPicker,
		handlePickerKey,
		getActiveDescendant,
		listboxId,
	} = createPicker<RoomMember>();

	const roomMembers = createMemo(() => {
		const room = client.getRoom(props.roomId);
		return room ? room.getJoinedMembers() : [];
	});

	const MAX_PICKER_RESULTS = 50;

	// Shared filtered member list — used by both picker and ARIA state
	const filteredMembers = createMemo(() => {
		const q = mentionQuery();
		if (q === null) return [];
		const lowerQ = q.toLowerCase();
		const results: RoomMember[] = [];
		for (const m of roomMembers()) {
			const name = (m.name ?? "").toLowerCase();
			const uid = m.userId.toLowerCase();
			if (name.includes(lowerQ) || uid.includes(lowerQ)) {
				results.push(m);
				if (results.length >= MAX_PICKER_RESULTS) break;
			}
		}
		return results;
	});

	const pickerRendered = () => filteredMembers().length > 0;

	function detectMention(currentText?: string): void {
		const el = textareaRef;
		if (!el) return;
		const pos = el.selectionStart;
		const before = (currentText ?? el.value).slice(0, pos);
		// Look for @ at start or after non-word char, capture query after it
		const match = before.match(/(^|[^\w])@(\S*)$/);
		if (match) {
			setMentionQuery(match[2]);
		} else {
			setMentionQuery(null);
		}
	}

	/** Prune mentions whose @DisplayName is no longer in non-code text */
	function reconcileMentions(msg: string): Mention[] {
		// Strip code blocks and inline code so mentions inside code don't count
		const stripped = msg
			.replace(/```(?:[^\n]*\n[\s\S]*?```|[\s\S]*?```)/g, "")
			.replace(/`[^`]+`/g, "");
		return mentions().filter((m) => {
			const token = `@${m.displayName}`;
			// Scan all occurrences in stripped text — keep if any has valid word boundaries
			let searchFrom = 0;
			while (searchFrom < stripped.length) {
				const idx = stripped.indexOf(token, searchFrom);
				if (idx < 0) return false;
				const beforeOk = idx === 0 || !/\w/.test(stripped[idx - 1]);
				const afterIdx = idx + token.length;
				const afterOk =
					afterIdx >= stripped.length || !/\w/.test(stripped[afterIdx]);
				if (beforeOk && afterOk) return true;
				searchFrom = idx + 1;
			}
			return false;
		});
	}

	function onMentionSelect(member: RoomMember): void {
		const el = textareaRef;
		if (!el) return;
		const pos = el.selectionStart;
		const currentText = text();
		const before = currentText.slice(0, pos);
		// Use same regex as detectMention to find the triggering @
		const triggerMatch = before.match(/(^|[^\w])@(\S*)$/);
		if (!triggerMatch) return;
		const atIdx = before.length - triggerMatch[2].length - 1;

		const rawName = member.name?.trim() || member.userId;
		// Strip leading @ from userId fallback to avoid @@user:server
		const displayName = rawName.startsWith("@") ? rawName.slice(1) : rawName;
		const insertion = `@${displayName} `;
		// Replace the entire @partial token (from @ through any non-whitespace after caret)
		const afterCaret = currentText.slice(pos);
		const trailingQuery = afterCaret.match(/^\S*/)?.[0] ?? "";
		const after = currentText.slice(pos + trailingQuery.length);
		const newText = currentText.slice(0, atIdx) + insertion + after;

		setText(newText);
		setMentionQuery(null);

		// Add to mentions list (deduplicate by userId)
		setMentions((prev) => {
			if (prev.some((m) => m.userId === member.userId)) return prev;
			return [...prev, { userId: member.userId, displayName }];
		});

		// Move caret after inserted mention
		requestAnimationFrame(() => {
			if (!textareaRef) return;
			const newPos = atIdx + insertion.length;
			textareaRef.setSelectionRange(newPos, newPos);
			textareaRef.focus();
			autoResize();
		});
	}

	function onEmojiSelect(item: PickerEmoji): void {
		const el = textareaRef;
		if (!el) return;

		let insertion: string;
		if (item.kind === "unicode") {
			insertion = item.emoji.unicode;
		} else {
			// Custom emoji: insert :shortcode: in text
			insertion = `:${item.emote.shortcode}:`;
		}

		const pos = el.selectionStart;
		const currentText = text();
		const before = currentText.slice(0, pos);
		const after = currentText.slice(el.selectionEnd);
		// Add space after emoji if there isn't one
		const spacer = after.length > 0 && after[0] !== " " ? " " : "";
		const newText = before + insertion + spacer + after;
		setText(newText);
		setEmojiPickerOpen(false);

		requestAnimationFrame(() => {
			if (!textareaRef) return;
			const newPos = pos + insertion.length + spacer.length;
			textareaRef.setSelectionRange(newPos, newPos);
			textareaRef.focus();
			autoResize();
		});
	}

	async function onGifSelect(gif: GifItem): Promise<void> {
		setGifPickerOpen(false);

		// Send the GIF URL as a plain text message (TOS-compliant: no re-hosting).
		// Attach an `info` block carrying intrinsic width/height (and mimetype)
		// so receivers can reserve the layout box before the GIF decodes,
		// eliminating the visible expand-on-load that confuses the virtualizer.
		// Other clients silently ignore `info` on m.text and still render the
		// URL the same way they do today.
		const content: Record<string, unknown> = {
			msgtype: "m.text",
			body: gif.url,
			info: {
				w: gif.width,
				h: gif.height,
				mimetype: "image/gif",
			},
		};

		// Attach reply fallback + metadata if replying (same format as normal sends)
		if (props.replyTo) {
			const { bodyPrefix, htmlPrefix } = buildReplyFallback(
				props.replyTo,
				props.roomId,
			);
			content.body = bodyPrefix + gif.url;
			content.format = "org.matrix.custom.html";
			content.formatted_body = htmlPrefix + escapeHtml(gif.url);
			content["m.relates_to"] = {
				"m.in_reply_to": { event_id: props.replyTo.eventId },
			};
		}

		setSending(true);
		setError(null);
		stopTyping();
		try {
			await client.sendMessage(
				props.roomId,
				content as unknown as RoomMessageEventContent,
			);
			props.onSent?.();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to send GIF");
		} finally {
			setSending(false);
			if (
				!document.activeElement ||
				document.activeElement === document.body ||
				document.activeElement === textareaRef
			) {
				textareaRef?.focus();
			}
		}
	}

	// Pre-fill text when entering edit mode
	createEffect(
		on(
			() => props.editingEvent,
			(ev) => {
				setMentions([]);
				setMentionQuery(null);
				setGifPickerOpen(false);
				if (ev) {
					// Edits can't carry attachments; discard any queued so the
					// tray doesn't linger un-sendable during the edit.
					clearAttachments();
					setText(ev.body);
					requestAnimationFrame(() => {
						autoResize();
						textareaRef?.focus();
					});
				}
			},
		),
	);

	// Clear state when switching rooms
	createEffect(
		on(
			() => props.roomId,
			() => {
				stopTyping();
				lastTypingSentAt = 0;
				typingRoomId = null;
				setText("");
				setError(null);
				setMentions([]);
				setMentionQuery(null);
				setEmojiPickerOpen(false);
				setGifPickerOpen(false);
				clearAttachments();
				// A send pinned to the previous room may still be in flight; reset
				// the busy flag so the newly selected room's composer is usable.
				// That send's own completion writes are gated on still being on
				// its room, so they won't clobber this fresh state.
				setSending(false);
				requestAnimationFrame(autoResize);
			},
		),
	);

	// Stop typing and release preview object URLs on unmount
	onCleanup(() => {
		stopTyping();
		clearAttachments();
	});

	const autoResize = (): void => {
		const el = textareaRef;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	};

	const sendTyping = (): void => {
		const now = Date.now();
		if (now - lastTypingSentAt < TYPING_RESEND_MS) return;
		lastTypingSentAt = now;
		typingRoomId = props.roomId;
		client.sendTyping(props.roomId, true, TYPING_TIMEOUT_MS).catch(() => {
			// Reset so next keystroke retries promptly
			lastTypingSentAt = 0;
		});
	};

	const stopTyping = (): void => {
		if (typingRoomId) {
			const roomToStop = typingRoomId;
			lastTypingSentAt = 0;
			typingRoomId = null;
			client.sendTyping(roomToStop, false, TYPING_TIMEOUT_MS).catch(() => {
				// Best-effort; typing indicators are ephemeral
			});
		}
	};

	const restoreFocus = (): void => {
		if (
			!document.activeElement ||
			document.activeElement === document.body ||
			document.activeElement === textareaRef
		) {
			textareaRef?.focus();
		}
	};

	const send = async (): Promise<void> => {
		const msg = text().trim();
		if ((!msg && attachments().length === 0) || sending()) return;

		// Pin the target room (and reply target) for the whole send: uploads
		// await, and the user could switch rooms mid-send. The composer is a
		// single reused instance with shared signals, so we (a) deliver to the
		// pinned room and (b) gate every completion-time write on still being on
		// that room, so a send that finishes after the user navigated away can't
		// clobber the newly selected room's composer.
		const roomId = props.roomId;
		const replyTo = props.replyTo;
		const onThisRoom = (): boolean => props.roomId === roomId;

		// Edit mode: send m.replace event
		if (props.editingEvent) {
			const currentMentions = reconcileMentions(msg);
			const emoji = findCustomEmoji(msg, shortcodeLookup());
			const { body: newBody, formatted_body } = formatMarkdown(
				msg,
				currentMentions,
				emoji,
			);
			const newContent: Record<string, unknown> = {
				msgtype: "m.text",
				body: newBody,
			};
			if (formatted_body) {
				newContent.format = "org.matrix.custom.html";
				newContent.formatted_body = formatted_body;
			}
			if (currentMentions.length > 0) {
				newContent["m.mentions"] = {
					user_ids: currentMentions.map((m) => m.userId),
				};
			}

			const content: Record<string, unknown> = {
				msgtype: "m.text",
				body: `* ${newBody}`,
				"m.new_content": newContent,
				"m.relates_to": {
					rel_type: "m.replace",
					event_id: props.editingEvent.eventId,
				},
			};
			if (formatted_body) {
				content.format = "org.matrix.custom.html";
				content.formatted_body = `* ${formatted_body}`;
			}

			const draft = text();
			const draftMentions = mentions();
			setText("");
			setError(null);
			setMentions([]);
			setMentionQuery(null);
			setEmojiPickerOpen(false);
			setSending(true);
			stopTyping();
			requestAnimationFrame(autoResize);

			try {
				await client.sendMessage(
					roomId,
					content as unknown as RoomMessageEventContent,
				);
				if (onThisRoom()) props.onSent?.();
			} catch (e) {
				if (onThisRoom()) {
					if (!text()) {
						setText(draft);
						setMentions(draftMentions);
					}
					setError(e instanceof Error ? e.message : "Failed to edit message");
					requestAnimationFrame(autoResize);
				}
			} finally {
				if (onThisRoom()) {
					setSending(false);
					restoreFocus();
				}
			}
			return;
		}

		// Normal send mode

		// Compute the trailing-text payload from the original input and snapshot
		// the draft, then clear the composer up front — mirroring the text-only
		// path — so a slow attachment upload can't race the textarea and wipe
		// text the user types while the upload is in flight.
		const hasText = msg.length > 0;
		const currentMentions = hasText ? reconcileMentions(msg) : [];
		const emoji = hasText ? findCustomEmoji(msg, shortcodeLookup()) : [];
		const draft = text();
		const draftMentions = mentions();
		setText("");
		setError(null);
		setMentions([]);
		setMentionQuery(null);
		setEmojiPickerOpen(false);
		setGifPickerOpen(false);
		requestAnimationFrame(autoResize);

		// Restore the trailing text on failure, but only if we're still on the
		// send's room and the user hasn't already started a new message.
		const restoreDraft = (): void => {
			if (onThisRoom() && !text()) {
				setText(draft);
				setMentions(draftMentions);
				requestAnimationFrame(autoResize);
			}
		};

		// Send any queued attachments first. The reply relation is attached to
		// the first event only (whether that's an attachment or the trailing
		// text) so we don't emit one reply per file.
		let replyConsumed = false;
		if (attachments().length > 0) {
			setSending(true);
			stopTyping();
			let allOk = true;
			for (const att of [...attachments()]) {
				// The user can remove a still-queued attachment from the tray while
				// an earlier one uploads; skip anything no longer in the queue.
				if (!attachments().some((a) => a.id === att.id)) continue;
				updateAttachment(att.id, {
					status: "uploading",
					progress: 0,
					error: undefined,
				});
				try {
					await uploadAndSend(client, roomId, att, {
						replyTo: replyConsumed ? null : replyTo,
						onProgress: (p) => updateAttachment(att.id, { progress: p }),
					});
					// Clear the reply at the source once an event has carried it,
					// so a retry after a partial failure doesn't re-attach it and
					// emit a second reply. Only touch the parent's reply state if
					// we're still on this room (else we'd clear another room's reply).
					if (replyTo && !replyConsumed) {
						replyConsumed = true;
						if (onThisRoom()) props.onCancelReply?.();
					}
					removeAttachment(att.id);
				} catch (e) {
					allOk = false;
					updateAttachment(att.id, {
						status: "error",
						error: e instanceof Error ? e.message : "Failed to upload file",
					});
				}
			}
			// Leave failed attachments in the tray and restore the trailing text
			// so the user can retry without losing it.
			if (!allOk) {
				restoreDraft();
				if (onThisRoom()) {
					setSending(false);
					restoreFocus();
				}
				return;
			}
			if (!hasText) {
				if (onThisRoom()) {
					setSending(false);
					props.onSent?.();
					restoreFocus();
				}
				return;
			}
			// Otherwise fall through to send the trailing text message.
		}

		const { body, formatted_body } = formatMarkdown(
			msg,
			currentMentions,
			emoji,
		);
		const content: Record<string, unknown> = {
			msgtype: "m.text",
			body,
		};
		if (formatted_body) {
			content.format = "org.matrix.custom.html";
			content.formatted_body = formatted_body;
		}
		if (currentMentions.length > 0) {
			content["m.mentions"] = {
				user_ids: currentMentions.map((m) => m.userId),
			};
		}

		// Add reply metadata if replying (unless an attachment already carried it)
		if (replyTo && !replyConsumed) {
			const { bodyPrefix, htmlPrefix } = buildReplyFallback(replyTo, roomId);
			const replyHtmlBody =
				(content.formatted_body as string | undefined) ??
				escapeHtml(content.body as string).replace(/\n/g, "<br>");
			content.body = bodyPrefix + (content.body as string);
			content.format = "org.matrix.custom.html";
			content.formatted_body = htmlPrefix + replyHtmlBody;
			content["m.relates_to"] = {
				"m.in_reply_to": { event_id: replyTo.eventId },
			};
		}

		setSending(true);
		stopTyping();

		try {
			await client.sendMessage(
				roomId,
				content as unknown as RoomMessageEventContent,
			);
			if (onThisRoom()) props.onSent?.();
		} catch (e) {
			restoreDraft();
			if (onThisRoom()) {
				setError(e instanceof Error ? e.message : "Failed to send message");
			}
		} finally {
			if (onThisRoom()) {
				setSending(false);
				restoreFocus();
			}
		}
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		// Picker gets first dibs on keyboard events
		if (handlePickerKey(e)) return;

		if (e.key === "Escape" && props.editingEvent) {
			e.preventDefault();
			stopTyping();
			setText("");
			setMentions([]);
			setMentionQuery(null);
			requestAnimationFrame(autoResize);
			props.onCancelEdit?.();
			return;
		}
		if (e.key === "Escape" && props.replyTo) {
			e.preventDefault();
			props.onCancelReply?.();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div class="border-t border-border-subtle px-4 py-3">
			<Show when={props.editingEvent}>
				{(editing) => (
					<div class="mb-2 flex items-center gap-2 rounded bg-surface-2/50 px-3 py-1.5">
						<div class="min-w-0 flex-1 border-l-2 border-info-border pl-2">
							<p class="truncate text-xs font-medium text-info-text">
								Editing message
							</p>
							<p class="truncate text-xs text-text-disabled">
								{editing().body.trim() || "Message"}
							</p>
						</div>
						<button
							type="button"
							class="shrink-0 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
							onClick={() => {
								stopTyping();
								setText("");
								setMentions([]);
								setMentionQuery(null);
								requestAnimationFrame(autoResize);
								props.onCancelEdit?.();
							}}
							aria-label="Cancel edit"
						>
							✕
						</button>
					</div>
				)}
			</Show>
			<Show when={!props.editingEvent && props.replyTo}>
				{(reply) => (
					<div class="mb-2 flex items-center gap-2 rounded bg-surface-2/50 px-3 py-1.5">
						<div class="min-w-0 flex-1 border-l-2 border-accent-hover pl-2">
							<p class="truncate text-xs font-medium text-text-muted">
								{reply().senderName.trim() || "Unknown"}
							</p>
							<p class="truncate text-xs text-text-disabled">
								{reply().body.trim() || "Message"}
							</p>
						</div>
						<button
							type="button"
							class="shrink-0 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
							onClick={() => props.onCancelReply?.()}
							aria-label="Cancel reply"
						>
							✕
						</button>
					</div>
				)}
			</Show>
			<Show when={error()}>
				<div
					class="mb-2 rounded bg-danger-bg/30 px-3 py-1.5 text-xs text-danger-text"
					role="alert"
				>
					{error()}
				</div>
			</Show>
			<Show when={attachments().length > 0}>
				<AttachmentTray
					attachments={attachments()}
					onRemove={removeAttachment}
					onCaptionChange={(id, caption) => updateAttachment(id, { caption })}
				/>
			</Show>
			<div class="relative">
				<MentionPicker
					items={filteredMembers()}
					query={mentionQuery() ?? ""}
					visible={mentionQuery() !== null}
					onSelect={onMentionSelect}
					onClose={() => setMentionQuery(null)}
					filterFn={(_item, _q) => true}
					renderItem={(member, highlighted) => (
						<div class="flex items-center gap-2">
							<div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-text-secondary">
								{((member.name ?? "").trim() || "?").charAt(0).toUpperCase()}
							</div>
							<div class="min-w-0 flex-1">
								<span
									class={
										highlighted ? "text-text-primary" : "text-text-secondary"
									}
								>
									{member.name?.trim() || member.userId}
								</span>
								<span class="ml-1 text-xs text-text-faint">
									{member.userId}
								</span>
							</div>
						</div>
					)}
					position={{ bottom: "100%", left: "0" }}
				/>
				{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is conditionally combobox */}
				<textarea
					ref={textareaRef}
					data-composer-textarea
					value={text()}
					onInput={(e) => {
						const val = e.currentTarget.value;
						setText(val);
						autoResize();
						detectMention(val);
						if (val.trim()) {
							sendTyping();
						} else {
							stopTyping();
						}
					}}
					onBlur={() => {
						stopTyping();
						setMentionQuery(null);
					}}
					onKeyUp={() => detectMention()}
					onClick={() => detectMention()}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					placeholder={props.editingEvent ? "Edit message…" : "Send a message…"}
					role={pickerRendered() ? "combobox" : undefined}
					aria-label={props.editingEvent ? "Edit message" : "Message"}
					aria-expanded={pickerRendered() ? true : undefined}
					aria-activedescendant={getActiveDescendant()}
					aria-autocomplete={pickerRendered() ? "list" : undefined}
					aria-controls={pickerRendered() ? listboxId : undefined}
					class="w-full resize-none rounded-lg bg-surface-2 px-4 py-2.5 pr-28 text-sm text-text-emphasis placeholder:text-text-disabled focus:outline-none focus:ring-1 focus:ring-accent-hover"
					rows={1}
				/>
				{/* Attach file button (hidden when editing — edits can't carry
				    attachments). The hidden input accepts images and arbitrary
				    files; non-media files are classified as m.file at send. */}
				<Show when={!props.editingEvent}>
					<input
						ref={(el) => {
							fileInputRef = el;
						}}
						type="file"
						multiple
						data-composer-file-input
						class="hidden"
						onChange={onFileInputChange}
					/>
					<button
						type="button"
						class="absolute right-16 bottom-2.5 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
						onClick={() => fileInputRef?.click()}
						aria-label="Attach file"
					>
						📎
					</button>
				</Show>
				{/* GIF picker button (only when GIF search is available and not editing) */}
				<Show when={gifConfig.available() && !props.editingEvent}>
					<button
						ref={(el) => {
							gifButtonRef = el;
						}}
						type="button"
						class="absolute bottom-2.5 right-9 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
						onClick={() => {
							setGifPickerOpen((v) => !v);
							setEmojiPickerOpen(false);
						}}
						aria-label="Open GIF picker"
						aria-expanded={gifPickerOpen()}
					>
						GIF
					</button>
				</Show>
				{/* Emoji picker button */}
				<button
					ref={(el) => {
						emojiButtonRef = el;
					}}
					type="button"
					class="absolute bottom-2.5 right-2 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
					onClick={() => {
						setEmojiPickerOpen((v) => !v);
						setGifPickerOpen(false);
					}}
					aria-label="Open emoji picker"
					aria-expanded={emojiPickerOpen()}
				>
					😀
				</button>
				{/* GIF picker popover */}
				<Show when={gifPickerOpen()}>
					<div class="absolute bottom-full right-0 z-20 mb-1">
						<GifPicker
							onSelect={onGifSelect}
							onClose={(focusTrigger) => {
								setGifPickerOpen(false);
								if (focusTrigger) gifButtonRef?.focus();
							}}
							triggerRef={gifButtonRef}
						/>
					</div>
				</Show>
				{/* Emoji picker popover */}
				<Show when={emojiPickerOpen()}>
					<div class="absolute bottom-full right-0 z-20 mb-1">
						<EmojiPicker
							packs={props.packs}
							onSelect={onEmojiSelect}
							onClose={() => {
								setEmojiPickerOpen(false);
								emojiButtonRef?.focus();
							}}
						/>
					</div>
				</Show>
			</div>
		</div>
	);
};

export { Composer };
