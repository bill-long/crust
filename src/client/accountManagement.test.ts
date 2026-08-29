import type { MatrixClient } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	ACCOUNT_MANAGEMENT_ACTIONS,
	fetchAccountManagementUrl,
} from "./accountManagement";

function clientWithMetadata(metadata: unknown): MatrixClient {
	return {
		getAuthMetadata: async () => {
			if (metadata instanceof Error) throw metadata;
			return metadata;
		},
	} as unknown as MatrixClient;
}

const RESET = ACCOUNT_MANAGEMENT_ACTIONS.crossSigningReset;
const DEVICE_DELETE = ACCOUNT_MANAGEMENT_ACTIONS.deviceDelete;

describe("fetchAccountManagementUrl", () => {
	it("deeplinks the action when the server advertises it", async () => {
		const client = clientWithMetadata({
			account_management_uri: "https://hs.example/account",
			account_management_actions_supported: [
				"org.matrix.profile",
				"org.matrix.cross_signing_reset",
			],
		});
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBe(
			"https://hs.example/account?action=org.matrix.cross_signing_reset",
		);
	});

	it("keeps existing query params when appending the action", async () => {
		const client = clientWithMetadata({
			account_management_uri: "https://hs.example/account?tab=security",
			account_management_actions_supported: [RESET],
		});
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBe(
			"https://hs.example/account?tab=security&action=org.matrix.cross_signing_reset",
		);
	});

	it("falls back to the base URI when the action isn't advertised", async () => {
		const client = clientWithMetadata({
			account_management_uri: "https://hs.example/account",
			account_management_actions_supported: ["org.matrix.profile"],
		});
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBe(
			"https://hs.example/account",
		);
	});

	it("falls back to the base URI when no action list is advertised", async () => {
		const client = clientWithMetadata({
			account_management_uri: "https://hs.example/account",
		});
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBe(
			"https://hs.example/account",
		);
	});

	it("returns null when the server has no OAuth metadata", async () => {
		const client = clientWithMetadata(new Error("M_UNRECOGNIZED"));
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBeNull();
	});

	it("returns null when the metadata has no account management URI", async () => {
		const client = clientWithMetadata({ issuer: "https://hs.example/" });
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBeNull();
	});

	it("returns null for a non-web account management URI", async () => {
		const client = clientWithMetadata({
			account_management_uri: "javascript:alert(1)",
			account_management_actions_supported: [RESET],
		});
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBeNull();
	});

	it("returns null for a malformed account management URI", async () => {
		const client = clientWithMetadata({
			account_management_uri: "not a url",
			account_management_actions_supported: [RESET],
		});
		await expect(fetchAccountManagementUrl(client, RESET)).resolves.toBeNull();
	});

	// #556: the device actions take a device_id alongside the action.
	it("carries the device id when the device action is advertised", async () => {
		const client = clientWithMetadata({
			account_management_uri: "https://hs.example/account",
			account_management_actions_supported: [DEVICE_DELETE],
		});
		await expect(
			fetchAccountManagementUrl(client, DEVICE_DELETE, {
				deviceId: "ABCDEF",
			}),
		).resolves.toBe(
			"https://hs.example/account?action=org.matrix.device_delete&device_id=ABCDEF",
		);
	});

	it("drops the device id when the action isn't advertised", async () => {
		// The base URL targets no device, so a device_id riding along on it
		// would be a parameter the page has no action to apply it to.
		const client = clientWithMetadata({
			account_management_uri: "https://hs.example/account",
			account_management_actions_supported: ["org.matrix.profile"],
		});
		await expect(
			fetchAccountManagementUrl(client, DEVICE_DELETE, {
				deviceId: "ABCDEF",
			}),
		).resolves.toBe("https://hs.example/account");
	});

	it("percent-encodes a device id with URL-significant characters", async () => {
		const client = clientWithMetadata({
			account_management_uri: "https://hs.example/account",
			account_management_actions_supported: [DEVICE_DELETE],
		});
		await expect(
			fetchAccountManagementUrl(client, DEVICE_DELETE, {
				deviceId: "a&b=c d",
			}),
		).resolves.toBe(
			"https://hs.example/account?action=org.matrix.device_delete&device_id=a%26b%3Dc+d",
		);
	});
});
