import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { type Component, createSignal, Show } from "solid-js";
import { useClient } from "../../../client/client";
import type { TimelineEvent } from "../timeline/useTimeline";
import { formatMarkdown } from "./markdown";

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function buildReplyFallback(replyTo: TimelineEvent): {
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
	const htmlPrefix =
		`<mx-reply><blockquote>` +
		`<a href="https://matrix.to/#/${encodeURIComponent(replyTo.senderId)}">${escapedSender}</a><br>` +
		`${escapedBody}` +
		`</blockquote></mx-reply>`;

	return { bodyPrefix, htmlPrefix };
}

const Composer: Component<{
	roomId: string;
	replyTo?: TimelineEvent | null;
	onCancelReply?: () => void;
	onSent?: () => void;
}> = (props) => {
	const { client } = useClient();
	const [text, setText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	let textareaRef: HTMLTextAreaElement | undefined;

	const autoResize = (): void => {
		const el = textareaRef;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	};

	const send = async (): Promise<void> => {
		const msg = text().trim();
		if (!msg || sending()) return;

		const { body, formatted_body } = formatMarkdown(msg);
		// Build content conforming to m.room.message / m.text
		const content: Record<string, unknown> = {
			msgtype: "m.text",
			body,
		};
		if (formatted_body) {
			content.format = "org.matrix.custom.html";
			content.formatted_body = formatted_body;
		}

		// Add reply metadata if replying
		if (props.replyTo) {
			const { bodyPrefix, htmlPrefix } = buildReplyFallback(props.replyTo);
			const replyHtmlBody =
				(content.formatted_body as string | undefined) ??
				escapeHtml(content.body as string).replace(/\n/g, "<br>");
			content.body = bodyPrefix + (content.body as string);
			content.format = "org.matrix.custom.html";
			content.formatted_body = htmlPrefix + replyHtmlBody;
			content["m.relates_to"] = {
				"m.in_reply_to": { event_id: props.replyTo.eventId },
			};
		}

		const draft = text();
		setText("");
		setError(null);
		setSending(true);
		requestAnimationFrame(autoResize);

		try {
			await client.sendMessage(
				props.roomId,
				content as unknown as RoomMessageEventContent,
			);
			props.onSent?.();
		} catch (e) {
			if (!text()) setText(draft);
			setError(e instanceof Error ? e.message : "Failed to send message");
			requestAnimationFrame(autoResize);
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
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div class="border-t border-neutral-800 px-4 py-3">
			<Show when={props.replyTo}>
				{(reply) => (
					<div class="mb-2 flex items-center gap-2 rounded bg-neutral-800/50 px-3 py-1.5">
						<div class="min-w-0 flex-1 border-l-2 border-pink-500 pl-2">
							<p class="truncate text-xs font-medium text-neutral-400">
								{reply().senderName.trim() || "Unknown"}
							</p>
							<p class="truncate text-xs text-neutral-500">
								{reply().body.trim() || "Message"}
							</p>
						</div>
						<button
							type="button"
							class="shrink-0 rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-700 hover:text-neutral-300"
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
					class="mb-2 rounded bg-red-900/30 px-3 py-1.5 text-xs text-red-400"
					role="alert"
				>
					{error()}
				</div>
			</Show>
			<textarea
				ref={textareaRef}
				value={text()}
				onInput={(e) => {
					setText(e.currentTarget.value);
					autoResize();
				}}
				onKeyDown={onKeyDown}
				placeholder="Send a message…"
				aria-label="Message"
				class="w-full resize-none rounded-lg bg-neutral-800 px-4 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-pink-500"
				rows={1}
			/>
		</div>
	);
};

export default Composer;
