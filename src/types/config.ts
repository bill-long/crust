export interface CrustConfig {
	defaultHomeserver: string;
	homeserverList: string[];
	allowCustomHomeservers: boolean;
	elementCall: {
		url: string;
	};
	gif: {
		enabled: boolean;
		provider: string;
		apiKey: string;
		trendingOnOpen: boolean;
		maxRating: string;
	};
	branding: {
		name: string;
		logoUrl: string;
		primaryColor: string;
	};
}
