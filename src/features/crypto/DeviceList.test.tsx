import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import { Suspense } from "solid-js";
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

/** Crypto-event listeners the list registered, so a test can make the
 *  device list refetch the way a real DevicesUpdated would. */
const listeners = new Map<string, (arg: unknown) => void>();

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => "@test:example.com",
			getDeviceId: () => "THISDEV",
			getCrypto: () => undefined,
			getDevices: () => getDevices(),
			on: (event: string, handler: (arg: unknown) => void) => {
				listeners.set(event, handler);
			},
			removeListener: (event: string) => {
				listeners.delete(event);
			},
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
vi.mock("./SignOutSessionsDialog", () => ({
	SignOutSessionsDialog: (props: {
		target: {
			kind: string;
			deviceId?: string;
			deviceName?: string;
			deviceIds?: string[];
		};
		portalUrl?: string | null;
		onClose: () => void;
		onSignedOut: () => void;
	}) => (
		<div
			data-testid="dialog"
			data-kind={props.target.kind}
			data-device={props.target.deviceId ?? ""}
			data-name={props.target.deviceName ?? ""}
			data-devices={(props.target.deviceIds ?? []).join(",")}
		>
			<span data-testid="portal">
				{props.portalUrl === undefined
					? "resolving"
					: (props.portalUrl ?? "none")}
			</span>
			<button type="button" data-testid="dialog-close" onClick={props.onClose}>
				Close
			</button>
			{/* The success path, in the real dialog's order: report the
			    revoke (which starts a refetch), then close. */}
			<button
				type="button"
				data-testid="dialog-signed-out"
				onClick={() => {
					props.onSignedOut();
					props.onClose();
				}}
			>
				Signed out
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
		actions: ["org.matrix.device_delete", "org.matrix.devices_list"],
	});
});

afterEach(() => {
	cleanup();
	listeners.clear();
	vi.clearAllMocks();
});

const portalText = (): string => screen.getByTestId("portal").textContent ?? "";

/** Ask the stubbed dialog to close, the way the real one would. */
const closeDialog = (): void => {
	fireEvent.click(screen.getByTestId("dialog-close"));
};

describe("DeviceList sign-out", () => {
	it("names a whitespace-only device by its id in the confirmation", async () => {
		getDevices.mockResolvedValue({
			devices: [
				{ device_id: "THISDEV", display_name: "This one" },
				{ device_id: "DEV_A", display_name: "   ", last_seen_ts: 2 },
			],
		});
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /DEV_A/ }));
		expect(screen.getByTestId("dialog").getAttribute("data-name")).toBe(
			"DEV_A",
		);
	});

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

const BULK = "Sign out all other sessions";

describe("DeviceList bulk sign-out", () => {
	it("hands the dialog every other session's id", async () => {
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: BULK }));
		const dialog = screen.getByTestId("dialog");
		expect(dialog.getAttribute("data-kind")).toBe("others");
		expect(dialog.getAttribute("data-devices")).toBe("DEV_A,DEV_B");
	});

	it("never includes the current device in the set", async () => {
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: BULK }));
		expect(
			screen.getByTestId("dialog").getAttribute("data-devices"),
		).not.toContain("THISDEV");
	});

	it("leaves out a device the server reported with no id", async () => {
		// There is nothing to put in the request for it, so counting it would
		// promise a revoke the request cannot make.
		getDevices.mockResolvedValue({
			devices: [
				{ device_id: "THISDEV", display_name: "This one" },
				{ device_id: "DEV_A", display_name: "Laptop A", last_seen_ts: 2 },
				{ display_name: "Nameless", last_seen_ts: 1 },
			],
		});
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: BULK }));
		expect(screen.getByTestId("dialog").getAttribute("data-devices")).toBe(
			"DEV_A",
		);
	});

	it("hides the control when this is the only session", async () => {
		getDevices.mockResolvedValue({
			devices: [{ device_id: "THISDEV", display_name: "This one" }],
		});
		render(() => <DeviceList />);
		await screen.findByText("This one");
		expect(screen.queryByRole("button", { name: BULK })).toBeNull();
	});

	it("withdraws the control while the list is reloading", async () => {
		// A resource keeps its previous value through a refetch, so without
		// this the button would count and revoke a set the rows below it
		// have already stopped showing.
		render(() => <DeviceList />);
		await screen.findByRole("button", { name: BULK });

		let release: (v: unknown) => void = () => undefined;
		getDevices.mockReturnValue(new Promise((r) => (release = r)));
		listeners.get(CryptoEvent.DevicesUpdated)?.(["@test:example.com"]);

		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: BULK })).toBeNull(),
		);
		release({
			devices: [
				{ device_id: "THISDEV", display_name: "This one" },
				{ device_id: "DEV_A", display_name: "Laptop A", last_seen_ts: 2 },
			],
		});
		expect(await screen.findByRole("button", { name: BULK })).toBeTruthy();
	});

	it("offers it for a single other session too", async () => {
		getDevices.mockResolvedValue({
			devices: [
				{ device_id: "THISDEV", display_name: "This one" },
				{ device_id: "DEV_A", display_name: "Laptop A", last_seen_ts: 2 },
			],
		});
		render(() => <DeviceList />);
		expect(await screen.findByRole("button", { name: BULK })).toBeTruthy();
	});

	it("resolves the session-list deeplink, not a device's removal page", async () => {
		// MSC4191 has no bulk-delete action, so the portal target is the list.
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: BULK }));
		await vi.waitFor(() =>
			expect(portalText()).toBe(
				"https://hs.example/account?action=org.matrix.devices_list",
			),
		);
	});

	it("never hands the bulk dialog the previous device's deeplink", async () => {
		// The identity gate has to separate the two dialog KINDS, not just two
		// device ids - the resource still holds the row's value while the bulk
		// lookup is in flight.
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		await vi.waitFor(() => expect(portalText()).toContain("device_id=DEV_A"));
		closeDialog();

		fireEvent.click(screen.getByRole("button", { name: BULK }));
		expect(portalText()).toBe("resolving");
		await vi.waitFor(() => expect(portalText()).toContain("devices_list"));
	});

	it("returns focus to the bulk control when nothing was revoked", async () => {
		render(() => <DeviceList />);
		const trigger = await screen.findByRole("button", { name: BULK });
		fireEvent.click(trigger);
		closeDialog();
		expect(document.activeElement).toBe(trigger);
	});

	it("falls back to the list when the bulk control is gone", async () => {
		// The success path: with every other session revoked the control has
		// nothing to do and unmounts, leaving a detached node that focus()
		// silently ignores - which would drop focus out of the settings
		// overlay and break its Escape and Tab handling.
		render(() => <DeviceList />);
		const trigger = await screen.findByRole("button", { name: BULK });
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

	it("keeps the set the confirmation counted when the list refetches", async () => {
		// The number in the confirmation and the ids in the request are the
		// same snapshot, taken when the dialog opened. A session that signs
		// in while it is open must not be swept up in a count the user never
		// saw - it shows up in the refreshed list afterwards instead.
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: BULK }));
		expect(screen.getByTestId("dialog").getAttribute("data-devices")).toBe(
			"DEV_A,DEV_B",
		);

		getDevices.mockResolvedValue({
			devices: [
				{ device_id: "THISDEV", display_name: "This one" },
				{ device_id: "DEV_A", display_name: "Laptop A", last_seen_ts: 2 },
				{ device_id: "DEV_B", display_name: "Laptop B", last_seen_ts: 1 },
				{
					device_id: "DEV_LATE",
					display_name: "Just arrived",
					last_seen_ts: 3,
				},
			],
		});
		listeners.get(CryptoEvent.DevicesUpdated)?.(["@test:example.com"]);
		await screen.findByText("Just arrived");

		expect(screen.getByTestId("dialog").getAttribute("data-devices")).toBe(
			"DEV_A,DEV_B",
		);
	});
});

/** Complete the sign-out the way the real dialog does on success. */
const succeed = (): void => {
	fireEvent.click(screen.getByTestId("dialog-signed-out"));
};

// The refetch that a sign-out triggers resolves AFTER the dialog closes,
// so the control that opened it is still in the document at the moment
// focus is restored and is removed a tick later - dropping focus onto
// <body>, where SettingsOverlay's Escape and Tab handling does not reach.
// Found in the running app, not by reasoning.
describe("DeviceList focus after a completed sign-out", () => {
	const onlyThisDevice = {
		devices: [{ device_id: "THISDEV", display_name: "This one" }],
	};

	it("keeps focus in the list when the bulk control is refetched away", async () => {
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: BULK }));
		getDevices.mockResolvedValue(onlyThisDevice);
		succeed();

		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: BULK })).toBeNull(),
		);
		expect(document.activeElement).not.toBe(document.body);
		expect(
			(document.activeElement as HTMLElement).contains(
				screen.getByText("Your devices"),
			),
		).toBe(true);
	});

	it("goes back to the trigger for the NEXT dialog, which is not doomed", async () => {
		// The doomed-trigger flag is per-close; leaving it set would make
		// every later cancel dump focus on the container instead of the row
		// the user came from.
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		getDevices.mockResolvedValue({
			devices: [
				{ device_id: "THISDEV", display_name: "This one" },
				{ device_id: "DEV_B", display_name: "Laptop B", last_seen_ts: 1 },
			],
		});
		succeed();
		const trigger = await screen.findByRole("button", { name: /Laptop B/ });
		expect(screen.queryByRole("button", { name: /Laptop A/ })).toBeNull();

		fireEvent.click(trigger);
		closeDialog();
		expect(document.activeElement).toBe(trigger);
	});

	it("keeps focus in the list when the row is refetched away", async () => {
		render(() => <DeviceList />);
		fireEvent.click(await screen.findByRole("button", { name: /Laptop A/ }));
		getDevices.mockResolvedValue(onlyThisDevice);
		succeed();

		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: /Laptop A/ })).toBeNull(),
		);
		expect(document.activeElement).not.toBe(document.body);
		expect(
			(document.activeElement as HTMLElement).contains(
				screen.getByText("Your devices"),
			),
		).toBe(true);
	});
});

describe("DeviceList under a Suspense boundary", () => {
	// The real tree wraps the lazy settings overlay in <Suspense> (Layout).
	// Solid DETACHES a suspended subtree, so any read of the resource that
	// runs while a refetch is in flight rips the whole settings pane out of
	// the document for the duration - taking focus to <body> with it, and
	// flashing the fallback on every CryptoEvent. A memo is eager, so a
	// short-circuit at the use site is no protection.
	it("does not suspend the boundary on the FIRST load either", async () => {
		// `.latest` only skips the suspending read once the resource has
		// resolved at least once - before that it IS the suspending read.
		// So the guard has to be `loading`/`error`, which never suspend.
		let release: (v: unknown) => void = () => undefined;
		getDevices.mockReturnValue(new Promise((r) => (release = r)));
		render(() => (
			<Suspense fallback={<div data-testid="fallback" />}>
				<DeviceList />
			</Suspense>
		));

		expect(screen.queryByTestId("fallback")).toBeNull();
		// The component's own loading state, not the boundary's fallback.
		expect(screen.getByText("Loading devices…")).toBeTruthy();

		release({ devices: [{ device_id: "THISDEV", display_name: "This one" }] });
		await screen.findByText("This one");
	});

	it("renders its own error state when the fetch fails", async () => {
		// `.latest` RETHROWS a settled error, and an eager memo reaches it
		// even though the Switch would have short-circuited on
		// `devices.error` first - so the failure escapes the component
		// instead of rendering the row it has for exactly this case.
		getDevices.mockRejectedValue(new Error("network down"));
		render(() => (
			<Suspense fallback={<div data-testid="fallback" />}>
				<DeviceList />
			</Suspense>
		));

		expect(await screen.findByText("Failed to load devices")).toBeTruthy();
		expect(screen.queryByRole("button", { name: BULK })).toBeNull();
	});

	it("does not suspend the boundary while the list refetches", async () => {
		render(() => (
			<Suspense fallback={<div data-testid="fallback" />}>
				<DeviceList />
			</Suspense>
		));
		const heading = await screen.findByText("Your devices");
		const pane = heading.closest("div[tabindex]") as HTMLElement;

		let release: (v: unknown) => void = () => undefined;
		getDevices.mockReturnValue(new Promise((r) => (release = r)));
		listeners.get(CryptoEvent.DevicesUpdated)?.(["@test:example.com"]);
		await Promise.resolve();
		await Promise.resolve();

		expect(pane.isConnected).toBe(true);
		expect(screen.queryByTestId("fallback")).toBeNull();

		release({
			devices: [{ device_id: "THISDEV", display_name: "This one" }],
		});
		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: BULK })).toBeNull(),
		);
	});
});
