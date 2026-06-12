import { type Component, Match, Switch } from "solid-js";
import type { EncryptedFileInfo } from "../composer/media/attachmentCrypto";
import { createDecryptedObjectUrl } from "../composer/media/useDecryptedMedia";

/**
 * Inline timeline render of an encrypted `m.image`. Downloads the ciphertext,
 * verifies + decrypts it (see {@link createDecryptedObjectUrl}), and shows the
 * plaintext image. While decrypting it reserves the image's box (so the
 * virtualizer doesn't jump), and on any failure it shows a closed error
 * placeholder rather than a broken `<img>` of ciphertext.
 */
export const EncryptedImage: Component<{
	/** Unscaled ciphertext http URL (the projection's `imageFullUrl`). */
	httpUrl: string | null;
	file: EncryptedFileInfo | null;
	mimetype: string | null;
	alt: string;
	/** Reserved layout box, from the event's intrinsic dimensions. */
	reserveWidth?: number;
	reserveHeight?: number;
}> = (props) => {
	const media = createDecryptedObjectUrl(
		() => props.httpUrl,
		() => props.file,
		() => props.mimetype,
	);

	const reserveStyle = (): Record<string, string> =>
		props.reserveWidth && props.reserveHeight
			? { "aspect-ratio": `${props.reserveWidth} / ${props.reserveHeight}` }
			: {};

	return (
		<Switch>
			{/* No usable descriptor/URL (malformed `content.file`) or a failed
			    download/verify/decrypt — fail closed rather than spinning forever. */}
			<Match when={!props.file || !props.httpUrl || media.failed()}>
				<div
					class="mt-1 flex max-h-64 max-w-[min(100%,24rem)] items-center justify-center rounded bg-surface-2 px-4 py-6 text-center text-xs text-text-disabled"
					style={reserveStyle()}
				>
					Couldn't decrypt image
				</div>
			</Match>
			<Match when={media.url()}>
				{(url) => (
					<img
						src={url()}
						alt={props.alt}
						width={props.reserveWidth}
						height={props.reserveHeight}
						class="mt-1 block h-auto w-auto max-h-64 max-w-[min(100%,24rem)] rounded object-contain"
						loading="lazy"
					/>
				)}
			</Match>
			<Match when={true}>
				<div
					class="mt-1 flex max-h-64 w-40 max-w-[min(100%,24rem)] items-center justify-center rounded bg-surface-2 px-4 py-6 text-center text-xs text-text-disabled"
					style={reserveStyle()}
					aria-busy="true"
				>
					Decrypting…
				</div>
			</Match>
		</Switch>
	);
};
