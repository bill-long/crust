import { escapeHtml, type Mention } from "../../../lib/markdown";
import { stripReplyFallback } from "../../../lib/replyFallback";
import type { TimelineEvent } from "../timeline/timelineTypes";

/**
 * Build the Matrix reply-fallback prefixes for a reply to `replyTo`. The body
 * prefix is the mandated `> <sender> quoted-text` block; the HTML prefix is the
 * `<mx-reply><blockquote>` permalink header. Shared by the text-send and GIF
 * paths.
 *
 * `replyTo.body` is the raw `content.body`, which for a reply still carries the
 * parent's own reply fallback. We strip that here (per the Matrix rich-reply
 * convention, matching Element) so nested fallbacks don't accumulate and bloat
 * the body/blockquote on every hop of a reply chain.
 */
export function buildReplyFallback(
	replyTo: TimelineEvent,
	roomId: string,
): {
	bodyPrefix: string;
	htmlPrefix: string;
} {
	const stripped = stripReplyFallback(replyTo.body);
	// When the parent's body is nothing but its own reply fallback (a reply
	// whose actual text is empty), stripping yields "". Fall back to the raw
	// body so we quote something rather than emitting a blank `> <sender> `
	// line; there is no parent-authored text to duplicate here, so no nested
	// fallback accumulates.
	const quotedBody = stripped === "" ? replyTo.body : stripped;
	const quotedLines = quotedBody
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	const bodyPrefix = `> <${replyTo.senderId}> ${quotedBody.split("\n")[0]}\n${
		quotedBody.includes("\n")
			? `${quotedLines.split("\n").slice(1).join("\n")}\n`
			: ""
	}\n`;

	const escapedSender = escapeHtml(replyTo.senderId);
	const escapedBody = escapeHtml(quotedBody).replace(/\n/g, "<br>");
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

/** The edit target's own `m.mentions`, for the newly-added diff below. */
export interface PrevMentions {
	userIds: string[];
	room: boolean;
}

/**
 * Build the content for an `m.replace` edit of `targetEventId`. The wrapper
 * body carries the `* ` fallback prefix (Matrix convention) while `m.new_content`
 * carries the clean replacement (with its own format / mentions). `msgtype`
 * mirrors the edit target's so editing an `/me` emote keeps it an emote.
 *
 * Mentions land in two places, per the intentional-mentions spec: the full
 * current set goes on `m.new_content` (the replacement's rendering state),
 * while the TOP-LEVEL content carries only the mentions `prevMentions`
 * didn't already have - push rules evaluate the top level, so this is what
 * notifies, and restating existing mentions there would re-ping everyone
 * on every typo fix (Element's attachMentions does the same diff).
 */
export function buildEditContent(
	newBody: string,
	formattedBody: string | null,
	mentions: Mention[],
	targetEventId: string,
	msgtype: "m.text" | "m.emote" = "m.text",
	roomMention = false,
	prevMentions: PrevMentions = { userIds: [], room: false },
): Record<string, unknown> {
	const newContent: Record<string, unknown> = {
		msgtype,
		body: newBody,
	};
	if (formattedBody) {
		newContent.format = "org.matrix.custom.html";
		newContent.formatted_body = formattedBody;
	}
	// No reply target on an edit (the relation is m.replace), so the
	// reply-author merge inside applyMentions is inert; myUserId is only
	// read on that path.
	applyMentions(newContent, mentions, null, "", roomMention);

	const content: Record<string, unknown> = {
		msgtype,
		body: `* ${newBody}`,
		"m.new_content": newContent,
		"m.relates_to": {
			rel_type: "m.replace",
			event_id: targetEventId,
		},
	};
	if (formattedBody) {
		content.format = "org.matrix.custom.html";
		content.formatted_body = `* ${formattedBody}`;
	}
	const addedMentions = mentions.filter(
		(m) => !prevMentions.userIds.includes(m.userId),
	);
	applyMentions(
		content,
		addedMentions,
		null,
		"",
		roomMention && !prevMentions.room,
	);
	return content;
}

/**
 * Merge the reply target's author into the typed mention ids so a reply counts
 * as an intentional mention of the parent's author (Element does this, so the
 * replied-to user is highlighted/notified even without an explicit `@`-mention).
 * Deduped, and self-replies are excluded so you never mention yourself.
 */
export function mentionUserIds(
	mentions: Mention[],
	replyTo: TimelineEvent | null,
	myUserId: string,
): string[] {
	const userIds: string[] = [];
	for (const m of mentions) {
		if (!userIds.includes(m.userId)) userIds.push(m.userId);
	}
	if (
		replyTo &&
		replyTo.senderId !== myUserId &&
		!userIds.includes(replyTo.senderId)
	) {
		userIds.push(replyTo.senderId);
	}
	return userIds;
}

/**
 * Set `content["m.mentions"]` from the typed mentions plus the reply target's
 * author (see {@link mentionUserIds}) and the `@room` everyone-mention flag,
 * or remove the field when there is nothing to carry. Shared by every send
 * path so the `m.mentions` shape and the reply-mention rule live in exactly
 * one place. Per spec, `room` is emitted only as `true` (never `false`) and
 * the "@room" text itself stays plain - no pill, no HTML.
 */
export function applyMentions(
	content: Record<string, unknown>,
	mentions: Mention[],
	replyTo: TimelineEvent | null,
	myUserId: string,
	roomMention = false,
): void {
	const userIds = mentionUserIds(mentions, replyTo, myUserId);
	const mentionsContent: Record<string, unknown> = {};
	if (userIds.length > 0) mentionsContent.user_ids = userIds;
	if (roomMention) mentionsContent.room = true;
	if (Object.keys(mentionsContent).length > 0) {
		content["m.mentions"] = mentionsContent;
	} else {
		delete content["m.mentions"];
	}
}

/**
 * Build the content for a text-like message (`m.text` by default;
 * `m.emote` for `/me`). When `replyTo` is non-null, merges the reply
 * fallback (body + formatted_body prefixes), the `m.in_reply_to`
 * relation, and the parent's author into `m.mentions`.
 */
export function buildTextMessageContent(
	body: string,
	formattedBody: string | null,
	mentions: Mention[],
	replyTo: TimelineEvent | null,
	roomId: string,
	myUserId: string,
	msgtype: "m.text" | "m.emote" = "m.text",
	roomMention = false,
): Record<string, unknown> {
	const content: Record<string, unknown> = {
		msgtype,
		body,
	};
	if (formattedBody) {
		content.format = "org.matrix.custom.html";
		content.formatted_body = formattedBody;
	}
	applyMentions(content, mentions, replyTo, myUserId, roomMention);

	// Add reply metadata + fallback if replying.
	if (replyTo) {
		const { bodyPrefix, htmlPrefix } = buildReplyFallback(replyTo, roomId);
		const replyHtmlBody =
			(content.formatted_body as string | undefined) ??
			escapeHtml(content.body as string).replace(/\n/g, "<br>");
		content.body = bodyPrefix + (content.body as string);
		content.format = "org.matrix.custom.html";
		content.formatted_body = htmlPrefix + replyHtmlBody;
		content["m.relates_to"] = {
			"m.in_reply_to": { event_id: replyTo.eventId },
		};
	}
	return content;
}
