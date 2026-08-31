import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFailedImageUrls } from "../../../lib/imageFallback";
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

/** Fail the currently rendered `<img>` the way a broken response would. */
function failImage(img: HTMLImageElement): void {
	img.dispatchEvent(new Event("error"));
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

	it("falls back to compact when the mxc URL resolves to an empty string", () => {
		const client = {
			mxcUrlToHttp: () => "",
		} as unknown as MatrixClient;
		render(() => (
			<UrlPreviewCard
				client={client}
				url="https://example.com/watch"
				data={{
					title: "Empty image",
					image: { mxcUrl: "mxc://empty", width: 1280, height: 720 },
				}}
			/>
		));
		// A falsy-but-non-null URL must not reserve a hero banner.
		expect(document.querySelector('[style*="aspect-ratio"]')).toBeNull();
		expect(screen.getByText("Empty image")).toBeTruthy();
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

	// A homeserver can hand back a non-image body for an OG image - it caches
	// whatever the remote origin returned, rate-limit pages included - and the
	// browser's broken-image icon must never reach the card.
	it("hides the compact thumbnail when it fails to load", () => {
		renderCard({
			title: "Broken thumb",
			image: { mxcUrl: "mxc://h/b" },
		});
		failImage(document.querySelector("img") as HTMLImageElement);
		expect(document.querySelector("img")).toBeNull();
		// The textual card survives.
		expect(screen.getByText("Broken thumb")).toBeTruthy();
	});

	it("retires the image outright when a hero fails, with no second request", () => {
		renderCard({
			title: "Broken hero",
			image: { mxcUrl: "mxc://h/bh", width: 1280, height: 720 },
		});
		const hero = document.querySelector("img") as HTMLImageElement;
		expect(hero.getAttribute("src")).toContain("w=800");

		failImage(hero);

		// One media failure is one failure: no reserved banner left empty, and
		// no fallback request for the 192px scale of the same broken media -
		// that would be a second near-certain failure and a second reflow.
		expect(document.querySelector('[style*="aspect-ratio"]')).toBeNull();
		expect(document.querySelector("img")).toBeNull();
		expect(screen.getByText("Broken hero")).toBeTruthy();
	});

	it("keeps a focused link focused when the hero collapses", () => {
		renderCard({
			title: "Focus me",
			image: { mxcUrl: "mxc://h/fh", width: 1280, height: 720 },
		});
		const link = screen.getByRole("link");
		link.focus();
		expect(document.activeElement).toBe(link);

		failImage(document.querySelector("img") as HTMLImageElement);

		// The layout swap must vary one <a>'s class, not replace the <a>:
		// destroying the focused element drops a keyboard user to <body>.
		expect(screen.getByRole("link")).toBe(link);
		expect(document.activeElement).toBe(link);
	});

	it("honours a shared registry so a known-broken URL is never re-attempted", () => {
		const broken = createFailedImageUrls();
		const data: UrlPreviewData = {
			title: "Shared",
			image: { mxcUrl: "mxc://h/shared" },
		};
		render(() => (
			<>
				<UrlPreviewCard
					client={makeClient()}
					url="https://example.com/a"
					data={data}
					broken={broken}
				/>
				<UrlPreviewCard
					client={makeClient()}
					url="https://example.com/b"
					data={data}
					broken={broken}
				/>
			</>
		));
		expect(document.querySelectorAll("img")).toHaveLength(2);
		// One card's failure retires the URL for every card rendering it -
		// which is what survives the timeline virtualizer recycling a row.
		failImage(document.querySelector("img") as HTMLImageElement);
		expect(document.querySelectorAll("img")).toHaveLength(0);
	});
});
