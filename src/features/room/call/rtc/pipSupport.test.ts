import { describe, expect, it } from "vitest";
import { getDocumentPip, isDocumentPipSupported } from "./pipSupport";

describe("pipSupport", () => {
	it("reports unsupported when the API is absent", () => {
		expect(isDocumentPipSupported()).toBe(false);
		expect(getDocumentPip()).toBeNull();
	});

	it("reports unsupported when documentPictureInPicture lacks requestWindow", () => {
		(
			window as unknown as { documentPictureInPicture: unknown }
		).documentPictureInPicture = {};
		try {
			expect(isDocumentPipSupported()).toBe(false);
			expect(getDocumentPip()).toBeNull();
		} finally {
			delete (window as unknown as { documentPictureInPicture?: unknown })
				.documentPictureInPicture;
		}
	});

	it("reports supported and returns the global when requestWindow exists", () => {
		const fake = { requestWindow: () => Promise.resolve({} as Window) };
		(
			window as unknown as { documentPictureInPicture: unknown }
		).documentPictureInPicture = fake;
		try {
			expect(isDocumentPipSupported()).toBe(true);
			expect(getDocumentPip()).toBe(fake);
		} finally {
			delete (window as unknown as { documentPictureInPicture?: unknown })
				.documentPictureInPicture;
		}
	});
});
