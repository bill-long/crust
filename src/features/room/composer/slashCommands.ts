/**
 * Composer slash commands (#448), parsed on the raw draft BEFORE the
 * markdown pipeline. Cinny/Element-compatible starter set:
 *
 * - `/me <action>`     - sends an `m.emote` (markdown still applies)
 * - `/shrug [msg]`     - prepends the shrug emoticon
 * - `/tableflip [msg]` - prepends the tableflip emoticon
 * - `/unflip [msg]`    - prepends the unflip emoticon
 * - `/lenny [msg]`     - prepends the lenny face
 * - `/plain <msg>`     - sends without markdown formatting
 * - `/spoiler <msg>`   - wraps the whole message in a spoiler
 * - `//text`           - escape hatch: sends `/text` literally
 *
 * Unknown commands pass through as literal text (the issue's contract -
 * no surprise swallowing of "/actually a message").
 *
 * Emoticon commands send plain: the faces contain `\` and `_` which this
 * repo's markdown (no backslash escapes) would mangle into emphasis.
 */

export interface ParsedSlashCommand {
	/** Text to continue the send pipeline with. */
	text: string;
	/** Msgtype for the outgoing event. */
	msgtype: "m.text" | "m.emote";
	/** Skip markdown formatting entirely. */
	plain: boolean;
	/** Wrap the message in a `data-mx-spoiler` span. */
	spoiler: boolean;
}

const EMOTICONS: Record<string, string> = {
	shrug: "¯\\_(ツ)_/¯",
	tableflip: "(╯°□°）╯︵ ┻━┻",
	unflip: "┬─┬ ノ( ゜-゜ノ)",
	lenny: "( ͡° ͜ʖ ͡°)",
};

function passthrough(text: string): ParsedSlashCommand {
	return { text, msgtype: "m.text", plain: false, spoiler: false };
}

export function parseSlashCommand(input: string): ParsedSlashCommand {
	if (!input.startsWith("/")) return passthrough(input);
	// `//text` sends `/text` literally.
	if (input.startsWith("//")) return passthrough(input.slice(1));

	const match = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/i.exec(input);
	if (!match) return passthrough(input);
	const command = match[1].toLowerCase();
	const rest = match[2]?.trim() ?? "";

	// Object.hasOwn: a plain-object lookup would resolve "/constructor"
	// et al. through Object.prototype and send a Function as the body.
	const emoticon = Object.hasOwn(EMOTICONS, command)
		? EMOTICONS[command]
		: undefined;
	if (emoticon !== undefined) {
		return {
			text: rest ? `${emoticon} ${rest}` : emoticon,
			msgtype: "m.text",
			plain: true,
			spoiler: false,
		};
	}

	// Text-consuming commands with nothing after them fall through as
	// literal text rather than sending an empty event.
	if (rest === "") return passthrough(input);

	switch (command) {
		case "me":
			return { text: rest, msgtype: "m.emote", plain: false, spoiler: false };
		case "plain":
			return { text: rest, msgtype: "m.text", plain: true, spoiler: false };
		case "spoiler":
			return { text: rest, msgtype: "m.text", plain: false, spoiler: true };
		default:
			return passthrough(input);
	}
}
