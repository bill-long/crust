import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createStore } from "solid-js/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { watchExternalLinks } from "../../../app/externalLinks";
import { linkedImage, setLinkedImage } from "../../../stores/linkedImage";
import "../../../styles/global.css";
import { LinkedImageViewer } from "./LinkedImageViewer";
import { _resetPreviewCacheForTests, getOrFetchPreview } from "./previewCache";
import { UrlPreviewCard } from "./UrlPreviewCard";

const source = "https://english.eve-guides.fr/images/wtd.jpg";
const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="black"/></svg>')}`;
const data = {
	image: { mxcUrl: "mxc://server/image", width: 1600, height: 900 },
};
const client = {
	mxcUrlToHttp: () => picture,
	getUrlPreview: async () => ({
		"og:image": data.image.mxcUrl,
		"og:image:width": 1600,
		"og:image:height": 900,
	}),
} as unknown as MatrixClient;
const [location, setLocation] = createStore({
	pathname: "/room/general",
	search: "",
	hash: "",
});
vi.mock("../../../client/client", () => ({ useClient: () => ({ client }) }));
vi.mock("@solidjs/router", () => ({ useLocation: () => location }));

let stop = () => {};
afterEach(() => {
	stop();
	cleanup();
	setLinkedImage(null);
	_resetPreviewCacheForTests();
	vi.unstubAllGlobals();
});

describe("linked image viewer", () => {
	it.each(["pathname", "search", "hash"] as const)(
		"closes when navigation changes %s",
		async (part) => {
			render(() => <LinkedImageViewer />);
			setLinkedImage({ sourceUrl: source, fullUrl: picture });
			expect(screen.getByRole("dialog")).toBeTruthy();
			setLocation(part, `${location[part]}changed`);
			await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
		},
	);
	it.each([false, true])(
		"enlarges the linked JPG and restores keyboard focus (desktop=%s)",
		async (native) => {
			const invoke = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("isTauri", native);
			vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
			stop = watchExternalLinks();
			await getOrFetchPreview(client, source, 0);
			render(() => (
				<>
					<div class="message-body">
						<a href={source} target="_blank" rel="noopener">
							Linked JPG
						</a>
					</div>
					<UrlPreviewCard client={client} url={source} data={data} />
					<LinkedImageViewer />
				</>
			));
			const link = screen.getByText("Linked JPG");
			link.focus();
			await userEvent.keyboard("{Enter}");
			await expect.poll(() => screen.queryByRole("dialog")).not.toBeNull();
			const image = screen.getByAltText("wtd.jpg") as HTMLImageElement;
			await expect.poll(() => image.naturalWidth).toBe(1600);
			expect(image.getBoundingClientRect().width).toBeLessThanOrEqual(
				window.innerWidth,
			);
			expect(image.getAttribute("src")).toBe(picture);
			expect(
				screen.getByRole("button", { name: "Download image" }),
			).toBeTruthy();
			expect(invoke).not.toHaveBeenCalled();
			expect(
				screen
					.getByRole("link", { name: "Open in browser" })
					.getAttribute("href"),
			).toBe(source);
			if (native) {
				await userEvent.click(
					screen.getByRole("link", { name: "Open in browser" }),
				);
				expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
					url: source,
				});
			}
			await userEvent.keyboard("{Escape}");
			await expect.poll(() => document.activeElement).toBe(link);
			await expect
				.poll(() =>
					screen.queryByRole("button", {
						name: "Open preview image in full-screen viewer",
					}),
				)
				.not.toBeNull();
			await userEvent.click(
				screen.getByRole("button", {
					name: "Open preview image in full-screen viewer",
				}),
			);
			await expect.poll(() => screen.queryByRole("dialog")).not.toBeNull();
			fireEvent.error(screen.getByAltText("wtd.jpg"));
			expect(screen.getByText("Couldn't load image")).toBeTruthy();
			await userEvent.click(screen.getByRole("button", { name: "Retry" }));
			expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
				true,
			);
			await expect
				.poll(
					() =>
						(screen.getByAltText("wtd.jpg") as HTMLImageElement).naturalWidth,
				)
				.toBe(1600);
			await userEvent.keyboard("{Escape}");
			await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
		},
	);

	it("keeps article titles external and enlarges their cached thumbnail", async () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("isTauri", true);
		vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
		stop = watchExternalLinks();
		render(() => (
			<>
				<UrlPreviewCard
					client={client}
					url="https://example.org/story.html"
					data={{ ...data, title: "Article" }}
				/>
				<LinkedImageViewer />
			</>
		));
		await userEvent.click(
			screen.getByRole("link", { name: "Link preview: Article" }),
		);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(linkedImage()).toBeNull();
		await userEvent.click(
			screen.getByRole("button", {
				name: "Open preview image in full-screen viewer",
			}),
		);
		expect(linkedImage()?.fullUrl).toBe(picture);
		expect(screen.getByAltText("Image")).toBeTruthy();
		expect(invoke).toHaveBeenCalledTimes(1);
	});
	it("opens uncached image links only on click and leaves modified clicks external", () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("isTauri", true);
		vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
		stop = watchExternalLinks();
		render(() => (
			<>
				<div class="message-body">
					<a href={source}>Uncached</a>
					<a href="http://example.org/insecure.jpg">Insecure image</a>
				</div>
				<LinkedImageViewer />
			</>
		));
		expect(linkedImage()).toBeNull();
		fireEvent.click(screen.getByText("Insecure image"));
		expect(linkedImage()).toBeNull();
		expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
			url: "http://example.org/insecure.jpg",
		});
		invoke.mockClear();
		fireEvent.click(screen.getByText("Uncached"), { ctrlKey: true });
		expect(linkedImage()).toBeNull();
		expect(invoke).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText("Uncached"));
		expect(linkedImage()?.fullUrl).toBe(source);
		expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
		expect(screen.getByRole("link", { name: "Open in browser" })).toBeTruthy();
	});
});
