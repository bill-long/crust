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
const setCryptoDialogOpen = vi.fn();

vi.mock("../../stores/cryptoActions", () => ({
	triggerCryptoAction: (...args: unknown[]) => triggerCryptoAction(...args),
	setCryptoDialogOpen: (...args: unknown[]) => setCryptoDialogOpen(...args),
	registerCryptoHandler: () => () => {},
	restoreCryptoTriggerFocus: () => {},
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
				statusOverrides.crossSigningReady ?? HEALTHY.crossSigningReady,
			thisDeviceVerified: () =>
				statusOverrides.thisDeviceVerified ?? HEALTHY.thisDeviceVerified,
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
				statusOverrides.crossSigningStatus ?? HEALTHY.crossSigningStatus,
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

		await waitFor(() =>
			expect(screen.getByLabelText("Export message keys")).toBeTruthy(),
		);
		expect(setCryptoDialogOpen).toHaveBeenLastCalledWith(true);
	});

	it("opens the import dialog", async () => {
		render(() => <DevicesTab />);
		fireEvent.click(screen.getByRole("button", { name: "Import…" }));

		await waitFor(() =>
			expect(screen.getByLabelText("Import message keys")).toBeTruthy(),
		);
		expect(setCryptoDialogOpen).toHaveBeenLastCalledWith(true);
	});
});
