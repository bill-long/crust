import { useLocation } from "@solidjs/router";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { isImageLink } from "../../../lib/imageLink";
import { ImageLightbox, type LightboxImage } from "../timeline/ImageLightbox";

/** Keep the viewer outside recycled message rows. Preview metadata is not involved. */
export function LinkedImageViewer() {
	const location = useLocation();
	const [image, setImage] = createSignal<LightboxImage | null>(null);
	let focusFallbacks: WeakRef<HTMLElement>[] = [];
	createEffect(() => {
		location.pathname;
		location.search;
		location.hash;
		setImage(null);
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
					? event.target.closest<HTMLAnchorElement>(
							".message-body a[href], a[data-link-preview]",
						)
					: null;
			if (
				!anchor ||
				anchor.hasAttribute("download") ||
				!isImageLink(anchor.href)
			)
				return;
			event.preventDefault();
			focusFallbacks = [];
			for (
				let parent = anchor.parentElement;
				parent;
				parent = parent.parentElement
			) {
				if (parent.hasAttribute("tabindex"))
					focusFallbacks.push(new WeakRef(parent));
			}
			const url = new URL(anchor.href);
			// Contact the linked origin only after an explicit click. An image can
			// display cross-origin without granting the fetch access a download needs.
			setImage({
				eventId: url.href,
				fullUrl: url.href,
				filename: url.pathname.split("/").pop() || "Image",
				canDownload: false,
				senderName: url.hostname,
				timestamp: null,
				width: null,
				height: null,
				size: null,
				mimetype: null,
				isEncrypted: false,
				encryptedFile: null,
			});
		};
		document.addEventListener("click", onClick);
		onCleanup(() => document.removeEventListener("click", onClick));
	});
	return (
		<ImageLightbox
			open={() => image() !== null}
			image={image}
			onClose={() => setImage(null)}
			fallbackFocus={() => {
				const target = focusFallbacks
					.map((ref) => ref.deref())
					.find((element) => element?.isConnected);
				focusFallbacks = [];
				return (
					target ??
					document.querySelector<HTMLElement>(
						'[data-testid="timeline-scroller"]',
					)
				);
			}}
		/>
	);
}
