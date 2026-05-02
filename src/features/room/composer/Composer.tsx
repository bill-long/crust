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
import EmojiPicker from "../../emoji/EmojiPicker";
import type { ImagePack, PickerEmoji, ResolvedEmote } from "../../emoji/types";
import { buildShortcodeLookup } from "../../emoji/useImagePacks";
import type { TimelineEvent } from "../timeline/useTimeline";
import {
	type CustomEmoji,
	escapeHtml,
	formatMarkdown,
	type Mention,
} from "./markdown";

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
	replyTo?: TimelineEvent | null;
	editingEvent?: TimelineEvent | null;
	onCancelReply?: () => void;
	onCancelEdit?: () => void;
	onSent?: () => void;
	packs: ImagePack[];
}> = (props) => {
	const { client } = useClient();
	const [text, setText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [mentions, setMentions] = createSignal<Mention[]>([]);
	const [mentionQuery, setMentionQuery] = createSignal<string | null>(null);
	const [emojiPickerOpen, setEmojiPickerOpen] = createSignal(false);

	// Memoize shortcode lookup to avoid rebuilding on every send
	const shortcodeLookup = createMemo(() => buildShortcodeLookup(props.packs));

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

	const MAX_PICKER_RESULTS = 50;

	// Shared filtered member list — used by both picker and ARIA state
	const filteredMembers = createMemo(() => {
		const q = mentionQuery();
		if (q === null) return [];
		const lowerQ = q.toLowerCase();
		const results: RoomMember[] = [];
		for (const m of roomMembers()) {
			const name = (m.name ?? "").toLowerCase();
			const uid = m.userId.toLowerCase();
			if (name.includes(lowerQ) || uid.includes(lowerQ)) {
				results.push(m);
				if (results.length >= MAX_PICKER_RESULTS) break;
			}
		}
		return results;
	});

	const pickerRendered = () => filteredMembers().length > 0;

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

	/** Prune mentions whose @DisplayName is no longer in non-code text */
	function reconcileMentions(msg: string): Mention[] {
		// Strip code blocks and inline code so mentions inside code don't count
		const stripped = msg
			.replace(/```(?:[^\n]*\n[\s\S]*?```|[\s\S]*?```)/g, "")
			.replace(/`[^`]+`/g, "");
		return mentions().filter((m) => {
			const token = `@${m.displayName}`;
			// Scan all occurrences in stripped text — keep if any has valid word boundaries
			let searchFrom = 0;
			while (searchFrom < stripped.length) {
				const idx = stripped.indexOf(token, searchFrom);
				if (idx < 0) return false;
				const beforeOk = idx === 0 || !/\w/.test(stripped[idx - 1]);
				const afterIdx = idx + token.length;
				const afterOk =
					afterIdx >= stripped.length || !/\w/.test(stripped[afterIdx]);
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
		// Use same regex as detectMention to find the triggering @
		const triggerMatch = before.match(/(^|[^\w])@(\S*)$/);
		if (!triggerMatch) return;
		const atIdx = before.length - triggerMatch[2].length - 1;

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
				setEmojiPickerOpen(false);
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
			const emoji = findCustomEmoji(msg, shortcodeLookup());
			const { body: newBody, formatted_body } = formatMarkdown(
				msg,
				currentMentions,
				emoji,
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
			setEmojiPickerOpen(false);
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
		const emoji = findCustomEmoji(msg, shortcodeLookup());
		const { body, formatted_body } = formatMarkdown(
			msg,
			currentMentions,
			emoji,
		);
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
		setEmojiPickerOpen(false);
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
					items={filteredMembers()}
					query={mentionQuery() ?? ""}
					visible={mentionQuery() !== null}
					onSelect={onMentionSelect}
					onClose={() => setMentionQuery(null)}
					filterFn={(_item, _q) => true}
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
					position={{ bottom: "100%", left: "0" }}
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
					class="w-full resize-none rounded-lg bg-neutral-800 px-4 py-2.5 pr-10 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-pink-500"
					rows={1}
				/>
				{/* Emoji picker button */}
				<button
					type="button"
					class="absolute bottom-2.5 right-2 rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-700 hover:text-neutral-300"
					onClick={() => setEmojiPickerOpen((v) => !v)}
					aria-label="Open emoji picker"
					aria-expanded={emojiPickerOpen()}
				>
					😀
				</button>
				{/* Emoji picker popover */}
				<Show when={emojiPickerOpen()}>
					<div class="absolute bottom-full right-0 z-20 mb-1">
						<EmojiPicker
							packs={props.packs}
							onSelect={onEmojiSelect}
							onClose={() => setEmojiPickerOpen(false)}
						/>
					</div>
				</Show>
			</div>
		</div>
	);
};

export default Composer;
