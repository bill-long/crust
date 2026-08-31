import type { MatrixClient } from "matrix-js-sdk";
import { type Component, Show } from "solid-js";
import {
	createImageFallback,
	type FailedImageUrls,
} from "../../../lib/imageFallback";
import type { UrlPreviewData } from "./previewCache";

interface UrlPreviewCardProps {
	client: MatrixClient;
	url: string;
	data: UrlPreviewData;
	/**
	 * Shared fail-closed registry from the component that owns the list this
	 * card renders in - the timeline recycles virtualized rows, so per-card
	 * state would re-attempt a known-broken image on every scroll back.
	 * Omit for a standalone card; it then keeps private state.
	 */
	broken?: FailedImageUrls;
}

// Minimum intrinsic width (px) for an OG image to be rendered as a large
// hero banner rather than a compact side thumbnail. Landscape-only so the
// reserved aspect-ratio box never produces an over-tall card.
const HERO_MIN_WIDTH = 300;

// Split so both layouts hang off ONE <a> - see the render path for why the
// element has to be stable across a layout change.
const CARD_BASE =
	"mt-1 flex rounded-md border border-border-subtle bg-surface-2 no-underline transition-colors hover:bg-surface-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus";
const CARD_COMPACT = "min-h-11 max-w-xl items-center gap-3 p-2";
const CARD_HERO = "max-w-md flex-col overflow-hidden";

/**
 * OpenGraph preview card. Rendered below a message body when the
 * homeserver's `/preview_url` endpoint returns useful metadata.
 *
 * Two layouts, both built only from homeserver-proxied data:
 * - Large hero-image card (Element parity) when the OG image is a
 *   sufficiently large landscape image — full-width banner above the
 *   text, with `video*` `og:type` getting a play overlay.
 * - Compact card with a 96×96 side thumbnail otherwise (small/missing
 *   image).
 *
 * The whole card is a single `<a>` so click-anywhere navigates to the
 * source URL in a new tab. Images are always `mxc://` (the
 * homeserver-cached image) — see `previewCache.ts` for why.
 *
 * Images are fail-closed: a homeserver can hand back a non-image body for an
 * OG image (continuwuity caches whatever the remote origin returned, rate
 * limit pages included), and that must not paint the browser's broken-image
 * icon. A card renders at most one image, so one failure retires it and the
 * card degrades to text-only.
 */
const UrlPreviewCard: Component<UrlPreviewCardProps> = (props) => {
	const isVideo = (): boolean => !!props.data.type?.startsWith("video");

	const heroHttpUrl = (): string | null => {
		const img = props.data.image;
		if (!img) return null;
		return props.client.mxcUrlToHttp(img.mxcUrl, 800, 800, "scale") ?? null;
	};

	const thumbHttpUrl = (): string | null => {
		const img = props.data.image;
		if (!img) return null;
		return props.client.mxcUrlToHttp(img.mxcUrl, 192, 192, "scale") ?? null;
	};

	// Hero only for large landscape images with known intrinsic dimensions
	// (needed to reserve aspect-ratio space and avoid layout shift) that also
	// resolve to a usable homeserver image URL — otherwise we'd reserve a
	// large empty banner. Pure over the OG metadata, so it decides WHICH
	// image the card requests before anything is loaded.
	const heroEligible = (): boolean => {
		const img = props.data.image;
		return (
			!!img &&
			img.width !== undefined &&
			img.height !== undefined &&
			img.width >= HERO_MIN_WIDTH &&
			img.width >= img.height &&
			!!heroHttpUrl()
		);
	};

	// The one image this card can render. A hero card asks for the 800px
	// scale, a compact card the 192px one - never both, because a body that
	// isn't an image is a property of the media, not of the thumbnail size.
	// Retrying the other scale would be a second near-certain failure and a
	// second reflow.
	const imageUrl = (): string | null =>
		heroEligible() ? heroHttpUrl() : thumbHttpUrl();

	const image = createImageFallback(imageUrl, props.broken);

	// A failed hero drops to the compact layout rather than keeping a large
	// reserved banner that will now never be filled. That reservation is a
	// promise about an image the server turned out not to have, and honouring
	// it forever costs a permanent empty box; Element and Discord collapse
	// here too. The cost is one relayout, which is why it must happen at most
	// once (see `imageUrl`) and must not destroy the link (see the render).
	const isHero = (): boolean => heroEligible() && !image.failed();

	const ariaLabel = (): string => {
		const parts: string[] = ["Link preview"];
		if (props.data.title) parts.push(props.data.title);
		if (props.data.site) parts.push(`(${props.data.site})`);
		const label = parts.join(": ").replace(": (", " (");
		return isVideo() ? `${label} (video)` : label;
	};

	const TextColumn: Component = () => (
		<div class="min-w-0 flex-1">
			<Show when={props.data.site}>
				<div class="truncate text-xs text-text-muted">{props.data.site}</div>
			</Show>
			<Show when={props.data.title}>
				<div class="line-clamp-1 text-sm font-medium text-accent-text">
					{props.data.title}
				</div>
			</Show>
			<Show when={props.data.description}>
				<div class="line-clamp-2 text-xs text-text-secondary">
					{props.data.description}
				</div>
			</Show>
		</div>
	);

	// ONE <a> whose class varies, not one <a> per layout: `isHero()` can flip
	// after mount when the image errors, and swapping the element would drop
	// the focus of a keyboard user who had already tabbed onto the link.
	return (
		<a
			href={props.url}
			target="_blank"
			rel="noreferrer noopener"
			aria-label={ariaLabel()}
			class={`${CARD_BASE} ${isHero() ? CARD_HERO : CARD_COMPACT}`}
		>
			<Show
				when={isHero()}
				fallback={
					<>
						<TextColumn />
						<Show when={!image.failed() && imageUrl()}>
							{(src) => (
								<img
									ref={image.ref}
									src={src()}
									alt={props.data.image?.alt ?? ""}
									width={96}
									height={96}
									loading="lazy"
									class="h-24 w-24 shrink-0 rounded object-cover"
									onError={image.onError}
									onLoad={image.onLoad}
								/>
							)}
						</Show>
					</>
				}
			>
				{/* Reserve aspect-ratio space from intrinsic w/h so the hero
				    image loading does not shift layout. */}
				<div
					class="relative w-full bg-surface-3"
					style={{
						"aspect-ratio": `${props.data.image?.width} / ${props.data.image?.height}`,
					}}
				>
					<Show when={imageUrl()}>
						{(src) => (
							<img
								ref={image.ref}
								src={src()}
								alt={props.data.image?.alt ?? ""}
								loading="lazy"
								class="absolute inset-0 h-full w-full object-cover"
								onError={image.onError}
								onLoad={image.onLoad}
							/>
						)}
					</Show>
					<Show when={isVideo()}>
						<span
							aria-hidden="true"
							class="absolute inset-0 flex items-center justify-center"
						>
							<span class="flex h-12 w-12 items-center justify-center rounded-full bg-surface-0/70 text-text-primary">
								<svg
									class="h-6 w-6"
									viewBox="0 0 24 24"
									fill="currentColor"
									aria-hidden="true"
								>
									<path d="M8 5v14l11-7z" />
								</svg>
							</span>
						</span>
					</Show>
				</div>
				<div class="p-2">
					<TextColumn />
				</div>
			</Show>
		</a>
	);
};

export { UrlPreviewCard };
