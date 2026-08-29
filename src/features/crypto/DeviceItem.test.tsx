import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DeviceInfo, DeviceItem, SIGN_OUT_ATTR } from "./DeviceItem";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
	return {
		deviceId: "DEVICEID",
		displayName: "Test device",
		lastSeenTs: undefined,
		verification: "unverified" as const,
		isCurrentDevice: false,
		...overrides,
	};
}

afterEach(cleanup);

describe("DeviceItem", () => {
	it("shows a visible 'Verified' label for verified devices", () => {
		render(() => (
			<DeviceItem device={makeDevice({ verification: "verified" })} />
		));
		expect(screen.getByText("Verified")).toBeTruthy();
		expect(screen.queryByText("Unverified")).toBeNull();
	});

	it("shows a visible 'Unverified' label (not an icon-only indicator)", () => {
		render(() => <DeviceItem device={makeDevice()} />);
		expect(screen.getByText("Unverified")).toBeTruthy();
		// The bare warning glyph must not be exposed as a labelled image.
		expect(screen.queryByRole("img", { name: "Unverified" })).toBeNull();
	});

	it("shows Unknown, with no Verify affordance, when the status is unavailable", () => {
		// No crypto / failed lookup / no keys for the device: no claim either
		// way, and nothing a Verify button could do (issue #480).
		const onVerify = vi.fn();
		render(() => (
			<DeviceItem
				device={makeDevice({ verification: "unknown" })}
				onVerify={onVerify}
			/>
		));
		expect(screen.getByText("Status unknown")).toBeTruthy();
		expect(screen.queryByText("Unverified")).toBeNull();
		expect(screen.queryByText("Verified")).toBeNull();
		expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
	});

	it("offers a Verify button for an unverified non-current device", () => {
		const onVerify = vi.fn();
		render(() => <DeviceItem device={makeDevice()} onVerify={onVerify} />);
		const verify = screen.getByRole("button", { name: "Verify" });
		verify.click();
		expect(onVerify).toHaveBeenCalledWith("DEVICEID");
	});

	it("shows a visible next-action hint instead of a Verify button for the current device", () => {
		const onVerify = vi.fn();
		render(() => (
			<DeviceItem
				device={makeDevice({ isCurrentDevice: true })}
				onVerify={onVerify}
			/>
		));
		expect(screen.getByText("Verify from another session")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
	});

	// #556
	it("offers Sign out for another session, named so rows stay distinguishable", () => {
		const onSignOut = vi.fn();
		render(() => (
			<DeviceItem
				device={makeDevice({ displayName: "Old laptop" })}
				onSignOut={onSignOut}
			/>
		));
		const signOut = screen.getByRole("button", {
			name: "Sign out Old laptop",
		});
		signOut.click();
		expect(onSignOut).toHaveBeenCalledWith("DEVICEID");
	});

	it("falls back to the device id in the sign-out label when unnamed", () => {
		render(() => (
			<DeviceItem
				device={makeDevice({ displayName: "" })}
				onSignOut={vi.fn()}
			/>
		));
		expect(
			screen.getByRole("button", { name: "Sign out DEVICEID" }),
		).toBeTruthy();
	});

	it("offers Sign out regardless of verification status", () => {
		render(() => (
			<DeviceItem
				device={makeDevice({ verification: "verified" })}
				onSignOut={vi.fn()}
			/>
		));
		expect(
			screen.getByRole("button", { name: "Sign out Test device" }),
		).toBeTruthy();
	});

	it("never offers Sign out for the current device", () => {
		// Signing THIS session out is logging out, which the app already has.
		render(() => (
			<DeviceItem
				device={makeDevice({ isCurrentDevice: true })}
				onSignOut={vi.fn()}
			/>
		));
		expect(screen.queryByRole("button", { name: /^Sign out/ })).toBeNull();
	});

	it("omits the sign-out control when no handler is given", () => {
		render(() => <DeviceItem device={makeDevice()} />);
		expect(screen.queryByRole("button", { name: /^Sign out/ })).toBeNull();
	});

	it("tags the sign-out control with the device id for focus lookup", () => {
		render(() => <DeviceItem device={makeDevice()} onSignOut={vi.fn()} />);
		const btn = screen.getByRole("button", { name: /^Sign out/ });
		expect(btn.getAttribute(SIGN_OUT_ATTR)).toBe("DEVICEID");
	});
});
