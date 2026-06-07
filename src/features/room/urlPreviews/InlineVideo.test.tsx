import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineVideo } from "./InlineVideo";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(() => {
	cleanup();
});

describe("InlineVideo", () => {
	it("shows a click-to-load poster, not a video element, initially", () => {
		render(() => <InlineVideo url="https://example.com/clip.mp4" />);
		expect(screen.getByRole("button", { name: "Load video" })).toBeTruthy();
		expect(document.querySelector("video")).toBeNull();
	});

	it("creates the video element only after the user clicks", () => {
		render(() => <InlineVideo url="https://example.com/clip.mp4" />);
		fireEvent.click(screen.getByRole("button", { name: "Load video" }));
		const video = document.querySelector("video");
		expect(video).toBeTruthy();
		expect(video?.getAttribute("src")).toBe("https://example.com/clip.mp4");
		expect(video?.getAttribute("preload")).toBe("none");
		expect(video?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(video?.getAttribute("playsinline")).not.toBeNull();
	});

	it("shows an Open link fallback when the video errors", () => {
		render(() => <InlineVideo url="https://example.com/clip.mp4" />);
		fireEvent.click(screen.getByRole("button", { name: "Load video" }));
		const video = document.querySelector("video");
		expect(video).toBeTruthy();
		fireEvent.error(video as HTMLVideoElement);
		const link = screen.getByRole("link", { name: "Open link" });
		expect(link.getAttribute("href")).toBe("https://example.com/clip.mp4");
	});
});
