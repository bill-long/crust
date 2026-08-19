import { type Accessor, createSignal, onCleanup } from "solid-js";

/** A load/error event from an `<img>`. */
type ImageEvent = Event & { currentTarget: HTMLImageElement };

/**
 * The URL the reporting element is bound to, which is what its load/error
 * event is about. A row can report long after the component that owns the
 * registry moved on - a detached `<img>` still completes its request - so the
 * event is attributed to that element rather than to whatever the accessor
 * returns now. (An element re-bound to a new URL is not covered: the attribute
 * already reads the new one. Browsers abort the old request without firing
 * `error`, so that case does not arise in practice.) The raw attribute is used
 * rather than `src`/`currentSrc` so the key matches the string the registry was
 * given, character for character.
 */
function sourceOf(event: ImageEvent | undefined): string | null | undefined {
	return event?.currentTarget?.getAttribute("src");
}

/** URL-keyed fail-closed state, shared by every image that renders a URL. */
export interface FailedImageUrls {
	/** True while this URL is known-broken. */
	failed(url: string | null | undefined): boolean;
	/** Record a URL as broken (wire to `onError`). */
	markFailed(url: string | null | undefined): void;
	/** Record a URL as loaded, clearing any block (wire to `onLoad`). */
	markLoaded(url: string | null | undefined): void;
}

/** Fail-closed state for one `<img>`. */
export interface ImageFallback {
	/** True while the currently bound URL is known-broken. */
	failed: Accessor<boolean>;
	/** Wire to the `<img>`'s `onError`. */
	onError: (event?: ImageEvent) => void;
	/** Wire to the `<img>`'s `onLoad`. */
	onLoad: (event?: ImageEvent) => void;
	/** Wire to the `<img>`'s `ref`. */
	ref: (el: HTMLImageElement) => void;
}

/**
 * Fail-closed handling for remote images (avatars, thumbnails), keyed by URL:
 * a URL that 404s or fails to decode must fall back to the initial/glyph
 * placeholder instead of painting the browser's broken-image icon.
 *
 * Create ONE of these in the stable component that owns a list, and share it
 * across the rows. `<For>` keys by object reference and these list builders
 * re-mint their items freely - `useMemberList` rebuilds every entry on a typing
 * notification, `useLivekitRoom` re-mints a participant on every speaking/mute
 * flip, the call-overlay snapshot is structurally cloned across a
 * BroadcastChannel - so per-row error state would be discarded on every such
 * rebuild and the broken-image icon would come straight back, several times a
 * second during a call. Because a broken URL is broken for every row that
 * renders it, keying on the URL both survives those remounts and de-duplicates
 * the failure.
 *
 * A block is not permanent, but nothing retries on a timer either: a
 * re-uploaded avatar arrives under a new URL, which no block covers, and any
 * image that does load clears its URL. Otherwise the block lasts as long as
 * the component that owns the registry, which matches how the single-image
 * fallbacks in this app have always behaved.
 *
 * Known limit: because the state is keyed by URL rather than by row, it also
 * outlives the row remounts that used to clear it by accident. A failure that
 * was really transient - media requests made before the service worker
 * controls the page cannot carry the auth an MSC3916 server wants, see
 * `lib/authedMedia.ts` - therefore sticks until the owning component is
 * mounted afresh. If that proves to matter, the fix belongs at the media
 * layer: have it signal "media auth changed" and clear the registries, rather
 * than having every avatar retry on a timer.
 */
export function createFailedImageUrls(): FailedImageUrls {
	const [urls, setUrls] = createSignal<ReadonlySet<string>>(new Set());

	return {
		failed: (url) => (url ? urls().has(url) : false),
		markFailed: (url) => {
			if (!url) return;
			setUrls((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
		},
		markLoaded: (url) => {
			if (!url) return;
			setUrls((prev) => {
				if (!prev.has(url)) return prev;
				const next = new Set(prev);
				next.delete(url);
				return next;
			});
		},
	};
}

/**
 * Fail-closed handling for a SINGLE `<img>`.
 *
 * Pass the list's shared registry as `broken` when the image lives in a list
 * whose rows can remount (see {@link createFailedImageUrls}); with no registry
 * it owns a private one, which is right for a standalone image. Either way,
 * create one of these per `<img>` - it also tracks what this element has
 * painted, so a sibling row's failure never blanks an image already on screen.
 *
 * Render the image under `<Show when={!failed() && url()}>` with the
 * placeholder as the `fallback`, and bind `ref`/`onError`/`onLoad` on the
 * `<img>`.
 */
export function createImageFallback(
	url: Accessor<string | null | undefined>,
	broken?: FailedImageUrls,
): ImageFallback {
	const registry = broken ?? createFailedImageUrls();
	// The URL this element has actually painted, if any. A shared registry
	// blocks a URL for every row that renders it, which is what makes the
	// fallback survive a remount - but an image already on screen here should
	// not be swapped for the initial because a sibling's in-flight request
	// errored. A remounted row starts with nothing painted, so the registry
	// still decides whether to attempt the image at all.
	//
	// A signal, not a plain variable: losing the grace is sometimes the only
	// thing that changes. When this element errors on a URL a sibling row has
	// already blocked, the registry has nothing new to record, so the fallback
	// would never render without this write.
	const [painted, setPainted] = createSignal<string | null>(null);

	return {
		failed: () => {
			const current = url();
			if (!current) return false;
			// Read the registry first, unconditionally: the grace below must not
			// cost the caller its subscription, or a row holding a painted image
			// could never learn that the URL was blocked after all.
			const blocked = registry.failed(current);
			// The grace applies only while this element is still bound to the
			// URL it painted. A stale value is inert rather than cleared here -
			// an accessor that writes the signal it reads forces a second
			// evaluation pass, and every path that matters (this element's own
			// error, a later load, the ref cleanup on unmount) already clears
			// it. If the element is re-bound back to a URL it painted earlier,
			// it is also still displaying that image, so honouring the grace is
			// what the user sees anyway.
			if (painted() === current) return false;
			return blocked;
		},
		onError: (event) => {
			// A detached element's failure still counts: it is evidence about
			// the URL, and recording it errs closed.
			const src = sourceOf(event) ?? url();
			if (painted() === src) setPainted(null);
			registry.markFailed(src);
		},
		onLoad: (event) => {
			// Removing an <img> neither aborts its request nor detaches this
			// handler, so a load can arrive for an element that is already gone.
			// Acting on it would un-block the URL for every row and re-create
			// the images an error had just retired - with intermittently failing
			// media, a thrash loop. Nothing off-screen may clear a block.
			if (event && !event.currentTarget?.isConnected) return;
			const src = sourceOf(event) ?? url();
			setPainted(src ?? null);
			registry.markLoaded(src);
		},
		ref: () => {
			// Runs in the element's own reactive scope, so this fires when the
			// <img> is removed - nothing is painted any more.
			onCleanup(() => setPainted(null));
		},
	};
}
