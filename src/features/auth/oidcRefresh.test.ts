import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../stores/session";
import { loadSession, loadSessions, saveSession } from "../../stores/session";

// Mock the SDK boundary: a fake TokenRefresher that captures constructor
// args and lets each test script what a refresh yields. What stays under
// test is OUR wiring: lazy construction (metadata fetch + OAuth2 context),
// the password-session no-op, and the identity-guarded persistence.
const oauth2Contexts = vi.hoisted(() => ({
	args: [] as Array<Record<string, unknown>>,
}));
const tokenRefresherInstances = vi.hoisted(() => ({
	instances: [] as Array<{
		auth: unknown;
		onRefresh: (tokens: {
			accessToken: string;
			refreshToken?: string;
		}) => Promise<void>;
	}>,
	nextTokens: { accessToken: "new-access", refreshToken: "new-refresh" } as {
		accessToken: string;
		refreshToken?: string;
	},
}));
const createClientMock = vi.hoisted(() => vi.fn());
vi.mock("matrix-js-sdk", () => ({
	createClient: (...args: unknown[]) => createClientMock(...args),
	OAuth2: class FakeOAuth2 {
		constructor(
			public metadata: unknown,
			public context: Record<string, unknown>,
		) {
			oauth2Contexts.args.push(context);
		}
	},
	TokenRefresher: class FakeTokenRefresher {
		constructor(
			public auth: unknown,
			public onRefresh: (tokens: {
				accessToken: string;
				refreshToken?: string;
			}) => Promise<void>,
		) {
			tokenRefresherInstances.instances.push({ auth, onRefresh });
		}
		tokenRefreshFunction = async (_refreshToken: string) => {
			const tokens = { ...tokenRefresherInstances.nextTokens };
			await this.onRefresh(tokens);
			// Faithful to the real SDK (tokenRefresher.js getNewTokens): the
			// returned refreshToken is undefined when the OP did not rotate it.
			return { ...tokens, refreshToken: tokens.refreshToken };
		};
	},
}));

import { createOidcTokenRefreshFn } from "./oidcRefresh";

const METADATA = {
	issuer: "https://auth.example.com/",
	token_endpoint: "https://auth.example.com/token",
};

const PASSWORD_SESSION: Session = {
	accessToken: "access-old",
	userId: "@alice:example.com",
	deviceId: "DEVICE42",
	homeserverUrl: "https://matrix.example.com",
};

const OIDC_SESSION: Session = {
	...PASSWORD_SESSION,
	refreshToken: "refresh-old",
	oidc: {
		issuer: "https://auth.example.com/",
		clientId: "client-xyz",
	},
};

/** The account persisted for `userId`, or undefined if it is not stored. */
const stored = (userId = PASSWORD_SESSION.userId): Session | undefined =>
	loadSessions().find((session) => session.userId === userId);

beforeEach(() => {
	localStorage.clear();
	oauth2Contexts.args.length = 0;
	tokenRefresherInstances.instances.length = 0;
	tokenRefresherInstances.nextTokens = {
		accessToken: "new-access",
		refreshToken: "new-refresh",
	};
	createClientMock.mockReturnValue({
		getAuthMetadata: vi.fn(async () => METADATA),
	});
});
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("createOidcTokenRefreshFn", () => {
	it("returns undefined for a password session", () => {
		expect(createOidcTokenRefreshFn(PASSWORD_SESSION)).toBeUndefined();
	});

	it("returns undefined when the OIDC session has no refresh token", () => {
		const session: Session = { ...OIDC_SESSION };
		delete session.refreshToken;
		expect(createOidcTokenRefreshFn(session)).toBeUndefined();
	});

	it("builds the SDK refresher lazily on first refresh with the right context", async () => {
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		// Nothing constructed until the first refresh actually fires.
		expect(oauth2Contexts.args).toHaveLength(0);

		const tokens = await fn("refresh-old");

		expect(oauth2Contexts.args).toHaveLength(1);
		expect(oauth2Contexts.args[0]).toEqual({
			clientId: "client-xyz",
			redirectUri: `${window.location.origin}/login/callback`,
		});
		expect(createClientMock).toHaveBeenCalledWith({
			baseUrl: "https://matrix.example.com",
		});
		expect(tokenRefresherInstances.instances).toHaveLength(1);
		expect(tokens.accessToken).toBe("new-access");
		expect(tokens.refreshToken).toBe("new-refresh");
	});

	it("persists rotated tokens back into the stored session on refresh", async () => {
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored()?.refreshToken).toBe("new-refresh");
		// Untouched fields survive the rotation.
		expect(stored()?.userId).toBe("@alice:example.com");
		expect(stored()?.oidc).toEqual(OIDC_SESSION.oidc);
	});

	it("keeps the stored refresh token when the OP does not rotate it", async () => {
		tokenRefresherInstances.nextTokens = { accessToken: "new-access" };
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored()?.refreshToken).toBe("refresh-old");
	});

	it("keeps the stored refresh token when the OP rotates it to empty", async () => {
		// An empty refresh_token is "not rotated", not a new value: storing "" would
		// fail session validation and lose the new access token with it.
		tokenRefresherInstances.nextTokens = {
			accessToken: "new-access",
			refreshToken: "",
		};
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored()?.refreshToken).toBe("refresh-old");
	});

	it("does not persist into a password session that replaced the OIDC one", async () => {
		saveSession(PASSWORD_SESSION);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		expect(stored()?.accessToken).toBe("access-old");
		expect(stored()?.refreshToken).toBeUndefined();
	});

	it("does not persist into a different account's OIDC session", async () => {
		const otherSession: Session = {
			...OIDC_SESSION,
			userId: "@bob:example.com",
			deviceId: "DEVICE99",
		};
		saveSession(otherSession);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		// The refreshing account is not logged in at all any more, so nothing is
		// written - and in particular the account that IS logged in keeps its own
		// tokens rather than being handed another account's.
		expect(stored()).toBeUndefined();
		expect(stored("@bob:example.com")?.accessToken).toBe("access-old");
		expect(stored("@bob:example.com")?.refreshToken).toBe("refresh-old");
	});

	it("persists into its own account while a different one is active", async () => {
		// A refresh can land after the user switched accounts (#532). It belongs
		// to the account it was issued for: that account's tokens are updated,
		// and the active account is neither written to nor switched away from.
		const other: Session = {
			...PASSWORD_SESSION,
			accessToken: "bob-access",
			userId: "@bob:example.com",
			deviceId: "DEVICE99",
		};
		// Two accounts is a state only the switcher (#533) creates, so seed it the
		// way it will be persisted rather than through the single-account login path.
		localStorage.setItem(
			"crust:session",
			JSON.stringify({
				activeUserId: other.userId,
				sessions: [OIDC_SESSION, other],
			}),
		);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored("@bob:example.com")?.accessToken).toBe("bob-access");
		expect(loadSession()?.userId).toBe("@bob:example.com");
	});

	it("does not throw when the session was cleared before a refresh lands", async () => {
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");
		localStorage.clear();

		await expect(fn("refresh-old")).resolves.toBeDefined();
		expect(localStorage.getItem("crust:session")).toBeNull();
		expect(loadSession()).toBeNull();
	});

	it("propagates a metadata-fetch failure as a transient error", async () => {
		createClientMock.mockReturnValue({
			getAuthMetadata: vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		});
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		// Not a TokenRefreshLogoutError: the SDK treats this as transient.
		await expect(fn("refresh-old")).rejects.toThrow("Failed to fetch");
	});
});
