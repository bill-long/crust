import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DeviceInfo, DeviceItem } from "./DeviceItem";

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
		isVerified: false,
		isCurrentDevice: false,
		...overrides,
	};
}

afterEach(cleanup);

describe("DeviceItem", () => {
	it("shows a visible 'Verified' label for verified devices", () => {
		render(() => <DeviceItem device={makeDevice({ isVerified: true })} />);
		expect(screen.getByText("Verified")).toBeTruthy();
		expect(screen.queryByText("Unverified")).toBeNull();
	});

	it("shows a visible 'Unverified' label (not an icon-only indicator)", () => {
		render(() => <DeviceItem device={makeDevice()} />);
		expect(screen.getByText("Unverified")).toBeTruthy();
		// The bare warning glyph must not be exposed as a labelled image.
		expect(screen.queryByRole("img", { name: "Unverified" })).toBeNull();
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
});
