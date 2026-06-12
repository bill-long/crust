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

const MAX_W = 384;
const MAX_H = 256;

/**
 * Timeline render of a received `m.video`.
 *
 * Plain videos use a native `<video controls>` pointed at the media URL, with
 * the cleartext `thumbnail_url` as a poster; the browser only fetches on play.
 *
 * Encrypted videos can't stream — the whole file must be downloaded to decrypt
 * it — so they're click-to-load: a reserved placeholder with a play button is
 * shown until the user clicks, at which point {@link createDecryptedObjectUrl}
 * downloads the ciphertext, verifies + decrypts it, and the player renders the
 * decrypted blob. A malformed descriptor or a hash/decrypt failure fails closed
 * to an error box rather than ever touching the ciphertext URL.
 *
 * When an encrypted video carries an encrypted poster (`info.thumbnail_file`),
 * it's downloaded + decrypted *eagerly* (best-effort, fail-open: a poster
 * failure just leaves no poster, never blocks playback or shows ciphertext) and
 * shown on the placeholder and the playing `<video>`. This mirrors the eager
 * decrypt-on-mount of {@link EncryptedImage}; the timeline virtualizer bounds
 * the fan-out to on-screen rows.
 *
 * Either way the box is reserved from the cleartext `info.w/h` before load so
 * the virtualizer doesn't reflow.
 */
export const MediaVideo: Component<{
	/** Full (unscaled) http URL — plaintext for plain video, ciphertext for encrypted. */
	httpUrl: string | null;
	file: EncryptedFileInfo | null;
	mimetype: string | null;
	/** Cleartext poster URL (plain video only); null otherwise. */
	posterUrl: string | null;
	/**
	 * Encrypted poster source (encrypted video only): the ciphertext http URL
	 * of `info.thumbnail_file`. Decrypted eagerly into a poster blob. Null when
	 * the video is plain or carries no encrypted thumbnail.
	 */
	thumbnailUrl?: string | null;
	/** Validated EncryptedFile descriptor for the encrypted poster, or null. */
	thumbnailFile?: EncryptedFileInfo | null;
	/** Plaintext mimetype of the encrypted poster (sets the blob type). */
	thumbnailMimetype?: string | null;
	/** Accessible name for the player. */
	label: string;
	/** Authoritative: when true, `httpUrl` is ciphertext and must be decrypted. */
	isEncrypted: boolean;
	reserveWidth: number | null;
	reserveHeight: number | null;
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

	// Encrypted decrypt is gated on the play click: the source stays null (so the
	// resource never fetches) until the user activates the player.
	const media = createDecryptedObjectUrl(
		() => (props.isEncrypted && activated() ? props.httpUrl : null),
		() => props.file,
		() => props.mimetype,
	);

	// Encrypted poster: decrypt the thumbnail eagerly (not gated on the play
	// click — the poster is shown *before* play) so the placeholder and the
	// playing <video> can use a real frame. Best-effort and fail-open: on any
	// download/verify/decrypt failure `poster.url()` stays null and we simply
	// render no poster — playback is unaffected and ciphertext is never shown.
	const poster = createDecryptedObjectUrl(
		() => (props.isEncrypted ? (props.thumbnailUrl ?? null) : null),
		() => props.thumbnailFile ?? null,
		() => props.thumbnailMimetype ?? null,
	);

	// Reserve the same box the player will occupy, scaling intrinsic dims into
	// the max box; fall back to a 16:9 default when dims are unknown.
	const reserveStyle = (): Record<string, string> => {
		const w = props.reserveWidth;
		const h = props.reserveHeight;
		if (!w || !h)
			return { width: `${MAX_W}px`, height: `${(MAX_W * 9) / 16}px` };
		const scale = Math.min(MAX_W / w, MAX_H / h, 1);
		return {
			width: `${Math.round(w * scale)}px`,
			height: `${Math.round(h * scale)}px`,
		};
	};

	const videoClass =
		"mt-1 block h-auto w-auto max-h-64 max-w-[min(100%,24rem)] rounded bg-black object-contain";

	return (
		<Show
			when={props.isEncrypted}
			fallback={
				<Show
					when={props.httpUrl}
					fallback={
						<div
							class="mt-1 flex max-w-[min(100%,24rem)] items-center justify-center rounded bg-surface-2 p-4 text-center text-xs text-text-disabled"
							style={reserveStyle()}
						>
							Video unavailable
						</div>
					}
				>
					{(url) => (
						// biome-ignore lint/a11y/useMediaCaption: received media has no caption track.
						<video
							controls
							// `none`: don't fetch the video bytes until the user presses
							// play, so a timeline of many videos doesn't burst N requests
							// on render. The poster still shows.
							preload="none"
							playsinline
							src={url()}
							poster={props.posterUrl ?? undefined}
							width={props.reserveWidth ?? undefined}
							height={props.reserveHeight ?? undefined}
							aria-label={props.label}
							class={videoClass}
						/>
					)}
				</Show>
			}
		>
			<Switch>
				{/* Malformed descriptor or failed download/verify/decrypt → fail closed. */}
				<Match when={!props.file || !props.httpUrl || media.failed()}>
					<div
						class="mt-1 flex max-w-[min(100%,24rem)] items-center justify-center rounded bg-surface-2 p-4 text-center text-xs text-text-disabled"
						style={reserveStyle()}
					>
						Couldn't decrypt video
					</div>
				</Match>
				{/* Decrypted blob ready → play it. */}
				<Match when={media.url()}>
					{(url) => (
						// biome-ignore lint/a11y/useMediaCaption: received media has no caption track.
						<video
							controls
							autoplay
							playsinline
							src={url()}
							poster={poster.url() ?? undefined}
							width={props.reserveWidth ?? undefined}
							height={props.reserveHeight ?? undefined}
							aria-label={props.label}
							class={videoClass}
						/>
					)}
				</Match>
				{/* Decrypting after the play click. */}
				<Match when={activated()}>
					<div
						class="mt-1 flex max-w-[min(100%,24rem)] items-center justify-center rounded bg-surface-2 p-4 text-center text-xs text-text-disabled"
						style={reserveStyle()}
						aria-busy="true"
					>
						Decrypting…
					</div>
				</Match>
				{/* Idle: reserved placeholder with a play button (click-to-load).
				    Shows the decrypted poster behind the play icon when available. */}
				<Match when={true}>
					<button
						type="button"
						class="group relative mt-1 flex items-center justify-center overflow-hidden rounded bg-surface-2 transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						style={reserveStyle()}
						onClick={() => setActivated(true)}
						aria-label={`Play video: ${props.label}`}
					>
						<Show when={poster.url()}>
							{(posterUrl) => (
								<img
									src={posterUrl()}
									alt=""
									aria-hidden="true"
									class="absolute inset-0 h-full w-full object-cover"
								/>
							)}
						</Show>
						<span class="relative flex h-12 w-12 items-center justify-center rounded-full bg-surface-0/70 text-text-primary transition-colors group-hover:bg-surface-0/90">
							<svg
								class="h-6 w-6"
								viewBox="0 0 24 24"
								fill="currentColor"
								aria-hidden="true"
							>
								<path d="M8 5v14l11-7z" />
							</svg>
						</span>
					</button>
				</Match>
			</Switch>
		</Show>
	);
};
