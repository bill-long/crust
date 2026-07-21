import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicesTab } from "./DevicesTab";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const triggerCryptoAction = vi.fn();
const acquireCryptoDialog = vi.fn(() => vi.fn());
const setCryptoTriggerElement = vi.fn();
const restoreCryptoTriggerFocus = vi.fn();

vi.mock("../../stores/cryptoActions", () => ({
	triggerCryptoAction: (...args: unknown[]) => triggerCryptoAction(...args),
	acquireCryptoDialog: () => acquireCryptoDialog(),
	registerCryptoHandler: () => () => {},
	restoreCryptoTriggerFocus: () => restoreCryptoTriggerFocus(),
	setCryptoTriggerElement: (...args: unknown[]) =>
		setCryptoTriggerElement(...args),
}));

// Keep the tab focused on its own logic; these children have their own
// suites.
vi.mock("../crypto/backup/BackupStatus", () => ({
	BackupStatus: () => <span>backup-status-ok</span>,
}));
vi.mock("../crypto/DeviceList", () => ({
	DeviceList: () => <span>device-list</span>,
}));

interface StatusOverrides {
	crossSigningReady?: boolean;
	thisDeviceVerified?: boolean;
	backupVersion?: string | null;
	backupOnServer?: boolean;
	crossSigningStatus?: {
		publicKeysOnDevice: boolean;
		privateKeysInSecretStorage: boolean;
		privateKeysCachedLocally: {
			masterKey: boolean;
			selfSigningKey: boolean;
			userSigningKey: boolean;
		};
	};
}

const HEALTHY: Required<StatusOverrides> = {
	crossSigningReady: true,
	thisDeviceVerified: true,
	backupVersion: "1",
	backupOnServer: true,
	crossSigningStatus: {
		publicKeysOnDevice: true,
		privateKeysInSecretStorage: true,
		privateKeysCachedLocally: {
			masterKey: true,
			selfSigningKey: true,
			userSigningKey: true,
		},
	},
};

let statusOverrides: StatusOverrides = {};

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {},
		cryptoStatus: {
			crossSigningReady: () =>
				"crossSigningReady" in statusOverrides
					? statusOverrides.crossSigningReady
					: HEALTHY.crossSigningReady,
			thisDeviceVerified: () =>
				"thisDeviceVerified" in statusOverrides
					? statusOverrides.thisDeviceVerified
					: HEALTHY.thisDeviceVerified,
			backupVersion: () =>
				statusOverrides.backupVersion !== undefined
					? statusOverrides.backupVersion
					: HEALTHY.backupVersion,
			backupOnServer: () =>
				"backupOnServer" in statusOverrides
					? statusOverrides.backupOnServer
					: HEALTHY.backupOnServer,
			backupTrusted: () => true,
			secretStorageReady: () => true,
			crossSigningStatus: () =>
				"crossSigningStatus" in statusOverrides
					? statusOverrides.crossSigningStatus
					: HEALTHY.crossSigningStatus,
			refresh: async () => {},
		},
	}),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	statusOverrides = {};
});

describe("DevicesTab", () => {
	it("offers a danger Reset… action when the server identity is unreachable", () => {
		statusOverrides = {
			crossSigningReady: false,
			thisDeviceVerified: false,
			crossSigningStatus: {
				publicKeysOnDevice: true,
				privateKeysInSecretStorage: false,
				privateKeysCachedLocally: {
					masterKey: false,
					selfSigningKey: false,
					userSigningKey: false,
				},
			},
		};
		render(() => <DevicesTab />);

		const reset = screen.getByRole("button", { name: "Reset…" });
		fireEvent.click(reset);
		expect(triggerCryptoAction).toHaveBeenCalledWith("reset-encryption");
		// The misleading plain "Set up" must not be offered in this state.
		expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
	});

	it("offers Set up when cross-signing is simply missing", () => {
		statusOverrides = {
			crossSigningReady: false,
			thisDeviceVerified: false,
			crossSigningStatus: {
				publicKeysOnDevice: false,
				privateKeysInSecretStorage: false,
				privateKeysCachedLocally: {
					masterKey: false,
					selfSigningKey: false,
					userSigningKey: false,
				},
			},
		};
		render(() => <DevicesTab />);

		fireEvent.click(screen.getByRole("button", { name: "Set up" }));
		expect(triggerCryptoAction).toHaveBeenCalledWith("setup-cross-signing");
		expect(screen.queryByRole("button", { name: "Reset…" })).toBeNull();
	});

	it("shows the unavailable-backup state with the promised guidance", () => {
		statusOverrides = { backupVersion: null, backupOnServer: true };
		render(() => <DevicesTab />);

		expect(screen.getByText("Unavailable")).toBeTruthy();
		expect(
			screen.getByText(/unavailable to this session — verify or enter/),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Unlock…" }));
		expect(triggerCryptoAction).toHaveBeenCalledWith("unlock-backup");
		// "Set up" would create a NEW backup and orphan the old keys.
		expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
	});

	it("offers backup setup only when the server truly has no backup", () => {
		statusOverrides = { backupVersion: null, backupOnServer: false };
		render(() => <DevicesTab />);

		expect(screen.getByText("Not set up")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Unlock…" })).toBeNull();
	});

	it("shows Checking… while the server backup state is unknown", () => {
		statusOverrides = {
			backupVersion: null,
			backupOnServer: undefined,
		};
		render(() => <DevicesTab />);

		expect(screen.getByText("Checking…")).toBeTruthy();
		// Neither action is safe to offer until the probe resolves.
		expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Unlock…" })).toBeNull();
	});

	it("opens the export dialog and coordinates modal state", async () => {
		render(() => <DevicesTab />);
		fireEvent.click(screen.getByRole("button", { name: "Export…" }));

		// Lazy-loaded dialog: the dynamic import + render can exceed the default
		// 1s findBy timeout under full-suite CPU contention (#423).
		expect(
			await screen.findByLabelText(
				"Export message keys",
				{},
				{ timeout: 5000 },
			),
		).toBeTruthy();
		expect(acquireCryptoDialog).toHaveBeenCalled();
	});

	it("captures and restores focus around the export dialog", async () => {
		// The dialogs bypass triggerCryptoAction, so the tab itself must
		// register the trigger element and restore focus on close.
		render(() => <DevicesTab />);
		fireEvent.click(screen.getByRole("button", { name: "Export…" }));
		expect(setCryptoTriggerElement).toHaveBeenCalled();

		const overlay = await screen.findByLabelText(
			"Export message keys",
			{},
			{ timeout: 5000 },
		);
		fireEvent.keyDown(overlay, { key: "Escape" });

		await waitFor(() => expect(restoreCryptoTriggerFocus).toHaveBeenCalled());
		await waitFor(() =>
			expect(screen.queryByLabelText("Export message keys")).toBeNull(),
		);
	});

	it("shows Loading… while cross-signing or verification state is unknown", () => {
		// Transient probe failures surface as undefined — the row must show
		// a pending label, never a guessed badge.
		statusOverrides = {
			crossSigningReady: undefined,
			thisDeviceVerified: undefined,
		};
		render(() => <DevicesTab />);

		expect(screen.getAllByText("Loading…")).toHaveLength(2);
		expect(screen.queryByText("Ready")).toBeNull();
		expect(screen.queryByText("Verified")).toBeNull();
		expect(screen.queryByText("Not verified")).toBeNull();
	});

	it("opens the import dialog", async () => {
		render(() => <DevicesTab />);
		fireEvent.click(screen.getByRole("button", { name: "Import…" }));

		// Same lazy-dialog import as the export case above (#423).
		expect(
			await screen.findByLabelText(
				"Import message keys",
				{},
				{ timeout: 5000 },
			),
		).toBeTruthy();
		expect(acquireCryptoDialog).toHaveBeenCalled();
	});
});
