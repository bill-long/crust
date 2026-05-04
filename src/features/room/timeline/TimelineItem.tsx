import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { MessageBody } from "../../emoji/MessageBody";
import type { ResolvedEmote } from "../../emoji/types";
import { InlineGif, extractGifUrl } from "../../gif/InlineGif";
import type { TimelineEvent } from "./useTimeline";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🚀"];

const ReactionPills: Component<{
	reactions: TimelineEvent["reactions"];
	myReactions: TimelineEvent["myReactions"];
	onReact: (key: string) => void;
	emoteLookup: Map<string, ResolvedEmote>;
	onOpenFullPicker?: () => void;
}> = (props) => {
	const entries = createMemo(() => Object.entries(props.reactions));
	const [showPicker, setShowPicker] = createSignal(false);

	const renderReactionKey = (key: string) => {
		// Custom emoji: reaction key is an mxc:// URL
		if (key.startsWith("mxc://")) {
			const emote = props.emoteLookup.get(key);
			if (emote) {
				return (
					<img
						src={emote.httpUrl}
						alt={`:${emote.shortcode}:`}
						title={`:${emote.shortcode}:`}
						class="inline h-4 w-4 object-contain"
					/>
				);
			}
			// Unknown pack — show placeholder instead of raw URL
			return (
				<span title={key} role="img" aria-label="custom emoji">
					❓
				</span>
			);
		}
		return <span>{key}</span>;
	};

	const reactionLabel = (key: string): string => {
		if (key.startsWith("mxc://")) {
			const emote = props.emoteLookup.get(key);
			return emote ? `:${emote.shortcode}:` : "custom emoji";
		}
		return key;
	};

	return (
		<div class="mt-1 flex flex-wrap gap-1">
			<For each={entries()}>
				{([key, count]) => {
					const isMine = () => Object.hasOwn(props.myReactions, key);
					return (
						<button
							type="button"
							class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
								isMine()
									? "bg-mention-bg/40 text-accent-text-bright ring-1 ring-accent-hover/50"
									: "bg-surface-2 text-text-secondary hover:bg-surface-3"
							}`}
							onClick={() => props.onReact(key)}
							aria-label={`${reactionLabel(key)} ${count}${isMine() ? ", remove your reaction" : ", react"}`}
							aria-pressed={isMine()}
						>
							{renderReactionKey(key)}
							<span class={isMine() ? "text-accent-text" : "text-text-disabled"}>
								{count}
							</span>
						</button>
					);
				}}
			</For>
			<button
				type="button"
				class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis"
				onClick={() => setShowPicker((v) => !v)}
				onKeyDown={(e) => {
					if (e.key === "Escape" && showPicker()) setShowPicker(false);
				}}
				aria-label="Add reaction"
				aria-expanded={showPicker()}
			>
				+
			</button>
			<Show when={showPicker()}>
				{/* biome-ignore lint/a11y/useSemanticElements: flex layout prevents fieldset use */}
				<div
					class="flex gap-1"
					role="group"
					aria-label="Quick reactions"
					onKeyDown={(e) => {
						if (e.key === "Escape") setShowPicker(false);
					}}
				>
					<For each={QUICK_REACTIONS}>
						{(emoji) => (
							<button
								type="button"
								class="rounded px-1 py-0.5 text-sm transition-colors hover:bg-surface-3"
								onClick={() => {
									props.onReact(emoji);
									setShowPicker(false);
								}}
								aria-label={`React with ${emoji}`}
							>
								{emoji}
							</button>
						)}
					</For>
					<Show when={props.onOpenFullPicker}>
						<button
							type="button"
							class="rounded px-1 py-0.5 text-xs text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
							onClick={() => {
								setShowPicker(false);
								props.onOpenFullPicker?.();
							}}
							aria-label="More reactions"
						>
							⋯
						</button>
					</Show>
				</div>
			</Show>
		</div>
	);
};

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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

const TimelineItem: Component<{
	event: TimelineEvent;
	isOwnMessage: boolean;
	onReact: (key: string) => void;
	onReply: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onImageLoad?: () => void;
	readReceipts?: { userId: string; displayName: string }[];
	client: MatrixClient;
	shortcodeLookup: Map<string, ResolvedEmote>;
	emoteLookup: Map<string, ResolvedEmote>;
	onOpenReactionPicker?: () => void;
}> = (props) => {
	const ev = props.event;

	return (
		<div class="group flex gap-3 px-4 py-1 hover:bg-surface-1/50">
			{/* Avatar placeholder */}
			<div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-text-secondary">
				{(ev.senderName.trim() || "?").charAt(0).toUpperCase()}
			</div>

			<div class="min-w-0 flex-1">
				{/* Header: sender + time + actions */}
				<div class="flex items-baseline gap-2">
					<span class="text-sm font-semibold text-text-emphasis">
						{ev.senderName.trim() || "Unknown"}
					</span>
					<span class="text-xs text-text-faint">
						{formatTime(ev.timestamp)}
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
					<span class="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
						<button
							type="button"
							class="rounded px-1.5 py-0.5 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-secondary"
							onClick={props.onReply}
							aria-label="Reply"
						>
							↩
						</button>
						<Show when={props.isOwnMessage && ev.msgtype === "m.text"}>
							<button
								type="button"
								class="rounded px-1.5 py-0.5 text-xs text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-secondary"
								onClick={props.onEdit}
								aria-label="Edit"
							>
								✏
							</button>
						</Show>
						<Show when={props.isOwnMessage}>
							<button
								type="button"
								class="rounded px-1.5 py-0.5 text-xs text-danger-text-muted transition-colors hover:bg-danger-bg/30 hover:text-danger-text"
								onClick={props.onDelete}
								aria-label="Delete"
							>
								🗑
							</button>
						</Show>
					</span>
				</div>

				{/* Body */}
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
						<Show
							when={
								(ev.msgtype === "m.image" || ev.type === "m.sticker") &&
								ev.imageUrl
							}
							fallback={
								<Show
									when={ev.msgtype === "m.text" || ev.msgtype === "m.emote"}
									fallback={
										<p class="whitespace-pre-wrap break-words text-sm text-text-secondary">
											{ev.body ||
												(ev.msgtype ? unsupportedLabel(ev.msgtype) : "")}
											<Show when={ev.isEdited}>
												<span class="ml-1 text-xs text-text-faint">
													(edited)
												</span>
											</Show>
										</p>
									}
								>
									{(() => {
										const gifUrl =
											ev.msgtype === "m.text" ? extractGifUrl(ev.body) : null;
										if (!gifUrl) {
											return (
												<MessageBody
													body={ev.body}
													format={ev.format}
													formattedBody={ev.formattedBody}
													isEdited={ev.isEdited}
													client={props.client}
													shortcodeLookup={props.shortcodeLookup}
												/>
											);
										}
										// Extract reply context from body prefix if present
										const isReply = ev.body.startsWith("> ");
										const replyPreview = isReply
											? ev.body
													.split("\n")[0]
													.replace(/^> <([^>]+)> /, "$1: ")
													.replace(/^> /, "")
											: null;
										return (
											<>
												<Show when={replyPreview}>
													<div class="mb-1 border-l-2 border-border-strong pl-2 text-xs text-text-disabled">
														{replyPreview}
													</div>
												</Show>
												<InlineGif
													url={gifUrl}
													alt="GIF"
													onSizeSettled={props.onImageLoad}
												/>
												<Show when={ev.isEdited}>
													<span class="ml-1 text-xs text-text-faint">
														(edited)
													</span>
												</Show>
											</>
										);
									})()}
								</Show>
							}
						>
							<img
								src={ev.imageUrl ?? ""}
								alt={ev.body?.trim() || "Image"}
								class="mt-1 max-h-64 max-w-sm rounded"
								loading="lazy"
								onLoad={() => props.onImageLoad?.()}
							/>
						</Show>
					</Show>
				</Show>

				{/* Reactions */}
				<ReactionPills
					reactions={ev.reactions}
					myReactions={ev.myReactions}
					onReact={props.onReact}
					emoteLookup={props.emoteLookup}
					onOpenFullPicker={props.onOpenReactionPicker}
				/>

				{/* Read receipts */}
				<Show when={props.readReceipts && props.readReceipts.length > 0}>
					<div class="mt-0.5 flex gap-0.5">
						<For each={props.readReceipts}>
							{(receipt) => (
								<div
									class="flex h-4 w-4 items-center justify-center rounded-full bg-surface-3 text-[8px] font-semibold text-text-muted"
									title={receipt.displayName}
									role="img"
									aria-label={`Read by ${receipt.displayName}`}
								>
									{(receipt.displayName.trim() || "?").charAt(0).toUpperCase()}
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>
		</div>
	);
};

export { TimelineItem };
