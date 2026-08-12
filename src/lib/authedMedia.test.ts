import { describe, expect, it } from "vitest";
import {
	isMediaV3Path,
	supportsAuthedMedia,
	toAuthedMediaUrl,
} from "./authedMedia";

describe("isMediaV3Path", () => {
	it("matches the download and thumbnail prefixes", () => {
		expect(isMediaV3Path("/_matrix/media/v3/download")).toBe(true);
		expect(isMediaV3Path("/_matrix/media/v3/thumbnail")).toBe(true);
		expect(isMediaV3Path("/_matrix/media/v3/thumbnail/matrix.org/abc123")).toBe(
			true,
		);
	});

	it("matches download URLs with a filename suffix", () => {
		expect(
			isMediaV3Path("/_matrix/media/v3/download/matrix.org/abc123/photo.png"),
		).toBe(true);
	});

	it("rejects non-media and non-download/thumbnail paths", () => {
		expect(isMediaV3Path("/_matrix/media/v3/config")).toBe(false);
		expect(isMediaV3Path("/_matrix/media/v3/preview_url")).toBe(false);
		expect(isMediaV3Path("/_matrix/media/v1/download/x/y")).toBe(false);
		expect(isMediaV3Path("/_matrix/client/v1/media/download/x/y")).toBe(false);
		expect(isMediaV3Path("/_matrix/media/v3/downloads")).toBe(false);
		expect(isMediaV3Path("/crust/index.html")).toBe(false);
	});
});

describe("toAuthedMediaUrl", () => {
	const hs = "https://matrix-client.matrix.org";

	it("rewrites a thumbnail URL and preserves the query string", () => {
		expect(
			toAuthedMediaUrl(
				`${hs}/_matrix/media/v3/thumbnail/matrix.org/abc123?width=800&height=800&method=scale&allow_redirect=true`,
				hs,
			),
		).toBe(
			`${hs}/_matrix/client/v1/media/thumbnail/matrix.org/abc123?width=800&height=800&method=scale&allow_redirect=true`,
		);
	});

	it("rewrites a download URL with a filename suffix", () => {
		expect(
			toAuthedMediaUrl(
				`${hs}/_matrix/media/v3/download/matrix.org/abc123/photo.png`,
				hs,
			),
		).toBe(
			`${hs}/_matrix/client/v1/media/download/matrix.org/abc123/photo.png`,
		);
	});

	it("returns null for a media URL on a different origin", () => {
		expect(
			toAuthedMediaUrl(
				"https://matrix.example.com/_matrix/media/v3/thumbnail/x/y?width=64",
				hs,
			),
		).toBeNull();
	});

	it("returns null when only the port differs", () => {
		expect(
			toAuthedMediaUrl(
				"https://matrix-client.matrix.org:8443/_matrix/media/v3/download/x/y",
				hs,
			),
		).toBeNull();
	});

	it("returns null for non-media paths on the homeserver origin", () => {
		expect(
			toAuthedMediaUrl(`${hs}/_matrix/client/v3/sync?timeout=0`, hs),
		).toBeNull();
		expect(toAuthedMediaUrl(`${hs}/_matrix/media/v3/config`, hs)).toBeNull();
	});

	it("returns null for unparseable input", () => {
		expect(toAuthedMediaUrl("not a url", hs)).toBeNull();
		expect(
			toAuthedMediaUrl(`${hs}/_matrix/media/v3/download/x/y`, ""),
		).toBeNull();
	});
});

describe("supportsAuthedMedia", () => {
	it("is true when the versions list includes v1.11", () => {
		expect(supportsAuthedMedia({ versions: ["v1.1", "v1.11", "v1.12"] })).toBe(
			true,
		);
	});

	it("is false when v1.11 is absent", () => {
		expect(supportsAuthedMedia({ versions: ["v1.1", "v1.10"] })).toBe(false);
		expect(supportsAuthedMedia({ versions: [] })).toBe(false);
	});

	it("is false for malformed responses", () => {
		expect(supportsAuthedMedia(null)).toBe(false);
		expect(supportsAuthedMedia(undefined)).toBe(false);
		expect(supportsAuthedMedia({})).toBe(false);
		expect(supportsAuthedMedia({ versions: "v1.11" })).toBe(false);
		expect(supportsAuthedMedia(["v1.11"])).toBe(false);
	});
});
