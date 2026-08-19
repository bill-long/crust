import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createRoot, createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "../components/Avatar";
import { createFailedImageUrls, createImageFallback } from "./imageFallback";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

describe("createFailedImageUrls", () => {
	it("blocks a url for every row that renders it", () => {
		createRoot((dispose) => {
			const broken = createFailedImageUrls();
			expect(broken.failed("https://example.com/a.png")).toBe(false);

			broken.markFailed("https://example.com/a.png");

			expect(broken.failed("https://example.com/a.png")).toBe(true);
			// Other urls are unaffected, and a missing url is never "failed".
			expect(broken.failed("https://example.com/b.png")).toBe(false);
			expect(broken.failed(null)).toBe(false);
			dispose();
		});
	});

	it("clears a block when the url loads", () => {
		createRoot((dispose) => {
			const broken = createFailedImageUrls();
			const url = "https://example.com/a.png";
			broken.markFailed(url);

			broken.markLoaded(url);

			expect(broken.failed(url)).toBe(false);
			dispose();
		});
	});
});

describe("createImageFallback", () => {
	it("fails closed on error and recovers when the url changes", () => {
		createRoot((dispose) => {
			const [url, setUrl] = createSignal<string | null>(
				"https://example.com/broken.png",
			);
			const avatar = createImageFallback(url);
			expect(avatar.failed()).toBe(false);

			avatar.onError();
			expect(avatar.failed()).toBe(true);

			// A new url was never blocked, so it is attempted.
			setUrl("https://example.com/fresh.png");
			expect(avatar.failed()).toBe(false);
			dispose();
		});
	});

	it("shares state through the registry it is given", () => {
		createRoot((dispose) => {
			const broken = createFailedImageUrls();
			const url = "https://example.com/a.png";
			const rowA = createImageFallback(() => url, broken);
			const rowB = createImageFallback(() => url, broken);

			rowA.onError();

			// The second row renders the same url, so it fails closed too - and
			// keeps doing so across a remount, since the state is not its own.
			expect(rowB.failed()).toBe(true);
			expect(createImageFallback(() => url, broken).failed()).toBe(true);
			dispose();
		});
	});

	it("keeps private state when no registry is passed", () => {
		createRoot((dispose) => {
			const url = "https://example.com/a.png";
			const rowA = createImageFallback(() => url);
			const rowB = createImageFallback(() => url);

			rowA.onError();

			expect(rowA.failed()).toBe(true);
			expect(rowB.failed()).toBe(false);
			dispose();
		});
	});

	it("attributes a late error to the url the element was loading", () => {
		createRoot((dispose) => {
			const [url, setUrl] = createSignal("https://example.com/old.png");
			const broken = createFailedImageUrls();
			const row = createImageFallback(url, broken);

			// The element is still bound to the old url when its request fails,
			// even though the component has moved on to a new one.
			const img = document.createElement("img");
			img.setAttribute("src", "https://example.com/old.png");
			setUrl("https://example.com/new.png");
			row.onError({ currentTarget: img } as unknown as Event & {
				currentTarget: HTMLImageElement;
			});

			expect(broken.failed("https://example.com/old.png")).toBe(true);
			expect(broken.failed("https://example.com/new.png")).toBe(false);
			dispose();
		});
	});
});

describe("createImageFallback painted-image grace", () => {
	it("keeps an image that already painted when a sibling row errors", () => {
		createRoot((dispose) => {
			const broken = createFailedImageUrls();
			const url = "https://example.com/a.png";
			const painted = createImageFallback(() => url, broken);
			const inFlight = createImageFallback(() => url, broken);

			painted.onLoad();
			inFlight.onError();

			// The row whose image is on screen keeps it; the one that failed
			// falls back, and so does any row that mounts from here on.
			expect(painted.failed()).toBe(false);
			expect(inFlight.failed()).toBe(true);
			expect(createImageFallback(() => url, broken).failed()).toBe(true);
			dispose();
		});
	});

	it("keeps the grace only while bound to the url it painted", () => {
		createRoot((dispose) => {
			const [url, setUrl] = createSignal("https://example.com/a.png");
			const broken = createFailedImageUrls();
			const row = createImageFallback(url, broken);

			row.onLoad();
			// Re-bound to a url this element never painted: the grace does not
			// carry over, so the registry decides.
			setUrl("https://example.com/b.png");
			broken.markFailed("https://example.com/b.png");
			expect(row.failed()).toBe(true);
			dispose();
		});
	});

	it("drops the painted grace when the img itself unmounts", () => {
		const broken = createRoot(() => createFailedImageUrls());
		const url = "https://example.com/a.png";
		const [shown, setShown] = createSignal(true);
		let avatar!: ReturnType<typeof createImageFallback>;

		render(() => {
			avatar = createImageFallback(() => url, broken);
			return (
				<Show when={shown()}>
					{/* biome-ignore lint/a11y/useAltText: stand-in for a real avatar img */}
					<img
						ref={avatar.ref}
						src={url}
						onError={avatar.onError}
						onLoad={avatar.onLoad}
					/>
				</Show>
			);
		});

		avatar.onLoad();
		broken.markFailed(url);
		// Still painted, so this element keeps its image.
		expect(avatar.failed()).toBe(false);

		// Surrounding markup swaps the image out (a call tile switching to
		// video, say). Nothing is painted now, so the block applies again.
		setShown(false);
		expect(avatar.failed()).toBe(true);
		cleanup();
	});
});

describe("Avatar rows sharing a registry", () => {
	afterEach(cleanup);

	it("falls back when a painted row errors on an already-blocked url", () => {
		const url = "https://example.com/a.png";
		const broken = createRoot(() => createFailedImageUrls());
		const { container } = render(() => (
			<>
				<Avatar url={url} initial="A" broken={broken} />
				<Avatar url={url} initial="B" broken={broken} />
			</>
		));
		const images = (): HTMLImageElement[] =>
			Array.from(container.querySelectorAll("img"));
		expect(images()).toHaveLength(2);

		// The first row paints; the second row's request fails and blocks the
		// url for every row that mounts from here on.
		fireEvent.load(images()[0]);
		fireEvent.error(images()[1]);
		expect(images()).toHaveLength(1);

		// Now the painted row's own request fails too. The registry already
		// knows the url is broken, so nothing changes there - this row still
		// has to give up its image.
		fireEvent.error(images()[0]);
		expect(images()).toHaveLength(0);
	});
});

describe("detached elements", () => {
	afterEach(cleanup);

	it("ignores a load reported by an <img> that is no longer mounted", () => {
		const url = "https://example.com/a.png";
		const broken = createRoot(() => createFailedImageUrls());
		const { container } = render(() => (
			<>
				<Avatar url={url} initial="A" broken={broken} />
				<Avatar url={url} initial="B" broken={broken} />
			</>
		));
		const images = (): HTMLImageElement[] =>
			Array.from(container.querySelectorAll("img"));
		const stale = images()[1];

		// One row errors, which retires the image on both rows.
		fireEvent.error(images()[0]);
		expect(images()).toHaveLength(0);

		// The other row's request completes afterwards. Removing an <img>
		// neither aborts it nor detaches the handler, so the event still
		// arrives - but acting on it would un-block the url and re-create every
		// image the error just retired.
		fireEvent.load(stale);

		expect(broken.failed(url)).toBe(true);
		expect(images()).toHaveLength(0);
	});
});
