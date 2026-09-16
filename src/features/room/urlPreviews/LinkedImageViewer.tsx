import { useLocation } from "@solidjs/router";
import { createEffect, createMemo, onCleanup, onMount } from "solid-js";
import { useClient } from "../../../client/client";
import { imageViewerSource, isImageLink } from "../../../lib/imageLink";
import { linkedImage, setLinkedImage } from "../../../stores/linkedImage";
import { ImageLightbox, type LightboxImage } from "../timeline/ImageLightbox";
import { peekPreview } from "./previewCache";

/** One viewer outside recycled timeline rows, also covering threads and search. */
export function LinkedImageViewer() {
	const { client } = useClient();
	const location = useLocation();
	createEffect(() => {
		location.pathname;
		location.search;
		setLinkedImage(null);
	});
	onMount(() => {
		const onClick = (event: MouseEvent) => {
			if (
				event.defaultPrevented ||
				event.button !== 0 ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			const anchor =
				event.target instanceof Element
					? event.target.closest<HTMLAnchorElement>(".message-body a[href]")
					: null;
			if (!anchor || !isImageLink(anchor.href)) return;
			const preview = peekPreview(anchor.href)?.image;
			const fullUrl = imageViewerSource(
				anchor.href,
				preview ? client.mxcUrlToHttp(preview.mxcUrl) : null,
			);
			if (!fullUrl) return;
			event.preventDefault();
			// No automatic remote fetch: a direct origin is contacted only on click
			// when no homeserver-cached image is available.
			setLinkedImage({
				sourceUrl: anchor.href,
				fullUrl,
				...(preview?.width !== undefined ? { width: preview.width } : {}),
				...(preview?.height !== undefined ? { height: preview.height } : {}),
			});
		};
		document.addEventListener("click", onClick);
		onCleanup(() => document.removeEventListener("click", onClick));
	});
	onCleanup(() => setLinkedImage(null));
	const image = createMemo<LightboxImage | null>(() => {
		const current = linkedImage();
		if (!current) return null;
		const url = new URL(current.sourceUrl);
		return {
			eventId: current.sourceUrl,
			fullUrl: current.fullUrl,
			externalUrl: current.sourceUrl,
			filename: isImageLink(current.sourceUrl)
				? url.pathname.split("/").pop() || null
				: null,
			width: current.width ?? null,
			height: current.height ?? null,
			senderName: url.hostname,
			timestamp: null,
			size: null,
			mimetype: null,
			isEncrypted: false,
			encryptedFile: null,
		};
	});
	return (
		<ImageLightbox
			open={() => image() !== null}
			image={image}
			onClose={() => setLinkedImage(null)}
			fallbackFocus={() =>
				document.querySelector<HTMLElement>('[data-testid="timeline-scroller"]')
			}
		/>
	);
}
