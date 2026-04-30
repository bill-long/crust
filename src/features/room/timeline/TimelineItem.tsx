import { type Component, For, Show } from "solid-js";
import type { TimelineEvent } from "./useTimeline";

const ReactionPills: Component<{
	reactions: TimelineEvent["reactions"];
}> = (props) => {
	const entries = () => Object.entries(props.reactions);

	return (
		<Show when={entries().length > 0}>
			<div class="mt-1 flex flex-wrap gap-1">
				<For each={entries()}>
					{([key, { count }]) => (
						<span class="inline-flex items-center gap-1 rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
							<span>{key}</span>
							<span class="text-neutral-500">{count}</span>
						</span>
					)}
				</For>
			</div>
		</Show>
	);
};

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TimelineItem: Component<{ event: TimelineEvent }> = (props) => {
	const ev = props.event;

	return (
		<div class="group flex gap-3 px-4 py-1 hover:bg-neutral-900/50">
			{/* Avatar placeholder */}
			<div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-xs font-semibold text-neutral-300">
				{(ev.senderName.trim() || "?").charAt(0).toUpperCase()}
			</div>

			<div class="min-w-0 flex-1">
				{/* Header: sender + time */}
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
					{/* Image */}
					<Show when={ev.msgtype === "m.image" && ev.imageUrl}>
						<img
							src={ev.imageUrl ?? ""}
							alt={ev.body?.trim() || "Image"}
							class="mt-1 max-h-64 max-w-sm rounded"
							loading="lazy"
						/>
					</Show>

					{/* Text */}
					<Show when={ev.msgtype !== "m.image" || !ev.imageUrl}>
						<p class="whitespace-pre-wrap break-words text-sm text-neutral-300">
							{ev.body}
						</p>
					</Show>
				</Show>

				{/* Reactions */}
				<ReactionPills reactions={ev.reactions} />
			</div>
		</div>
	);
};

export default TimelineItem;
