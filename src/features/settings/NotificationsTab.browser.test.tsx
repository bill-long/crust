import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { updateSetting, userSettings } from "../../stores/settings";
import { NotificationsTab } from "./NotificationsTab";

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: { pushRules: null, on: () => {}, off: () => {} },
	}),
}));
vi.mock("../../app/ConfigProvider", () => ({
	useConfig: () => ({
		push: {
			vapidPublicKey: "key",
			gatewayUrl: "https://push.example.com",
			appId: "test",
		},
	}),
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	updateSetting("desktopNotifications", false);
	updateSetting("backgroundNotifications", false);
});

it("enables native notifications without requesting WebView2 permission and disables background push", async () => {
	vi.stubGlobal("isTauri", true);
	const requestPermission = vi.fn();
	vi.stubGlobal("Notification", { permission: "denied", requestPermission });
	const invoke = vi.fn(async () => "granted");
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
	updateSetting("desktopNotifications", false);
	updateSetting("backgroundNotifications", true);
	render(() => <NotificationsTab />);
	const toggle = screen.getByRole("switch", {
		name: "Enable desktop notifications",
	});
	await userEvent.click(toggle);
	await vi.waitFor(() => expect(toggle).toBeChecked());
	expect(invoke).toHaveBeenCalledWith(
		"plugin:notification|request_permission",
		undefined,
	);
	expect(requestPermission).not.toHaveBeenCalled();
	const background = screen.getByRole("switch", {
		name: "Enable background notifications",
	});
	expect(background).toBeDisabled();
	expect(background).not.toBeChecked();
	expect(
		screen.getByText(
			/Background notifications are unavailable in the desktop app/,
		),
	).toBeVisible();
	await userEvent.click(toggle);
	expect(userSettings().desktopNotifications).toBe(false);
	expect(invoke).toHaveBeenCalledTimes(1);
});

it("shows a failed native permission request inline and allows retry", async () => {
	vi.stubGlobal("isTauri", true);
	const invoke = vi
		.fn()
		.mockRejectedValueOnce(new Error("Native service unavailable"))
		.mockResolvedValue("granted");
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
	updateSetting("desktopNotifications", false);
	render(() => <NotificationsTab />);
	const toggle = screen.getByRole("switch", {
		name: "Enable desktop notifications",
	});
	await userEvent.click(toggle);
	await vi.waitFor(() =>
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Native service unavailable",
		),
	);
	expect(toggle).not.toBeChecked();
	await userEvent.click(toggle);
	await vi.waitFor(() => expect(toggle).toBeChecked());
	expect(screen.queryByRole("alert")).toBeNull();
});

it("explains an ungranted browser permission instead of silently doing nothing", async () => {
	vi.stubGlobal("isTauri", false);
	vi.stubGlobal("Notification", {
		permission: "default",
		requestPermission: async () => "default",
	});
	updateSetting("desktopNotifications", false);
	render(() => <NotificationsTab />);
	await userEvent.click(
		screen.getByRole("switch", { name: "Enable desktop notifications" }),
	);
	await vi.waitFor(() =>
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Notification permission was not granted",
		),
	);
	expect(userSettings().desktopNotifications).toBe(false);
});
