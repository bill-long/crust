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

function normalizeGifConfig(raw: unknown): GifConfig {
	if (typeof raw !== "object" || raw === null) return { ...defaultGifConfig };
	const obj = raw as Record<string, unknown>;
	return {
		enabled:
			typeof obj.enabled === "boolean" ? obj.enabled : defaultGifConfig.enabled,
		provider: GIF_PROVIDERS.includes(obj.provider as string)
			? (obj.provider as GifProvider)
			: defaultGifConfig.provider,
		apiKey:
			typeof obj.apiKey === "string" ? obj.apiKey : defaultGifConfig.apiKey,
		trendingOnOpen:
			typeof obj.trendingOnOpen === "boolean"
				? obj.trendingOnOpen
				: defaultGifConfig.trendingOnOpen,
		maxRating: GIF_RATINGS.includes(obj.maxRating as string)
			? (obj.maxRating as GifRating)
			: defaultGifConfig.maxRating,
	};
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

/** Apply defaults for missing/malformed fields in operator config. */
export function normalizeConfig(raw: Record<string, unknown>): CrustConfig {
	return {
		defaultHomeserver:
			typeof raw.defaultHomeserver === "string"
				? raw.defaultHomeserver
				: "matrix.org",
		homeserverList: Array.isArray(raw.homeserverList)
			? (raw.homeserverList as string[])
			: ["matrix.org"],
		allowCustomHomeservers:
			typeof raw.allowCustomHomeservers === "boolean"
				? raw.allowCustomHomeservers
				: true,
		elementCall:
			typeof raw.elementCall === "object" && raw.elementCall !== null
				? (raw.elementCall as CrustConfig["elementCall"])
				: { url: "" },
		gif: normalizeGifConfig(raw.gif),
		branding:
			typeof raw.branding === "object" && raw.branding !== null
				? (raw.branding as CrustConfig["branding"])
				: { name: "Crust", logoUrl: "/favicon.svg", primaryColor: "#e33e7f" },
	};
}
