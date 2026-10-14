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

const fakeDeviceId = "DEVABC123";

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
	it("POSTs the openid token + livekit alias + device_id to the service URL", async () => {
		const { fetchImpl } = mockOk();
		const res = await fetchLivekitToken(
			livekitFocus(),
			fakeToken,
			"DEVICEXYZ",
			{
				fetchImpl: asFetch(fetchImpl),
			},
		);
		expect(res).toEqual({ url: "wss://sfu.example.com", jwt: "JWT" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://call.example.com/livekit/sfu/get");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string);
		expect(body).toEqual({
			room: "!room:example.com",
			openid_token: fakeToken,
			device_id: "DEVICEXYZ",
		});
	});

	it("throws LivekitJwtError when device_id is empty (identity-mismatch defence)", async () => {
		// lk-jwt-service builds identity as `<userId>:<deviceId>`. An
		// empty device_id silently yields `@user:server:` which mismatches
		// matrix-js-sdk's `rtcBackendIdentity` and breaks outbound E2EE
		// (see element-hq/lk-jwt-service main.go).
		const fetchImpl = vi.fn();
		await expect(
			fetchLivekitToken(livekitFocus(), fakeToken, "", {
				fetchImpl: asFetch(fetchImpl),
			}),
		).rejects.toBeInstanceOf(LivekitJwtError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("appends /sfu/get when the service URL is a bare host (MSC4143 standard)", async () => {
		const { fetchImpl } = mockOk();
		await fetchLivekitToken(
			livekitFocus({ livekit_service_url: "https://livekit.example.com" }),
			fakeToken,
			fakeDeviceId,
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
			fakeDeviceId,
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
			fakeDeviceId,
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
			fakeDeviceId,
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
			fetchLivekitToken(livekitFocus(), fakeToken, fakeDeviceId, {
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
			fetchLivekitToken(livekitFocus(), fakeToken, fakeDeviceId, {
				fetchImpl: asFetch(fetchImpl),
			}),
		).rejects.toBeInstanceOf(LivekitJwtError);
	});

	it("wraps network errors as LivekitJwtError", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(
			fetchLivekitToken(livekitFocus(), fakeToken, fakeDeviceId, {
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
			fetchLivekitToken(livekitFocus(), fakeToken, fakeDeviceId, {
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
	])(
		"refuses to POST the openid token when service URL is %s",
		async (_label, badUrl) => {
			// Defence-in-depth: parseFociFromWellKnown already filters these
			// out at ingestion, but a malformed value reaching the fetch
			// boundary must throw before fetch() is called - otherwise a
			// relative URL would POST the openid token to the app origin.
			const fetchImpl = vi.fn();
			await expect(
				fetchLivekitToken(
					livekitFocus({ livekit_service_url: badUrl }),
					fakeToken,
					fakeDeviceId,
					{ fetchImpl: asFetch(fetchImpl) },
				),
			).rejects.toBeInstanceOf(LivekitJwtError);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
});

const own = {
	roomId: "!room:example.com",
	userId: "@alice:example.com",
	deviceId: fakeDeviceId,
	memberId: "member-uuid",
	backendIdentity: "current-hash",
	modern: true,
};

describe("current MatrixRTC token contracts", () => {
	it("uses flat member_id at the authenticated homeserver endpoint without sending OpenID there", async () => {
		const authedRequest = vi.fn().mockResolvedValue({ jwt: "CURRENT" });
		const fetchImpl = vi.fn();
		const openId = vi.fn().mockRejectedValue(new Error("OpenID disabled"));
		const response = await fetchLivekitToken(
			livekitFocus({
				url: "wss://sfu.example.com",
				server_name: "foreign.example",
			}),
			openId,
			fakeDeviceId,
			{
				client: { http: { authedRequest } } as never,
				membership: own,
				fetchImpl: asFetch(fetchImpl),
			},
		);
		expect(response).toEqual({
			url: "wss://sfu.example.com",
			jwt: "CURRENT",
			localIdentity: "current-hash",
		});
		expect(authedRequest).toHaveBeenCalledWith(
			"POST",
			"/rtc/livekit/get_token",
			undefined,
			{
				url: "wss://sfu.example.com",
				server_name: "foreign.example",
				room_id: own.roomId,
				slot_id: "m.call#ROOM",
				member_id: own.memberId,
			},
			expect.objectContaining({
				prefix: "/_matrix/client/unstable/io.element.msc4195",
			}),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(openId).not.toHaveBeenCalled();
	});
	it("falls back to the advertised legacy publisher route only for an unsupported endpoint", async () => {
		const authedRequest = vi
			.fn()
			.mockRejectedValue({ errcode: "M_UNRECOGNIZED" });
		const { fetchImpl } = mockOk();
		const response = await fetchLivekitToken(
			livekitFocus({ url: "wss://sfu.example.com" }),
			fakeToken,
			fakeDeviceId,
			{
				client: { http: { authedRequest } } as never,
				membership: own,
				fetchImpl: asFetch(fetchImpl),
			},
		);
		expect(fetchImpl.mock.calls[0]?.[0]).toContain("/sfu/get");
		expect(response.localIdentity).toBe(`${own.userId}:${fakeDeviceId}`);
	});
	it.each([
		{ errcode: "M_FORBIDDEN" },
		{ httpStatus: 404 },
		new TypeError("offline"),
		new DOMException("aborted", "AbortError"),
	])(
		"does not downgrade a failed authenticated request (%s)",
		async (error) => {
			const fetchImpl = vi.fn();
			await expect(
				fetchLivekitToken(
					livekitFocus({ url: "wss://sfu.example.com" }),
					fakeToken,
					fakeDeviceId,
					{
						client: {
							http: { authedRequest: vi.fn().mockRejectedValue(error) },
						} as never,
						membership: own,
						fetchImpl: asFetch(fetchImpl),
					},
				),
			).rejects.toEqual(error);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
	it("tries the standalone hashed subscriber endpoint before legacy, using the Matrix room ID without an alias", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("missing", { status: 404 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ url: "wss://sfu", jwt: "JWT" })),
			);
		await fetchLivekitToken(
			{
				type: "livekit",
				livekit_service_url: "https://foreign.example/jwt/sfu/get?tenant=1",
			},
			fakeToken,
			fakeDeviceId,
			{ membership: own, subscriber: true, fetchImpl },
		);
		expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
			"https://foreign.example/jwt/get_token?tenant=1",
			"https://foreign.example/jwt/sfu/get?tenant=1",
		]);
		expect(JSON.parse(fetchImpl.mock.calls[0]?.[1].body)).toEqual({
			room_id: own.roomId,
			slot_id: "m.call#ROOM",
			openid_token: fakeToken,
			member: {
				id: own.memberId,
				claimed_user_id: own.userId,
				claimed_device_id: fakeDeviceId,
			},
		});
		expect(JSON.parse(fetchImpl.mock.calls[1]?.[1].body).room).toBe(own.roomId);
	});
	it("does not send a legacy publisher to a hashed endpoint", async () => {
		const { fetchImpl } = mockOk();
		const authedRequest = vi.fn();
		await fetchLivekitToken(
			livekitFocus({ url: "wss://sfu" }),
			fakeToken,
			fakeDeviceId,
			{
				client: { http: { authedRequest } } as never,
				membership: { ...own, modern: false },
				fetchImpl: asFetch(fetchImpl),
			},
		);
		expect(authedRequest).not.toHaveBeenCalled();
		expect(fetchImpl.mock.calls[0]?.[0]).toContain("/sfu/get");
	});
	it("fails a URL-only transport without inventing a fallback service", async () => {
		const fetchImpl = vi.fn();
		const error = { errcode: "M_NOT_FOUND" };
		await expect(
			fetchLivekitToken(
				{ type: "livekit", livekit_service_url: "", url: "wss://sfu" },
				fakeToken,
				fakeDeviceId,
				{
					client: {
						http: { authedRequest: vi.fn().mockRejectedValue(error) },
					} as never,
					membership: own,
					fetchImpl: asFetch(fetchImpl),
				},
			),
		).rejects.toEqual(error);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
