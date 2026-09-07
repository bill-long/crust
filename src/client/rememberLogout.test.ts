import type { MatrixClient } from "matrix-js-sdk";
import { beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../stores/session";

const remember = vi.fn(async (_session: Session) => {});
const sessions = vi.fn((): Session[] => []);
vi.mock("../stores/logoutResidue", () => ({
	rememberLogoutSession: (session: Session) => remember(session),
}));
vi.mock("../stores/session", () => ({ loadSessions: () => sessions() }));

import { rememberClientLogout } from "./rememberLogout";

const alice: Session = {
	userId: "@alice:example.org",
	deviceId: "A",
	accessToken: "old",
	homeserverUrl: "https://example.org",
};
const client = { getAccessToken: () => "current" } as MatrixClient;
beforeEach(() => {
	remember.mockClear();
	sessions.mockReset();
	sessions.mockReturnValue([]);
});

it("records the outgoing client's refreshed credential, not its stale boot token", async () => {
	const current = { ...alice, accessToken: "current", refreshToken: "refresh" };
	sessions.mockReturnValue([current]);
	await rememberClientLogout(client, alice);
	expect(remember).toHaveBeenCalledExactlyOnceWith(current);
});
it.each([
	{ ...alice, accessToken: "new-tab" },
	{ ...alice, accessToken: "current", deviceId: "NEW" },
	{ ...alice, accessToken: "current", userId: "@bob:example.org" },
	{
		...alice,
		accessToken: "current",
		homeserverUrl: "https://other.example.org",
	},
])(
	"does not authorize replacement of an unrelated stored session",
	async (stored) => {
		sessions.mockReturnValue([stored]);
		await rememberClientLogout(client, alice);
		expect(remember).not.toHaveBeenCalled();
	},
);
it("does not interrupt logout if recording fails", async () => {
	sessions.mockReturnValue([{ ...alice, accessToken: "current" }]);
	remember.mockRejectedValueOnce(new Error("crypto unavailable"));
	await expect(rememberClientLogout(client, alice)).resolves.toBeUndefined();
});
