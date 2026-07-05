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

/**
 * Build the content for an `m.replace` edit of `targetEventId`. The wrapper
 * body carries the `* ` fallback prefix (Matrix convention) while `m.new_content`
 * carries the clean replacement (with its own format / mentions).
 */
export function buildEditContent(
	newBody: string,
	formattedBody: string | null,
	mentions: Mention[],
	targetEventId: string,
): Record<string, unknown> {
	const newContent: Record<string, unknown> = {
		msgtype: "m.text",
		body: newBody,
	};
	if (formattedBody) {
		newContent.format = "org.matrix.custom.html";
		newContent.formatted_body = formattedBody;
	}
	if (mentions.length > 0) {
		newContent["m.mentions"] = {
			user_ids: mentions.map((m) => m.userId),
		};
	}

	const content: Record<string, unknown> = {
		msgtype: "m.text",
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
	return content;
}

/**
 * Build the content for a plain `m.text` message. When `replyTo` is non-null,
 * merges the reply fallback (body + formatted_body prefixes) and the
 * `m.in_reply_to` relation.
 */
export function buildTextMessageContent(
	body: string,
	formattedBody: string | null,
	mentions: Mention[],
	replyTo: TimelineEvent | null,
	roomId: string,
): Record<string, unknown> {
	const content: Record<string, unknown> = {
		msgtype: "m.text",
		body,
	};
	if (formattedBody) {
		content.format = "org.matrix.custom.html";
		content.formatted_body = formattedBody;
	}
	if (mentions.length > 0) {
		content["m.mentions"] = {
			user_ids: mentions.map((m) => m.userId),
		};
	}

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
