import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { ImageLightbox, type LightboxImage } from "./ImageLightbox";

function mkImage(overrides: Partial<LightboxImage> = {}): LightboxImage {
	return {
		eventId: "$evt1",
		fullUrl: "https://example.com/img.png",
		mimetype: "image/png",
		size: 1234,
		filename: "kitten.png",
		width: 200,
		height: 100,
		senderName: "Alice",
		timestamp: 1_700_000_000_000,
		isEncrypted: false,
		encryptedFile: null,
		...overrides,
	};
}

function setup(
	opts: {
		image?: LightboxImage | null;
		hasPrev?: boolean;
		hasNext?: boolean;
	} = {},
) {
	const [open, setOpen] = createSignal(true);
	const [image, setImage] = createSignal<LightboxImage | null>(
		opts.image ?? mkImage(),
	);
	const onClose = vi.fn(() => setOpen(false));
	const onPrev = vi.fn();
	const onNext = vi.fn();

	render(() => (
		<ImageLightbox
			open={open}
			onClose={onClose}
			image={image}
			onPrev={onPrev}
			onNext={onNext}
			hasPrev={() => !!opts.hasPrev}
			hasNext={() => !!opts.hasNext}
		/>
	));

	return { onClose, onPrev, onNext, setOpen, setImage };
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** A structurally-valid EncryptedFile descriptor (not used for real crypto here). */
const SAMPLE_ENCRYPTED_FILE = {
	url: "mxc://example.com/ciphertext",
	key: { k: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
	iv: "AAAAAAAAAAAAAAAAAAAAAA==",
	hashes: { sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
	v: "v2",
};

describe("ImageLightbox", () => {
	it("renders the image and metadata when open", () => {
		setup();
		expect(screen.getByRole("dialog")).toBeTruthy();
		const img = screen.getByAltText("kitten.png") as HTMLImageElement;
		expect(img.src).toContain("img.png");
		// Metadata strip
		expect(screen.getByText("Alice")).toBeTruthy();
		// Filename appears in header title
		const titles = screen.getAllByText("kitten.png");
		expect(titles.length).toBeGreaterThan(0);
	});

	it("does not render when closed", () => {
		const [open, _setOpen] = createSignal(false);
		render(() => (
			<ImageLightbox open={open} onClose={() => {}} image={() => mkImage()} />
		));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("Close button calls onClose", () => {
		const { onClose } = setup();
		fireEvent.click(screen.getByLabelText("Close"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("Escape key closes", () => {
		const { onClose } = setup();
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("ArrowRight calls onNext when hasNext is true", () => {
		const { onNext } = setup({ hasNext: true });
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
		expect(onNext).toHaveBeenCalledTimes(1);
	});

	it("ArrowLeft calls onPrev when hasPrev is true", () => {
		const { onPrev } = setup({ hasPrev: true });
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
		expect(onPrev).toHaveBeenCalledTimes(1);
	});

	it("ArrowRight is a no-op when hasNext is false", () => {
		const { onNext } = setup({ hasNext: false });
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
		expect(onNext).not.toHaveBeenCalled();
	});

	it("Prev/Next nav buttons only render when has* is true", () => {
		setup({ hasPrev: false, hasNext: true });
		expect(screen.queryByLabelText("Previous image")).toBeNull();
		expect(screen.getByLabelText("Next image")).toBeTruthy();
	});

	it("Download button is disabled while an encrypted image is decrypting", () => {
		// Hold the ciphertext fetch open so the decrypt stays in-flight.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		setup({
			image: mkImage({
				isEncrypted: true,
				encryptedFile: SAMPLE_ENCRYPTED_FILE,
			}),
		});
		const btn = screen.getByLabelText("Download image") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.title).toMatch(/Decrypting/);
	});

	it("Encrypted image shows a decrypting state, not a ciphertext <img>", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		setup({
			image: mkImage({
				isEncrypted: true,
				encryptedFile: SAMPLE_ENCRYPTED_FILE,
			}),
		});
		expect(screen.queryByAltText("kitten.png")).toBeNull();
		expect(screen.getByText(/Decrypting/i)).toBeTruthy();
	});

	it("Encrypted image with a missing descriptor fails closed (no ciphertext)", () => {
		// isEncrypted but no usable encryptedFile (malformed content.file): must
		// not render or expose the ciphertext fullUrl anywhere.
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		setup({ image: mkImage({ isEncrypted: true, encryptedFile: null }) });

		expect(screen.queryByAltText("kitten.png")).toBeNull();
		expect(screen.getByText(/couldn't decrypt image/i)).toBeTruthy();
		const btn = screen.getByLabelText("Download image") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(screen.queryByLabelText("Open in new tab")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("'0' resets to fit, '1' zooms to 100%", () => {
		setup();
		const dialog = screen.getByRole("dialog");
		// '1' selects 100%
		fireEvent.keyDown(dialog, { key: "1" });
		// The 100% indicator button text should read "100%"
		expect(screen.getByLabelText("Zoom to 100%").textContent).toBe("100%");
		// '0' resets to fit
		fireEvent.keyDown(dialog, { key: "0" });
		// Fit button reflects the active mode via aria-current
		const fitBtn = screen.getByLabelText("Fit to viewport");
		expect(fitBtn.getAttribute("aria-current")).toBe("true");
	});

	it("Open-in-new-tab anchor has rel=noopener noreferrer", () => {
		setup();
		const a = screen.getByLabelText("Open in new tab") as HTMLAnchorElement;
		expect(a.getAttribute("rel")).toBe("noopener noreferrer");
		expect(a.getAttribute("target")).toBe("_blank");
	});

	it("Open-in-new-tab is hidden while an encrypted image is decrypting", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		setup({
			image: mkImage({
				isEncrypted: true,
				encryptedFile: SAMPLE_ENCRYPTED_FILE,
			}),
		});
		expect(screen.queryByLabelText("Open in new tab")).toBeNull();
	});
});
