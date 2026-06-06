import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UrlPreviewData } from "./previewCache";
import { UrlPreviewCard } from "./UrlPreviewCard";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function makeClient(): MatrixClient {
	return {
		mxcUrlToHttp: (mxc: string, w?: number) =>
			`https://hs/img?src=${mxc}&w=${w}`,
	} as unknown as MatrixClient;
}

function renderCard(data: UrlPreviewData): void {
	render(() => (
		<UrlPreviewCard
			client={makeClient()}
			url="https://example.com/watch"
			data={data}
		/>
	));
}

afterEach(() => {
	cleanup();
});

describe("UrlPreviewCard", () => {
	it("renders a large hero image for a large landscape OG image", () => {
		renderCard({
			title: "A video",
			site: "youtube.com",
			image: { mxcUrl: "mxc://h/v", width: 1280, height: 720 },
		});
		const img = document.querySelector("img") as HTMLImageElement;
		// Hero requests the large (800px) thumbnail, not the 96px compact one.
		expect(img.getAttribute("src")).toContain("w=800");
		expect(img.getAttribute("width")).not.toBe("96");
		// Aspect ratio is reserved from intrinsic dimensions.
		const ratioBox = document.querySelector('[style*="aspect-ratio"]');
		expect(ratioBox).not.toBeNull();
		expect((ratioBox as HTMLElement).style.aspectRatio).toContain("1280");
	});

	it("renders the compact thumbnail for a small image", () => {
		renderCard({
			title: "Small",
			image: { mxcUrl: "mxc://h/s", width: 96, height: 96 },
		});
		const img = document.querySelector("img") as HTMLImageElement;
		expect(img.getAttribute("width")).toBe("96");
		expect(img.getAttribute("src")).toContain("w=192");
		expect(document.querySelector('[style*="aspect-ratio"]')).toBeNull();
	});

	it("falls back to compact for a large portrait image", () => {
		renderCard({
			title: "Portrait",
			image: { mxcUrl: "mxc://h/p", width: 600, height: 900 },
		});
		const img = document.querySelector("img") as HTMLImageElement;
		expect(img.getAttribute("width")).toBe("96");
		expect(document.querySelector('[style*="aspect-ratio"]')).toBeNull();
	});

	it("falls back to compact when image dimensions are unknown", () => {
		renderCard({
			title: "No dims",
			image: { mxcUrl: "mxc://h/n" },
		});
		const img = document.querySelector("img") as HTMLImageElement;
		expect(img.getAttribute("width")).toBe("96");
	});

	it("falls back to compact when the mxc image cannot resolve to a URL", () => {
		const client = {
			mxcUrlToHttp: () => null,
		} as unknown as MatrixClient;
		render(() => (
			<UrlPreviewCard
				client={client}
				url="https://example.com/watch"
				data={{
					title: "Broken image",
					image: { mxcUrl: "mxc://bad", width: 1280, height: 720 },
				}}
			/>
		));
		// No hero banner is reserved, and no image renders.
		expect(document.querySelector('[style*="aspect-ratio"]')).toBeNull();
		expect(document.querySelector("img")).toBeNull();
		// The textual card still renders.
		expect(screen.getByText("Broken image")).toBeTruthy();
	});

	it("overlays a play affordance and labels video links for video og:type", () => {
		renderCard({
			title: "Clip",
			type: "video.other",
			image: { mxcUrl: "mxc://h/v", width: 1280, height: 720 },
		});
		expect(screen.getByRole("link").getAttribute("aria-label")).toContain(
			"(video)",
		);
		// Play triangle svg present inside the hero.
		expect(document.querySelector("svg path")).not.toBeNull();
	});

	it("does not show a play overlay for non-video links", () => {
		renderCard({
			title: "Article",
			type: "article",
			image: { mxcUrl: "mxc://h/a", width: 1280, height: 720 },
		});
		expect(screen.getByRole("link").getAttribute("aria-label")).not.toContain(
			"(video)",
		);
		expect(document.querySelector("svg path")).toBeNull();
	});
});
