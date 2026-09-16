import { createSignal } from "solid-js";

export interface LinkedImage {
	sourceUrl: string;
	fullUrl: string;
	previewType?: string;
	alt?: string;
	width?: number;
	height?: number;
	focusFallbacks?: HTMLElement[];
}

export const [linkedImage, setLinkedImage] = createSignal<LinkedImage | null>(
	null,
);

/** Save surviving focus containers before a virtualized opener can be recycled. */
export function openLinkedImage(image: LinkedImage, opener: HTMLElement): void {
	const focusFallbacks: HTMLElement[] = [];
	for (
		let parent = opener.parentElement;
		parent;
		parent = parent.parentElement
	) {
		if (parent.hasAttribute("tabindex")) focusFallbacks.push(parent);
	}
	setLinkedImage({ ...image, focusFallbacks });
}
