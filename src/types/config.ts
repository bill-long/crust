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

/**
 * Build-time override for `remoteConfigUrl`, mirroring the VITE_GIF_* pattern
 * above.
 *
 * The shipped public/config.json leaves the field EMPTY on purpose. That file
 * doubles as the starting template operators copy (deploy/README.md), and a
 * baked-in upstream URL would mean any fork's desktop build fetched upstream's
 * homeserver list, GIF key and push gateway - silently overriding the
 * operator's own. So the value is opt-in, and upstream's own installers get it
 * from the desktop release workflow rather than from the template.
 */
function applyRemoteConfigUrlOverride(base: string): string {
	const env = import.meta.env as Record<string, string | undefined>;
	const raw = env.VITE_REMOTE_CONFIG_URL;
	if (typeof raw !== "string" || raw.trim().length === 0) return base;
	// An invalid override warns (inside normalizeRemoteConfigUrl) and leaves
	// the configured value alone rather than blanking it.
	return (
		normalizeRemoteConfigUrl(
			raw,
			"VITE_REMOTE_CONFIG_URL (the REMOTE_CONFIG_URL repository variable)",
		) || base
	);
}

export interface CrustConfig {
	defaultHomeserver: string;
	homeserverList: string[];
	allowCustomHomeservers: boolean;
	/**
	 * Where to fetch the live operator config from, overriding this bundled
	 * copy. Only the native desktop shell uses it: a browser already loads
	 * config.json from the deployment that serves it, but the desktop app
	 * embeds dist/ at build time and would otherwise be stuck with whatever
	 * public/config.json held when the installer was cut (see #580).
	 *
	 * Empty (the default) means "use the bundled copy as-is".
	 */
	remoteConfigUrl: string;
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

/**
 * Whether `url` is a secure origin: https://, or http:// on loopback, which
 * browsers treat as a secure context per the W3C Secure Contexts spec (so
 * local dev setups still work).
 *
 * Shared by every config URL that must not be fetched or embedded over
 * plaintext - `elementCall.url` needs a secure context for camera/mic, and
 * `remoteConfigUrl` carries the GIF API key and push VAPID key over the wire.
 * Defined once here so the two can never drift apart.
 */
function isSecureOriginUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === "https:") return true;
	if (parsed.protocol !== "http:") return false;
	const host = parsed.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]") return true;
	// Allow the full IPv4 127.0.0.0/8 loopback range. Validate octet ranges
	// (0-255) so strings like `127.999.999.999` are rejected - URL parsers
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

function isSecureCallUrl(url: string): boolean {
	// Reject any URL containing `?` or `#`. callSrc() appends
	// `/room/#?roomId=...` to this base, so a query string or fragment
	// (including a bare trailing `?` or `#`, which the URL parser
	// normalizes to empty `search`/`hash`) would corrupt the resulting
	// URL. This is specific to how the call URL is consumed, which is why
	// it layers on top of isSecureOriginUrl rather than living inside it.
	if (url.includes("?") || url.includes("#")) return false;
	return isSecureOriginUrl(url);
}

/**
 * A remote config URL is optional; an unset or malformed one just means the
 * bundled config stands. Rejecting a plaintext URL matters because the file
 * it points at carries the operator's GIF API key and push VAPID key.
 *
 * Note that a packaged desktop build can only reach an https:// URL: the
 * shipped CSP allows `connect-src ... https:` but not plain http:. Loopback
 * is accepted here because `tauri dev` runs under devCsp, which does allow it.
 */
function normalizeRemoteConfigUrl(
	raw: unknown,
	source = "config.remoteConfigUrl",
): string {
	const url = typeof raw === "string" ? raw.trim() : "";
	if (!url) return "";
	if (!isSecureOriginUrl(url)) {
		// Name the source: the build-time override runs through here too, and
		// pointing an operator at config.json when the bad value came from a CI
		// variable sends them to a file that is correct - with, on desktop, a
		// packaged WebView2 shell and no devtools to argue otherwise.
		console.warn(
			`${source} must be https:// or http:// loopback (localhost / 127.0.0.0/8 / [::1]); ignoring:`,
			url,
		);
		return "";
	}
	return url;
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
/**
 * Top-level keys that mark a body as a Crust config. Every one is optional in
 * the schema, so the probe below asks whether a body speaks the vocabulary at
 * all, not whether any particular field is present - requiring a specific key
 * would reject a valid config that every browser client accepts, on the
 * desktop path only, with a console line as the operator's only clue.
 *
 * Lives beside CrustConfig because it mirrors it; a test locks the two
 * together. `remoteConfigUrl` is deliberately absent: it is inert in a served
 * config, so a body carrying nothing else is not one.
 */
export const CONFIG_KEYS = [
	"defaultHomeserver",
	"homeserverList",
	"allowCustomHomeservers",
	"elementCall",
	"gif",
	"push",
	"branding",
] as const;

/**
 * Whether a body is recognisably a Crust config.
 *
 * normalizeConfig() never throws - it coerces anything, including `null`, `[]`
 * or an unrelated object, into a full defaults object pointing at matrix.org.
 * So a caller accepting a fetched body without this check would take a captive
 * portal's JSON error page or a WAF challenge as configuration.
 *
 * Object.hasOwn, not `in`: the question is whether the body itself carries a
 * config key, and `in` would answer yes for anything on the prototype chain.
 */
export function looksLikeCrustConfig(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return false;
	}
	return CONFIG_KEYS.some((key) =>
		Object.hasOwn(raw as Record<string, unknown>, key),
	);
}

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
		remoteConfigUrl: applyRemoteConfigUrlOverride(
			normalizeRemoteConfigUrl(obj.remoteConfigUrl),
		),
		elementCall: normalizeElementCall(obj.elementCall),
		gif: normalizeGifConfig(obj.gif),
		push: normalizePush(obj.push),
		branding: normalizeBranding(obj.branding),
	};
}
