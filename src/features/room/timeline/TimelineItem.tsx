import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import MessageBody from "../../emoji/MessageBody";
import type { ResolvedEmote } from "../../emoji/types";
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
									? "bg-pink-900/40 text-pink-300 ring-1 ring-pink-500/50"
									: "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
							}`}
							onClick={() => props.onReact(key)}
							aria-label={`${reactionLabel(key)} ${count}${isMine() ? ", remove your reaction" : ", react"}`}
							aria-pressed={isMine()}
						>
							{renderReactionKey(key)}
							<span class={isMine() ? "text-pink-400" : "text-neutral-500"}>
								{count}
							</span>
						</button>
					);
				}}
			</For>
			<button
				type="button"
				class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-xs text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-200"
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
								class="rounded px-1 py-0.5 text-sm transition-colors hover:bg-neutral-700"
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
							class="rounded px-1 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-700 hover:text-neutral-300"
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
		<div class="group flex gap-3 px-4 py-1 hover:bg-neutral-900/50">
			{/* Avatar placeholder */}
			<div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-xs font-semibold text-neutral-300">
				{(ev.senderName.trim() || "?").charAt(0).toUpperCase()}
			</div>

			<div class="min-w-0 flex-1">
				{/* Header: sender + time + actions */}
				<div class="flex items-baseline gap-2">
					<span class="text-sm font-semibold text-neutral-200">
						{ev.senderName.trim() || "Unknown"}
					</span>
					<span class="text-xs text-neutral-600">
						{formatTime(ev.timestamp)}
					</span>
					<Show when={ev.isEncrypted && !ev.isDecryptionFailure}>
						<span
							class="text-xs text-green-600"
							role="img"
							aria-label="Encrypted"
						>
							🔒
						</span>
					</Show>
					<span class="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
						<button
							type="button"
							class="rounded px-1.5 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
							onClick={props.onReply}
							aria-label="Reply"
						>
							↩
						</button>
						<Show when={props.isOwnMessage && ev.msgtype === "m.text"}>
							<button
								type="button"
								class="rounded px-1.5 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
								onClick={props.onEdit}
								aria-label="Edit"
							>
								✏
							</button>
						</Show>
						<Show when={props.isOwnMessage}>
							<button
								type="button"
								class="rounded px-1.5 py-0.5 text-xs text-red-700 transition-colors hover:bg-red-900/30 hover:text-red-400"
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
						<p class="text-sm italic text-amber-500/80">
							Unable to decrypt this message
						</p>
					}
				>
					<Show
						when={!ev.isEncrypted || ev.type !== "m.room.encrypted"}
						fallback={
							<p class="text-sm italic text-neutral-500">Decrypting…</p>
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
										<p class="whitespace-pre-wrap break-words text-sm text-neutral-300">
											{ev.body ||
												(ev.msgtype ? unsupportedLabel(ev.msgtype) : "")}
											<Show when={ev.isEdited}>
												<span class="ml-1 text-xs text-neutral-600">
													(edited)
												</span>
											</Show>
										</p>
									}
								>
									<MessageBody
										body={ev.body}
										format={ev.format}
										formattedBody={ev.formattedBody}
										isEdited={ev.isEdited}
										client={props.client}
										shortcodeLookup={props.shortcodeLookup}
									/>
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
									class="flex h-4 w-4 items-center justify-center rounded-full bg-neutral-700 text-[8px] font-semibold text-neutral-400"
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

export default TimelineItem;
