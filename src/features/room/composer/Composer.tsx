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
import { unwrap } from "solid-js/store";
import { useClient } from "../../../client/client";
import {
	type CustomEmoji,
	escapeHtml,
	formatMarkdown,
} from "../../../lib/markdown";
import { pushNotice } from "../../../stores/notices";
import { EmojiPicker } from "../../emoji/EmojiPicker";
import { MessageBody } from "../../emoji/MessageBody";
import type { ImagePack, PickerEmoji, ResolvedEmote } from "../../emoji/types";
import { buildShortcodeLookup } from "../../emoji/useImagePacks";
import { GifPicker } from "../../gif/GifPicker";
import { useGifConfig } from "../../gif/gifConfig";
import type { GifItem } from "../../gif/types";
import { CreateEventDialog } from "../poll/CreateEventDialog";
import { CreatePollDialog } from "../poll/CreatePollDialog";
import type { TimelineEvent } from "../timeline/useTimeline";
import { AttachmentTray } from "./AttachmentTray";
import {
	applyMentions,
	buildEditContent,
	buildReplyFallback,
	buildTextMessageContent,
} from "./buildMessageContent";
import { ComposerActionStrip } from "./ComposerActionStrip";
import { ComposerContextBanner } from "./ComposerContextBanner";
import { createComposerFormatting } from "./composerFormatting";
import { composerTextareaScope } from "./composerTextarea";
import { FormattingToolbar } from "./FormattingToolbar";
import type { PendingAttachment } from "./media/types";
import { createPendingAttachment, uploadAndSend } from "./media/uploadMedia";
import {
	createVoiceRecorder,
	isVoiceRecordingSupported,
} from "./media/voiceRecorder";
import { useAttachments } from "./useAttachments";
import { useMentions } from "./useMentions";
import { VoiceRecordingBar } from "./VoiceRecordingBar";

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
	/**
	 * Up-arrow in an empty composer requests the "edit last" shortcut. The parent
	 * owns the timeline, so it resolves the target (the user's most recent
	 * message, edited only if it is editable - see findLastEditableEvent) and
	 * enters edit mode; the composer only detects the gesture.
	 */
	onEditLast?: () => void;
	onSent?: () => void;
	packs: ImagePack[];
	/**
	 * Hands the parent the composer's file-queue seam so out-of-composer
	 * entry points (e.g. TimelineView's drag-and-drop overlay) can enqueue
	 * files into the same queue the attach button and paste use. Registered
	 * on mount; TimelineView renders this Composer and both share a lifetime
	 * (RoomPane, and thus both, are remounted together per room by the keyed
	 * <Show> in Layout), so the registration is naturally scoped to the
	 * current room.
	 */
	onEnqueueReady?: (enqueue: (files: Iterable<File>) => void) => void;
}> = (props) => {
	const { client } = useClient();
	const [text, setText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const {
		mentions,
		setMentions,
		mentionQuery,
		setMentionQuery,
		MentionPicker,
		handlePickerKey,
		getActiveDescendant,
		listboxId,
		filteredMembers,
		pickerRendered,
		detectMention,
		reconcileMentions,
		onMentionSelect,
	} = useMentions({
		client,
		roomId: () => props.roomId,
		getTextarea: () => textareaRef,
		text,
		setText,
		autoResize: () => autoResize(),
	});
	const [emojiPickerOpen, setEmojiPickerOpen] = createSignal(false);
	const [gifPickerOpen, setGifPickerOpen] = createSignal(false);
	const [pollDialogOpen, setPollDialogOpen] = createSignal(false);
	const [eventDialogOpen, setEventDialogOpen] = createSignal(false);
	const [previewOpen, setPreviewOpen] = createSignal(false);
	const {
		attachments,
		setAttachments,
		enqueueFiles,
		onFileInputChange,
		updateAttachment,
		removeAttachment,
		clearAttachments,
		onPaste,
	} = useAttachments(() => props.editingEvent);
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
		// Pinned at entry so post-await reads use the send's target rather than a
		// newer value; see send() for which of these actually change in place
		// (replyTo) versus which are remount-frozen (roomId/threadRootId).
		const threadRootId = props.threadRootId ?? null;
		// Completion writes below run unconditionally: a room switch remounts this
		// Composer (see send() for the full rationale), so an in-flight send can
		// only ever touch its own now-disposed instance, never the newly selected
		// room's fresh Composer.
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
			setError("Nothing was recorded");
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
			if (!props.editingEvent) {
				props.onCancelReply?.();
				props.onSent?.();
			}
		} catch (e) {
			// Deliberately NOT gated on room or edit mode: parking a failed
			// upload in the tray beats silently losing the recording. Within the
			// room the send started in, the entry stays visible and retryable.
			// (Room-switch caveat: a switch remounts this Composer - see send() -
			// so a failure that resolves after the user has already left the room
			// lands in the disposed instance's tray, i.e. it is effectively lost.
			// That is a pre-existing limitation of the per-room mount.)
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

	// Expose the enqueue seam to the parent so the room view's drag-and-drop
	// overlay can feed dropped files into this same queue.
	onMount(() => props.onEnqueueReady?.(enqueueFiles));

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
	// Set on unmount (a room/thread switch remounts this Composer via Layout's
	// keyed <Show>). Lets a send that fails after the switch tell that its inline
	// error would be invisible and escalate to an app-level notice instead (#381).
	let disposed = false;

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
		// Pinned at entry and used exclusively below: a reactive prop read after
		// an await would otherwise see a newer value. (replyTo genuinely changes
		// in place; roomId/threadRootId are remount-frozen - see send().)
		const gifRoomId = props.roomId;
		const gifThreadRootId = props.threadRootId ?? null;
		const gifReplyTo = props.replyTo;
		// Pinned for the failure notice (#381): if the user switches rooms before
		// the send fails, this Composer is disposed and we surface an app-level
		// notice naming the room it was meant for. Trimmed so a whitespace-only
		// room name falls back to the generic message rather than a dangling "to ".
		const gifRoomName = client.getRoom(gifRoomId)?.name?.trim();
		// Completion writes below are unconditional: a room switch remounts this
		// Composer (see send()), so an in-flight send only ever touches its own
		// disposed instance.
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
			// Flag the reply as an intentional mention of the parent's author, so
			// they're notified even though a GIF carries no typed mentions (shares
			// applyMentions with the text-send path). Skip self-replies.
			applyMentions(content, [], gifReplyTo, client.getUserId() ?? "");
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
			props.onSent?.();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to send GIF");
			// The GIF path has no draft/tray to fall back on. If the user has since
			// switched rooms this Composer is disposed, so the inline error above is
			// invisible - escalate to an app-level notice so the failure isn't
			// silently lost (#381). On-room failures keep the inline error only.
			if (disposed) {
				pushNotice(
					gifRoomName
						? `Couldn't send GIF to ${gifRoomName}`
						: "Couldn't send GIF",
					"error",
				);
			}
		} finally {
			setSending(false);
			restoreFocus();
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

	// There is deliberately no "clear state when props.roomId changes" effect:
	// RoomPane (and this Composer) sit under a keyed <Show> in Layout, so a room
	// switch REMOUNTS the whole subtree - the new room always gets a fresh
	// Composer with clean signals, so there is no stale in-place state to reset.
	// That keyed remount is load-bearing (it's also why the send paths above need
	// no room guard); a test in Composer.roomIsolation.test.ts fails if Layout
	// ever drops `keyed`. See issue #382.

	// Size the textarea to its initial content on mount (the only work the former
	// reset effect did that isn't already the signal's initial value).
	onMount(() => requestAnimationFrame(autoResize));

	// Stop typing and release preview object URLs on unmount
	onCleanup(() => {
		disposed = true;
		stopTyping();
		clearAttachments();
	});

	const autoResize = (): void => {
		const el = textareaRef;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	};

	// Formatting-toolbar actions (bold/italic/code/strike, link, line prefixes).
	const { wrapInline, insertLink, prefixLines } = createComposerFormatting({
		getTextarea: () => textareaRef,
		text,
		setText,
		autoResize,
	});

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
		if ((!msg && attachments.length === 0) || sending()) return;

		// Pin the room, reply target, and thread for the whole send: uploads
		// await, and a reactive prop read after an await would see a newer
		// value. Cross-room (and cross-thread) isolation, though, comes from the
		// mount structure, not from these reads: RoomPane (and this Composer) sit
		// under a keyed <Show> in Layout, so switching rooms REMOUNTS the whole
		// subtree - the newly selected room gets a fresh Composer with its own
		// signals, and an in-flight send from the disposed instance can only
		// touch that disposed instance's own props/state. The thread panel is
		// likewise keyed on threadId (RoomPane), so props.roomId and
		// props.threadRootId both never change within a single Composer instance
		// (pinning them is symmetry - they're already frozen). Only replyTo
		// genuinely changes in place: it's a live signal in TimelineView, so the
		// user can reply to a different message mid-send without any remount -
		// pinning it is the read that actually matters here.
		const roomId = props.roomId;
		const replyTo = props.replyTo;
		const threadRootId = props.threadRootId ?? null;
		// Completion writes below run unconditionally: the keyed-<Show> remount
		// (see above) means an in-flight send can only touch its own disposed
		// instance, never the newly selected room's fresh Composer.

		// Edit mode: send m.replace event
		if (props.editingEvent) {
			const currentMentions = reconcileMentions(msg);
			const emoji = findCustomEmoji(msg, shortcodeLookup());
			const { body: newBody, formatted_body } = formatMarkdown(
				msg,
				currentMentions,
				emoji,
			);
			const content = buildEditContent(
				newBody,
				formatted_body,
				currentMentions,
				props.editingEvent.eventId,
			);

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
				props.onSent?.();
			} catch (e) {
				if (!text()) {
					setText(draft);
					setMentions(draftMentions);
				}
				setError(e instanceof Error ? e.message : "Failed to edit message");
				requestAnimationFrame(autoResize);
			} finally {
				setSending(false);
				restoreFocus();
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

		// Restore the trailing text on failure, but only if the user hasn't
		// already started a new message.
		const restoreDraft = (): void => {
			if (!text()) {
				setText(draft);
				setMentions(draftMentions);
				requestAnimationFrame(autoResize);
			}
		};

		// Send any queued attachments first. The reply relation is attached to
		// the first event only (whether that's an attachment or the trailing
		// text) so we don't emit one reply per file.
		let replyConsumed = false;
		if (attachments.length > 0) {
			setSending(true);
			stopTyping();
			let allOk = true;
			for (const att of [...attachments]) {
				// The user can remove a still-queued attachment from the tray while
				// an earlier one uploads; skip anything no longer in the queue.
				if (!attachments.some((a) => a.id === att.id)) continue;
				updateAttachment(att.id, {
					status: "uploading",
					progress: 0,
					error: undefined,
				});
				try {
					// Hand the send path plain data, not the live store proxy: unwrap
					// so nested fields (e.g. a voice note's waveform number[]) serialize
					// onto the wire as plain values rather than Solid proxies.
					await uploadAndSend(client, roomId, unwrap(att), {
						replyTo: replyConsumed ? null : replyTo,
						threadId: threadRootId,
						onProgress: (p) => updateAttachment(att.id, { progress: p }),
					});
					// Clear the reply at the source once an event has carried it,
					// so a retry after a partial failure doesn't re-attach it and
					// emit a second reply.
					if (replyTo && !replyConsumed) {
						replyConsumed = true;
						props.onCancelReply?.();
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
				setSending(false);
				restoreFocus();
				return;
			}
			if (!hasText) {
				setSending(false);
				props.onSent?.();
				restoreFocus();
				return;
			}
			// Otherwise fall through to send the trailing text message.
		}

		const { body, formatted_body } = formatMarkdown(
			msg,
			currentMentions,
			emoji,
		);
		const content = buildTextMessageContent(
			body,
			formatted_body,
			currentMentions,
			replyTo && !replyConsumed ? replyTo : null,
			roomId,
			client.getUserId() ?? "",
		);

		setSending(true);
		stopTyping();

		try {
			// 3-arg overload: see the GIF path - threads route via threadId.
			await client.sendMessage(
				roomId,
				threadRootId,
				content as unknown as RoomMessageEventContent,
			);
			props.onSent?.();
		} catch (e) {
			restoreDraft();
			setError(e instanceof Error ? e.message : "Failed to send message");
		} finally {
			setSending(false);
			restoreFocus();
		}
	};

	/** Exit edit mode, discarding the in-progress draft. Shared by the context
	 *  banner's cancel button and the Escape shortcut. */
	const cancelEdit = (): void => {
		stopTyping();
		setText("");
		setMentions([]);
		setMentionQuery(null);
		requestAnimationFrame(autoResize);
		props.onCancelEdit?.();
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
			cancelEdit();
			return;
		}
		if (e.key === "Escape" && props.replyTo) {
			e.preventDefault();
			props.onCancelReply?.();
			return;
		}
		// Up-arrow in an empty composer edits the last own message (Element /
		// Discord / Slack convention). Only a plain Up on a genuinely empty, idle
		// composer: no modifiers (Shift/Cmd/Option+Up are caret/selection nav), no
		// draft text (so it never hijacks multi-line cursor movement), no queued
		// attachment, and not already editing/replying/composing - so it can't
		// silently clobber a pending reply or orphan an attachment. The picker
		// already consumed the key above if one was open (handlePickerKey).
		if (
			e.key === "ArrowUp" &&
			!e.isComposing &&
			!e.shiftKey &&
			!e.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!props.editingEvent &&
			!props.replyTo &&
			text() === "" &&
			attachments.length === 0 &&
			props.onEditLast
		) {
			e.preventDefault();
			props.onEditLast();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div class="border-t border-border-subtle px-4 py-3">
			<ComposerContextBanner
				editingEvent={props.editingEvent}
				replyTo={props.replyTo}
				onCancelEdit={cancelEdit}
				onCancelReply={() => props.onCancelReply?.()}
			/>
			<Show when={error()}>
				<div
					class="mb-2 rounded bg-danger-bg/30 px-3 py-1.5 text-xs text-danger-text"
					role="alert"
				>
					{error()}
				</div>
			</Show>
			<Show when={attachments.length > 0}>
				<AttachmentTray
					attachments={attachments}
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
				{/* Inert while recording: the recording bar overlays it, and its
				    buttons must not be reachable underneath. */}
				<ComposerActionStrip
					voiceSupported={voiceSupported}
					editing={!!props.editingEvent}
					inThread={!!props.threadRootId}
					gifAvailable={gifConfig.available()}
					pollOpen={pollDialogOpen()}
					eventOpen={eventDialogOpen()}
					gifOpen={gifPickerOpen()}
					emojiOpen={emojiPickerOpen()}
					inert={voiceRecorder.recording()}
					onStartRecording={() => void startRecording()}
					onOpenPoll={() => {
						setPollDialogOpen(true);
						setEventDialogOpen(false);
						setGifPickerOpen(false);
						setEmojiPickerOpen(false);
					}}
					onOpenEvent={() => {
						setEventDialogOpen(true);
						setPollDialogOpen(false);
						setGifPickerOpen(false);
						setEmojiPickerOpen(false);
					}}
					onFileSelected={onFileInputChange}
					onToggleGif={() => {
						setGifPickerOpen((v) => !v);
						setEmojiPickerOpen(false);
					}}
					onToggleEmoji={() => {
						setEmojiPickerOpen((v) => !v);
						setGifPickerOpen(false);
					}}
					onMeasure={setStripWidth}
					gifButtonRef={(el) => {
						gifButtonRef = el;
					}}
					emojiButtonRef={(el) => {
						emojiButtonRef = el;
					}}
				/>
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
				<CreateEventDialog
					client={client}
					roomId={props.roomId}
					open={eventDialogOpen}
					onClose={() => setEventDialogOpen(false)}
				/>
			</div>
		</div>
	);
};

export { Composer };
