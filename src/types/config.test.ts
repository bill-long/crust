import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "./config";

const GIF_ENV_VARS = [
	"VITE_GIF_API_KEY",
	"VITE_GIF_PROVIDER",
	"VITE_GIF_ENABLED",
	"VITE_GIF_TRENDING_ON_OPEN",
	"VITE_GIF_MAX_RATING",
] as const;

const baseGif = {
	enabled: false,
	provider: "giphy",
	apiKey: "",
	trendingOnOpen: true,
	maxRating: "g",
};

describe("normalizeConfig gif env overrides", () => {
	// Clear any VITE_GIF_* values inherited from the developer's shell so
	// these tests behave the same in CI and local dev. Empty strings are
	// treated as "no override" by applyGifEnvOverrides.
	beforeEach(() => {
		for (const name of GIF_ENV_VARS) {
			vi.stubEnv(name, "");
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns config.json values when no env overrides are set", () => {
		const cfg = normalizeConfig({
			gif: { ...baseGif, enabled: true, apiKey: "from-json" },
		});
		expect(cfg.gif.apiKey).toBe("from-json");
		expect(cfg.gif.enabled).toBe(true);
		expect(cfg.gif.provider).toBe("giphy");
	});

	it("overrides apiKey from VITE_GIF_API_KEY", () => {
		vi.stubEnv("VITE_GIF_API_KEY", "from-env");
		const cfg = normalizeConfig({ gif: { ...baseGif, apiKey: "from-json" } });
		expect(cfg.gif.apiKey).toBe("from-env");
	});

	it("ignores empty / whitespace-only VITE_GIF_API_KEY", () => {
		vi.stubEnv("VITE_GIF_API_KEY", "   ");
		const cfg = normalizeConfig({ gif: { ...baseGif, apiKey: "from-json" } });
		expect(cfg.gif.apiKey).toBe("from-json");
	});

	it("trims surrounding whitespace from VITE_GIF_API_KEY", () => {
		vi.stubEnv("VITE_GIF_API_KEY", "  key  ");
		const cfg = normalizeConfig({ gif: { ...baseGif } });
		expect(cfg.gif.apiKey).toBe("key");
	});

	it("overrides enabled from VITE_GIF_ENABLED (true/false/1/0)", () => {
		vi.stubEnv("VITE_GIF_ENABLED", "true");
		expect(
			normalizeConfig({ gif: { ...baseGif, enabled: false } }).gif.enabled,
		).toBe(true);
		vi.stubEnv("VITE_GIF_ENABLED", "0");
		expect(
			normalizeConfig({ gif: { ...baseGif, enabled: true } }).gif.enabled,
		).toBe(false);
	});

	it("ignores invalid VITE_GIF_ENABLED values", () => {
		vi.stubEnv("VITE_GIF_ENABLED", "yes");
		const cfg = normalizeConfig({ gif: { ...baseGif, enabled: false } });
		expect(cfg.gif.enabled).toBe(false);
	});

	it("overrides provider only when value is in the allowlist", () => {
		vi.stubEnv("VITE_GIF_PROVIDER", "klipy");
		expect(normalizeConfig({ gif: { ...baseGif } }).gif.provider).toBe("klipy");
		vi.stubEnv("VITE_GIF_PROVIDER", "tenor");
		expect(normalizeConfig({ gif: { ...baseGif } }).gif.provider).toBe("giphy");
	});

	it("trims surrounding whitespace from VITE_GIF_PROVIDER and VITE_GIF_MAX_RATING", () => {
		vi.stubEnv("VITE_GIF_PROVIDER", "  klipy  ");
		vi.stubEnv("VITE_GIF_MAX_RATING", "  pg  ");
		const cfg = normalizeConfig({ gif: { ...baseGif } });
		expect(cfg.gif.provider).toBe("klipy");
		expect(cfg.gif.maxRating).toBe("pg");
	});

	it("overrides maxRating only when value is in the allowlist", () => {
		vi.stubEnv("VITE_GIF_MAX_RATING", "pg-13");
		expect(normalizeConfig({ gif: { ...baseGif } }).gif.maxRating).toBe(
			"pg-13",
		);
		vi.stubEnv("VITE_GIF_MAX_RATING", "xxx");
		expect(normalizeConfig({ gif: { ...baseGif } }).gif.maxRating).toBe("g");
	});

	it("overrides trendingOnOpen from VITE_GIF_TRENDING_ON_OPEN", () => {
		vi.stubEnv("VITE_GIF_TRENDING_ON_OPEN", "false");
		const cfg = normalizeConfig({ gif: { ...baseGif, trendingOnOpen: true } });
		expect(cfg.gif.trendingOnOpen).toBe(false);
	});

	it("applies env overrides when config.json has no gif section", () => {
		vi.stubEnv("VITE_GIF_API_KEY", "from-env");
		vi.stubEnv("VITE_GIF_ENABLED", "true");
		const cfg = normalizeConfig({});
		expect(cfg.gif.apiKey).toBe("from-env");
		expect(cfg.gif.enabled).toBe(true);
	});
});
