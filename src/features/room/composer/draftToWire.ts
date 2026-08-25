import {
	type CustomEmoji,
	escapeHtml,
	formatMarkdown,
	type Mention,
} from "../../../lib/markdown";
import { parseSlashCommand } from "./slashCommands";

export interface WireDraft {
	body: string;
	formatted_body: string | null;
	msgtype: "m.text" | "m.emote";
}

/**
 * The single draft-to-wire transform: slash commands parse on the raw
 * draft, then markdown (unless the command asked for plain), then the
 * /spoiler wrap. Both the send path and the live preview consume this,
 * so what the user previews stays byte-identical to what is sent.
 *
 * /spoiler keeps only a placeholder in the plain-text `body` (per
 * MSC2010's recommendation) so plaintext surfaces - push notifications,
 * room-list previews, reply quotes, forward-as-text - don't leak the
 * hidden content. Inline `||...||` spoilers keep their markers in the
 * body instead: the markers themselves convey the hiding.
 */
export function draftToWire(
	text: string,
	mentions: Mention[],
	customEmoji: CustomEmoji[],
): WireDraft {
	const command = parseSlashCommand(text);
	const { body, formatted_body } = command.plain
		? { body: command.text, formatted_body: null }
		: formatMarkdown(command.text, mentions, customEmoji);
	if (!command.spoiler) {
		return { body, formatted_body, msgtype: command.msgtype };
	}
	return {
		body: "[Spoiler]",
		formatted_body: `<span data-mx-spoiler>${
			formatted_body ?? escapeHtml(body).replace(/\n/g, "<br>")
		}</span>`,
		msgtype: command.msgtype,
	};
}
