import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import {
	type Component,
	createEffect,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import type { TimelineEvent } from "../timeline/useTimeline";
import { escapeHtml, formatMarkdown } from "./markdown";

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

const TYPING_TIMEOUT_MS = 30_000;
const TYPING_RESEND_MS = 25_000;

const Composer: Component<{
	roomId: string;
	replyTo?: TimelineEvent | null;
	editingEvent?: TimelineEvent | null;
	onCancelReply?: () => void;
	onCancelEdit?: () => void;
	onSent?: () => void;
}> = (props) => {
	const { client } = useClient();
	const [text, setText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	let textareaRef: HTMLTextAreaElement | undefined;
	let lastTypingSentAt = 0;
	let typingRoomId: string | null = null;

	// Pre-fill text when entering edit mode
	createEffect(
		on(
			() => props.editingEvent,
			(ev) => {
				if (ev) {
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
				requestAnimationFrame(autoResize);
			},
		),
	);

	// Stop typing on unmount
	onCleanup(() => {
		stopTyping();
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
			// Best-effort; typing indicators are ephemeral
		});
	};

	const stopTyping = (): void => {
		if (lastTypingSentAt > 0) {
			const roomToStop = typingRoomId ?? props.roomId;
			lastTypingSentAt = 0;
			typingRoomId = null;
			client.sendTyping(roomToStop, false, TYPING_TIMEOUT_MS).catch(() => {
				// Best-effort; typing indicators are ephemeral
			});
		}
	};

	const send = async (): Promise<void> => {
		const msg = text().trim();
		if (!msg || sending()) return;

		// Edit mode: send m.replace event
		if (props.editingEvent) {
			const { body: newBody, formatted_body } = formatMarkdown(msg);
			const newContent: Record<string, unknown> = {
				msgtype: "m.text",
				body: newBody,
			};
			if (formatted_body) {
				newContent.format = "org.matrix.custom.html";
				newContent.formatted_body = formatted_body;
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
			setText("");
			setError(null);
			setSending(true);
			stopTyping();
			requestAnimationFrame(autoResize);

			try {
				await client.sendMessage(
					props.roomId,
					content as unknown as RoomMessageEventContent,
				);
				props.onSent?.();
			} catch (e) {
				if (!text()) setText(draft);
				setError(e instanceof Error ? e.message : "Failed to edit message");
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
			return;
		}

		// Normal send mode
		const { body, formatted_body } = formatMarkdown(msg);
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
			const { bodyPrefix, htmlPrefix } = buildReplyFallback(
				props.replyTo,
				props.roomId,
			);
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
		stopTyping();
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
		if (e.key === "Escape" && props.editingEvent) {
			e.preventDefault();
			stopTyping();
			setText("");
			requestAnimationFrame(autoResize);
			props.onCancelEdit?.();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div class="border-t border-neutral-800 px-4 py-3">
			<Show when={props.editingEvent}>
				{(editing) => (
					<div class="mb-2 flex items-center gap-2 rounded bg-neutral-800/50 px-3 py-1.5">
						<div class="min-w-0 flex-1 border-l-2 border-blue-500 pl-2">
							<p class="truncate text-xs font-medium text-blue-400">
								Editing message
							</p>
							<p class="truncate text-xs text-neutral-500">
								{editing().body.trim() || "Message"}
							</p>
						</div>
						<button
							type="button"
							class="shrink-0 rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-700 hover:text-neutral-300"
							onClick={() => {
								stopTyping();
								setText("");
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
					if (e.currentTarget.value.trim()) {
						sendTyping();
					} else {
						stopTyping();
					}
				}}
				onBlur={() => stopTyping()}
				onKeyDown={onKeyDown}
				placeholder={props.editingEvent ? "Edit message…" : "Send a message…"}
				aria-label={props.editingEvent ? "Edit message" : "Message"}
				class="w-full resize-none rounded-lg bg-neutral-800 px-4 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-pink-500"
				rows={1}
			/>
		</div>
	);
};

export default Composer;
