import { afterEach, describe, expect, it, vi } from "vitest";
import capabilities from "../../desktop/src-tauri/capabilities/default.json";
import {
	EXTERNAL_PROTOCOLS,
	openExternalUrl,
	watchExternalLinks,
} from "./externalLinks";

let stop = () => {};
afterEach(() => {
	stop();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function desktop() {
	const invoke = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("isTauri", true);
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
	stop = watchExternalLinks();
	return invoke;
}

describe("external link routing", () => {
	it("keeps native opener permissions in sync with the frontend protocol gate", () => {
		const permission = capabilities.permissions.find(
			(entry) =>
				typeof entry !== "string" &&
				entry.identifier === "opener:allow-open-url",
		);
		if (!permission || typeof permission === "string")
			throw new Error("Missing scoped opener permission");
		expect(
			permission.allow
				.map(({ url }) => url.slice(0, url.indexOf(":") + 1))
				.sort(),
		).toEqual([...EXTERNAL_PROTOCOLS].sort());
	});
	it.each([
		"matrix:u/alice:example.org",
		"tel:+15551234567",
		"xmpp:alice@example.org",
		"geo:1,2",
		"magnet:?xt=urn:btih:example",
	])(
		"opens supported custom link %s after in-app routing declines it",
		(href) => {
			const invoke = desktop();
			const anchor = document.createElement("a");
			anchor.href = href;
			document.body.append(anchor);
			for (const init of [
				{ ctrlKey: true },
				{ metaKey: true },
				{ button: 1 },
			]) {
				anchor.dispatchEvent(
					new MouseEvent(init.button ? "auxclick" : "click", {
						bubbles: true,
						cancelable: true,
						...init,
					}),
				);
			}
			expect(invoke).toHaveBeenCalledTimes(3);
			expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
				url: href,
			});
			const handled = new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
			});
			handled.preventDefault();
			anchor.dispatchEvent(handled);
			expect(invoke).toHaveBeenCalledTimes(3);
		},
	);
	it("opens ordinary and modified desktop links, respecting handled clicks and downloads", () => {
		const invoke = desktop();
		const anchor = document.createElement("a");
		anchor.href = "https://example.org/image.jpg";
		anchor.target = "_blank";
		document.body.append(anchor);
		for (const init of [{}, { ctrlKey: true }, { button: 1 }]) {
			const event = new MouseEvent(init.button ? "auxclick" : "click", {
				bubbles: true,
				cancelable: true,
				...init,
			});
			anchor.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		}
		expect(invoke).toHaveBeenCalledTimes(3);
		const handled = new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
		});
		handled.preventDefault();
		anchor.dispatchEvent(handled);
		anchor.download = "image.jpg";
		anchor.click();
		expect(invoke).toHaveBeenCalledTimes(3);
		expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
			url: anchor.href,
		});
	});
	it("uses a new tab on web and rejects non-browser schemes", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		await openExternalUrl("https://example.org/image.jpg");
		expect(open).toHaveBeenCalledWith(
			"https://example.org/image.jpg",
			"_blank",
			"noopener,noreferrer",
		);
		await expect(openExternalUrl("file:///secret.txt")).rejects.toThrow();
		expect(open).toHaveBeenCalledTimes(1);
	});
	it("propagates native opener failures rather than silently succeeding", async () => {
		const invoke = desktop();
		invoke.mockRejectedValue(new Error("No browser"));
		await expect(openExternalUrl("https://example.org")).rejects.toThrow(
			"No browser",
		);
	});
});
