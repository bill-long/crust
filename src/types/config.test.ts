import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIG_KEYS,
	isPushConfigured,
	looksLikeCrustConfig,
	normalizeConfig,
} from "./config";

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

describe("normalizeConfig elementCall url validation", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	function callUrl(url: string): string {
		return normalizeConfig({ elementCall: { url } }).elementCall.url;
	}

	it("accepts https:// URLs", () => {
		expect(callUrl("https://call.example.com")).toBe(
			"https://call.example.com",
		);
		expect(callUrl("https://call.example.com:8443/path")).toBe(
			"https://call.example.com:8443/path",
		);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("accepts loopback http:// URLs (localhost, 127/8, [::1])", () => {
		expect(callUrl("http://localhost")).toBe("http://localhost");
		expect(callUrl("http://localhost:8080/")).toBe("http://localhost:8080/");
		expect(callUrl("http://127.0.0.1")).toBe("http://127.0.0.1");
		expect(callUrl("http://127.0.0.2:3000")).toBe("http://127.0.0.2:3000");
		expect(callUrl("http://127.1.2.3")).toBe("http://127.1.2.3");
		expect(callUrl("http://[::1]")).toBe("http://[::1]");
		expect(callUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("rejects non-loopback http:// URLs", () => {
		expect(callUrl("http://call.example.com")).toBe("");
		expect(callUrl("http://10.0.0.1")).toBe("");
		expect(callUrl("http://192.168.1.1")).toBe("");
		// Hostname containing 'localhost' but not equal to it
		expect(callUrl("http://localhost.evil.com")).toBe("");
		// IPv4 outside 127/8
		expect(callUrl("http://128.0.0.1")).toBe("");
		// Octets out of 0-255 range — these can be reinterpreted by URL
		// parsers as non-loopback hostnames, so reject them.
		expect(callUrl("http://127.999.999.999")).toBe("");
		expect(callUrl("http://127.0.0.256")).toBe("");
		// IPv6 non-loopback
		expect(callUrl("http://[::2]")).toBe("");
	});

	it("rejects dangerous schemes", () => {
		expect(callUrl("javascript:alert(1)")).toBe("");
		expect(callUrl("data:text/html,<script>alert(1)</script>")).toBe("");
		expect(callUrl("file:///etc/passwd")).toBe("");
		expect(callUrl("ws://localhost")).toBe("");
		expect(callUrl("ftp://example.com")).toBe("");
	});

	it("rejects malformed URLs", () => {
		expect(callUrl("not a url")).toBe("");
		expect(callUrl("://broken")).toBe("");
		expect(callUrl("https://")).toBe("");
	});

	it("rejects URLs with a query string or fragment", () => {
		// callSrc() appends `/room/#?roomId=...`; a preset search or hash
		// would corrupt the concatenation (see issue #112).
		expect(callUrl("https://call.example.com?foo=bar")).toBe("");
		expect(callUrl("https://call.example.com/path?foo=bar")).toBe("");
		expect(callUrl("https://call.example.com#frag")).toBe("");
		expect(callUrl("https://call.example.com/path#frag")).toBe("");
		expect(callUrl("http://localhost?x=1")).toBe("");
		expect(callUrl("http://localhost#y")).toBe("");
		// Bare trailing `?` or `#` also corrupts concatenation in
		// callSrc() — the URL parser normalizes these to empty
		// search/hash but the raw string still breaks `${base}/room/...`.
		expect(callUrl("https://call.example.com?")).toBe("");
		expect(callUrl("https://call.example.com#")).toBe("");
	});

	it("treats missing or empty url as no element-call config", () => {
		expect(normalizeConfig({}).elementCall.url).toBe("");
		expect(callUrl("")).toBe("");
		expect(callUrl("   ")).toBe("");
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe("normalizeConfig push", () => {
	it("defaults to an empty (unconfigured) push block", () => {
		const push = normalizeConfig({}).push;
		expect(push).toEqual({ vapidPublicKey: "", gatewayUrl: "", appId: "" });
		expect(isPushConfigured(push)).toBe(false);
	});

	it("reads and trims push fields from config.json", () => {
		const push = normalizeConfig({
			push: {
				vapidPublicKey: "  BHDunEhVBbl  ",
				gatewayUrl: "  https://sygnal.example/_matrix/push/v1/notify  ",
				appId: "  pizza.strange.crust.webpush  ",
			},
		}).push;
		expect(push).toEqual({
			vapidPublicKey: "BHDunEhVBbl",
			gatewayUrl: "https://sygnal.example/_matrix/push/v1/notify",
			appId: "pizza.strange.crust.webpush",
		});
		expect(isPushConfigured(push)).toBe(true);
	});

	it("ignores non-string push fields", () => {
		const push = normalizeConfig({
			push: { vapidPublicKey: 123, gatewayUrl: null, appId: ["x"] },
		}).push;
		expect(push).toEqual({ vapidPublicKey: "", gatewayUrl: "", appId: "" });
	});

	it("is not configured when any field is missing", () => {
		expect(
			isPushConfigured(
				normalizeConfig({ push: { vapidPublicKey: "k", gatewayUrl: "u" } })
					.push,
			),
		).toBe(false);
	});
});

describe("normalizeConfig remoteConfigUrl", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// As with VITE_GIF_*, a value inherited from the developer's shell
		// would override every case below.
		vi.stubEnv("VITE_REMOTE_CONFIG_URL", "");
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	function remoteUrl(raw: unknown): string {
		return normalizeConfig({ remoteConfigUrl: raw }).remoteConfigUrl;
	}

	it("defaults to empty, meaning the bundled config stands", () => {
		expect(normalizeConfig({}).remoteConfigUrl).toBe("");
		expect(remoteUrl(undefined)).toBe("");
		expect(remoteUrl("")).toBe("");
		expect(remoteUrl("   ")).toBe("");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("accepts https:// and loopback http:// URLs", () => {
		expect(remoteUrl("https://example.com/crust/config.json")).toBe(
			"https://example.com/crust/config.json",
		);
		expect(remoteUrl("http://localhost:5173/config.json")).toBe(
			"http://localhost:5173/config.json",
		);
		expect(remoteUrl("http://127.0.0.1/config.json")).toBe(
			"http://127.0.0.1/config.json",
		);
		expect(remoteUrl("http://[::1]/config.json")).toBe(
			"http://[::1]/config.json",
		);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("trims surrounding whitespace", () => {
		expect(remoteUrl("  https://example.com/config.json  ")).toBe(
			"https://example.com/config.json",
		);
	});

	// The file this URL names carries the GIF API key and the push VAPID key,
	// so a plaintext fetch would put both on the wire in clear.
	it("rejects plaintext http:// on a non-loopback host", () => {
		expect(remoteUrl("http://example.com/config.json")).toBe("");
		expect(warnSpy).toHaveBeenCalled();
	});

	it("rejects a host that only looks like loopback", () => {
		expect(remoteUrl("http://127.0.0.1.example.com/config.json")).toBe("");
		expect(remoteUrl("http://127.999.999.999/config.json")).toBe("");
	});

	it("rejects non-http(s) schemes and unparseable values", () => {
		expect(remoteUrl("file:///etc/config.json")).toBe("");
		expect(remoteUrl("javascript:alert(1)")).toBe("");
		expect(remoteUrl("not a url")).toBe("");
		expect(remoteUrl("/crust/config.json")).toBe("");
		expect(remoteUrl(42)).toBe("");
		expect(remoteUrl(null)).toBe("");
	});

	// Unlike elementCall.url, which is rejected for a query or fragment
	// because callSrc() concatenates onto it. Nothing is appended to this
	// URL - it is fetched as-is - so the restriction must not leak across
	// from the secure-origin rule the two now share.
	it("allows a query string or fragment", () => {
		expect(remoteUrl("https://example.com/config.json?v=2")).toBe(
			"https://example.com/config.json?v=2",
		);
		expect(
			normalizeConfig({
				elementCall: { url: "https://call.example.com?v=2" },
			}).elementCall.url,
		).toBe("");
	});
});

describe("normalizeConfig remoteConfigUrl env override", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	// public/config.json ships the field empty so a fork's desktop build never
	// fetches upstream's config; the release workflow supplies the real URL.
	it("supplies a URL the shipped template leaves empty", () => {
		vi.stubEnv("VITE_REMOTE_CONFIG_URL", "https://ops.example.com/c.json");
		expect(normalizeConfig({ remoteConfigUrl: "" }).remoteConfigUrl).toBe(
			"https://ops.example.com/c.json",
		);
	});

	it("wins over a value in config.json", () => {
		vi.stubEnv("VITE_REMOTE_CONFIG_URL", "https://ops.example.com/c.json");
		expect(
			normalizeConfig({ remoteConfigUrl: "https://old.example.com/c.json" })
				.remoteConfigUrl,
		).toBe("https://ops.example.com/c.json");
	});

	it("leaves the configured value alone when unset or blank", () => {
		vi.stubEnv("VITE_REMOTE_CONFIG_URL", "");
		expect(
			normalizeConfig({ remoteConfigUrl: "https://kept.example.com/c.json" })
				.remoteConfigUrl,
		).toBe("https://kept.example.com/c.json");
	});

	// A typo in the build environment must not blank a working configured URL.
	it("warns and keeps the configured value when the override is invalid", () => {
		vi.stubEnv("VITE_REMOTE_CONFIG_URL", "http://insecure.example.com/c.json");
		expect(
			normalizeConfig({ remoteConfigUrl: "https://kept.example.com/c.json" })
				.remoteConfigUrl,
		).toBe("https://kept.example.com/c.json");
		// The message must name the CI variable, not config.json: that file is
		// correct, and on desktop the operator has no devtools to check.
		expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
			"REMOTE_CONFIG_URL repository variable",
		);
	});
});

describe("looksLikeCrustConfig", () => {
	// CONFIG_KEYS is a hand-written mirror of CrustConfig. A key added there
	// and forgotten here would silently narrow what counts as a valid remote
	// body, and the failure would be desktop-only and console-only.
	it("covers every top-level config key except remoteConfigUrl", () => {
		const schemaKeys = Object.keys(normalizeConfig({}))
			.filter((key) => key !== "remoteConfigUrl")
			.sort();
		expect([...CONFIG_KEYS].sort()).toEqual(schemaKeys);
	});

	it("accepts a body carrying any single config key", () => {
		for (const key of CONFIG_KEYS) {
			expect(looksLikeCrustConfig({ [key]: undefined })).toBe(true);
		}
	});

	it("rejects bodies that are not configs", () => {
		expect(looksLikeCrustConfig(null)).toBe(false);
		expect(looksLikeCrustConfig([])).toBe(false);
		expect(looksLikeCrustConfig("ok")).toBe(false);
		expect(looksLikeCrustConfig(42)).toBe(false);
		expect(looksLikeCrustConfig({ error: "blocked" })).toBe(false);
		// remoteConfigUrl alone is inert in a served config, so it is not one.
		expect(looksLikeCrustConfig({ remoteConfigUrl: "https://x/c.json" })).toBe(
			false,
		);
	});

	it("ignores keys that live only on the prototype", () => {
		expect(looksLikeCrustConfig(Object.create({ gif: {} }))).toBe(false);
	});
});
