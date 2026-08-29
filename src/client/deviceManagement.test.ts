import type { AuthDict, MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { uia401 } from "../test/uiaFixtures";
import { signOutDevice } from "./deviceManagement";

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
