import type { MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildFallbackLivekitFoci, discoverLivekitFoci } from "./discoverFoci";

describe("buildFallbackLivekitFoci", () => {
	it("derives the lk-jwt-service URL from the Element Call URL", () => {
		const foci = buildFallbackLivekitFoci(
			"https://call.example.com",
			"!room:example.com",
		);
		expect(foci).toEqual([
			{
				type: "livekit",
				livekit_service_url: "https://call.example.com/livekit/sfu/get",
				livekit_alias: "!room:example.com",
			},
		]);
	});

	it("strips trailing slashes before appending the service path", () => {
		const foci = buildFallbackLivekitFoci(
			"https://call.example.com///",
			"!a:b",
		);
		expect(foci[0]?.livekit_service_url).toBe(
			"https://call.example.com/livekit/sfu/get",
		);
	});

	it("returns an empty list when the EC URL is missing or whitespace", () => {
		expect(buildFallbackLivekitFoci("", "!r:s")).toEqual([]);
		expect(buildFallbackLivekitFoci("   ", "!r:s")).toEqual([]);
	});

	it("trims the EC URL before building the focus", () => {
		const foci = buildFallbackLivekitFoci(
			"  https://call.example.com  ",
			"!r:s",
		);
		expect(foci[0]?.livekit_service_url).toBe(
			"https://call.example.com/livekit/sfu/get",
		);
	});
});

interface FakeClient {
	getClientWellKnown: ReturnType<typeof vi.fn>;
	getDomain: ReturnType<typeof vi.fn>;
}

function makeClient(overrides: Partial<FakeClient> = {}): MatrixClient {
	return {
		getClientWellKnown: vi.fn(() => undefined),
		getDomain: vi.fn(() => undefined),
		...overrides,
	} as unknown as MatrixClient;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const asFetch = (m: ReturnType<typeof vi.fn>): typeof fetch =>
	m as unknown as typeof fetch;

describe("discoverLivekitFoci", () => {
	const ROOM = "!room:example.com";
	const EC = "https://call.example.com";

	it("returns foci from the SDK's cached well-known when present", async () => {
		const client = makeClient({
			getClientWellKnown: vi.fn(() => ({
				"org.matrix.msc4143.rtc_foci": [
					{
						type: "livekit",
						livekit_service_url: "https://livekit.example.com",
					},
				],
			})),
		});
		const fetchImpl = vi.fn();
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual([
			{
				type: "livekit",
				livekit_service_url: "https://livekit.example.com",
				livekit_alias: ROOM,
			},
		]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("fetches .well-known/matrix/client when the cache is empty", async () => {
		const client = makeClient({
			getClientWellKnown: vi.fn(() => undefined),
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				"org.matrix.msc4143.rtc_foci": [
					{
						type: "livekit",
						livekit_service_url: "https://livekit.example.com",
					},
				],
			}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://example.com/.well-known/matrix/client",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(foci).toEqual([
			{
				type: "livekit",
				livekit_service_url: "https://livekit.example.com",
				livekit_alias: ROOM,
			},
		]);
	});

	it("trims whitespace inside livekit_service_url entries", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				"org.matrix.msc4143.rtc_foci": [
					{
						type: "livekit",
						livekit_service_url: "  https://livekit.example.com  ",
					},
				],
			}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci[0]?.livekit_service_url).toBe("https://livekit.example.com");
	});

	it("preserves the order of multiple foci entries", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				"org.matrix.msc4143.rtc_foci": [
					{ type: "livekit", livekit_service_url: "https://primary.example" },
					{ type: "livekit", livekit_service_url: "https://backup.example" },
				],
			}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci.map((f) => f.livekit_service_url)).toEqual([
			"https://primary.example",
			"https://backup.example",
		]);
	});

	it("skips non-livekit transport entries", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				"org.matrix.msc4143.rtc_foci": [
					{ type: "full_mesh" },
					{ type: "livekit", livekit_service_url: "https://livekit.example" },
				],
			}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toHaveLength(1);
		expect(foci[0]?.livekit_service_url).toBe("https://livekit.example");
	});

	it("rejects entries with missing or non-string livekit_service_url", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				"org.matrix.msc4143.rtc_foci": [
					{ type: "livekit" },
					{ type: "livekit", livekit_service_url: 42 },
					{ type: "livekit", livekit_service_url: "" },
					{ type: "livekit", livekit_service_url: "   " },
				],
			}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		// All entries invalid → returns the EC-bundled fallback.
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("rejects entries with non-absolute or non-http(s) livekit_service_url", async () => {
		// External data hardening: a malformed or hostile well-known
		// could otherwise direct the OpenID token POST at the app
		// origin (relative URL) or a non-http scheme (javascript:,
		// file:, etc.). Each invalid entry must be skipped so a single
		// valid focus or the EC fallback still wins.
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				"org.matrix.msc4143.rtc_foci": [
					{ type: "livekit", livekit_service_url: "livekit.example.com" },
					{ type: "livekit", livekit_service_url: "/sfu/get" },
					{
						type: "livekit",
						livekit_service_url: "javascript:alert(1)",
					},
					{ type: "livekit", livekit_service_url: "file:///etc/passwd" },
					{
						type: "livekit",
						livekit_service_url: "https://livekit.example.com",
					},
				],
			}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		// Only the https entry survives.
		expect(foci).toEqual([
			{
				type: "livekit",
				livekit_service_url: "https://livekit.example.com",
				livekit_alias: ROOM,
			},
		]);
	});

	it("aborts the in-flight fetch when the caller-supplied signal fires", async () => {
		// Regression: onCleanup in useRtcSession passes an AbortSignal
		// so a quickly-opened-and-closed call overlay can cancel the
		// in-flight well-known fetch instead of wasting a full 5s
		// timeout of network work.
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		let receivedSignal: AbortSignal | undefined;
		const fetchImpl = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					receivedSignal = init?.signal;
					init?.signal?.addEventListener("abort", () => {
						reject(
							new DOMException("The operation was aborted.", "AbortError"),
						);
					});
				}),
		);
		const external = new AbortController();
		const promise = discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
			signal: external.signal,
		});
		// Cancel before the fetch resolves.
		external.abort();
		const foci = await promise;
		expect(receivedSignal?.aborted).toBe(true);
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("falls back when a custom discoverFoci-style override throws synchronously", async () => {
		// Regression: useRtcSession wraps the override in
		// Promise.resolve().then(...) so a sync throw is normalised
		// into a rejection. This test pins the discoverLivekitFoci
		// contract (must not throw out of its own body even if the
		// SDK's getClientWellKnown throws synchronously).
		const client = makeClient({
			getClientWellKnown: vi.fn(() => {
				throw new Error("sdk blew up");
			}),
			getDomain: vi.fn(() => undefined),
		});
		const foci = await discoverLivekitFoci(client, EC, ROOM);
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("falls back to buildFallbackLivekitFoci when .well-known has no foci block", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ "m.homeserver": { base_url: "https://example.com/" } }),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("falls back when the .well-known fetch hangs past the timeout", async () => {
		// Regression: a homeserver that accepts the TCP connection but
		// never responds would otherwise hang fociReady forever and
		// permanently block Join. The fetch must abort and fall through
		// to the EC-bundled fallback.
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(
							new DOMException("The operation was aborted.", "AbortError"),
						);
					});
				}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
			timeoutMs: 5,
		});
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("falls back when the .well-known fetch errors", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("falls back when the .well-known fetch returns a non-2xx", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(
			async () => new Response("Not Found", { status: 404 }),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("falls back when the .well-known body is not valid JSON", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
		});
		const fetchImpl = vi.fn(
			async () =>
				new Response("not json", {
					status: 200,
					headers: { "Content-Type": "text/plain" },
				}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("returns an empty list when there is no domain and no EC URL", async () => {
		const client = makeClient({
			getDomain: vi.fn(() => undefined),
		});
		const fetchImpl = vi.fn();
		const foci = await discoverLivekitFoci(client, "", ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("survives a missing getClientWellKnown method on the client shape", async () => {
		// Some test/fake clients omit getClientWellKnown entirely; the
		// function must not throw and must still hit the fetch path.
		const client = {
			getDomain: vi.fn(() => "example.com"),
		} as unknown as MatrixClient;
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				"org.matrix.msc4143.rtc_foci": [
					{ type: "livekit", livekit_service_url: "https://livekit.example" },
				],
			}),
		);
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toHaveLength(1);
	});
});
