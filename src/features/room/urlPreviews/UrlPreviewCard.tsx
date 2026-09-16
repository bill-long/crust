import type { MatrixClient } from "matrix-js-sdk";
import { type Component, Show } from "solid-js";
import {
	createImageFallback,
	type FailedImageUrls,
} from "../../../lib/imageFallback";
import { imageViewerSource, isImageLink } from "../../../lib/imageLink";
import { setLinkedImage } from "../../../stores/linkedImage";
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

// One stable title link survives image failure and layout changes.
const CARD_BASE =
	"mt-1 flex rounded-md border border-border-subtle bg-surface-2";
const CARD_COMPACT = "min-h-11 max-w-xl items-center gap-3 p-2";
const CARD_HERO = "max-w-md flex-col overflow-hidden";

/** Homeserver-proxied preview; images enlarge, titles navigate to the source. */
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
	// large empty banner. Reads only the OG metadata and the client's
	// mxc-to-HTTP conversion - never load state - so it decides WHICH image
	// the card requests before anything has been fetched.
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

	const openImage = () => {
		const img = props.data.image;
		const fullUrl = imageViewerSource(
			props.url,
			(img ? props.client.mxcUrlToHttp(img.mxcUrl) : null) || imageUrl(),
			props.data.type,
		);
		if (!fullUrl) return false;
		setLinkedImage({
			sourceUrl: props.url,
			fullUrl,
			...(props.data.type ? { previewType: props.data.type } : {}),
			...(img?.alt ? { alt: img.alt } : {}),
			...(img?.width !== undefined ? { width: img.width } : {}),
			...(img?.height !== undefined ? { height: img.height } : {}),
		});
		return true;
	};
	const onTitleClick = (event: MouseEvent) => {
		if (
			event.button !== 0 ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			event.altKey ||
			!isImageLink(props.url, props.data.type)
		)
			return;
		if (openImage()) event.preventDefault();
	};
	const onImageClick = (event: MouseEvent) => {
		if (
			event.button !== 0 ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			event.altKey ||
			isVideo()
		)
			return;
		if (openImage()) event.preventDefault();
	};
	let titleLink: HTMLAnchorElement | undefined;
	let imageLink: HTMLAnchorElement | undefined;
	const onImageError = (event: Event & { currentTarget: HTMLImageElement }) => {
		if (document.activeElement === imageLink) titleLink?.focus();
		image.onError(event);
	};

	return (
		<div class={`${CARD_BASE} ${isHero() ? CARD_HERO : CARD_COMPACT}`}>
			<a
				ref={titleLink}
				href={props.url}
				target="_blank"
				rel="noreferrer noopener"
				aria-label={ariaLabel()}
				onClick={onTitleClick}
				class={`min-w-0 flex-1 rounded no-underline hover:bg-surface-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus ${isHero() ? "order-2 w-full p-2" : "self-stretch content-center"}`}
			>
				<TextColumn />
				<Show
					when={
						!props.data.title && !props.data.site && !props.data.description
					}
				>
					<span class="block truncate text-xs text-text-muted">
						{new URL(props.url).hostname}
					</span>
				</Show>
			</a>
			<Show when={!image.failed() && imageUrl()}>
				{(src) => (
					<a
						ref={imageLink}
						href={props.url}
						target="_blank"
						rel="noreferrer noopener"
						onClick={onImageClick}
						aria-label={
							isVideo()
								? "Open video in browser"
								: "Open preview image in full-screen viewer"
						}
						class={`relative shrink-0 bg-surface-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus ${isHero() ? "order-1 w-full" : "h-24 w-24 rounded"}`}
						style={
							isHero()
								? {
										"aspect-ratio": `${props.data.image?.width} / ${props.data.image?.height}`,
									}
								: undefined
						}
					>
						<img
							ref={image.ref}
							src={src()}
							alt={props.data.image?.alt ?? ""}
							width={isHero() ? undefined : 96}
							height={isHero() ? undefined : 96}
							loading="lazy"
							onError={onImageError}
							onLoad={image.onLoad}
							class="absolute inset-0 h-full w-full rounded object-cover"
						/>
						<Show when={isVideo() && isHero()}>
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
					</a>
				)}
			</Show>
		</div>
	);
};

export { UrlPreviewCard };
