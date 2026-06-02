import type { IOpenIDToken } from "matrix-js-sdk";
import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";
import { describe, expect, it, vi } from "vitest";
import { fetchLivekitToken, LivekitJwtError } from "./fetchLivekitToken";

const fakeToken: IOpenIDToken = {
	access_token: "opaque",
	token_type: "Bearer",
	matrix_server_name: "example.com",
	expires_in: 3600,
};

const livekitFocus = (
	overrides?: Partial<LivekitTransport>,
): LivekitTransport => ({
	type: "livekit",
	livekit_service_url: "https://call.example.com/livekit/sfu/get",
	livekit_alias: "!room:example.com",
	...overrides,
});

function mockOk(): { fetchImpl: ReturnType<typeof vi.fn> } {
	const fetchImpl = vi.fn();
	fetchImpl.mockResolvedValue(
		new Response(JSON.stringify({ url: "wss://sfu.example.com", jwt: "JWT" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
	return { fetchImpl };
}

const asFetch = (m: ReturnType<typeof vi.fn>): typeof fetch =>
	m as unknown as typeof fetch;

describe("fetchLivekitToken", () => {
	it("POSTs the openid token + livekit alias to the service URL", async () => {
		const { fetchImpl } = mockOk();
		const res = await fetchLivekitToken(livekitFocus(), fakeToken, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(res).toEqual({ url: "wss://sfu.example.com", jwt: "JWT" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://call.example.com/livekit/sfu/get");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string);
		expect(body).toEqual({
			room: "!room:example.com",
			openid_token: fakeToken,
		});
	});

	it("appends /sfu/get when the service URL is a bare host (MSC4143 standard)", async () => {
		const { fetchImpl } = mockOk();
		await fetchLivekitToken(
			livekitFocus({ livekit_service_url: "https://livekit.example.com" }),
			fakeToken,
			{ fetchImpl: asFetch(fetchImpl) },
		);
		expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
			"https://livekit.example.com/sfu/get",
		);
	});

	it("appends /sfu/get when the service URL is base + /livekit (EC bundled)", async () => {
		const { fetchImpl } = mockOk();
		await fetchLivekitToken(
			livekitFocus({
				livekit_service_url: "https://call.example.com/livekit",
			}),
			fakeToken,
			{ fetchImpl: asFetch(fetchImpl) },
		);
		expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
			"https://call.example.com/livekit/sfu/get",
		);
	});

	it("appends /sfu/get when the service URL has an arbitrary prefix", async () => {
		// Element Call ESS deployments publish e.g. `${host}/livekit/jwt`;
		// the JWT endpoint is `${host}/livekit/jwt/sfu/get`.
		const { fetchImpl } = mockOk();
		await fetchLivekitToken(
			livekitFocus({
				livekit_service_url: "https://matrix-rtc.example.com/livekit/jwt",
			}),
			fakeToken,
			{ fetchImpl: asFetch(fetchImpl) },
		);
		expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
			"https://matrix-rtc.example.com/livekit/jwt/sfu/get",
		);
	});

	it("does not double /sfu/get when already present", async () => {
		const { fetchImpl } = mockOk();
		await fetchLivekitToken(
			livekitFocus({
				livekit_service_url: "https://call.example.com/livekit/sfu/get/",
			}),
			fakeToken,
			{ fetchImpl: asFetch(fetchImpl) },
		);
		expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
			"https://call.example.com/livekit/sfu/get",
		);
	});

	it("throws LivekitJwtError with status on non-2xx", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("Unauthorized", { status: 401 }),
		);
		await expect(
			fetchLivekitToken(livekitFocus(), fakeToken, {
				fetchImpl: asFetch(fetchImpl),
			}),
		).rejects.toMatchObject({ name: "LivekitJwtError", status: 401 });
	});

	it("throws LivekitJwtError on malformed response body", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ url: "wss://x" }), { status: 200 }),
		);
		await expect(
			fetchLivekitToken(livekitFocus(), fakeToken, {
				fetchImpl: asFetch(fetchImpl),
			}),
		).rejects.toBeInstanceOf(LivekitJwtError);
	});

	it("wraps network errors as LivekitJwtError", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(
			fetchLivekitToken(livekitFocus(), fakeToken, {
				fetchImpl: asFetch(fetchImpl),
			}),
		).rejects.toMatchObject({
			name: "LivekitJwtError",
			message: expect.stringContaining("Failed to fetch"),
		});
	});

	it("propagates AbortError untouched", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new DOMException("aborted", "AbortError");
		});
		await expect(
			fetchLivekitToken(livekitFocus(), fakeToken, {
				fetchImpl: asFetch(fetchImpl),
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it.each([
		["relative path", "/sfu/get"],
		["empty string", ""],
		["bare hostname (no scheme)", "livekit.example.com"],
		["javascript: scheme", "javascript:alert(1)"],
		["file: scheme", "file:///etc/passwd"],
	])("refuses to POST the openid token when service URL is %s", async (_label, badUrl) => {
		// Defence-in-depth: parseFociFromWellKnown already filters these
		// out at ingestion, but a malformed value reaching the fetch
		// boundary must throw before fetch() is called — otherwise a
		// relative URL would POST the openid token to the app origin.
		const fetchImpl = vi.fn();
		await expect(
			fetchLivekitToken(
				livekitFocus({ livekit_service_url: badUrl }),
				fakeToken,
				{ fetchImpl: asFetch(fetchImpl) },
			),
		).rejects.toBeInstanceOf(LivekitJwtError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
