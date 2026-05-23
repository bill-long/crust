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
	branding: {
		name: string;
		logoUrl: string;
		primaryColor: string;
	};
}

function normalizeElementCall(raw: unknown): CrustConfig["elementCall"] {
	if (typeof raw !== "object" || raw === null) return { url: "" };
	const obj = raw as Record<string, unknown>;
	return {
		url: typeof obj.url === "string" ? obj.url : "",
	};
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
		branding: normalizeBranding(obj.branding),
	};
}
