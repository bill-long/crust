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
vi.mock("../../stores/session", () => ({
	saveSession: (...args: unknown[]) => saveSessionMock(...args),
}));

const completeOidcLoginMock = vi.fn();
const takeOidcReturnToMock = vi.fn();
vi.mock("./oidc", () => ({
	completeOidcLogin: (...args: unknown[]) => completeOidcLoginMock(...args),
	takeOidcReturnTo: () => takeOidcReturnToMock(),
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
		idToken: "header.payload.signature",
		tokenEndpoint: "https://strange.pizza/token",
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
