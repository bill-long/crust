import { createSignal } from "solid-js";

export interface LinkedImage {
	sourceUrl: string;
	fullUrl: string;
	previewType?: string;
	alt?: string;
	width?: number;
	height?: number;
}

export const [linkedImage, setLinkedImage] = createSignal<LinkedImage | null>(
	null,
);
