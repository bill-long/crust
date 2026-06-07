import { describe, expect, it } from "vitest";
import { type CanNotifyInput, computeCanNotify } from "./notifyChannel";

const base: CanNotifyInput = {
	live: true,
	focused: false,
	desktopNotificationsEnabled: false,
	notificationPermissionGranted: false,
};

describe("computeCanNotify", () => {
	it("never confirms when the app is not live, regardless of other inputs", () => {
		expect(
			computeCanNotify({
				live: false,
				focused: true,
				desktopNotificationsEnabled: true,
				notificationPermissionGranted: true,
			}),
		).toBe(false);
	});

	it("confirms when live and focused, even without desktop notifications", () => {
		expect(computeCanNotify({ ...base, live: true, focused: true })).toBe(true);
	});

	it("confirms when live and able to show a desktop notification while unfocused", () => {
		expect(
			computeCanNotify({
				...base,
				live: true,
				focused: false,
				desktopNotificationsEnabled: true,
				notificationPermissionGranted: true,
			}),
		).toBe(true);
	});

	it("does not confirm when unfocused and desktop notifications are disabled (the 1a gap)", () => {
		expect(
			computeCanNotify({
				...base,
				live: true,
				focused: false,
				desktopNotificationsEnabled: false,
				notificationPermissionGranted: true,
			}),
		).toBe(false);
	});

	it("does not confirm when unfocused and permission is not granted", () => {
		expect(
			computeCanNotify({
				...base,
				live: true,
				focused: false,
				desktopNotificationsEnabled: true,
				notificationPermissionGranted: false,
			}),
		).toBe(false);
	});

	it("requires both desktop setting and permission for the desktop path", () => {
		// Setting on, permission off
		expect(
			computeCanNotify({
				...base,
				live: true,
				desktopNotificationsEnabled: true,
				notificationPermissionGranted: false,
			}),
		).toBe(false);
		// Permission on, setting off
		expect(
			computeCanNotify({
				...base,
				live: true,
				desktopNotificationsEnabled: false,
				notificationPermissionGranted: true,
			}),
		).toBe(false);
	});
});
