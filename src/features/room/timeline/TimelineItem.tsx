import { Popover } from "@kobalte/core/popover";
import type { MatrixClient } from "matrix-js-sdk";
import { EventStatus } from "matrix-js-sdk";
import {
	type Component,
	createMemo,
	createSignal,
	For,
	Match,
	Show,
	Switch,
} from "solid-js";
import { userSettings } from "../../../stores/settings";
import { EmojiPicker } from "../../emoji/EmojiPicker";
import { MessageBody } from "../../emoji/MessageBody";
import type { ImagePack, PickerEmoji, ResolvedEmote } from "../../emoji/types";
import { extractGifUrl, InlineGif } from "../../gif/InlineGif";
import type { EncryptedFileInfo } from "../composer/media/attachmentCrypto";
import { createDecryptedObjectUrl } from "../composer/media/useDecryptedMedia";
import { PollMessage } from "../poll/PollMessage";
import { ThreadSummaryChip } from "../threads/ThreadSummaryChip";
import {
	extractUrlsFromHtml,
	extractUrlsFromText,
} from "../urlPreviews/extractUrls";
import { InlineVideo } from "../urlPreviews/InlineVideo";
import { UrlPreviewList } from "../urlPreviews/UrlPreviewList";
import { isDirectVideoUrl } from "../urlPreviews/videoUrl";
import { formatFullDateTime, formatTime } from "./dateFormatting";
import { EncryptedImage } from "./EncryptedImage";
import { MediaAudio } from "./MediaAudio";
import { MediaFile } from "./MediaFile";
import { MediaVideo } from "./MediaVideo";
import { formatReactors } from "./reactionFormatting";
import { StateNoticeIcon } from "./StateNoticeIcon";
import type { TimelineEvent } from "./useTimeline";
import { VoiceMessage } from "./VoiceMessage";

function reactionLabel(
	key: string,
	emoteLookup: Map<string, ResolvedEmote>,
): string {
	if (key.startsWith("mxc://")) {
		const emote = emoteLookup.get(key);
		return emote ? `:${emote.shortcode}:` : "custom emoji";
	}
	return key;
}

const ReactionKey: Component<{
	reactionKey: string;
	emoteLookup: Map<string, ResolvedEmote>;
}> = (props) => {
	// Custom emoji: reaction key is an mxc:// URL
	if (props.reactionKey.startsWith("mxc://")) {
		const emote = props.emoteLookup.get(props.reactionKey);
		if (emote) {
			return (
				<img
					src={emote.httpUrl}
					alt={`:${emote.shortcode}:`}
					class="inline h-4 w-4 object-contain"
				/>
			);
		}
		// Unknown pack
		return (
			<span role="img" aria-label="custom emoji">
				?
			</span>
		);
	}
	return <span>{props.reactionKey}</span>;
};

const ReactionPills: Component<{
	reactions: TimelineEvent["reactions"];
	myReactions: TimelineEvent["myReactions"];
	onReact: (key: string) => void;
	emoteLookup: Map<string, ResolvedEmote>;
}> = (props) => {
	const entries = createMemo(() => Object.entries(props.reactions));

	return (
		<Show when={entries().length > 0}>
			<div class="mt-1 flex flex-wrap gap-1">
				<For each={entries()}>
					{([key, agg]) => {
						const isMine = () => Object.hasOwn(props.myReactions, key);
						const label = reactionLabel(key, props.emoteLookup);
						const tooltip = formatReactors(agg.senders, label);
						return (
							<button
								type="button"
								class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
									isMine()
										? "bg-mention-bg/40 text-accent-text-bright ring-1 ring-accent-hover/50"
										: "bg-surface-2 text-text-secondary hover:bg-surface-3"
								}`}
								onClick={() => props.onReact(key)}
								title={tooltip}
								aria-label={`${tooltip}. ${isMine() ? "Click to remove your reaction" : "Click to react"}.`}
								aria-pressed={isMine()}
							>
								<ReactionKey
									reactionKey={key}
									emoteLookup={props.emoteLookup}
								/>
								<span
									class={isMine() ? "text-accent-text" : "text-text-disabled"}
								>
									{agg.count}
								</span>
							</button>
						);
					}}
				</For>
			</div>
		</Show>
	);
};

/**
 * Failed-reaction row. One entry per failed key for the message; each
 * entry shows the reaction key (mxc-rendered when custom) with a ⚠
 * marker and inline Retry / Discard buttons. Rendered in red tint so
 * the failure is unambiguous against the normal pill row.
 *
 * Issue #106: AC requires per-pill Retry / Discard with the failed
 * pill visible. Each row is `role="alert"` so screen readers announce
 * the failure when it appears.
 */
const FailedReactionPills: Component<{
	keys: string[];
	emoteLookup: Map<string, ResolvedEmote>;
	onRetry: (key: string) => void;
	onDiscard: (key: string) => void;
}> = (props) => {
	return (
		<Show when={props.keys.length > 0}>
			<div
				class="mt-1 flex flex-wrap items-center gap-1"
				role="alert"
				aria-label="Failed reactions"
			>
				<For each={props.keys}>
					{(key) => (
						<div class="inline-flex items-center gap-1 rounded-full bg-danger-bg/20 px-2 py-0.5 text-xs text-danger-text ring-1 ring-danger/40">
							<span aria-hidden="true">⚠</span>
							<ReactionKey reactionKey={key} emoteLookup={props.emoteLookup} />
							<span class="sr-only">
								{`Reaction ${reactionLabel(key, props.emoteLookup)} failed to send`}
							</span>
							<button
								type="button"
								class="rounded bg-surface-3 px-1.5 py-0.5 text-text-emphasis transition-colors hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								onClick={() => props.onRetry(key)}
								aria-label={`Retry sending reaction ${reactionLabel(key, props.emoteLookup)}`}
							>
								Retry
							</button>
							<button
								type="button"
								class="rounded bg-surface-3 px-1.5 py-0.5 text-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
								onClick={() => props.onDiscard(key)}
								aria-label={`Discard failed reaction ${reactionLabel(key, props.emoteLookup)}`}
							>
								Discard
							</button>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
};

/**
 * Tiny media thumbnail shown inside {@link ReplyContext} for image/sticker
 * parents. Plain media renders straight from the scaled http url; encrypted
 * media downloads + decrypts the ciphertext (via {@link createDecryptedObjectUrl})
 * and fails closed — rendering nothing rather than the ciphertext url — so the
 * text label still identifies the reply target.
 */
const ReplyThumb: Component<{
	url: string;
	file: EncryptedFileInfo | null;
	mimetype: string | null;
}> = (props) => {
	const cls = "size-9 shrink-0 rounded object-cover bg-surface-2";
	return (
		<Show
			when={props.file}
			fallback={<img src={props.url} alt="" loading="lazy" class={cls} />}
		>
			{(file) => {
				const media = createDecryptedObjectUrl(
					() => props.url,
					() => file(),
					() => props.mimetype,
				);
				return (
					<Show when={media.url()}>
						{(url) => <img src={url()} alt="" loading="lazy" class={cls} />}
					</Show>
				);
			}}
		</Show>
	);
};

/**
 * Quoted reply-context block shown above a message that replies to another
 * event. Resolved from the `m.in_reply_to` relation (see useTimeline's
 * `replyTo*` projection) so it renders for every message type — text, image,
 * media, GIF — not just legacy `> `-prefixed text. When the parent isn't in any
 * loaded timeline the sender/snippet are null and it shows a generic
 * "In reply to a message" line.
 *
 * Whenever `eventId` is set (i.e. the message is a reply at all) the block is a
 * button that jumps to + flashes the original — even if the parent isn't
 * currently loaded, since the click drives `jumpToEvent`, which loads an
 * anchored window on demand. The non-interactive fallback only applies when
 * `eventId` is null. Image/sticker parents also show a tiny thumbnail so the
 * reply visually identifies which media it answers.
 */
const ReplyContext: Component<{
	eventId: string | null;
	sender: string | null;
	snippet: string | null;
	thumbUrl: string | null;
	thumbEncryptedFile: EncryptedFileInfo | null;
	thumbMimetype: string | null;
	onJump: (eventId: string) => void;
}> = (props) => {
	const body = (
		<div class="flex min-w-0 items-center gap-1.5">
			<Show when={props.thumbUrl}>
				{(url) => (
					<ReplyThumb
						url={url()}
						file={props.thumbEncryptedFile}
						mimetype={props.thumbMimetype}
					/>
				)}
			</Show>
			<Show
				when={props.sender}
				fallback={<span class="italic">In reply to a message</span>}
			>
				<div class="min-w-0 truncate">
					<span class="font-medium text-text-muted">{props.sender}</span>
					<Show when={props.snippet}>
						<span>{`: ${props.snippet}`}</span>
					</Show>
				</div>
			</Show>
		</div>
	);
	return (
		<Show
			when={props.eventId}
			fallback={
				<div class="mb-1 border-l-2 border-border-strong pl-2 text-xs text-text-disabled">
					{body}
				</div>
			}
		>
			{(eventId) => (
				<button
					type="button"
					onClick={() => props.onJump(eventId())}
					aria-label="Jump to replied message"
					class="mb-1 block w-full cursor-pointer rounded-sm border-l-2 border-border-strong pl-2 text-left text-xs text-text-disabled transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				>
					{body}
				</button>
			)}
		</Show>
	);
};

function unsupportedLabel(msgtype: string): string {
	switch (msgtype) {
		case "m.video":
			return "🎬 Video";
		case "m.audio":
			return "🔊 Audio";
		case "m.file":
			return "📎 File";
		default:
			return "📎 Attachment";
	}
}

const HoverToolbar: Component<{
	isOwnMessage: boolean;
	msgtype: string | undefined;
	canPin: boolean;
	isPinned: boolean;
	packs: ImagePack[];
	onReactPick: (key: string) => void;
	onReply: () => void;
	/** Open (or start) this message's thread. Absent inside the panel. */
	onReplyInThread?: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onTogglePin: () => void;
}> = (props) => {
	const [pickerOpen, setPickerOpen] = createSignal(false);
	const handlePick = (item: PickerEmoji): void => {
		const key = item.kind === "custom" ? item.emote.mxcUrl : item.emoji.unicode;
		props.onReactPick(key);
		setPickerOpen(false);
	};
	return (
		<div
			class="pointer-events-none absolute -top-4 right-4 z-10 flex items-center gap-0.5 rounded-md bg-surface-2 px-0.5 py-0.5 shadow-lg opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
			classList={{
				"!pointer-events-auto !opacity-100": pickerOpen(),
			}}
		>
			<Popover
				open={pickerOpen()}
				onOpenChange={setPickerOpen}
				placement="top-end"
				gutter={6}
			>
				<Popover.Trigger
					as="button"
					type="button"
					class="rounded p-1 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					aria-label="Add reaction"
				>
					<svg
						class="h-4 w-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="M8 14s1.5 2 4 2 4-2 4-2" />
						<line x1="9" y1="9" x2="9.01" y2="9" />
						<line x1="15" y1="9" x2="15.01" y2="9" />
					</svg>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content class="z-50 focus:outline-none">
						<EmojiPicker
							packs={props.packs}
							onSelect={handlePick}
							onClose={() => setPickerOpen(false)}
						/>
					</Popover.Content>
				</Popover.Portal>
			</Popover>
			<button
				type="button"
				class="rounded p-1 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				onClick={props.onReply}
				aria-label="Reply"
			>
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<polyline points="9 17 4 12 9 7" />
					<path d="M20 18v-2a4 4 0 0 0-4-4H4" />
				</svg>
			</button>
			<Show when={props.onReplyInThread}>
				<button
					type="button"
					class="rounded p-1 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					onClick={() => props.onReplyInThread?.()}
					aria-label="Reply in thread"
				>
					<svg
						class="h-4 w-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					</svg>
				</button>
			</Show>
			<Show when={props.isOwnMessage && props.msgtype === "m.text"}>
				<button
					type="button"
					class="rounded p-1 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					onClick={props.onEdit}
					aria-label="Edit"
				>
					<svg
						class="h-4 w-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
						<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
					</svg>
				</button>
			</Show>
			<Show when={props.canPin}>
				<button
					type="button"
					class="rounded p-1 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					classList={{ "text-accent": props.isPinned }}
					onClick={props.onTogglePin}
					aria-label={props.isPinned ? "Unpin message" : "Pin message"}
					aria-pressed={props.isPinned}
					title={props.isPinned ? "Unpin message" : "Pin message"}
				>
					<svg
						class="h-4 w-4"
						viewBox="0 0 24 24"
						fill={props.isPinned ? "currentColor" : "none"}
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M15 3l6 6-3 1.5-2 2 1.5 5.5-6-4-5 5-1.5-1.5 5-5-4-6 5.5 1.5 2-2L15 3z" />
					</svg>
				</button>
			</Show>
			<Show when={props.isOwnMessage}>
				<button
					type="button"
					class="rounded p-1 text-xs text-danger-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
					onClick={props.onDelete}
					aria-label="Delete"
				>
					<svg
						class="h-4 w-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<polyline points="3 6 5 6 21 6" />
						<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
					</svg>
				</button>
			</Show>
		</div>
	);
};

const TimelineItem: Component<{
	event: TimelineEvent;
	showHeader: boolean;
	isOwnMessage: boolean;
	onReact: (key: string) => void;
	/** Cast/change the local user's poll vote (empty array = retraction). */
	onVote: (answerIds: string[]) => void;
	/** Open the thread panel for this event's thread (chip click). Absent
	 *  inside the panel itself, where the chip is a plain summary. */
	onOpenThread?: (threadId: string) => void;
	/** Close the poll (only offered when the snapshot says canEnd). */
	onEndPoll: () => void;
	onReply: () => void;
	onJumpToReply: (eventId: string) => void;
	onEdit: () => void;
	onDelete: () => void;
	onTogglePin?: () => void;
	canPin?: boolean;
	isPinned?: boolean;
	onRetry?: () => void;
	onDiscard?: () => void;
	onCancel?: () => void;
	onRetryRedaction?: () => void;
	onDiscardRedaction?: () => void;
	onCancelRedaction?: () => void;
	pendingRedactionStatus?: EventStatus;
	/** Reaction keys whose latest local echo is NOT_SENT for this event. */
	failedReactionKeys?: string[];
	/** Retry the last failed reaction echo for `(this event, key)`. */
	onRetryReaction?: (key: string) => void;
	/** Discard every failed reaction echo for `(this event, key)`. */
	onDiscardReaction?: (key: string) => void;
	/**
	 * Body text the user attempted to send as an edit, if the latest
	 * edit echo for this event is NOT_SENT. Undefined when no edit has
	 * failed. Empty string is rendered as "(empty)" so the surface
	 * stays discoverable.
	 */
	failedEditAttempt?: string;
	onRetryEdit?: () => void;
	onDiscardEdit?: () => void;
	readReceipts?: { userId: string; displayName: string }[];
	client: MatrixClient;
	shortcodeLookup: Map<string, ResolvedEmote>;
	emoteLookup: Map<string, ResolvedEmote>;
	/** Custom emoji packs for the room — passed to the reaction picker. */
	packs: ImagePack[];
	/**
	 * Invoked when the user clicks an `m.image` thumbnail. Only wired
	 * for server-confirmed (non-pending, non-failed) image events.
	 */
	onOpenImage?: (eventId: string) => void;
}> = (props) => {
	const ev = props.event;
	const formattedTime = createMemo(() =>
		formatTime(ev.timestamp, userSettings().timeFormat),
	);
	const fullDateTime = createMemo(() =>
		formatFullDateTime(ev.timestamp, userSettings().timeFormat),
	);
	const isFailed = createMemo(() => ev.status === EventStatus.NOT_SENT);
	const isPending = createMemo(
		() =>
			ev.status === EventStatus.SENDING ||
			ev.status === EventStatus.QUEUED ||
			ev.status === EventStatus.ENCRYPTING,
	);
	const isRedactionPending = createMemo(() => {
		const s = props.pendingRedactionStatus;
		// Anything non-null that isn't a failure / cancellation is
		// pending UX. SENT specifically is a transient state between
		// "server ack" and "remote echo processed by SDK"; during this
		// window the target is still locally redacted (content cleared),
		// so the overlay must persist or the user sees a blank row with
		// full interactions re-enabled.
		return (
			s === EventStatus.SENDING ||
			s === EventStatus.QUEUED ||
			s === EventStatus.ENCRYPTING ||
			s === EventStatus.SENT
		);
	});
	const isRedactionFailed = createMemo(
		() => props.pendingRedactionStatus === EventStatus.NOT_SENT,
	);
	// The SDK's `cancelPendingEvent` accepts QUEUED / NOT_SENT / ENCRYPTING
	// (matrix-js-sdk client.js whitelist). We expose Cancel only for the
	// in-flight subset: QUEUED / ENCRYPTING.
	// SENDING is excluded because the HTTP request is already in flight —
	// the SDK throws "cannot cancel an event with status sending" if asked.
	// SENT is excluded because the server has acknowledged the redaction.
	// NOT_SENT (failed) is excluded because the failed banner already
	// renders Retry / Discard, where Discard performs the same cancel.
	const isRedactionCancellable = createMemo(() => {
		const s = props.pendingRedactionStatus;
		return s === EventStatus.QUEUED || s === EventStatus.ENCRYPTING;
	});

	// Maximum rendered dimensions for image / sticker messages (the inline
	// <img>; video reserves its own box inside MediaVideo). The browser
	// combines the `width` / `height` HTML attributes (intrinsic aspect-ratio)
	// with CSS `max-w-[min(100%,24rem)]` + `max-h-64` to reserve the *correct*
	// layout box before the image decodes — this is what prevents the
	// virtualizer overlap from #67. We pass the raw intrinsic dims (not
	// pre-scaled) so the reserved box and the post-decode rendered box agree
	// under the same CSS constraints. Fallback to a 3:2 box when intrinsic dims
	// are missing so we reserve *something* instead of zero height.
	const IMAGE_FALLBACK_W = 384;
	const IMAGE_FALLBACK_H = 256;
	const mediaReserveDims = createMemo<{ w: number; h: number }>(() => {
		const w = ev.mediaWidth;
		const h = ev.mediaHeight;
		if (w === null || h === null) {
			return { w: IMAGE_FALLBACK_W, h: IMAGE_FALLBACK_H };
		}
		return { w, h };
	});

	// Memoize URL extraction at the component top level (not inside a
	// JSX IIFE) so the reactive primitive is created exactly once for
	// the lifetime of this TimelineItem instance. Extraction runs once
	// when either link-enrichment feature is enabled; the results are
	// then split into OpenGraph-preview URLs and direct-video URLs.
	const messageUrls = createMemo<string[]>(() => {
		if (!userSettings().urlPreviews && !userSettings().inlineMediaPlayers) {
			return [];
		}
		if (ev.msgtype !== "m.text" && ev.msgtype !== "m.emote") return [];
		return ev.format === "org.matrix.custom.html" && ev.formattedBody
			? extractUrlsFromHtml(ev.formattedBody)
			: extractUrlsFromText(ev.body);
	});

	// Direct-media links rendered as a click-to-load inline player.
	const videoUrls = createMemo<string[]>(() =>
		userSettings().inlineMediaPlayers
			? messageUrls().filter(isDirectVideoUrl)
			: [],
	);

	// OpenGraph preview cards. Direct-video URLs are excluded only when the
	// inline player will render them instead (a raw media URL never returns
	// useful `/preview_url` metadata, so fetching a preview is wasted). When
	// inline players are disabled, those URLs fall back to the preview path —
	// preserving the pre-feature behavior for that settings combination.
	const previewUrls = createMemo<string[]>(() => {
		if (!userSettings().urlPreviews) return [];
		return userSettings().inlineMediaPlayers
			? messageUrls().filter((u) => !isDirectVideoUrl(u))
			: messageUrls();
	});

	// Cap visible read-receipt avatars and roll the rest into a "+N"
	// chip so busy rooms don't render a sprawling row of small circles.
	// Memoized so the slice/string-join work only re-runs when the
	// receipt list actually changes — not on every reactive read.
	const MAX_VISIBLE_RECEIPTS = 5;
	const MAX_NAMED_OVERFLOW = 10;
	const receiptDisplay = createMemo(() => {
		const all = props.readReceipts ?? [];
		const visible = all.slice(0, MAX_VISIBLE_RECEIPTS);
		const overflow = all.slice(MAX_VISIBLE_RECEIPTS);
		if (overflow.length === 0) {
			return { visible, overflowCount: 0, overflowLabel: "" };
		}
		const namedOverflow = overflow.slice(0, MAX_NAMED_OVERFLOW);
		const unnamedCount = overflow.length - namedOverflow.length;
		const namesPart = namedOverflow.map((r) => r.displayName).join(", ");
		const overflowLabel =
			unnamedCount > 0
				? `Also read by ${namesPart}, and ${unnamedCount} more`
				: `Also read by ${namesPart}`;
		return { visible, overflowCount: overflow.length, overflowLabel };
	});

	return (
		<Show
			when={!ev.stateNotice}
			fallback={
				<div
					data-event-id={ev.eventId}
					class="group flex items-center gap-3 px-4 py-0.5 hover:bg-surface-1/50"
					role="note"
				>
					<div class="flex w-8 shrink-0 justify-center text-text-faint">
						<StateNoticeIcon variant={ev.stateNotice?.icon ?? "info"} />
					</div>
					<div class="flex min-w-0 flex-1 items-baseline gap-2">
						<span
							class="min-w-0 flex-1 truncate text-xs text-text-muted"
							title={`${ev.stateNotice?.text ?? ""} • ${fullDateTime()}`}
						>
							{ev.stateNotice?.text}
						</span>
						<span
							class="shrink-0 text-[10px] text-text-muted select-none"
							aria-hidden="true"
						>
							{formattedTime()}
						</span>
						<span class="sr-only"> • {fullDateTime()}</span>
					</div>
				</div>
			}
		>
			<div
				data-event-id={ev.eventId}
				class={`group relative flex gap-3 px-4 hover:bg-surface-1/50 ${props.showHeader ? "mt-2 pt-1" : "py-0.5"} ${isFailed() || isRedactionFailed() ? "bg-danger-bg/20" : ""} ${isPending() || isRedactionPending() ? "opacity-60" : ""}`}
			>
				{/* Hover toolbar — hidden for failed/pending echoes (no remote
			    event yet, so react/reply/edit/delete would have no target).
			    Also hidden while a redaction is pending or failed on this
			    target — the relevant action is Retry/Discard on the redaction. */}
				<Show
					when={
						!isFailed() &&
						!isPending() &&
						!isRedactionPending() &&
						!isRedactionFailed()
					}
				>
					<HoverToolbar
						isOwnMessage={props.isOwnMessage}
						msgtype={ev.msgtype}
						canPin={props.canPin ?? false}
						isPinned={props.isPinned ?? false}
						packs={props.packs}
						onReactPick={(key) => props.onReact(key)}
						onReply={props.onReply}
						onReplyInThread={
							props.onOpenThread
								? () => props.onOpenThread?.(props.event.eventId)
								: undefined
						}
						onEdit={props.onEdit}
						onDelete={props.onDelete}
						onTogglePin={() => props.onTogglePin?.()}
					/>
				</Show>

				<Show
					when={props.showHeader}
					fallback={
						<div class="flex w-8 shrink-0 items-start justify-center">
							<span
								class="text-[10px] text-text-muted opacity-0 transition-opacity select-none group-hover:opacity-100 group-focus-within:opacity-100"
								title={fullDateTime()}
								aria-hidden="true"
							>
								{formattedTime()}
							</span>
						</div>
					}
				>
					{/* Avatar */}
					<div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-text-secondary">
						{(ev.senderName.trim() || "?").charAt(0).toUpperCase()}
					</div>
				</Show>

				<div class="min-w-0 flex-1">
					{/* Header: sender + time (only for first message in group) */}
					<Show
						when={props.showHeader}
						fallback={
							<span class="sr-only">
								{ev.senderName.trim() || "Unknown"} at {formattedTime()}
							</span>
						}
					>
						<div class="flex items-baseline gap-2">
							<span class="text-sm font-semibold text-text-emphasis">
								{ev.senderName.trim() || "Unknown"}
							</span>
							<span class="text-xs text-text-muted" title={fullDateTime()}>
								{formattedTime()}
							</span>
							<Show when={ev.isEncrypted && !ev.isDecryptionFailure}>
								<span
									class="text-xs text-success-hover"
									role="img"
									aria-label="Encrypted"
								>
									🔒
								</span>
							</Show>
						</div>
					</Show>

					{/* Body — suppressed during pending/failed redaction since
				    the SDK's `markLocallyRedacted` clears the visible
				    content; the overlay carries the meaning. */}
					<Show when={!isRedactionPending() && !isRedactionFailed()}>
						<Show
							when={!ev.isDecryptionFailure}
							fallback={
								<p class="text-sm italic text-warning-text/80">
									Unable to decrypt this message
								</p>
							}
						>
							<Show
								when={!ev.isEncrypted || ev.type !== "m.room.encrypted"}
								fallback={
									<p class="text-sm italic text-text-disabled">Decrypting…</p>
								}
							>
								{/* Reply context for ALL message types, resolved from the
								    m.in_reply_to relation (media sends carry no `> ` body
								    prefix). Sits above the image / text / media render. */}
								<Show when={ev.replyToId}>
									<ReplyContext
										eventId={ev.replyToId}
										sender={ev.replyToSender}
										snippet={ev.replyToBody}
										thumbUrl={ev.replyToThumbUrl}
										thumbEncryptedFile={ev.replyToThumbEncryptedFile}
										thumbMimetype={ev.replyToThumbMimetype}
										onJump={props.onJumpToReply}
									/>
								</Show>
								<Show
									when={
										(ev.msgtype === "m.image" || ev.type === "m.sticker") &&
										ev.mediaUrl
									}
									fallback={
										<Show
											when={ev.msgtype === "m.text" || ev.msgtype === "m.emote"}
											fallback={
												<Switch
													fallback={
														<p class="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-text-secondary">
															{ev.body ||
																(ev.msgtype
																	? unsupportedLabel(ev.msgtype)
																	: "")}
															<Show when={ev.isEdited}>
																<span class="ml-1 text-xs text-text-disabled">
																	(edited)
																</span>
															</Show>
														</p>
													}
												>
													<Match when={ev.poll}>
														{(poll) => (
															<PollMessage
																poll={poll()}
																onVote={props.onVote}
																onEndPoll={props.onEndPoll}
															/>
														)}
													</Match>
													<Match when={ev.msgtype === "m.video"}>
														<MediaVideo
															httpUrl={ev.mediaFullUrl}
															file={ev.mediaEncryptedFile}
															mimetype={ev.mediaMimetype}
															posterUrl={ev.mediaPosterUrl}
															thumbnailUrl={ev.mediaThumbnailUrl}
															thumbnailFile={ev.mediaThumbnailFile}
															thumbnailMimetype={ev.mediaThumbnailMimetype}
															label={ev.mediaFilename || "Video"}
															isEncrypted={ev.mediaIsEncrypted}
															reserveWidth={ev.mediaWidth}
															reserveHeight={ev.mediaHeight}
														/>
													</Match>
													<Match when={ev.msgtype === "m.audio"}>
														<Show
															when={ev.isVoice}
															fallback={
																<MediaAudio
																	httpUrl={ev.mediaFullUrl}
																	file={ev.mediaEncryptedFile}
																	mimetype={ev.mediaMimetype}
																	label={ev.mediaFilename || "Audio"}
																	isEncrypted={ev.mediaIsEncrypted}
																/>
															}
														>
															<VoiceMessage
																httpUrl={ev.mediaFullUrl}
																file={ev.mediaEncryptedFile}
																mimetype={ev.mediaMimetype}
																isEncrypted={ev.mediaIsEncrypted}
																durationMs={ev.voiceDurationMs}
																waveform={ev.voiceWaveform}
															/>
														</Show>
													</Match>
													<Match when={ev.msgtype === "m.file"}>
														<MediaFile
															httpUrl={ev.mediaFullUrl}
															file={ev.mediaEncryptedFile}
															mimetype={ev.mediaMimetype}
															filename={ev.mediaFilename || "file"}
															size={ev.mediaSize}
															isEncrypted={ev.mediaIsEncrypted}
														/>
													</Match>
												</Switch>
											}
										>
											{(() => {
												const gifUrl =
													ev.msgtype === "m.text"
														? extractGifUrl(ev.body)
														: null;
												if (!gifUrl) {
													return (
														<>
															<MessageBody
																body={ev.body}
																format={ev.format}
																formattedBody={ev.formattedBody}
																isEdited={ev.isEdited}
																client={props.client}
																shortcodeLookup={props.shortcodeLookup}
															/>
															<UrlPreviewList
																client={props.client}
																urls={previewUrls}
																ts={() => ev.timestamp}
																disabled={() => previewUrls().length === 0}
															/>
															<Show when={videoUrls().length > 0}>
																<div class="mt-1 flex flex-col gap-1">
																	<For each={videoUrls()}>
																		{(url) => <InlineVideo url={url} />}
																	</For>
																</div>
															</Show>
														</>
													);
												}
												// Reply context for GIF rows is rendered by the shared
												// ReplyContext block above (resolved from the
												// m.in_reply_to relation), so the legacy `> ` body-prefix
												// parse that used to live here is gone.
												return (
													<>
														<InlineGif
															url={gifUrl}
															alt="GIF"
															width={ev.mediaWidth}
															height={ev.mediaHeight}
														/>
														<Show when={ev.isEdited}>
															<span class="ml-1 text-xs text-text-disabled">
																(edited)
															</span>
														</Show>
													</>
												);
											})()}
										</Show>
									}
								>
									{(() => {
										// Only m.image (not stickers) is openable in the
										// lightbox, and only when the send has confirmed —
										// pending / failed local echoes shouldn't be navigable
										// because their event id can rekey on confirmation.
										// Also require a usable full URL: without it the
										// lightbox would open and immediately auto-close
										// (no matching gallery entry), which reads as a
										// dead click.
										const isOpenableImage =
											ev.msgtype === "m.image" &&
											ev.status === null &&
											!!ev.mediaFullUrl &&
											!!props.onOpenImage;
										// Encrypted images can't be rendered from their (scaled)
										// ciphertext URL — download + decrypt the full file and
										// show the plaintext blob instead.
										// Alt text: the validated `mediaFilename` is already single-line
										// and control-char-safe, unlike the raw `body` (which for a
										// captioned image is the multi-line caption). Using the filename
										// also avoids screen readers double-announcing the caption, which
										// renders as adjacent visible text below.
										const altText = ev.mediaFilename || "Image";
										const imgEl = ev.mediaIsEncrypted ? (
											<EncryptedImage
												httpUrl={ev.mediaFullUrl}
												file={ev.mediaEncryptedFile}
												mimetype={ev.mediaMimetype}
												alt={altText}
												reserveWidth={mediaReserveDims().w}
												reserveHeight={mediaReserveDims().h}
											/>
										) : (
											<img
												src={ev.mediaUrl ?? ""}
												alt={altText}
												width={mediaReserveDims().w}
												height={mediaReserveDims().h}
												class="mt-1 block h-auto w-auto max-h-64 max-w-[min(100%,24rem)] rounded object-contain"
												loading="lazy"
											/>
										);
										const imageBlock = isOpenableImage ? (
											<button
												type="button"
												onClick={() => props.onOpenImage?.(ev.eventId)}
												aria-label={`Open image${ev.mediaFilename ? `: ${ev.mediaFilename}` : ""} in full-screen viewer`}
												class="inline-block max-w-full cursor-zoom-in border-0 bg-transparent p-0 align-top focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0"
											>
												{imgEl}
											</button>
										) : (
											imgEl
										);
										// Caption (m.image only): the spec stores the filename in
										// `content.filename` and the caption in `content.body`; the
										// projection surfaces `mediaCaption` only when the two differ,
										// so it renders beneath the image. Stickers never set it.
										// Auto-escaped as text content (no XSS); multi-line preserved.
										return (
											<>
												{imageBlock}
												<Show when={ev.mediaCaption}>
													<p class="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-text-secondary">
														{ev.mediaCaption}
													</p>
												</Show>
											</>
										);
									})()}
								</Show>
							</Show>
						</Show>
					</Show>

					{/* Reactions — also hidden during pending/failed redaction
				    so the message reads as "deleting" rather than fully
				    interactive. */}
					<Show when={!isRedactionPending() && !isRedactionFailed()}>
						<Show when={ev.thread}>
							{(thread) => (
								<ThreadSummaryChip
									thread={thread()}
									onOpen={
										props.onOpenThread
											? () => props.onOpenThread?.(thread().threadId)
											: undefined
									}
								/>
							)}
						</Show>
						<ReactionPills
							reactions={ev.reactions}
							myReactions={ev.myReactions}
							onReact={props.onReact}
							emoteLookup={props.emoteLookup}
						/>
						<Show
							when={
								(props.failedReactionKeys?.length ?? 0) > 0 &&
								props.onRetryReaction &&
								props.onDiscardReaction
							}
						>
							<FailedReactionPills
								keys={props.failedReactionKeys ?? []}
								emoteLookup={props.emoteLookup}
								onRetry={(key) => props.onRetryReaction?.(key)}
								onDiscard={(key) => props.onDiscardReaction?.(key)}
							/>
						</Show>
					</Show>

					{/* Failed-send banner: visible when status is NOT_SENT, with
				    Retry / Discard actions. Discard removes the local echo;
				    Retry resends through the SDK's pending-event queue. */}
					<Show when={isFailed()}>
						<div
							class="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger-text"
							role="alert"
						>
							<span aria-hidden="true">⚠</span>
							<span>Failed to send</span>
							<Show when={props.onRetry}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-emphasis transition-colors hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={props.onRetry}
								>
									Retry
								</button>
							</Show>
							<Show when={props.onDiscard}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
									onClick={props.onDiscard}
								>
									Discard
								</button>
							</Show>
						</div>
					</Show>

					{/* Sending indicator + Cancel control. The body is dimmed
				    via opacity-60 on the outer wrapper; this surfaces a
				    way to back out of a stuck send. */}
					<Show when={isPending()}>
						<div class="mt-1 flex items-center gap-2 text-xs text-text-muted">
							<span class="sr-only" role="status">
								Sending message
							</span>
							<span aria-hidden="true">Sending…</span>
							<Show when={props.onCancel}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
									onClick={props.onCancel}
									aria-label="Cancel sending message"
								>
									Cancel
								</button>
							</Show>
						</div>
					</Show>

					{/* Pending-redaction indicator + Cancel control. The body is
				    dimmed via the outer wrapper; Cancel calls
				    `client.cancelPendingEvent` on the in-flight redaction
				    (only QUEUED / ENCRYPTING are SDK-cancellable; SENDING
				    is in-flight HTTP and SENT is post-ack). */}
					<Show when={isRedactionPending()}>
						<div class="mt-1 flex items-center gap-2 text-xs text-text-muted">
							<span class="sr-only" role="status">
								Deleting message
							</span>
							<span aria-hidden="true">Deleting…</span>
							<Show when={isRedactionCancellable() && props.onCancelRedaction}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
									onClick={props.onCancelRedaction}
									aria-label="Cancel deleting message"
								>
									Cancel
								</button>
							</Show>
						</div>
					</Show>

					{/* Failed-redaction banner: Retry resends the m.room.redaction
				    echo; Discard cancels it (target restores to normal). */}
					<Show when={isRedactionFailed()}>
						<div
							class="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger-text"
							role="alert"
						>
							<span aria-hidden="true">⚠</span>
							<span>Delete failed</span>
							<Show when={props.onRetryRedaction}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-emphasis transition-colors hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={props.onRetryRedaction}
									aria-label="Retry deleting message"
								>
									Retry
								</button>
							</Show>
							<Show when={props.onDiscardRedaction}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
									onClick={props.onDiscardRedaction}
									aria-label="Discard pending deletion"
								>
									Discard
								</button>
							</Show>
						</div>
					</Show>

					{/* Failed-edit banner: visible when the latest edit echo is
				    NOT_SENT. Shows the attempted edit body so the user can
				    decide whether to retry without retyping. Gated below
				    failed-send and failed-redaction states so we don't
				    stack three failure banners. */}
					<Show
						when={
							!isFailed() &&
							!isRedactionPending() &&
							!isRedactionFailed() &&
							props.failedEditAttempt !== undefined
						}
					>
						<div
							class="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger-text"
							role="alert"
						>
							<span aria-hidden="true">⚠</span>
							<span>Edit failed:</span>
							<span
								class="max-w-[24rem] truncate rounded bg-danger-bg/15 px-1.5 py-0.5 text-text-emphasis"
								title={props.failedEditAttempt || "(empty)"}
							>
								{props.failedEditAttempt || "(empty)"}
							</span>
							<Show when={props.onRetryEdit}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-emphasis transition-colors hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={props.onRetryEdit}
									aria-label="Retry sending edit"
								>
									Retry
								</button>
							</Show>
							<Show when={props.onDiscardEdit}>
								<button
									type="button"
									class="rounded bg-surface-3 px-2 py-0.5 text-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
									onClick={props.onDiscardEdit}
									aria-label="Discard failed edit"
								>
									Discard
								</button>
							</Show>
						</div>
					</Show>

					{/* Read receipts — cap visible avatars and overflow to "+N"
				    so multi-hundred-member rooms don't render a sprawling
				    row of small circles. Cap is intentionally small (5);
				    the chip's aria-label exposes the remaining names. */}
					<Show when={props.readReceipts && props.readReceipts.length > 0}>
						<div class="mt-1.5 flex gap-0.5">
							<For each={receiptDisplay().visible}>
								{(receipt) => (
									<div
										class="flex h-4 w-4 items-center justify-center rounded-full bg-surface-3 text-[8px] font-semibold text-text-muted"
										title={receipt.displayName}
										role="img"
										aria-label={`Read by ${receipt.displayName}`}
									>
										{(receipt.displayName.trim() || "?")
											.charAt(0)
											.toUpperCase()}
									</div>
								)}
							</For>
							<Show when={receiptDisplay().overflowCount > 0}>
								<div
									class="flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-3 px-1 text-[8px] font-semibold text-text-muted"
									title={receiptDisplay().overflowLabel}
									role="img"
									aria-label={receiptDisplay().overflowLabel}
								>
									+{receiptDisplay().overflowCount}
								</div>
							</Show>
						</div>
					</Show>
				</div>
			</div>
		</Show>
	);
};

export { TimelineItem };
