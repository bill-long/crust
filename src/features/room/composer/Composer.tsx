import type { RoomMember } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { createPicker } from "../../../components/picker/Picker";
import type { TimelineEvent } from "../timeline/useTimeline";
import { escapeHtml, formatMarkdown, type Mention } from "./markdown";

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
	const [mentions, setMentions] = createSignal<Mention[]>([]);
	const [mentionQuery, setMentionQuery] = createSignal<string | null>(null);

	let textareaRef: HTMLTextAreaElement | undefined;
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

	function filterMember(member: RoomMember, query: string): boolean {
		const q = query.toLowerCase();
		const name = (member.name ?? "").toLowerCase();
		const uid = member.userId.toLowerCase();
		return name.includes(q) || uid.includes(q);
	}

	// Whether the picker is actually rendered (visible and has matching items)
	const pickerRendered = createMemo(() => {
		const q = mentionQuery();
		if (q === null) return false;
		return roomMembers().some((m) => filterMember(m, q));
	});

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

	/** Prune mentions whose @DisplayName is no longer in the text as a whole token */
	function reconcileMentions(msg: string): Mention[] {
		return mentions().filter((m) => {
			const token = `@${m.displayName}`;
			// Scan all occurrences — keep if any has valid word boundaries
			let searchFrom = 0;
			while (searchFrom < msg.length) {
				const idx = msg.indexOf(token, searchFrom);
				if (idx < 0) return false;
				const beforeOk = idx === 0 || !/\w/.test(msg[idx - 1]);
				const afterIdx = idx + token.length;
				const afterOk = afterIdx >= msg.length || !/\w/.test(msg[afterIdx]);
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
		// Find the @ that triggered this mention (search backward from caret)
		const atIdx = before.lastIndexOf("@");
		if (atIdx < 0) return;

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

	// Pre-fill text when entering edit mode
	createEffect(
		on(
			() => props.editingEvent,
			(ev) => {
				setMentions([]);
				setMentionQuery(null);
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
				setMentions([]);
				setMentionQuery(null);
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

	const send = async (): Promise<void> => {
		const msg = text().trim();
		if (!msg || sending()) return;

		// Edit mode: send m.replace event
		if (props.editingEvent) {
			const currentMentions = reconcileMentions(msg);
			const { body: newBody, formatted_body } = formatMarkdown(
				msg,
				currentMentions,
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
				if (!text()) {
					setText(draft);
					setMentions(draftMentions);
				}
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
		const currentMentions = reconcileMentions(msg);
		const { body, formatted_body } = formatMarkdown(msg, currentMentions);
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
		const draftMentions = mentions();
		setText("");
		setError(null);
		setMentions([]);
		setMentionQuery(null);
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
			if (!text()) {
				setText(draft);
				setMentions(draftMentions);
			}
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
		// Picker gets first dibs on keyboard events
		if (handlePickerKey(e)) return;

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
			<div class="relative">
				<MentionPicker
					items={roomMembers()}
					query={mentionQuery() ?? ""}
					visible={mentionQuery() !== null}
					onSelect={onMentionSelect}
					onClose={() => setMentionQuery(null)}
					filterFn={filterMember}
					keyFn={(m) => m.userId}
					renderItem={(member, highlighted) => (
						<div class="flex items-center gap-2">
							<div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-[10px] font-semibold text-neutral-300">
								{((member.name ?? "").trim() || "?").charAt(0).toUpperCase()}
							</div>
							<div class="min-w-0 flex-1">
								<span
									class={highlighted ? "text-neutral-100" : "text-neutral-300"}
								>
									{member.name?.trim() || member.userId}
								</span>
								<span class="ml-1 text-xs text-neutral-600">
									{member.userId}
								</span>
							</div>
						</div>
					)}
					position={{ bottom: 48, left: 0 }}
				/>
				{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is conditionally combobox */}
				<textarea
					ref={textareaRef}
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
					placeholder={props.editingEvent ? "Edit message…" : "Send a message…"}
					role={pickerRendered() ? "combobox" : undefined}
					aria-label={props.editingEvent ? "Edit message" : "Message"}
					aria-expanded={pickerRendered() ? true : undefined}
					aria-activedescendant={getActiveDescendant()}
					aria-autocomplete={pickerRendered() ? "list" : undefined}
					aria-controls={pickerRendered() ? listboxId : undefined}
					class="w-full resize-none rounded-lg bg-neutral-800 px-4 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-pink-500"
					rows={1}
				/>
			</div>
		</div>
	);
};

export default Composer;
