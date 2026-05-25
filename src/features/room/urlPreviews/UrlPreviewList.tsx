import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createResource, For, Show } from "solid-js";
import { getOrFetchPreview, type UrlPreviewData } from "./previewCache";
import { UrlPreviewCard } from "./UrlPreviewCard";

interface UrlPreviewListProps {
	client: MatrixClient;
	urls: () => string[];
	/** Event timestamp; passed to `client.getUrlPreview` for stability. */
	ts: () => number;
	/** When true, fetches are skipped and nothing renders. */
	disabled: () => boolean;
}

interface PreviewItem {
	url: string;
	data: UrlPreviewData | null | undefined;
}

/**
 * Per-URL preview. Each card has its own `createResource` so one slow
 * URL doesn't block the others.
 *
 * Returns nothing when disabled, while loading, or when the preview is
 * empty / errored.
 */
const PreviewItemView: Component<{
	client: MatrixClient;
	url: string;
	ts: number;
	disabled: boolean;
}> = (props) => {
	const [resource] = createResource<UrlPreviewData | null, string>(
		// Source: re-fetch when the URL changes. When disabled, source
		// resolves to false-y so the fetcher doesn't run.
		() => (props.disabled ? null : props.url),
		(url) => getOrFetchPreview(props.client, url, props.ts),
	);

	return (
		<Show when={!props.disabled && resource()}>
			{(data) => (
				<UrlPreviewCard client={props.client} url={props.url} data={data()} />
			)}
		</Show>
	);
};

/**
 * Render up to N preview cards for the URLs in a message, stacked
 * vertically below the message body.
 *
 * Hidden entirely when `disabled()` is true or the URL list is empty.
 */
const UrlPreviewList: Component<UrlPreviewListProps> = (props) => {
	return (
		<Show when={!props.disabled() && props.urls().length > 0}>
			<div class="mt-1 flex flex-col gap-1">
				<For each={props.urls()}>
					{(url) => (
						<PreviewItemView
							client={props.client}
							url={url}
							ts={props.ts()}
							disabled={props.disabled()}
						/>
					)}
				</For>
			</div>
		</Show>
	);
};

export type { PreviewItem };
export { UrlPreviewList };
