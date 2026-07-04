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
import {
	type CustomEmoji,
	escapeHtml,
	formatMarkdown,
	type Mention,
} from "../../../lib/markdown";
import { EmojiPicker } from "../../emoji/EmojiPicker";
import { MessageBody } from "../../emoji/MessageBody";
import type { ImagePack, PickerEmoji, ResolvedEmote } from "../../emoji/types";
import { buildShortcodeLookup } from "../../emoji/useImagePacks";
import { GifPicker } from "../../gif/GifPicker";
import { useGifConfig } from "../../gif/gifConfig";
import type { GifItem } from "../../gif/types";
import { CreatePollDialog } from "../poll/CreatePollDialog";
import type { TimelineEvent } from "../timeline/useTimeline";
import { AttachmentTray } from "./AttachmentTray";
import { composerTextareaScope } from "./composerTextarea";
import { FormattingToolbar } from "./FormattingToolbar";
import type { PendingAttachment } from "./media/types";
import { createPendingAttachment, uploadAndSend } from "./media/uploadMedia";
import {
	createVoiceRecorder,
	isVoiceRecordingSupported,
} from "./media/voiceRecorder";
import { VoiceRecordingBar } from "./VoiceRecordingBar";

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
	/** Thread scope: sends target this thread (SDK 3-arg overload builds
	 *  the MSC3440 relation). Absent for the main room composer. */
	threadRootId?: string;
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
	const [pollDialogOpen, setPollDialogOpen] = createSignal(false);
	const [previewOpen, setPreviewOpen] = createSignal(false);
	const [attachments, setAttachments] = createSignal<PendingAttachment[]>([]);
	const gifConfig = useGifConfig();
	/** Measured width of the action strip; the textarea reserves exactly
	 *  this so text never runs under the buttons regardless of which are
	 *  visible. Initial value approximates the full strip pre-measure. */
	const [stripWidth, setStripWidth] = createSignal(160);

	// Voice notes (MSC3245). Feature-detected once: the mic button is
	// hidden entirely where MediaRecorder/AudioContext/getUserMedia are
	// unavailable.
	const voiceSupported = isVoiceRecordingSupported();
	/** Guards the STOP phase only (not the upload): a double-click on the
	 *  bar's send button must not deliver the same recording twice, but
	 *  once the clip is in hand the flag clears so the mic is immediately
	 *  usable again and uploads from different rooms can overlap. */
	const [voiceStopping, setVoiceStopping] = createSignal(false);
	const voiceRecorder = createVoiceRecorder({
		onMaxDuration: () => void stopAndSendVoice(),
		// Mic unplugged / permission revoked: deliver what was captured.
		onInterrupted: () => void stopAndSendVoice(),
	});
	onCleanup(() => voiceRecorder.dispose());

	const startRecording = async (): Promise<void> => {
		if (voiceRecorder.recording() || voiceStopping()) return;
		setError(null);
		// The recording bar overlays the input area; a picker left open
		// would float above it and edit the hidden draft.
		setEmojiPickerOpen(false);
		setGifPickerOpen(false);
		try {
			await voiceRecorder.start();
			// Keyboard focus moves into the recording bar (the composer
			// input goes inert underneath it).
			queueMicrotask(() => voiceSendButtonRef?.focus());
		} catch {
			setError("Couldn't access the microphone");
		}
	};

	/** Stop the recording and send it as an MSC3245 voice note through the
	 *  regular upload pipeline (encrypts in E2EE rooms). Same room/reply
	 *  pinning as send(); a failed upload lands the attachment in the tray
	 *  with the standard error/retry affordance instead of dropping it. */
	const stopAndSendVoice = async (): Promise<void> => {
		if (voiceStopping()) return;
		const roomId = props.roomId;
		const replyTo = props.replyTo;
		// Pinned: the recorder stop awaits, and the panel's thread (or the
		// panel itself) can change under the send.
		const threadRootId = props.threadRootId ?? null;
		const onThisRoom = (): boolean => props.roomId === roomId;
		let attachment: PendingAttachment | null = null;
		setVoiceStopping(true);
		try {
			const recorded = await voiceRecorder.stop();
			if (recorded) {
				const extension =
					recorded.mimetype === "audio/ogg"
						? "ogg"
						: recorded.mimetype === "audio/mp4"
							? "m4a"
							: "webm";
				const file = new File([recorded.blob], `Voice message.${extension}`, {
					type: recorded.mimetype,
				});
				attachment = {
					...createPendingAttachment(file),
					voice: recorded.voice,
				};
			}
		} finally {
			setVoiceStopping(false);
			// The recording bar (which held focus) disappears with the stop;
			// hand focus back to the input now, not after the upload.
			restoreFocus();
		}
		if (!attachment) {
			if (onThisRoom()) setError("Nothing was recorded");
			return;
		}
		setError(null);
		stopTyping();
		try {
			await uploadAndSend(client, roomId, attachment, {
				replyTo: replyTo ?? undefined,
				threadId: threadRootId,
			});
			// Don't fire onSent while an edit is active: TimelineView
			// reads it as "edit complete" and would clear the edit the
			// user is composing.
			if (onThisRoom() && !props.editingEvent) {
				props.onCancelReply?.();
				props.onSent?.();
			}
		} catch (e) {
			// Deliberately NOT gated on room or edit mode: the alternative
			// to parking the failed recording is silently losing it. The
			// tray belongs to the (shared) composer instance, so after a
			// room switch the recording stays visible and removable, and a
			// retry sends it to the currently selected room.
			const failed = attachment;
			setAttachments((prev) => [
				...prev,
				{
					...failed,
					status: "error",
					error:
						e instanceof Error ? e.message : "Failed to send voice message",
				},
			]);
			setError("Failed to send voice message - kept in the tray");
		}
	};

	/** Queue raw files for upload. The shared seam for paste / attach / drop. */
	const enqueueFiles = (files: Iterable<File>): void => {
		if (props.editingEvent) return;
		const list = Array.from(files);
		if (list.length === 0) return;
		// Encrypted and unencrypted rooms both accept attachments; the send path
		// (uploadAndSend) encrypts when the room is encrypted.
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

	// Live preview: render the in-progress draft through the SAME send→receive
	// pipeline a real message takes (formatMarkdown → MessageBody), so what the
	// user previews is byte-identical to what recipients render. Computed only
	// when the preview is open; returns null for an empty draft so the panel can
	// show a placeholder instead of an empty box.
	const previewContent = createMemo(() => {
		if (!previewOpen()) return null;
		const msg = text();
		if (!msg.trim()) return null;
		return formatMarkdown(
			msg,
			reconcileMentions(msg),
			findCustomEmoji(msg, shortcodeLookup()),
		);
	});

	let textareaRef: HTMLTextAreaElement | undefined;
	let emojiButtonRef: HTMLButtonElement | undefined;
	let gifButtonRef: HTMLButtonElement | undefined;
	let voiceSendButtonRef: HTMLButtonElement | undefined;
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
		// Pinned at entry and used exclusively below: the panel's thread (or
		// the room, or the reply target) can change while the send is in
		// flight, and every read of a reactive prop after an await would see
		// the NEW value.
		const gifRoomId = props.roomId;
		const gifThreadRootId = props.threadRootId ?? null;
		const gifReplyTo = props.replyTo;
		// Like send(): the send can finish after the user switched rooms, so
		// gate every completion-time write on still being on the room it
		// started in - otherwise it clobbers the newly selected room's
		// composer (clears its reply state, steals focus). See the room-switch
		// effect, which resets `sending` for the new room on our behalf.
		const onThisRoom = (): boolean => props.roomId === gifRoomId;
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
		if (gifReplyTo) {
			const { bodyPrefix, htmlPrefix } = buildReplyFallback(
				gifReplyTo,
				gifRoomId,
			);
			content.body = bodyPrefix + gif.url;
			content.format = "org.matrix.custom.html";
			content.formatted_body = htmlPrefix + escapeHtml(gif.url);
			content["m.relates_to"] = {
				"m.in_reply_to": { event_id: gifReplyTo.eventId },
			};
		}

		setSending(true);
		setError(null);
		stopTyping();
		try {
			// 3-arg overload: a threadId routes the send into the thread and
			// the SDK builds the MSC3440 relation (preserving an explicit
			// m.in_reply_to as a real reply, is_falling_back false).
			await client.sendMessage(
				gifRoomId,
				gifThreadRootId,
				content as unknown as RoomMessageEventContent,
			);
			if (onThisRoom()) props.onSent?.();
		} catch (e) {
			if (onThisRoom()) {
				setError(e instanceof Error ? e.message : "Failed to send GIF");
			}
		} finally {
			if (onThisRoom()) {
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
	}

	// Pre-fill text when entering edit mode
	createEffect(
		on(
			() => props.editingEvent,
			(ev) => {
				setMentions([]);
				setMentionQuery(null);
				setGifPickerOpen(false);
				// Entering edit mode discards an active recording: the edit UI
				// replaces the send affordances, and a voice send completing
				// mid-edit would be misread as the edit completing.
				if (ev) {
					voiceRecorder.cancel();
					// Edits can't carry attachments; discard any queued so the
					// tray doesn't linger un-sendable during the edit. (One
					// deliberate exception: a voice upload that FAILS during an
					// edit still parks in the tray - losing the recording is
					// worse than a tray entry that waits out the edit.)
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
				setPollDialogOpen(false);
				setPreviewOpen(false);
				voiceRecorder.cancel();
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

	// --- Formatting toolbar ---
	// All helpers read the live `text()` signal and the textarea selection at
	// call time, then restore focus + caret in a rAF (mirroring onEmojiSelect).
	// They mutate only the shared `text()` signal — no new cross-room state.

	/**
	 * Apply a pure text transform to the current selection. `transform` receives
	 * the selected text plus the text before/after it and returns the new full
	 * value with the selection range to restore.
	 */
	const applyFormat = (
		transform: (
			sel: string,
			before: string,
			after: string,
		) => { value: string; selStart: number; selEnd: number },
	): void => {
		const el = textareaRef;
		if (!el) return;
		const value = text();
		const start = el.selectionStart;
		const end = el.selectionEnd;
		const result = transform(
			value.slice(start, end),
			value.slice(0, start),
			value.slice(end),
		);
		setText(result.value);
		autoResize();
		// Don't run mention detection here: formatting never inserts an `@`
		// trigger, and the caret hasn't moved to its new spot yet (that happens
		// in the rAF below), so detecting now would read a stale position.
		requestAnimationFrame(() => {
			if (!textareaRef) return;
			textareaRef.focus();
			textareaRef.setSelectionRange(result.selStart, result.selEnd);
		});
	};

	/** Wrap the selection in `marker` on each side (e.g. `**`, `*`, `` ` ``). */
	const wrapInline = (marker: string): void => {
		applyFormat((sel, before, after) => {
			const inner = before.length + marker.length;
			return {
				value: `${before}${marker}${sel}${marker}${after}`,
				selStart: inner,
				selEnd: inner + sel.length,
			};
		});
	};

	/** Insert a `[label](url)` link template, selecting the `url` placeholder. */
	const insertLink = (): void => {
		applyFormat((sel, before, after) => {
			const label = sel || "text";
			const url = "url";
			const urlStart = before.length + 1 + label.length + 2; // "[" label "]("
			return {
				value: `${before}[${label}](${url})${after}`,
				selStart: urlStart,
				selEnd: urlStart + url.length,
			};
		});
	};

	/** Prefix every line touched by the selection with `prefix` (lists/quotes). */
	const prefixLines = (prefix: string): void => {
		applyFormat((sel, before, after) => {
			const lineStart = before.lastIndexOf("\n") + 1;
			const head = before.slice(0, lineStart);
			const region = before.slice(lineStart) + sel;
			const prefixed = region
				.split("\n")
				.map((l) => `${prefix}${l}`)
				.join("\n");
			const value = `${head}${prefixed}${after}`;
			// With no selection, keep a collapsed caret at its original spot,
			// shifted by the single prefix inserted ahead of it, so the next
			// keystroke continues typing instead of overwriting the line.
			if (sel === "") {
				const caret = before.length + prefix.length;
				return { value, selStart: caret, selEnd: caret };
			}
			return {
				value,
				selStart: head.length,
				selEnd: head.length + prefixed.length,
			};
		});
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
		// Pinned like roomId: the panel can switch threads (or close) while
		// uploads run, and every await-separated send below must target the
		// thread this send STARTED in.
		const threadRootId = props.threadRootId ?? null;
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
				// 3-arg overload: without the threadId the edit's local echo gets
				// no thread association (the SDK only calls setThread when one is
				// passed), so a thread panel's acceptsEvent gate would reject it -
				// no optimistic update and no failed-edit Retry surface there.
				await client.sendMessage(
					roomId,
					threadRootId,
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
						threadId: threadRootId,
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
			// 3-arg overload: see the GIF path - threads route via threadId.
			await client.sendMessage(
				roomId,
				threadRootId,
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

		// Formatting shortcuts (Ctrl/Cmd). Skip while an IME composition is
		// active so we don't hijack composition-confirming keystrokes.
		if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing) {
			const k = e.key.toLowerCase();
			if (e.shiftKey && k === "x") {
				e.preventDefault();
				wrapInline("~~");
				return;
			}
			if (!e.shiftKey && (k === "b" || k === "i" || k === "e")) {
				e.preventDefault();
				wrapInline(k === "b" ? "**" : k === "i" ? "*" : "`");
				return;
			}
		}

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
			{/* Inert while recording: the recording bar hides the draft, and a
			    toolbar action would silently edit text the user can't see. */}
			<FormattingToolbar
				onWrap={wrapInline}
				onLink={insertLink}
				onPrefix={prefixLines}
				previewOpen={previewOpen()}
				onTogglePreview={() => setPreviewOpen((v) => !v)}
				inert={voiceRecorder.recording()}
			/>
			<Show when={previewOpen()}>
				<section
					class="mb-1.5 max-h-40 overflow-y-auto rounded-lg border border-border-subtle bg-surface-2 px-4 py-2.5"
					aria-label="Message preview"
				>
					<Show
						when={previewContent()}
						fallback={
							<p class="text-sm italic text-text-disabled">
								Nothing to preview
							</p>
						}
					>
						{(content) => (
							<MessageBody
								body={content().body}
								format={
									content().formatted_body ? "org.matrix.custom.html" : null
								}
								formattedBody={content().formatted_body}
								isEdited={false}
								client={client}
								shortcodeLookup={shortcodeLookup()}
							/>
						)}
					</Show>
				</section>
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
					data-composer-textarea={composerTextareaScope(props.threadRootId)}
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
					inert={voiceRecorder.recording() || undefined}
					class="w-full resize-none rounded-lg bg-surface-2 px-4 py-2.5 text-sm text-text-emphasis placeholder:text-text-disabled focus:outline-none focus:ring-1 focus:ring-accent-hover"
					style={{
						// Reserve exactly the action strip's measured width, so
						// the padding tracks whichever buttons are visible
						// (editing, GIF availability, voice support).
						"padding-right": `${stripWidth() + 12}px`,
					}}
					rows={1}
				/>
				{/* Composer action strip: one flex row instead of per-button
				    absolute offsets, so adding/hiding buttons never requires
				    recomputing right-N positions or the textarea padding (the
				    textarea reserves this strip's measured width). Inert while
				    recording: the recording bar overlays it, and its buttons
				    must not be reachable underneath. */}
				<div
					ref={(el) => {
						// Deferred to the next frame: writing the padding inside
						// the observer callback perturbs layout in the same frame
						// and trips the browser's "ResizeObserver loop" error. The
						// pending frame is tracked so cleanup can cancel it (no
						// setter call after dispose) and rapid fires coalesce.
						let raf = 0;
						const observer = new ResizeObserver(() => {
							cancelAnimationFrame(raf);
							raf = requestAnimationFrame(() => setStripWidth(el.offsetWidth));
						});
						observer.observe(el);
						onCleanup(() => {
							cancelAnimationFrame(raf);
							observer.disconnect();
						});
					}}
					inert={voiceRecorder.recording() || undefined}
					class="absolute bottom-2.5 right-2 flex items-center gap-1"
				>
					<Show when={voiceSupported && !props.editingEvent}>
						<button
							type="button"
							class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							onClick={() => void startRecording()}
							aria-label="Record voice message"
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<rect x="9" y="2" width="6" height="12" rx="3" />
								<path d="M5 10v1a7 7 0 0 0 14 0v-1" />
								<path d="M12 18v4" />
							</svg>
						</button>
					</Show>
					{/* Poll button (hidden when editing - polls are new sends -
					    and in threads: polls-in-threads are deferred, #303). */}
					<Show when={!props.editingEvent && !props.threadRootId}>
						<button
							type="button"
							class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							onClick={() => {
								setPollDialogOpen(true);
								setGifPickerOpen(false);
								setEmojiPickerOpen(false);
							}}
							aria-label="Create poll"
							aria-haspopup="dialog"
							aria-expanded={pollDialogOpen()}
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								aria-hidden="true"
							>
								<path d="M6 20V10" />
								<path d="M12 20V4" />
								<path d="M18 20v-6" />
							</svg>
						</button>
					</Show>
					{/* Attach file button (hidden when editing - edits can't carry
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
							class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
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
							class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
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
						class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						onClick={() => {
							setEmojiPickerOpen((v) => !v);
							setGifPickerOpen(false);
						}}
						aria-label="Open emoji picker"
						aria-expanded={emojiPickerOpen()}
					>
						😀
					</button>
				</div>
				{/* Always mounted: live regions announce content CHANGES, so the
				    text flips with the recording state (a region inserted with
				    its text already present is typically never announced). */}
				<span class="sr-only" role="status">
					{voiceRecorder.recording() ? "Recording voice message" : ""}
				</span>
				{/* Recording bar: overlays the input area while capturing. */}
				<Show when={voiceRecorder.recording()}>
					<VoiceRecordingBar
						elapsedMs={voiceRecorder.elapsedMs()}
						amplitudes={voiceRecorder.liveAmplitudes()}
						onCancel={() => {
							voiceRecorder.cancel();
							restoreFocus();
						}}
						onSend={() => void stopAndSendVoice()}
						sendButtonRef={(el) => {
							voiceSendButtonRef = el;
						}}
					/>
				</Show>
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
				<CreatePollDialog
					client={client}
					roomId={props.roomId}
					open={pollDialogOpen}
					onClose={() => setPollDialogOpen(false)}
				/>
			</div>
		</div>
	);
};

export { Composer };
