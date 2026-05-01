import type { EmojiMapping } from "matrix-js-sdk/lib/crypto-api/verification";
import { type Component, For } from "solid-js";

interface EmojiDisplayProps {
	emoji: EmojiMapping[];
}

/**
 * Renders the 7 SAS verification emoji with their English labels.
 * Users compare these on both devices to confirm the verification.
 */
const EmojiDisplay: Component<EmojiDisplayProps> = (props) => {
	return (
		<ul class="grid grid-cols-7 gap-2" aria-label="Verification emoji">
			<For each={props.emoji}>
				{([emojiChar, name]) => (
					<li class="flex flex-col items-center gap-1">
						<span class="text-3xl" aria-hidden="true">
							{emojiChar}
						</span>
						<span class="text-center text-xs text-neutral-400">{name}</span>
					</li>
				)}
			</For>
		</ul>
	);
};

export default EmojiDisplay;
