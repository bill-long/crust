import {
	type Component,
	createEffect,
	createSignal,
	Match,
	on,
	Show,
	Switch,
} from "solid-js";
import type { EncryptedFileInfo } from "../composer/media/attachmentCrypto";
import { createDecryptedObjectUrl } from "../composer/media/useDecryptedMedia";

/**
 * Timeline render of a received `m.audio`.
 *
 * Plain audio uses a native `<audio controls>` pointed at the media URL (the
 * browser fetches lazily). Encrypted audio is click-to-load: a labelled
 * placeholder with a "Load audio" button is shown until the user clicks, then
 * {@link createDecryptedObjectUrl} downloads + verifies + decrypts the
 * ciphertext and the player renders the decrypted blob. A malformed descriptor
 * or a hash/decrypt failure fails closed to an error rather than touching the
 * ciphertext URL.
 *
 * The row is a fixed height so it reserves its layout box immediately and the
 * virtualizer doesn't reflow when the encrypted decrypt resolves.
 */
export const MediaAudio: Component<{
	/** Full (unscaled) http URL — plaintext for plain audio, ciphertext for encrypted. */
	httpUrl: string | null;
	file: EncryptedFileInfo | null;
	mimetype: string | null;
	/** Accessible name / displayed filename for the player. */
	label: string;
	/** Authoritative: when true, `httpUrl` is ciphertext and must be decrypted. */
	isEncrypted: boolean;
}> = (props) => {
	const [activated, setActivated] = createSignal(false);

	// Reset the click-to-load gate if the underlying media changes (e.g. an edit
	// rewrites the attachment while this component instance is reused), so a new
	// ciphertext is never auto-downloaded without a fresh user click. Track every
	// field the decrypt depends on — URL, key/iv/hash, and mimetype — mirroring
	// createDecryptedObjectUrl's cache key, so a descriptor swap that reuses the
	// same URL still re-gates.
	createEffect(
		on(
			() =>
				`${props.httpUrl}|${props.file?.iv ?? ""}|${props.file?.key.k ?? ""}|${props.file?.hashes.sha256 ?? ""}|${props.mimetype ?? ""}`,
			() => setActivated(false),
			{ defer: true },
		),
	);

	const media = createDecryptedObjectUrl(
		() => (props.isEncrypted && activated() ? props.httpUrl : null),
		() => props.file,
		() => props.mimetype,
	);

	const rowClass =
		"mt-1 flex h-12 max-w-[min(100%,28rem)] items-center gap-2 rounded bg-surface-2 px-3";

	const audioEl = (src: string, autoplay: boolean) => (
		// biome-ignore lint/a11y/useMediaCaption: received audio has no caption track.
		<audio
			controls
			autoplay={autoplay}
			// `none`: a timeline of many plain audio messages shouldn't each fetch
			// metadata on render. The decrypted (autoplay) path already holds the
			// blob, so this only gates the plain, not-yet-played case.
			preload="none"
			src={src}
			aria-label={props.label}
			class="mt-1 block h-12 w-full max-w-[min(100%,28rem)]"
		/>
	);

	return (
		<Show
			when={props.isEncrypted}
			fallback={
				<Show
					when={props.httpUrl}
					fallback={
						<div class={`${rowClass} text-xs text-text-disabled`}>
							Audio unavailable
						</div>
					}
				>
					{(url) => audioEl(url(), false)}
				</Show>
			}
		>
			<Switch>
				{/* Malformed descriptor or failed download/verify/decrypt → fail closed. */}
				<Match when={!props.file || !props.httpUrl || media.failed()}>
					<div class={`${rowClass} text-xs text-text-disabled`}>
						Couldn't decrypt audio
					</div>
				</Match>
				{/* Decrypted blob ready → play it. */}
				<Match when={media.url()}>{(url) => audioEl(url(), true)}</Match>
				{/* Decrypting after the load click. */}
				<Match when={activated()}>
					<div
						class={`${rowClass} text-xs text-text-disabled`}
						aria-busy="true"
					>
						Decrypting…
					</div>
				</Match>
				{/* Idle: labelled placeholder with a load button (click-to-load). */}
				<Match when={true}>
					<button
						type="button"
						class={`${rowClass} text-text-secondary transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover`}
						onClick={() => setActivated(true)}
						aria-label={`Load audio: ${props.label}`}
					>
						<svg
							class="h-4 w-4 shrink-0 text-text-muted"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
						>
							<path d="M8 5v14l11-7z" />
						</svg>
						<span class="truncate text-sm">{props.label}</span>
					</button>
				</Match>
			</Switch>
		</Show>
	);
};
