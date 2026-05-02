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

function normalizeElementCall(raw: unknown): CrustConfig["elementCall"] {
	if (typeof raw !== "object" || raw === null) return { url: "" };
	const obj = raw as Record<string, unknown>;
	return {
		url: typeof obj.url === "string" ? obj.url : "",
	};
}

function normalizeBranding(raw: unknown): CrustConfig["branding"] {
	if (typeof raw !== "object" || raw === null) {
		return { name: "Crust", logoUrl: "/favicon.svg", primaryColor: "#e33e7f" };
	}
	const obj = raw as Record<string, unknown>;
	return {
		name: typeof obj.name === "string" ? obj.name : "Crust",
		logoUrl: typeof obj.logoUrl === "string" ? obj.logoUrl : "/favicon.svg",
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
		homeserverList: Array.isArray(obj.homeserverList)
			? (obj.homeserverList as unknown[]).filter(
					(v): v is string => typeof v === "string",
				)
			: ["matrix.org"],
		allowCustomHomeservers:
			typeof obj.allowCustomHomeservers === "boolean"
				? obj.allowCustomHomeservers
				: true,
		elementCall: normalizeElementCall(obj.elementCall),
		gif: normalizeGifConfig(obj.gif),
		branding: normalizeBranding(obj.branding),
	};
}
