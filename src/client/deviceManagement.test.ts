import type { AuthDict, MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { uia401 } from "../test/uiaFixtures";
import { signOutDevice, signOutOtherDevices } from "./deviceManagement";

/** A UIA callback that answers a password challenge with `password`. */
function passwordCallback(password: string) {
	return async (
		makeRequest: (auth: AuthDict | null) => Promise<void>,
	): Promise<void> => {
		try {
			await makeRequest(null);
			return;
		} catch {
			await makeRequest({
				type: "m.login.password",
				password,
				session: "sess",
			} as unknown as AuthDict);
		}
	};
}

describe("signOutDevice", () => {
	it("discovers the challenge with no auth dict, then completes it", async () => {
		const deleteDevice = vi
			.fn()
			.mockRejectedValueOnce(uia401("sess", [["m.login.password"]]))
			.mockResolvedValueOnce({});
		const client = { deleteDevice } as unknown as MatrixClient;

		await signOutDevice(client, "OTHERDEV", passwordCallback("hunter2"));

		expect(deleteDevice).toHaveBeenNthCalledWith(1, "OTHERDEV", undefined);
		expect(deleteDevice).toHaveBeenNthCalledWith(
			2,
			"OTHERDEV",
			expect.objectContaining({ password: "hunter2" }),
		);
	});

	it("resolves without auth when the server needs none", async () => {
		const deleteDevice = vi.fn().mockResolvedValue({});
		const client = { deleteDevice } as unknown as MatrixClient;

		await signOutDevice(client, "OTHERDEV", passwordCallback("unused"));

		expect(deleteDevice).toHaveBeenCalledTimes(1);
		expect(deleteDevice).toHaveBeenCalledWith("OTHERDEV", undefined);
	});

	it("propagates a failure the callback rethrows", async () => {
		const boom = Object.assign(new Error("server down"), { httpStatus: 500 });
		const client = {
			deleteDevice: vi.fn().mockRejectedValue(boom),
		} as unknown as MatrixClient;

		await expect(
			signOutDevice(client, "OTHERDEV", async (makeRequest) => {
				await makeRequest(null);
			}),
		).rejects.toBe(boom);
	});
});

describe("signOutOtherDevices", () => {
	/** A client whose current device is THISDEV. */
	function clientWith(deleteMultipleDevices: ReturnType<typeof vi.fn>) {
		return {
			getDeviceId: () => "THISDEV",
			deleteMultipleDevices,
		} as unknown as MatrixClient;
	}

	it("revokes the whole set in one request, after one challenge", async () => {
		const deleteMultipleDevices = vi
			.fn()
			.mockRejectedValueOnce(uia401("sess", [["m.login.password"]]))
			.mockResolvedValueOnce({});

		await signOutOtherDevices(
			clientWith(deleteMultipleDevices),
			["DEV_A", "DEV_B"],
			passwordCallback("hunter2"),
		);

		expect(deleteMultipleDevices).toHaveBeenNthCalledWith(
			1,
			["DEV_A", "DEV_B"],
			undefined,
		);
		expect(deleteMultipleDevices).toHaveBeenNthCalledWith(
			2,
			["DEV_A", "DEV_B"],
			expect.objectContaining({ password: "hunter2" }),
		);
	});

	// The UI hides the control for the current row, but that flag is not
	// the enforcement: revoking this session's own device is logging out,
	// which has its own teardown, and reaching it through here would leave
	// the app holding a dead token with none of it done.
	it("never revokes the device this session is running on", async () => {
		const deleteMultipleDevices = vi.fn().mockResolvedValue({});

		await signOutOtherDevices(
			clientWith(deleteMultipleDevices),
			["DEV_A", "THISDEV", "DEV_B"],
			passwordCallback("unused"),
		);

		expect(deleteMultipleDevices).toHaveBeenCalledWith(
			["DEV_A", "DEV_B"],
			undefined,
		);
	});

	it("sends nothing when only the current device was asked for", async () => {
		const deleteMultipleDevices = vi.fn().mockResolvedValue({});

		await signOutOtherDevices(
			clientWith(deleteMultipleDevices),
			["THISDEV"],
			passwordCallback("unused"),
		);

		expect(deleteMultipleDevices).not.toHaveBeenCalled();
	});

	// An empty request would still make the user answer a UIA challenge -
	// Continuwuity challenges an empty device list too (wire-verified).
	it("sends nothing for an empty set", async () => {
		const deleteMultipleDevices = vi.fn().mockResolvedValue({});

		await signOutOtherDevices(
			clientWith(deleteMultipleDevices),
			[],
			passwordCallback("unused"),
		);

		expect(deleteMultipleDevices).not.toHaveBeenCalled();
	});

	it("drops an id the server reported empty rather than sending it", async () => {
		const deleteMultipleDevices = vi.fn().mockResolvedValue({});

		await signOutOtherDevices(
			clientWith(deleteMultipleDevices),
			["", "DEV_A"],
			passwordCallback("unused"),
		);

		expect(deleteMultipleDevices).toHaveBeenCalledWith(["DEV_A"], undefined);
	});

	it("propagates a failure the callback rethrows", async () => {
		const boom = Object.assign(new Error("server down"), { httpStatus: 500 });
		const client = clientWith(vi.fn().mockRejectedValue(boom));

		await expect(
			signOutOtherDevices(client, ["DEV_A"], async (makeRequest) => {
				await makeRequest(null);
			}),
		).rejects.toBe(boom);
	});
});
