export type GifProvider = "giphy" | "klipy";
export type GifRating = "g" | "pg" | "pg-13" | "r";

export interface GifConfig {
	enabled: boolean;
	provider: GifProvider;
	apiKey: string;
	trendingOnOpen: boolean;
	maxRating: GifRating;
}

const GIF_PROVIDERS: readonly string[] = ["giphy", "klipy"];
const GIF_RATINGS: readonly string[] = ["g", "pg", "pg-13", "r"];

const defaultGifConfig: GifConfig = {
	enabled: false,
	provider: "giphy",
	apiKey: "",
	trendingOnOpen: true,
	maxRating: "g",
};

function parseEnvBool(raw: string | undefined): boolean | undefined {
	if (typeof raw !== "string") return undefined;
	const v = raw.trim().toLowerCase();
	if (v === "true" || v === "1") return true;
	if (v === "false" || v === "0") return false;
	return undefined;
}

/**
 * Apply VITE_GIF_* env var overrides on top of the operator's config.json.
 * Intended for local development: put VITE_GIF_API_KEY=... in .env.local
 * (gitignored) instead of editing config.json. Vite inlines these at build
 * time, so setting them during `pnpm build` will bake values into the bundle.
 */
function applyGifEnvOverrides(base: GifConfig): GifConfig {
	const env = import.meta.env as Record<string, string | undefined>;
	const result: GifConfig = { ...base };

	const apiKey = env.VITE_GIF_API_KEY;
	if (typeof apiKey === "string" && apiKey.trim().length > 0) {
		result.apiKey = apiKey.trim();
	}

	const provider = env.VITE_GIF_PROVIDER?.trim();
	if (typeof provider === "string" && GIF_PROVIDERS.includes(provider)) {
		result.provider = provider as GifProvider;
	}

	const enabled = parseEnvBool(env.VITE_GIF_ENABLED);
	if (enabled !== undefined) result.enabled = enabled;

	const trending = parseEnvBool(env.VITE_GIF_TRENDING_ON_OPEN);
	if (trending !== undefined) result.trendingOnOpen = trending;

	const maxRating = env.VITE_GIF_MAX_RATING?.trim();
	if (typeof maxRating === "string" && GIF_RATINGS.includes(maxRating)) {
		result.maxRating = maxRating as GifRating;
	}

	return result;
}

function normalizeGifConfig(raw: unknown): GifConfig {
	const base: GifConfig =
		typeof raw !== "object" || raw === null
			? { ...defaultGifConfig }
			: (() => {
					const obj = raw as Record<string, unknown>;
					return {
						enabled:
							typeof obj.enabled === "boolean"
								? obj.enabled
								: defaultGifConfig.enabled,
						provider: GIF_PROVIDERS.includes(obj.provider as string)
							? (obj.provider as GifProvider)
							: defaultGifConfig.provider,
						apiKey:
							typeof obj.apiKey === "string"
								? obj.apiKey.trim()
								: defaultGifConfig.apiKey,
						trendingOnOpen:
							typeof obj.trendingOnOpen === "boolean"
								? obj.trendingOnOpen
								: defaultGifConfig.trendingOnOpen,
						maxRating: GIF_RATINGS.includes(obj.maxRating as string)
							? (obj.maxRating as GifRating)
							: defaultGifConfig.maxRating,
					};
				})();
	return applyGifEnvOverrides(base);
}

export interface CrustConfig {
	defaultHomeserver: string;
	homeserverList: string[];
	allowCustomHomeservers: boolean;
	elementCall: {
		url: string;
	};
	gif: GifConfig;
	push: PushConfig;
	branding: {
		name: string;
		logoUrl: string;
		primaryColor: string;
	};
}

export interface PushConfig {
	/**
	 * VAPID application server public key (the "Application Server Key" emitted
	 * by `vapid --gen --applicationServerKey`), as an unpadded URL-safe base64
	 * string. Required for the browser to subscribe to Web Push.
	 */
	vapidPublicKey: string;
	/**
	 * Full URL of the Sygnal push gateway's notify endpoint, e.g.
	 * `https://strange.pizza/_matrix/push/v1/notify`. The homeserver POSTs
	 * notifications here; the client passes it as the pusher `data.url`.
	 */
	gatewayUrl: string;
	/**
	 * Pusher `app_id` — must exactly match the key under `apps:` in the
	 * operator's `sygnal.yaml` for the webpush pushkin.
	 */
	appId: string;
}

const defaultPushConfig: PushConfig = {
	vapidPublicKey: "",
	gatewayUrl: "",
	appId: "",
};

function normalizePush(raw: unknown): PushConfig {
	if (typeof raw !== "object" || raw === null) {
		return { ...defaultPushConfig };
	}
	const obj = raw as Record<string, unknown>;
	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return {
		vapidPublicKey: str(obj.vapidPublicKey),
		gatewayUrl: str(obj.gatewayUrl),
		appId: str(obj.appId),
	};
}

/** Whether the operator has supplied everything needed for Web Push. */
export function isPushConfigured(push: PushConfig): boolean {
	return (
		push.vapidPublicKey !== "" && push.gatewayUrl !== "" && push.appId !== ""
	);
}

function normalizeElementCall(raw: unknown): CrustConfig["elementCall"] {
	if (typeof raw !== "object" || raw === null) return { url: "" };
	const obj = raw as Record<string, unknown>;
	const rawUrl = typeof obj.url === "string" ? obj.url.trim() : "";
	// Element Call's media APIs (camera, microphone, display-capture) only
	// work in a secure context. Allow https:// and loopback http:// (which
	// browsers treat as secure per the W3C Secure Contexts spec, so local
	// EC dev setups still work). Reject everything else, plus any URL that
	// carries a query string or fragment — callSrc() builds the iframe URL
	// by appending `/room/#?roomId=...` to this base, and either a preset
	// search or hash would corrupt that concatenation (e.g. `?foo=bar` keeps
	// `/room/` inside `search` rather than `pathname`, and a `#frag` nests
	// the roomId fragment inside the existing one).
	if (rawUrl && !isSecureCallUrl(rawUrl)) {
		console.warn(
			"config.elementCall.url must be https:// or http:// loopback (localhost / 127.0.0.0/8 / [::1]) with no query string or fragment; ignoring:",
			rawUrl,
		);
		return { url: "" };
	}
	return { url: rawUrl };
}

function isSecureCallUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	// Reject any URL containing `?` or `#`. callSrc() appends
	// `/room/#?roomId=...` to this base, so a query string or fragment
	// (including a bare trailing `?` or `#`, which the URL parser
	// normalizes to empty `search`/`hash`) would corrupt the resulting
	// URL.
	if (url.includes("?") || url.includes("#")) return false;
	if (parsed.protocol === "https:") return true;
	if (parsed.protocol !== "http:") return false;
	const host = parsed.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]") return true;
	// Allow the full IPv4 127.0.0.0/8 loopback range. Validate octet ranges
	// (0–255) so strings like `127.999.999.999` are rejected — URL parsers
	// can treat those as hostnames rather than loopback IPs, which would
	// defeat the loopback-HTTP secure-context exception.
	const m = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	for (let i = 1; i <= 3; i++) {
		const oct = Number(m[i]);
		if (oct < 0 || oct > 255) return false;
	}
	return true;
}

function normalizeBranding(raw: unknown): CrustConfig["branding"] {
	const defaultLogoUrl = `${import.meta.env.BASE_URL}favicon.svg`;
	if (typeof raw !== "object" || raw === null) {
		return { name: "Crust", logoUrl: defaultLogoUrl, primaryColor: "#e33e7f" };
	}
	const obj = raw as Record<string, unknown>;
	return {
		name: typeof obj.name === "string" ? obj.name : "Crust",
		logoUrl: typeof obj.logoUrl === "string" ? obj.logoUrl : defaultLogoUrl,
		primaryColor:
			typeof obj.primaryColor === "string" ? obj.primaryColor : "#e33e7f",
	};
}

/** Apply defaults for missing/malformed fields in operator config. */
export function normalizeConfig(raw: unknown): CrustConfig {
	if (typeof raw !== "object" || raw === null) {
		return normalizeConfig({});
	}
	const obj = raw as Record<string, unknown>;
	return {
		defaultHomeserver:
			typeof obj.defaultHomeserver === "string"
				? obj.defaultHomeserver
				: "matrix.org",
		homeserverList: (() => {
			if (!Array.isArray(obj.homeserverList)) return ["matrix.org"];
			const filtered = (obj.homeserverList as unknown[]).filter(
				(v): v is string => typeof v === "string",
			);
			return filtered.length > 0 ? filtered : ["matrix.org"];
		})(),
		allowCustomHomeservers:
			typeof obj.allowCustomHomeservers === "boolean"
				? obj.allowCustomHomeservers
				: true,
		elementCall: normalizeElementCall(obj.elementCall),
		gif: normalizeGifConfig(obj.gif),
		push: normalizePush(obj.push),
		branding: normalizeBranding(obj.branding),
	};
}
