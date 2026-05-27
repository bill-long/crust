import { describe, expect, it } from "vitest";
import { buildFallbackLivekitFoci } from "./discoverFoci";

describe("buildFallbackLivekitFoci", () => {
	it("derives the lk-jwt-service URL from the Element Call URL", () => {
		const foci = buildFallbackLivekitFoci(
			"https://call.example.com",
			"!room:example.com",
		);
		expect(foci).toEqual([
			{
				type: "livekit",
				livekit_service_url: "https://call.example.com/livekit/sfu/get",
				livekit_alias: "!room:example.com",
			},
		]);
	});

	it("strips trailing slashes before appending the service path", () => {
		const foci = buildFallbackLivekitFoci(
			"https://call.example.com///",
			"!a:b",
		);
		expect(foci[0]?.livekit_service_url).toBe(
			"https://call.example.com/livekit/sfu/get",
		);
	});

	it("returns an empty list when the EC URL is missing or whitespace", () => {
		expect(buildFallbackLivekitFoci("", "!r:s")).toEqual([]);
		expect(buildFallbackLivekitFoci("   ", "!r:s")).toEqual([]);
	});

	it("trims the EC URL before building the focus", () => {
		const foci = buildFallbackLivekitFoci(
			"  https://call.example.com  ",
			"!r:s",
		);
		expect(foci[0]?.livekit_service_url).toBe(
			"https://call.example.com/livekit/sfu/get",
		);
	});
});
