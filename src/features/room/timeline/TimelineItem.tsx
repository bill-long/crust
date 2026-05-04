import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, For, Show } from "solid-js";
import { MessageBody } from "../../emoji/MessageBody";
import type { ResolvedEmote } from "../../emoji/types";
import { extractGifUrl, InlineGif } from "../../gif/InlineGif";
import type { TimelineEvent } from "./useTimeline";

const ReactionPills: Component<{
	reactions: TimelineEvent["reactions"];
	myReactions: TimelineEvent["myReactions"];
	onReact: (key: string) => void;
	emoteLookup: Map<string, ResolvedEmote>;
}> = (props) => {
	const entries = createMemo(() => Object.entries(props.reactions));

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
			// Unknown pack
			return (
				<span title={key} role="img" aria-label="custom emoji">
					?
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
		<Show when={entries().length > 0}>
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
								<span
									class={isMine() ? "text-accent-text" : "text-text-disabled"}
								>
									{count}
								</span>
							</button>
						);
					}}
				</For>
			</div>
		</Show>
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

const HoverToolbar: Component<{
	isOwnMessage: boolean;
	msgtype: string | undefined;
	onReact: () => void;
	onReply: () => void;
	onEdit: () => void;
	onDelete: () => void;
}> = (props) => {
	return (
		<div class="absolute -top-4 right-4 z-10 flex items-center gap-0.5 rounded-md bg-surface-2 px-0.5 py-0.5 shadow-lg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
			<button
				type="button"
				class="rounded p-1 text-xs text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				onClick={props.onReact}
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
			</button>
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
		<div
			class={`group relative flex gap-3 px-4 hover:bg-surface-1/50 ${props.showHeader ? "mt-2 pt-1" : "py-0.5"}`}
		>
			{/* Hover toolbar */}
			<HoverToolbar
				isOwnMessage={props.isOwnMessage}
				msgtype={ev.msgtype}
				onReact={() => props.onOpenReactionPicker?.()}
				onReply={props.onReply}
				onEdit={props.onEdit}
				onDelete={props.onDelete}
			/>

			<Show
				when={props.showHeader}
				fallback={
					<div class="flex w-8 shrink-0 items-start justify-center">
						<span class="text-[10px] text-text-faint opacity-0 group-hover:opacity-100 transition-opacity select-none">
							{formatTime(ev.timestamp)}
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
				<Show when={props.showHeader}>
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
					</div>
				</Show>

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
