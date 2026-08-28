import type { Session } from "../stores/session";

/**
 * A logged-in account for tests that render under `ClientContext.Provider`.
 * The context carries the provider's own account (#532) so account-owned
 * storage can only ever be touched for the account on screen; tests that do
 * not exercise that still have to supply one.
 */
export const TEST_SESSION: Session = {
	accessToken: "syt_test_token",
	userId: "@test:example.com",
	deviceId: "TESTDEVICE",
	homeserverUrl: "https://matrix.example.com",
	cryptoPrefix: "crust:@test:example.com",
};
