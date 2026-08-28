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
const locationState: { value: unknown } = { value: null };
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useLocation: () => ({
		pathname: "/login",
		search: "",
		hash: "",
		get state() {
			return locationState.value;
		},
	}),
	useParams: () => ({}),
}));

vi.mock("../../app/ConfigProvider", () => ({
	useConfig: () => ({ defaultHomeserver: "strange.pizza" }),
}));

// matrix-js-sdk boundary: each test scripts the temporary unauthenticated
// client's loginFlows / getAuthMetadata / loginRequest.
const loginFlowsMock = vi.fn();
const getAuthMetadataMock = vi.fn();
const loginRequestMock = vi.fn();
vi.mock("matrix-js-sdk", () => ({
	createClient: () => ({
		loginFlows: loginFlowsMock,
		getAuthMetadata: getAuthMetadataMock,
		loginRequest: loginRequestMock,
	}),
}));

// Keep the real probe/registration-cache logic; stub only the two flow
// entry points that would navigate the page or hit the OP.
const startOidcLoginMock = vi.fn();
const stashOidcReturnToMock = vi.fn();
const stashOidcAddAccountMock = vi.fn();
const revokeAccountTokenMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../client/accountLogout", () => ({
	revokeAccountToken: (...args: unknown[]) => revokeAccountTokenMock(...args),
}));
vi.mock("./oidc", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./oidc")>();
	return {
		...actual,
		startOidcLogin: (...args: unknown[]) => startOidcLoginMock(...args),
		stashOidcReturnTo: (...args: unknown[]) => stashOidcReturnToMock(...args),
		stashOidcAddAccount: () => stashOidcAddAccountMock(),
	};
});

import {
	loadSession,
	loadSessions,
	MAX_ACCOUNTS,
	type Session,
	saveSession,
} from "../../stores/session";
import { LoginPage } from "./LoginPage";

const METADATA = {
	issuer: "https://strange.pizza/",
	authorization_endpoint: "https://strange.pizza/authorize",
	token_endpoint: "https://strange.pizza/token",
	revocation_endpoint: "https://strange.pizza/revoke",
	registration_endpoint: "https://strange.pizza/register",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
};

const assignMock = vi.fn();

beforeEach(() => {
	locationState.value = null;
	localStorage.clear();
	sessionStorage.clear();
	// discoverHomeserver's .well-known lookup fails fast so the discovered
	// base URL is the direct https://<server> fallback.
	vi.stubGlobal("fetch", async () => {
		throw new Error("no well-known in tests");
	});
	// jsdom navigation is a noisy no-op; capture it instead.
	vi.stubGlobal("location", { ...window.location, assign: assignMock });
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

/** Probe result for a server with the given login methods. */
function stubProbe(opts: {
	password?: boolean;
	sso?: boolean;
	delegated?: boolean;
}): void {
	const flows = [
		...(opts.password ? [{ type: "m.login.password" }] : []),
		...(opts.sso ? [{ type: "m.login.sso" }] : []),
	];
	loginFlowsMock.mockResolvedValue({ flows });
	if (opts.delegated) {
		getAuthMetadataMock.mockResolvedValue(METADATA);
	} else {
		getAuthMetadataMock.mockRejectedValue(new Error("no delegated auth"));
	}
}

async function renderAndProbe(): Promise<void> {
	render(() => <LoginPage />);
	fireEvent.submit(screen.getByRole("button", { name: "Continue" }));
	await waitFor(() => expect(loginFlowsMock).toHaveBeenCalled());
}

describe("LoginPage server stage", () => {
	it("shows the homeserver form first, not the credential fields", () => {
		render(() => <LoginPage />);
		expect(screen.getByLabelText("Homeserver")).toBeTruthy();
		expect(screen.queryByLabelText("Username")).toBeNull();
		expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
	});

	it("reports an unreachable homeserver", async () => {
		loginFlowsMock.mockRejectedValue(new Error("network"));
		getAuthMetadataMock.mockRejectedValue(new Error("network"));
		render(() => <LoginPage />);
		fireEvent.submit(screen.getByRole("button", { name: "Continue" }));
		await screen.findByText(
			"Could not contact the homeserver. Check the server address.",
		);
	});

	it("rejects a legacy-SSO-only server", async () => {
		stubProbe({ sso: true });
		render(() => <LoginPage />);
		fireEvent.submit(screen.getByRole("button", { name: "Continue" }));
		await screen.findByText(
			"This server only supports legacy SSO login, which Crust doesn't support.",
		);
	});

	it("rejects a server with no supported login method", async () => {
		stubProbe({});
		render(() => <LoginPage />);
		fireEvent.submit(screen.getByRole("button", { name: "Continue" }));
		await screen.findByText(
			"This server doesn't support password or OAuth login.",
		);
	});
});

describe("LoginPage methods stage", () => {
	it("password-only server: shows the password form and logs in", async () => {
		stubProbe({ password: true });
		loginRequestMock.mockResolvedValue({
			access_token: "tok",
			user_id: "@alice:strange.pizza",
			device_id: "DEV1",
		});
		await renderAndProbe();

		await screen.findByLabelText("Username");
		expect(screen.queryByRole("button", { name: /Continue with/ })).toBeNull();

		fireEvent.input(screen.getByLabelText("Username"), {
			target: { value: "alice" },
		});
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "hunter2" },
		});
		fireEvent.submit(
			screen.getByRole("button", { name: "Log in with password" }),
		);

		await waitFor(() =>
			expect(loginRequestMock).toHaveBeenCalledWith({
				type: "m.login.password",
				identifier: { type: "m.id.user", user: "alice" },
				password: "hunter2",
				initial_device_display_name: "Crust",
			}),
		);
		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
		);
		expect(loadSession()).toMatchObject({
			accessToken: "tok",
			userId: "@alice:strange.pizza",
			deviceId: "DEV1",
			homeserverUrl: "https://strange.pizza",
		});
	});

	it("OAuth-only server: shows the OAuth button, no password form, and redirects on click", async () => {
		stubProbe({ delegated: true });
		startOidcLoginMock.mockResolvedValue(
			"https://strange.pizza/authorize?client_id=x",
		);
		locationState.value = { returnTo: "/home/!room:strange.pizza" };
		await renderAndProbe();

		const button = await screen.findByRole("button", {
			name: "Continue with strange.pizza",
		});
		expect(screen.queryByLabelText("Username")).toBeNull();

		fireEvent.click(button);

		await waitFor(() =>
			expect(startOidcLoginMock).toHaveBeenCalledWith(
				METADATA,
				"https://strange.pizza",
			),
		);
		// The deep-linked target is stashed for the callback route, and the
		// full page navigates to the OP's authorization URL.
		expect(stashOidcReturnToMock).toHaveBeenCalledWith(
			"/home/!room:strange.pizza",
		);
		expect(assignMock).toHaveBeenCalledWith(
			"https://strange.pizza/authorize?client_id=x",
		);
		await screen.findByRole("button", { name: "Redirecting…" });
	});

	it("server with both methods: shows the OAuth button and the password form", async () => {
		stubProbe({ password: true, delegated: true });
		await renderAndProbe();

		await screen.findByRole("button", { name: "Continue with strange.pizza" });
		expect(screen.getByLabelText("Username")).toBeTruthy();
	});

	it("surfaces an OAuth start failure inline instead of redirecting", async () => {
		stubProbe({ delegated: true });
		startOidcLoginMock.mockRejectedValue(
			new Error("Dynamic registration failed"),
		);
		await renderAndProbe();

		fireEvent.click(
			await screen.findByRole("button", {
				name: "Continue with strange.pizza",
			}),
		);

		await screen.findByText("Dynamic registration failed");
		expect(assignMock).not.toHaveBeenCalled();
		// Back to the pre-click label so the user can retry.
		await screen.findByRole("button", { name: "Continue with strange.pizza" });
	});

	it("'Use a different server' returns to the server stage and clears credentials", async () => {
		stubProbe({ password: true });
		await renderAndProbe();

		const usernameInput = await screen.findByLabelText("Username");
		fireEvent.input(usernameInput, { target: { value: "alice" } });
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "hunter2" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Use a different server" }),
		);

		await screen.findByLabelText("Homeserver");
		expect(screen.queryByLabelText("Username")).toBeNull();

		// Re-probe: the previous server's credentials must not pre-fill.
		stubProbe({ password: true });
		fireEvent.submit(screen.getByRole("button", { name: "Continue" }));
		const refilled = (await screen.findByLabelText(
			"Username",
		)) as HTMLInputElement;
		expect(refilled.value).toBe("");
		expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
			"",
		);
	});
});

describe("LoginPage add-account mode", () => {
	const EXISTING: Session = {
		accessToken: "syt_existing",
		userId: "@bob:strange.pizza",
		deviceId: "DEV_BOB",
		homeserverUrl: "https://strange.pizza",
	};

	/** Drive the password form to a successful login. */
	async function logInAsAlice(): Promise<void> {
		stubProbe({ password: true });
		loginRequestMock.mockResolvedValue({
			access_token: "tok",
			user_id: "@alice:strange.pizza",
			device_id: "DEV1",
		});
		await renderAndProbe();
		await screen.findByLabelText("Username");
		fireEvent.input(screen.getByLabelText("Username"), {
			target: { value: "alice" },
		});
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "hunter2" },
		});
		fireEvent.submit(
			screen.getByRole("button", { name: "Log in with password" }),
		);
	}

	it("appends the new account and keeps the one already logged in", async () => {
		saveSession(EXISTING);
		locationState.value = { addAccount: true };

		await logInAsAlice();

		await waitFor(() => expect(loadSessions()).toHaveLength(2));
		expect(loadSessions().map((a) => a.userId)).toEqual([
			EXISTING.userId,
			"@alice:strange.pizza",
		]);
		expect(loadSession()?.userId).toBe("@alice:strange.pizza");
	});

	it("reloads into the added account instead of routing there", async () => {
		// The app is mid-teardown from another account; only a fresh document
		// guarantees no module-scope state crosses the boundary.
		saveSession(EXISTING);
		locationState.value = { addAccount: true };

		await logInAsAlice();

		await waitFor(() => expect(assignMock).toHaveBeenCalled());
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("replaces, and routes, for a plain login on the same page", async () => {
		// A bare visit to /login must NOT append: the route is outside the auth
		// guard, so appending would strand the previous account's live token.
		saveSession(EXISTING);
		locationState.value = null;

		await logInAsAlice();

		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith("/", { replace: true }),
		);
		expect(loadSessions().map((a) => a.userId)).toEqual([
			"@alice:strange.pizza",
		]);
	});

	it("says so rather than dropping the credential at the account cap", async () => {
		const filled = Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({
			...EXISTING,
			userId: `@user${i}:strange.pizza`,
		}));
		localStorage.setItem(
			"crust:session",
			JSON.stringify({
				activeUserId: filled[0]?.userId,
				sessions: filled,
			}),
		);
		locationState.value = { addAccount: true };

		await logInAsAlice();

		await screen.findByText(
			`You can be logged into ${MAX_ACCOUNTS} accounts at once. Log out of one first.`,
		);
		expect(loadSessions()).toHaveLength(MAX_ACCOUNTS);
		expect(assignMock).not.toHaveBeenCalled();
		// The login already minted a device; leaving it alive would orphan a
		// token this app never stored and the user cannot revoke from here.
		expect(revokeAccountTokenMock).toHaveBeenCalledOnce();
	});

	it("carries the add-account intent across the OAuth redirect", async () => {
		// Router state does not survive the full-page trip to the OP, so the
		// intent has to be stashed alongside the returnTo.
		locationState.value = { addAccount: true };
		stubProbe({ delegated: true });
		startOidcLoginMock.mockResolvedValue("https://strange.pizza/authorize?x=1");
		await renderAndProbe();

		fireEvent.click(
			await screen.findByRole("button", { name: /Continue with/ }),
		);

		await waitFor(() => expect(stashOidcAddAccountMock).toHaveBeenCalledOnce());
	});

	it("does not stash the intent for a plain OAuth login", async () => {
		locationState.value = null;
		stubProbe({ delegated: true });
		startOidcLoginMock.mockResolvedValue("https://strange.pizza/authorize?x=1");
		await renderAndProbe();

		fireEvent.click(
			await screen.findByRole("button", { name: /Continue with/ }),
		);

		await waitFor(() => expect(startOidcLoginMock).toHaveBeenCalled());
		expect(stashOidcAddAccountMock).not.toHaveBeenCalled();
	});

	it("offers a way back out of add-account mode", async () => {
		locationState.value = { addAccount: true };
		stubProbe({ password: true });
		await renderAndProbe();

		fireEvent.click(screen.getByRole("button", { name: "Cancel and go back" }));

		expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
	});
});
