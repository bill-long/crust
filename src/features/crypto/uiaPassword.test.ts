import { AuthType } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { passwordUiaCallback } from "./uiaPassword";

describe("passwordUiaCallback", () => {
	it("completes without a password when the server needs no auth", async () => {
		const makeRequest = vi.fn(async () => {});
		await passwordUiaCallback("@u:example.com", "pw")(makeRequest);
		expect(makeRequest).toHaveBeenCalledTimes(1);
		expect(makeRequest).toHaveBeenCalledWith(null);
	});

	it("retries with m.login.password against the UIA session on 401", async () => {
		const uia401 = Object.assign(new Error("Unauthorized"), {
			httpStatus: 401,
			data: { session: "sess-1" },
		});
		const makeRequest = vi
			.fn()
			.mockRejectedValueOnce(uia401)
			.mockResolvedValueOnce(undefined);
		await passwordUiaCallback("@u:example.com", "pw")(makeRequest);
		expect(makeRequest).toHaveBeenCalledTimes(2);
		expect(makeRequest).toHaveBeenLastCalledWith({
			type: AuthType.Password,
			identifier: { type: "m.id.user", user: "@u:example.com" },
			password: "pw",
			session: "sess-1",
		});
	});

	it("rethrows a non-401 failure instead of retrying", async () => {
		const boom = Object.assign(new Error("server down"), { httpStatus: 500 });
		const makeRequest = vi.fn().mockRejectedValue(boom);
		await expect(
			passwordUiaCallback("@u:example.com", "pw")(makeRequest),
		).rejects.toBe(boom);
		expect(makeRequest).toHaveBeenCalledTimes(1);
	});

	it("rethrows a 401 without a session instead of retrying", async () => {
		const noSession = Object.assign(new Error("Unauthorized"), {
			httpStatus: 401,
			data: {},
		});
		const makeRequest = vi.fn().mockRejectedValue(noSession);
		await expect(
			passwordUiaCallback("@u:example.com", "pw")(makeRequest),
		).rejects.toBe(noSession);
		expect(makeRequest).toHaveBeenCalledTimes(1);
	});
});
