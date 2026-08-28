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
});
