import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountManagement } from "../../client/accountManagement";
import { DeviceList } from "./DeviceList";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const getDevices = vi.fn();

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => "@test:example.com",
			getDeviceId: () => "THISDEV",
			getCrypto: () => undefined,
			getDevices: () => getDevices(),
			on: () => undefined,
			removeListener: () => undefined,
		},
	}),
}));

let sessionOidc: object | undefined;
vi.mock("../../stores/session", () => ({
	loadSession: () => ({ oidc: sessionOidc }),
}));

let management: Promise<AccountManagement | null>;
const fetchAccountManagement = vi.fn(() => management);
vi.mock("../../client/accountManagement", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../client/accountManagement")>();
	return { ...actual, fetchAccountManagement: () => fetchAccountManagement() };
});

// Prop-seam stub: the dialog's own behaviour has its own suite, so this
// only surfaces what the list decided to hand it.
vi.mock("./SignOutDeviceDialog", () => ({
	SignOutDeviceDialog: (props: {
		deviceId: string;
		portalUrl?: string | null;
		onClose: () => void;
	}) => (
		<div data-testid="dialog" data-device={props.deviceId}>
			<span data-testid="portal">
				{props.portalUrl === undefined
					? "resolving"
					: (props.portalUrl ?? "none")}
			</span>
			<button type="button" data-testid="dialog-close" onClick={props.onClose}>
				Close
			</button>
		</div>
	),
}));

beforeEach(() => {
	sessionOidc = undefined;
	getDevices.mockResolvedValue({
		devices: [
			{ device_id: "THISDEV", display_name: "This one" },
			{ device_id: "DEV_A", display_name: "Laptop A", last_seen_ts: 2 },
			{ device_id: "DEV_B", display_name: "Laptop B", last_seen_ts: 1 },
		],
	});
	management = Promise.resolve({
		uri: "https://hs.example/account",
		actions: ["org.matrix.device_delete"],
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const portalText = (): string => screen.getByTestId("portal").textContent ?? "";

/** Ask the stubbed dialog to close, the way the real one would. */
const closeDialog = (): void => {
	fireEvent.click(screen.getByTestId("dialog-close"));
};

describe("DeviceList sign-out", () => {
	it("opens a dialog for the row's own device", async () => {
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		expect(screen.getByTestId("dialog").getAttribute("data-device")).toBe(
			"DEV_A",
		);
	});

	it("never offers sign-out for the current device", async () => {
		render(() => <DeviceList />);
		await screen.findByText("Laptop A");
		expect(screen.queryByRole("button", { name: /This one/ })).toBeNull();
	});

	it("resolves the portal deeplink for the device it was opened for", async () => {
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		await vi.waitFor(() =>
			expect(portalText()).toBe(
				"https://hs.example/account?action=org.matrix.device_delete&device_id=DEV_A",
			),
		);
	});

	it("reports the deeplink as unresolved rather than absent while fetching", async () => {
		// null means "the server has no account-management page" - claiming
		// that during the round-trip would be a false statement to an OIDC
		// user whose only affordance is that link.
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		expect(portalText()).toBe("resolving");
		await vi.waitFor(() => expect(portalText()).toContain("device_id=DEV_A"));
	});

	it("reports no deeplink once the server answers with no portal", async () => {
		management = Promise.resolve(null);
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		await vi.waitFor(() => expect(portalText()).toBe("none"));
	});

	it("never hands a dialog the previous device's deeplink", async () => {
		// createResource keeps the previous value while refetching, so
		// without the identity gate the second dialog would render the FIRST
		// device's removal link - and this link's whole job is to name one
		// exact device.
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		await vi.waitFor(() => expect(portalText()).toContain("device_id=DEV_A"));

		fireEvent.click(screen.getByRole("button", { name: /Laptop B/ }));
		expect(portalText()).toBe("resolving");
		await vi.waitFor(() => expect(portalText()).toContain("device_id=DEV_B"));
	});

	// Focus must stay inside the settings overlay: it binds its Escape and
	// Tab handling to its own root, so focus falling to <body> silently
	// breaks both.
	it("returns focus to the row that opened the dialog", async () => {
		render(() => <DeviceList />);
		const trigger = await screen.findByRole("button", { name: /Laptop A/ });
		// Not focused first, on purpose: the row is found by id, so restoring
		// must not depend on the click having moved focus there.
		fireEvent.click(trigger);
		closeDialog();
		expect(document.activeElement).toBe(trigger);
	});

	it("falls back to the list when the row is gone (the success path)", async () => {
		// A successful sign-out removes the row, so the trigger is detached
		// by the time the dialog closes - the common case, not the edge one.
		render(() => <DeviceList />);
		const trigger = await screen.findByRole("button", { name: /Laptop A/ });
		fireEvent.click(trigger);
		trigger.remove();
		closeDialog();
		expect(document.activeElement).not.toBe(document.body);
		expect(
			(document.activeElement as HTMLElement).contains(
				screen.getByText("Your devices"),
			),
		).toBe(true);
	});

	it("fetches the account-management metadata only once for the list", async () => {
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		await vi.waitFor(() => expect(portalText()).toContain("DEV_A"));
		fireEvent.click(screen.getByRole("button", { name: /Laptop B/ }));
		await vi.waitFor(() => expect(portalText()).toContain("DEV_B"));
		expect(fetchAccountManagement).toHaveBeenCalledTimes(1);
	});

	it("does not fetch the metadata until a sign-out is started", async () => {
		render(() => <DeviceList />);
		await screen.findByText("Laptop A");
		expect(fetchAccountManagement).not.toHaveBeenCalled();
	});
});
