import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	loadSessions,
	MAX_ACCOUNTS,
	type Session,
	saveSession,
	unfreezeAccountScope,
} from "../../stores/session";
import { mockLoginLocks } from "../../test/loginLocks";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const complete = vi.fn();
const revoke = vi.fn(async (_session: Session) => {});
const navigate = vi.fn();
const assign = vi.fn();
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }));
vi.mock("../../client/accountLogout", () => ({
	revokeAccountToken: (session: Session) => revoke(session),
}));
vi.mock("./oidc", () => ({
	completeOidcLogin: () => complete(),
	takeOidcReturnTo: () => "/",
	takeOidcAddAccount: () => false,
}));

import { LoginCallback } from "./LoginCallback";

const alice: Session = {
	userId: "@alice:example.org",
	deviceId: "A",
	accessToken: "alice-token",
	homeserverUrl: "https://example.org",
};
const bob: Session = {
	...alice,
	userId: "@bob:example.org",
	deviceId: "B",
	accessToken: "bob-token",
	refreshToken: "refresh",
	oidc: { issuer: "https://example.org", clientId: "client" },
};
beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	unfreezeAccountScope();
	mockLoginLocks();
	vi.stubGlobal("location", { search: "?code=test", assign });
	vi.clearAllMocks();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	unfreezeAccountScope();
});

it("preserves a session added in another tab during the OAuth exchange", async () => {
	let finish!: (session: Session) => void;
	complete.mockReturnValueOnce(
		new Promise<Session>((resolve) => {
			finish = resolve;
		}),
	);
	render(() => <LoginCallback />);
	saveSession(alice);
	finish(bob);
	await waitFor(() => expect(assign).toHaveBeenCalledOnce());
	expect(loadSessions().map((s) => s.userId)).toEqual([
		alice.userId,
		bob.userId,
	]);
	expect(revoke).not.toHaveBeenCalled();
	expect(navigate).not.toHaveBeenCalled();
});

it("revokes a refused OAuth credential and preserves every account at the cap", async () => {
	const existing = Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({
		...alice,
		userId: `@user${i}:example.org`,
	}));
	localStorage.setItem(
		"crust:session",
		JSON.stringify({ activeUserId: existing[0]?.userId, sessions: existing }),
	);
	complete.mockResolvedValueOnce(bob);
	render(() => <LoginCallback />);
	await screen.findByText(/accounts at once/);
	expect(loadSessions()).toHaveLength(MAX_ACCOUNTS);
	expect(revoke).toHaveBeenCalledExactlyOnceWith(bob);
	expect(assign).not.toHaveBeenCalled();
});
