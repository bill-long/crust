import { AuthType, type MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { uia401 } from "../test/uiaFixtures";
import {
	changePassword,
	deactivateAccount,
	fetchThreePids,
} from "./accountSecurity";

interface ClientMocks {
	setPassword?: ReturnType<typeof vi.fn>;
	deactivateAccount?: ReturnType<typeof vi.fn>;
	getThreePids?: ReturnType<typeof vi.fn>;
}

function clientWith(mocks: ClientMocks): MatrixClient {
	return {
		getUserId: () => "@u:example.com",
		...mocks,
	} as unknown as MatrixClient;
}

const PASSWORD_FLOW = [["m.login.password"]];

describe("changePassword", () => {
	it("completes in one request when the server needs no auth", async () => {
		const setPassword = vi.fn(async () => ({}));
		await changePassword(clientWith({ setPassword }), {
			currentPassword: "old",
			newPassword: "new",
			logoutOtherDevices: false,
		});
		expect(setPassword).toHaveBeenCalledTimes(1);
		expect(setPassword).toHaveBeenCalledWith(undefined, "new", false);
	});

	it("answers the password challenge against the 401's session", async () => {
		const setPassword = vi
			.fn()
			.mockRejectedValueOnce(uia401("sess-1", PASSWORD_FLOW))
			.mockResolvedValueOnce({});
		await changePassword(clientWith({ setPassword }), {
			currentPassword: "old",
			newPassword: "new",
			logoutOtherDevices: true,
		});
		expect(setPassword).toHaveBeenLastCalledWith(
			{
				type: AuthType.Password,
				identifier: { type: "m.id.user", user: "@u:example.com" },
				password: "old",
				session: "sess-1",
			},
			"new",
			true,
		);
	});

	it("fails with a clear message when no password flow is offered", async () => {
		const setPassword = vi
			.fn()
			.mockRejectedValue(uia401("sess-1", [["m.oauth"]]));
		await expect(
			changePassword(clientWith({ setPassword }), {
				currentPassword: "old",
				newPassword: "new",
				logoutOtherDevices: false,
			}),
		).rejects.toThrow(/does not accept a password/);
		expect(setPassword).toHaveBeenCalledTimes(1);
	});

	it("propagates a wrong-password rejection", async () => {
		const wrong = Object.assign(new Error("Invalid password"), {
			httpStatus: 401,
			data: { errcode: "M_FORBIDDEN" },
		});
		const setPassword = vi
			.fn()
			.mockRejectedValueOnce(uia401("sess-1", PASSWORD_FLOW))
			.mockRejectedValueOnce(wrong);
		await expect(
			changePassword(clientWith({ setPassword }), {
				currentPassword: "nope",
				newPassword: "new",
				logoutOtherDevices: false,
			}),
		).rejects.toBe(wrong);
	});

	it("rethrows non-UIA failures without retrying", async () => {
		const boom = Object.assign(new Error("down"), { httpStatus: 500 });
		const setPassword = vi.fn().mockRejectedValue(boom);
		await expect(
			changePassword(clientWith({ setPassword }), {
				currentPassword: "old",
				newPassword: "new",
				logoutOtherDevices: false,
			}),
		).rejects.toBe(boom);
		expect(setPassword).toHaveBeenCalledTimes(1);
	});
});

describe("deactivateAccount", () => {
	it("answers the password challenge and sends the erase flag", async () => {
		const deactivate = vi
			.fn()
			.mockRejectedValueOnce(uia401("sess-9", PASSWORD_FLOW))
			.mockResolvedValueOnce({});
		await deactivateAccount(clientWith({ deactivateAccount: deactivate }), {
			password: "pw",
			erase: true,
		});
		expect(deactivate).toHaveBeenLastCalledWith(
			{
				type: AuthType.Password,
				identifier: { type: "m.id.user", user: "@u:example.com" },
				password: "pw",
				session: "sess-9",
			},
			true,
		);
	});
});

describe("fetchThreePids", () => {
	it("returns the well-formed identifiers", async () => {
		const getThreePids = vi.fn(async () => ({
			threepids: [
				{ medium: "email", address: "a@b.c", validated_at: 1 },
				{ medium: 42, address: "junk" },
				"garbage",
				{ medium: "msisdn", address: "+15551234" },
			],
		}));
		await expect(fetchThreePids(clientWith({ getThreePids }))).resolves.toEqual(
			[
				{ medium: "email", address: "a@b.c", validated_at: 1 },
				{ medium: "msisdn", address: "+15551234" },
			],
		);
	});

	it("returns empty for a malformed response", async () => {
		const getThreePids = vi.fn(async () => ({ threepids: "nope" }));
		await expect(fetchThreePids(clientWith({ getThreePids }))).resolves.toEqual(
			[],
		);
	});
});
