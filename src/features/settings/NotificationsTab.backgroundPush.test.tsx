import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			pushRules: null,
			on: () => {},
			off: () => {},
			setPushRuleEnabled: async () => {},
		},
	}),
}));

const PUSH = {
	vapidPublicKey: "key",
	gatewayUrl: "https://push.example.com/_matrix/push/v1/notify",
	appId: "pizza.strange.crust",
};
vi.mock("../../app/ConfigProvider", () => ({
	useConfig: () => ({ push: PUSH }),
}));

/** Resolves only when the test lets it, standing in for a slow homeserver. */
let finishRelease: () => void = () => {};
const disableBackgroundNotifications = vi.hoisted(() => vi.fn());
vi.mock("../notifications/accountPush", () => ({
	disableBackgroundNotifications: (...args: unknown[]) =>
		disableBackgroundNotifications(...args),
}));
vi.mock("../notifications/webPush", () => ({
	enableWebPush: async () => {},
	isPushSupported: () => true,
}));

import { updateSetting } from "../../stores/settings";
import { NotificationsTab } from "./NotificationsTab";

beforeEach(() => {
	disableBackgroundNotifications.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finishRelease = resolve;
			}),
	);
	vi.stubGlobal("Notification", { permission: "granted" });
	updateSetting("backgroundNotifications", true);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	updateSetting("backgroundNotifications", false);
});

describe("turning background notifications off", () => {
	it("goes through the shared disable, which records the preference first", async () => {
		// The toggle does not sequence this itself: the order (preference, then
		// the bounded release it no longer gates) lives in
		// `disableBackgroundNotifications`, with the test that locks it.
		render(() => <NotificationsTab />);
		const toggle = screen.getByRole("switch", {
			name: /background notifications/i,
		});

		fireEvent.click(toggle);

		expect(disableBackgroundNotifications).toHaveBeenCalledOnce();

		finishRelease();
	});
});
