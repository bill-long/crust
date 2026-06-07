import { describe, expect, it } from "vitest";
import {
	type CanNotifyInput,
	computeCanNotify,
	createSurfacedEventTracker,
} from "./notifyChannel";

const base: CanNotifyInput = {
	live: true,
	focused: false,
	desktopNotificationsEnabled: false,
	notificationPermissionGranted: false,
	eventSurfacedInApp: false,
};

describe("computeCanNotify", () => {
	it("never confirms when the app is not live, regardless of other inputs", () => {
		expect(
			computeCanNotify({
				live: false,
				focused: true,
				desktopNotificationsEnabled: true,
				notificationPermissionGranted: true,
				eventSurfacedInApp: true,
			}),
		).toBe(false);
	});

	it("confirms when live and focused, even without desktop notifications", () => {
		expect(computeCanNotify({ ...base, live: true, focused: true })).toBe(true);
	});

	it("confirms when live and unfocused only if the event was surfaced in-app", () => {
		expect(
			computeCanNotify({
				...base,
				live: true,
				focused: false,
				desktopNotificationsEnabled: true,
				notificationPermissionGranted: true,
				eventSurfacedInApp: true,
			}),
		).toBe(true);
	});

	it("does not confirm a bare-notify (un-surfaced) event while unfocused, even with desktop notifications enabled", () => {
		// The #242 residual: previously this returned true (per-client desktop
		// capability) and suppressed the SW notification with nothing shown.
		expect(
			computeCanNotify({
				...base,
				live: true,
				focused: false,
				desktopNotificationsEnabled: true,
				notificationPermissionGranted: true,
				eventSurfacedInApp: false,
			}),
		).toBe(false);
	});

	it("does not confirm when unfocused and desktop notifications are disabled (the 1a gap)", () => {
		expect(
			computeCanNotify({
				...base,
				live: true,
				focused: false,
				desktopNotificationsEnabled: false,
				notificationPermissionGranted: true,
				eventSurfacedInApp: true,
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
				eventSurfacedInApp: true,
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
				eventSurfacedInApp: true,
			}),
		).toBe(false);
		// Permission on, setting off
		expect(
			computeCanNotify({
				...base,
				live: true,
				desktopNotificationsEnabled: false,
				notificationPermissionGranted: true,
				eventSurfacedInApp: true,
			}),
		).toBe(false);
	});
});

describe("createSurfacedEventTracker", () => {
	it("records and reports surfaced event ids", () => {
		const tracker = createSurfacedEventTracker();
		expect(tracker.has("$a")).toBe(false);
		tracker.record("$a");
		expect(tracker.has("$a")).toBe(true);
		expect(tracker.has("$b")).toBe(false);
	});

	it("a repeated record is a no-op that neither consumes a slot nor refreshes recency", () => {
		const tracker = createSurfacedEventTracker(2);
		tracker.record("$a");
		tracker.record("$b");
		tracker.record("$a"); // no-op: must not move $a to the newest slot
		tracker.record("$c"); // evicts the genuine oldest ($a)
		// A slot-consuming or move-to-end impl would instead retain $a and evict
		// $b here, so this sequence distinguishes the correct no-op behavior.
		expect(tracker.has("$a")).toBe(false);
		expect(tracker.has("$b")).toBe(true);
		expect(tracker.has("$c")).toBe(true);
	});

	it("evicts the oldest id once the cap is exceeded", () => {
		const tracker = createSurfacedEventTracker(2);
		tracker.record("$a");
		tracker.record("$b");
		tracker.record("$c");
		// $a was the oldest and is dropped; $b and $c remain.
		expect(tracker.has("$a")).toBe(false);
		expect(tracker.has("$b")).toBe(true);
		expect(tracker.has("$c")).toBe(true);
	});

	it("clear() drops all tracked ids", () => {
		const tracker = createSurfacedEventTracker();
		tracker.record("$a");
		tracker.record("$b");
		tracker.clear();
		expect(tracker.has("$a")).toBe(false);
		expect(tracker.has("$b")).toBe(false);
	});
});
