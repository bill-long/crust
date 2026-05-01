import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import type { TimelineEvent } from "./useTimeline";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🚀"];

const ReactionPills: Component<{
	reactions: TimelineEvent["reactions"];
	myReactions: TimelineEvent["myReactions"];
	onReact: (key: string) => void;
}> = (props) => {
	const entries = createMemo(() => Object.entries(props.reactions));
	const [showPicker, setShowPicker] = createSignal(false);

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
							aria-label={`${key} ${count}${isMine() ? ", remove your reaction" : ", react"}`}
							aria-pressed={isMine()}
						>
							<span>{key}</span>
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
				</div>
			</Show>
		</div>
	);
};

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TimelineItem: Component<{
	event: TimelineEvent;
	onReact: (key: string) => void;
	onReply: () => void;
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
								<p class="whitespace-pre-wrap break-words text-sm text-neutral-300">
									{ev.body}
								</p>
							}
						>
							<img
								src={ev.imageUrl ?? ""}
								alt={ev.body?.trim() || "Image"}
								class="mt-1 max-h-64 max-w-sm rounded"
								loading="lazy"
							/>
						</Show>
					</Show>
				</Show>

				{/* Reactions */}
				<ReactionPills
					reactions={ev.reactions}
					myReactions={ev.myReactions}
					onReact={props.onReact}
				/>
			</div>
		</div>
	);
};

export default TimelineItem;
