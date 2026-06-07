import type { MatrixClient } from "matrix-js-sdk";
import { type Component, Show } from "solid-js";
import type { UrlPreviewData } from "./previewCache";

interface UrlPreviewCardProps {
	client: MatrixClient;
	url: string;
	data: UrlPreviewData;
}

// Minimum intrinsic width (px) for an OG image to be rendered as a large
// hero banner rather than a compact side thumbnail. Landscape-only so the
// reserved aspect-ratio box never produces an over-tall card.
const HERO_MIN_WIDTH = 300;

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
 */
const UrlPreviewCard: Component<UrlPreviewCardProps> = (props) => {
	const isVideo = (): boolean => !!props.data.type?.startsWith("video");

	// Hero only for large landscape images with known intrinsic dimensions
	// (needed to reserve aspect-ratio space and avoid layout shift) that also
	// resolve to a usable homeserver image URL — otherwise we'd reserve a
	// large empty banner. The URL check uses the same truthiness test as the
	// render path's <Show> so the two predicates can't diverge.
	const isHero = (): boolean => {
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

	return (
		<Show
			when={isHero()}
			fallback={
				<a
					href={props.url}
					target="_blank"
					rel="noreferrer noopener"
					aria-label={ariaLabel()}
					class="mt-1 flex min-h-11 max-w-xl items-center gap-3 rounded-md border border-border-subtle bg-surface-2 p-2 no-underline transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
				>
					<TextColumn />
					<Show when={thumbHttpUrl()}>
						{(src) => (
							<img
								src={src()}
								alt={props.data.image?.alt ?? ""}
								width={96}
								height={96}
								loading="lazy"
								class="h-24 w-24 shrink-0 rounded object-cover"
							/>
						)}
					</Show>
				</a>
			}
		>
			<a
				href={props.url}
				target="_blank"
				rel="noreferrer noopener"
				aria-label={ariaLabel()}
				class="mt-1 flex max-w-md flex-col overflow-hidden rounded-md border border-border-subtle bg-surface-2 no-underline transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
			>
				{/* Reserve aspect-ratio space from intrinsic w/h so the hero
				    image loading does not shift layout. */}
				<div
					class="relative w-full bg-surface-3"
					style={{
						"aspect-ratio": `${props.data.image?.width} / ${props.data.image?.height}`,
					}}
				>
					<Show when={heroHttpUrl()}>
						{(src) => (
							<img
								src={src()}
								alt={props.data.image?.alt ?? ""}
								loading="lazy"
								class="absolute inset-0 h-full w-full object-cover"
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
			</a>
		</Show>
	);
};

export { UrlPreviewCard };
