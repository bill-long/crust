import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
}));

const saveSessionMock = vi.fn();
const addSessionMock = vi.fn((..._args: unknown[]) => true);
const revokeAccountTokenMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../client/accountLogout", () => ({
	revokeAccountToken: (...args: unknown[]) => revokeAccountTokenMock(...args),
}));
vi.mock("../../stores/session", () => ({
	saveSession: (...args: unknown[]) => saveSessionMock(...args),
	addSession: (...args: unknown[]) => addSessionMock(...args),
	MAX_ACCOUNTS: 5,
}));

const completeOidcLoginMock = vi.fn();
const takeOidcReturnToMock = vi.fn();
const takeOidcAddAccountMock = vi.fn(() => false);
vi.mock("./oidc", () => ({
	completeOidcLogin: (...args: unknown[]) => completeOidcLoginMock(...args),
	takeOidcReturnTo: () => takeOidcReturnToMock(),
	takeOidcAddAccount: () => takeOidcAddAccountMock(),
}));

import { LoginCallback } from "./LoginCallback";

const GRANT_RESULT = {
	accessToken: "access-123",
	refreshToken: "refresh-abc",
	userId: "@alice:strange.pizza",
	deviceId: "DEVICE42",
	homeserverUrl: "https://strange.pizza",
	oidc: {
		issuer: "https://strange.pizza/",
		clientId: "client-xyz",
	},
};

beforeEach(() => {
	takeOidcReturnToMock.mockReturnValue(null);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("LoginCallback", () => {
	it("persists the session and navigates home on success", async () => {
		completeOidcLoginMock.mockResolvedValue(GRANT_RESULT);
		render(() => <LoginCallback />);

		expect(completeOidcLoginMock).toHaveBeenCalledWith(window.location.search);
		await waitFor(() =>
			expect(saveSessionMock).toHaveBeenCalledWith({
				accessToken: "access-123",
				refreshToken: "refresh-abc",
				userId: "@alice:strange.pizza",
				deviceId: "DEVICE42",
				homeserverUrl: "https://strange.pizza",
				oidc: GRANT_RESULT.oidc,
			}),
		);
		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
		);
	});

	it("returns to the stashed deep-link target on success", async () => {
		completeOidcLoginMock.mockResolvedValue(GRANT_RESULT);
		takeOidcReturnToMock.mockReturnValue("/home/!room:strange.pizza");
		render(() => <LoginCallback />);

		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith("/home/!room:strange.pizza", {
				replace: true,
			}),
		);
	});

	it("sanitizes a tampered stash back to home", async () => {
		completeOidcLoginMock.mockResolvedValue(GRANT_RESULT);
		takeOidcReturnToMock.mockReturnValue("https://evil.example/phish");
		render(() => <LoginCallback />);

		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
		);
	});

	it("shows the failure and offers a way back to login", async () => {
		completeOidcLoginMock.mockRejectedValue(
			new Error("Login failed: User refused (access_denied)."),
		);
		render(() => <LoginCallback />);

		await screen.findByText("Login failed: User refused (access_denied).");
		expect(saveSessionMock).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalledWith("/", { replace: true });

		fireEvent.click(screen.getByRole("button", { name: "Back to log in" }));
		expect(navigateMock).toHaveBeenCalledWith("/login", { replace: true });
	});
});

describe("LoginCallback add-account mode", () => {
	it("clears the add-account intent even when the exchange fails", async () => {
		// A flag left armed would turn the NEXT plain OAuth login in this tab
		// into an append, which only the switcher may ask for.
		takeOidcAddAccountMock.mockReturnValueOnce(true);
		completeOidcLoginMock.mockRejectedValueOnce(new Error("bad state"));

		render(() => <LoginCallback />);

		await screen.findByText("bad state");
		expect(takeOidcAddAccountMock).toHaveBeenCalledOnce();
		expect(addSessionMock).not.toHaveBeenCalled();
	});

	it("revokes the new device when the account cap is reached", async () => {
		takeOidcAddAccountMock.mockReturnValueOnce(true);
		addSessionMock.mockReturnValueOnce(false);
		completeOidcLoginMock.mockResolvedValueOnce(GRANT_RESULT);

		render(() => <LoginCallback />);

		await waitFor(() => expect(revokeAccountTokenMock).toHaveBeenCalledOnce());
		// ...and the login is reported rather than silently swallowed.
		await screen.findByText(/accounts at once/);
	});
});
