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

	// Reserve the *same* box the decrypted <img> will occupy so the row doesn't
	// jump when the image arrives. Scale intrinsic dims into the image's max box
	// (max-w 24rem / max-h 16rem); fall back to a default box when dims unknown.
	const MAX_W = 384;
	const MAX_H = 256;
	const reserveStyle = (): Record<string, string> => {
		const w = props.reserveWidth;
		const h = props.reserveHeight;
		if (!w || !h) return { width: "10rem", height: "8rem" };
		const scale = Math.min(MAX_W / w, MAX_H / h, 1);
		return {
			width: `${Math.round(w * scale)}px`,
			height: `${Math.round(h * scale)}px`,
		};
	};

	return (
		<Switch>
			{/* No usable descriptor/URL (malformed `content.file`) or a failed
			    download/verify/decrypt — fail closed rather than spinning forever. */}
			<Match when={!props.file || !props.httpUrl || media.failed()}>
				<div
					class="mt-1 flex max-w-[min(100%,24rem)] items-center justify-center rounded bg-surface-2 p-4 text-center text-xs text-text-disabled"
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
					class="mt-1 flex max-w-[min(100%,24rem)] items-center justify-center rounded bg-surface-2 p-4 text-center text-xs text-text-disabled"
					style={reserveStyle()}
					aria-busy="true"
				>
					Decrypting…
				</div>
			</Match>
		</Switch>
	);
};
