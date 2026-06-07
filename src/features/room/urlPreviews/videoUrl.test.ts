import { describe, expect, it } from "vitest";
import { isDirectVideoUrl } from "./videoUrl";

describe("isDirectVideoUrl", () => {
	it("matches common video extensions", () => {
		expect(isDirectVideoUrl("https://example.com/clip.mp4")).toBe(true);
		expect(isDirectVideoUrl("https://example.com/clip.m4v")).toBe(true);
		expect(isDirectVideoUrl("https://example.com/clip.webm")).toBe(true);
		expect(isDirectVideoUrl("https://example.com/clip.ogv")).toBe(true);
		expect(isDirectVideoUrl("https://example.com/clip.ogg")).toBe(true);
		expect(isDirectVideoUrl("https://example.com/clip.mov")).toBe(true);
	});

	it("ignores the query string (signed/expiring CDN links)", () => {
		expect(
			isDirectVideoUrl(
				"https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=abc&is=def&hm=123",
			),
		).toBe(true);
	});

	it("ignores the fragment", () => {
		expect(isDirectVideoUrl("https://example.com/clip.mp4#t=10")).toBe(true);
	});

	it("is case-insensitive on the extension", () => {
		expect(isDirectVideoUrl("https://example.com/CLIP.MP4")).toBe(true);
		expect(isDirectVideoUrl("https://example.com/Clip.WebM")).toBe(true);
	});

	it("matches nested paths", () => {
		expect(isDirectVideoUrl("https://example.com/a/b/c/movie.mp4")).toBe(true);
	});

	it("rejects non-video URLs", () => {
		expect(isDirectVideoUrl("https://example.com/page")).toBe(false);
		expect(isDirectVideoUrl("https://example.com/image.png")).toBe(false);
		expect(isDirectVideoUrl("https://youtube.com/watch?v=abc")).toBe(false);
	});

	it("does not match the extension in the query string only", () => {
		expect(isDirectVideoUrl("https://example.com/play?file=clip.mp4")).toBe(
			false,
		);
	});

	it("rejects non-https schemes", () => {
		expect(isDirectVideoUrl("http://example.com/clip.mp4")).toBe(false);
		expect(isDirectVideoUrl("ftp://example.com/clip.mp4")).toBe(false);
		expect(isDirectVideoUrl("data:video/mp4;base64,AAAA")).toBe(false);
	});

	it("rejects malformed input", () => {
		expect(isDirectVideoUrl("not a url")).toBe(false);
		expect(isDirectVideoUrl("")).toBe(false);
	});
});
