import type { MatrixClient } from "matrix-js-sdk";
import { type Component, Show } from "solid-js";
import type { UrlPreviewData } from "./previewCache";

interface UrlPreviewCardProps {
	client: MatrixClient;
	url: string;
	data: UrlPreviewData;
}

/**
 * OpenGraph preview card. Rendered below a message body when the
 * homeserver's `/preview_url` endpoint returns useful metadata.
 *
 * The whole card is a single `<a>` so click-anywhere navigates to the
 * source URL in a new tab. Thumbnails are always `mxc://` (the
 * homeserver-cached image) — see `previewCache.ts` for why.
 */
const UrlPreviewCard: Component<UrlPreviewCardProps> = (props) => {
	const thumbHttpUrl = (): string | null => {
		const img = props.data.image;
		if (!img) return null;
		return props.client.mxcUrlToHttp(img.mxcUrl, 192, 192, "scale") ?? null;
	};

	const ariaLabel = (): string => {
		const parts: string[] = ["Link preview"];
		if (props.data.title) parts.push(props.data.title);
		if (props.data.site) parts.push(`(${props.data.site})`);
		return parts.join(": ").replace(": (", " (");
	};

	return (
		<a
			href={props.url}
			target="_blank"
			rel="noreferrer noopener"
			aria-label={ariaLabel()}
			class="mt-1 flex min-h-11 max-w-xl items-center gap-3 rounded-md border border-border-subtle bg-surface-2 p-2 no-underline transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
		>
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
	);
};

export { UrlPreviewCard };
