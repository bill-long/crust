import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createStore } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { watchExternalLinks } from "../../../app/externalLinks";
import "../../../styles/global.css";
import { LinkedImageViewer } from "./LinkedImageViewer";
import { UrlPreviewCard } from "./UrlPreviewCard";

vi.mock("../../../client/client", () => ({ useClient: () => ({ client }) }));

const source = "https://images.invalid/map.jpg";
const svg =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="black"/></svg>';
const picture = `data:image/svg+xml,${encodeURIComponent(svg)}`;
declare module "vitest/browser" {
	interface BrowserCommands {
		mockLinkedImage(url: string, svg: string | null): Promise<void>;
	}
}
const client = { mxcUrlToHttp: () => picture } as unknown as MatrixClient;
const [location, setLocation] = createStore({
	pathname: "/room/general",
	search: "",
	hash: "",
});
vi.mock("@solidjs/router", () => ({ useLocation: () => location }));
let stop = () => {};
beforeEach(() => commands.mockLinkedImage(source, svg));
afterEach(async () => {
	stop();
	cleanup();
	vi.unstubAllGlobals();
	await commands.mockLinkedImage(source, null);
});

function nativeLinks(native: boolean) {
	const invoke = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("isTauri", native);
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
	stop = watchExternalLinks();
	return invoke;
}

function Example() {
	return (
		<>
			<div data-testid="timeline-scroller" tabindex="-1">
				Main timeline
			</div>
			<section tabindex="-1" aria-label="Thread timeline">
				<div data-testid="opener-row">
					<div class="message-body">
						<a href={source}>Linked JPG</a>
					</div>
					<UrlPreviewCard
						client={client}
						url={source}
						data={{
							title: "Map",
							image: { mxcUrl: "mxc://server/map", width: 1600, height: 900 },
						}}
					/>
				</div>
			</section>
			<LinkedImageViewer />
		</>
	);
}

describe("direct linked image viewer", () => {
	it.each([false, true])(
		"opens message and preview links with the existing viewer (desktop=%s)",
		async (native) => {
			const invoke = nativeLinks(native);
			render(() => <Example />);
			for (const label of ["Linked JPG", "Link preview: Map"]) {
				const opener = screen.getByRole("link", { name: label });
				opener.focus();
				await userEvent.keyboard("{Enter}");
				expect(screen.getByRole("dialog")).toBeTruthy();
				const displayed = screen.getByAltText("map.jpg") as HTMLImageElement;
				expect(displayed.getAttribute("src")).toBe(source);
				await expect
					.poll(() => displayed.complete && displayed.naturalWidth === 1600)
					.toBe(true);
				await expect
					.poll(() => displayed.getBoundingClientRect().width)
					.toBeLessThanOrEqual(window.innerWidth);
				expect(
					screen.getByRole("button", { name: "Fit to viewport" }),
				).toBeTruthy();
				expect(
					screen.queryByRole("button", { name: "Download image" }),
				).toBeNull();
				expect(invoke).not.toHaveBeenCalled();
				const external = screen.getByRole("link", { name: "Open in browser" });
				expect(external.getAttribute("href")).toBe(source);
				fireEvent.error(screen.getByAltText("map.jpg"));
				expect(screen.getByText("Couldn't load image")).toBeTruthy();
				expect(screen.getByRole("link", { name: "Open in browser" })).toBe(
					external,
				);
				if (native) {
					await userEvent.click(external);
					expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
						url: source,
					});
					invoke.mockClear();
				}
				await userEvent.keyboard("{Escape}");
				await expect.poll(() => document.activeElement).toBe(opener);
				await expect
					.poll(() => screen.queryByRole("link", { name: "Link preview: Map" }))
					.not.toBeNull();
			}
		},
	);
	it.each(["pathname", "search", "hash"] as const)(
		"closes on %s navigation",
		async (part) => {
			render(() => <Example />);
			fireEvent.click(screen.getByRole("link", { name: "Linked JPG" }));
			expect(screen.getByRole("dialog")).toBeTruthy();
			setLocation(part, `${location[part]}changed`);
			await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
		},
	);
	it("restores a recycled opener to its originating timeline", async () => {
		render(() => <Example />);
		const origin = screen.getByRole("region", { name: "Thread timeline" });
		screen.getByRole("link", { name: "Linked JPG" }).focus();
		await userEvent.keyboard("{Enter}");
		screen.getByTestId("opener-row").remove();
		await userEvent.keyboard("{Escape}");
		await expect.poll(() => document.activeElement).toBe(origin);
	});
	it("preserves modified and middle clicks on both entry points", () => {
		const invoke = nativeLinks(true);
		render(() => <Example />);
		for (const label of ["Linked JPG", "Link preview: Map"]) {
			const link = screen.getByRole("link", { name: label });
			for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"])
				fireEvent.click(link, { [modifier]: true });
			fireEvent(
				link,
				new MouseEvent("auxclick", {
					button: 1,
					bubbles: true,
					cancelable: true,
				}),
			);
		}
		expect(invoke).toHaveBeenCalledTimes(10);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it.each(["article", "video.other"])(
		"keeps ordinary %s preview cards as one external link",
		async (type) => {
			const invoke = nativeLinks(true);
			const url = "https://example.org/page";
			render(() => (
				<>
					<UrlPreviewCard
						client={client}
						url={url}
						data={{
							type,
							title: "Page",
							image: { mxcUrl: "mxc://server/preview" },
						}}
					/>
					<LinkedImageViewer />
				</>
			));
			expect(screen.getAllByRole("link")).toHaveLength(1);
			await userEvent.click(
				screen.getByRole("link").querySelector("img") as HTMLImageElement,
			);
			expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", { url });
			expect(screen.queryByRole("dialog")).toBeNull();
		},
	);
});
