import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountTab } from "./AccountTab";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Server capabilities returned by the mocked client; mutable per test.
let capabilities: Record<string, unknown> = {};

// Session type drives which security UI renders; mutable per test.
const sessionState: { oidc?: { issuer: string; clientId: string } } = {};
vi.mock("../../stores/session", () => ({
	loadSession: () => ({
		accessToken: "t",
		userId: "@test:example.com",
		deviceId: "DEV",
		homeserverUrl: "https://hs.example",
		oidc: sessionState.oidc,
	}),
}));

const fetchThreePids = vi.fn(
	async (_client?: unknown): Promise<{ medium: string; address: string }[]> => [
		{ medium: "email", address: "me@example.com" },
	],
);
const changePassword = vi.fn();
const deactivateAccount = vi.fn();
vi.mock("../../client/accountSecurity", () => ({
	fetchThreePids: (client: unknown) => fetchThreePids(client),
	changePassword: (...args: unknown[]) => changePassword(...args),
	deactivateAccount: (...args: unknown[]) => deactivateAccount(...args),
}));

// Auth metadata served by the mocked client; null = no delegated auth.
// The real accountManagement module runs against it.
let authMetadata: {
	account_management_uri?: string;
	account_management_actions_supported?: string[];
} | null = null;
const getAuthMetadata = vi.fn(async () => {
	if (!authMetadata) throw new Error("no delegated auth");
	return authMetadata;
});

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => "@test:example.com",
			getUser: () => null,
			on: () => {},
			removeListener: () => {},
			getIgnoredUsers: () => [],
			getCapabilities: async () => capabilities,
			getAuthMetadata,
		},
	}),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	delete sessionState.oidc;
	capabilities = {};
	authMetadata = null;
});

describe("AccountTab account security (#451)", () => {
	it("offers in-app password change and deactivation to password sessions", async () => {
		render(() => <AccountTab onDeactivated={() => {}} />);

		expect(await screen.findByRole("button", { name: "Change…" })).toBeTruthy();
		expect(
			await screen.findByRole("button", { name: "Deactivate…" }),
		).toBeTruthy();
		expect(screen.queryByText("Password managed outside Crust")).toBeNull();

		// The bound email renders read-only.
		expect(await screen.findByText("me@example.com")).toBeTruthy();
		expect(getAuthMetadata).not.toHaveBeenCalled();
	});

	it("shows the empty state when no identifiers are bound", async () => {
		fetchThreePids.mockResolvedValue([]);
		render(() => <AccountTab onDeactivated={() => {}} />);
		expect(
			await screen.findByText(/No email addresses or phone numbers are linked/),
		).toBeTruthy();
	});

	it("routes OIDC sessions to the account provider instead", async () => {
		sessionState.oidc = { issuer: "https://hs.example/", clientId: "c" };
		authMetadata = {
			account_management_uri: "https://hs.example/account",
			account_management_actions_supported: ["org.matrix.account_deactivate"],
		};

		render(() => <AccountTab onDeactivated={() => {}} />);

		expect(
			await screen.findByText("Password managed outside Crust"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Deactivate…" })).toBeNull();

		const manage = await screen.findByRole("link", {
			name: "Open account settings",
		});
		expect(manage.getAttribute("href")).toBe("https://hs.example/account");
		const deactivate = screen.getByRole("link", { name: "Deactivate…" });
		expect(deactivate.getAttribute("href")).toBe(
			"https://hs.example/account?action=org.matrix.account_deactivate",
		);
	});

	it("opens the change-password dialog from the row", async () => {
		render(() => <AccountTab onDeactivated={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "Change…" }));
		expect(
			await screen.findByRole("dialog", { name: "Change password" }),
		).toBeTruthy();
	});

	it("keeps in-app deactivation when only password changes are disabled", async () => {
		// Password session, but m.change_password is explicitly off: the
		// password form would dead-end, so the provider text takes over -
		// deactivation is a different endpoint the capability does not
		// govern, and must stay in-app.
		capabilities = { "m.change_password": { enabled: false } };
		authMetadata = {
			account_management_uri: "https://hs.example/account",
			account_management_actions_supported: [],
		};

		render(() => <AccountTab onDeactivated={() => {}} />);
		expect(
			await screen.findByText("Password managed outside Crust"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
		expect(
			await screen.findByRole("button", { name: "Deactivate…" }),
		).toBeTruthy();
	});

	it("opens the deactivate dialog wired to the logout handler", async () => {
		deactivateAccount.mockResolvedValue(undefined);
		const onDeactivated = vi.fn();
		render(() => <AccountTab onDeactivated={onDeactivated} />);
		fireEvent.click(await screen.findByRole("button", { name: "Deactivate…" }));
		const dialog = await screen.findByRole("dialog", {
			name: "Deactivate account",
		});
		expect(dialog).toBeTruthy();

		fireEvent.input(screen.getByLabelText(/to confirm/), {
			target: { value: "@test:example.com" },
		});
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "pw" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Deactivate forever" }));
		await screen.findByRole("dialog", { name: "Deactivate account" });
		await vi.waitFor(() => expect(onDeactivated).toHaveBeenCalled());
	});
});
