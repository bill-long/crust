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
});
