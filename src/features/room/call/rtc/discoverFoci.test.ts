import { type MatrixClient, MatrixError } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	http: { authedRequest: ReturnType<typeof vi.fn> } | undefined;
}

/** What a homeserver without MSC4519 answers: 404 M_UNRECOGNIZED. */
const endpointMissing = () =>
	new MatrixError(
		{ errcode: "M_UNRECOGNIZED", error: "Unrecognized request" },
		404,
	);

type RequestOpts = { abortSignal?: AbortSignal; localTimeoutMs?: number };

/**
 * An `http.authedRequest` fake for the transports endpoint. `answer` runs
 * with the request options so a case can inspect the timeout budget or
 * hold the request open; a held request rejects when `abortSignal` fires,
 * as the SDK's does.
 */
function transportsRequest(
	answer: (opts: RequestOpts) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
	return vi.fn(
		(
			_method: string,
			_path: string,
			_query: unknown,
			_body: unknown,
			opts: RequestOpts,
		) =>
			new Promise((resolve, reject) => {
				opts.abortSignal?.addEventListener("abort", () =>
					reject(new DOMException("The operation was aborted.", "AbortError")),
				);
				answer(opts).then(resolve, reject);
			}),
	);
}

const endpointAnswers = (transports: unknown) =>
	transportsRequest(async () => ({ rtc_transports: transports }));
const endpointRejects = (err: () => unknown) =>
	transportsRequest(async () => {
		throw err();
	});

function makeClient(overrides: Partial<FakeClient> = {}): MatrixClient {
	return {
		getClientWellKnown: vi.fn(() => undefined),
		getDomain: vi.fn(() => undefined),
		// The default server has no MSC4519 endpoint, so the pre-existing
		// well-known cases run unchanged past step 0.
		http: { authedRequest: endpointRejects(endpointMissing) },
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
		// Cancel once the fetch is in flight (the MSC4519 probe runs first,
		// so it is not in flight synchronously) and before it resolves.
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
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
		// No HTTP layer, so the transports probe does not spend any of the
		// budget before the fetch and the timeout path itself is what runs.
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
			http: undefined,
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
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
			timeoutMs: 5,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(receivedSignal?.aborted).toBe(true);
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

describe("discoverLivekitFoci via MSC4519 /rtc/transports (#506)", () => {
	const ROOM = "!room:example.com";
	const EC = "https://call.example.com";
	const WELL_KNOWN = {
		"org.matrix.msc4143.rtc_foci": [
			{ type: "livekit", livekit_service_url: "https://wk.example.com" },
		],
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	it("prefers the transports endpoint and never touches .well-known", async () => {
		const request = endpointAnswers([
			{ type: "livekit", livekit_service_url: "https://ep.example.com" },
		]);
		const client = makeClient({
			getClientWellKnown: vi.fn(() => WELL_KNOWN),
			getDomain: vi.fn(() => "example.com"),
			http: { authedRequest: request },
		});
		const fetchImpl = vi.fn();
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual([
			{
				type: "livekit",
				livekit_service_url: "https://ep.example.com",
				livekit_alias: ROOM,
			},
		]);
		expect(request).toHaveBeenCalledWith(
			"GET",
			"/rtc/transports",
			undefined,
			undefined,
			expect.objectContaining({
				prefix: "/_matrix/client/unstable/org.matrix.msc4143",
			}),
		);
		expect(client.getClientWellKnown).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("validates endpoint entries with the same rules as .well-known", async () => {
		const client = makeClient({
			http: {
				authedRequest: endpointAnswers([
					{ type: "sip", uri: "sip:example.com" },
					{ type: "livekit", livekit_service_url: "/relative" },
					{ type: "livekit", livekit_service_url: "javascript:alert(1)" },
					{ type: "livekit" },
					{ type: "livekit", livekit_service_url: "  https://ok.example.com " },
				]),
			},
		});
		const foci = await discoverLivekitFoci(client, EC, ROOM);
		expect(foci.map((f) => f.livekit_service_url)).toEqual([
			"https://ok.example.com",
		]);
	});

	it("falls through to .well-known on M_UNRECOGNIZED and does not ask that client again", async () => {
		// A server without the MSC: one probe per client, then straight to
		// .well-known on every later join.
		const request = endpointRejects(endpointMissing);
		const client = makeClient({
			getClientWellKnown: vi.fn(() => WELL_KNOWN),
			http: { authedRequest: request },
		});
		const first = await discoverLivekitFoci(client, EC, ROOM);
		const second = await discoverLivekitFoci(client, EC, ROOM);
		expect(first[0]?.livekit_service_url).toBe("https://wk.example.com");
		expect(second[0]?.livekit_service_url).toBe("https://wk.example.com");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("keeps asking after a transient failure or a bare proxy 404", async () => {
		// A 502 from a proxy, a dropped connection, or a 404 with no Matrix
		// body say nothing about whether the server serves the endpoint; the
		// next join tries again.
		for (const err of [
			() =>
				new MatrixError({ errcode: "M_UNKNOWN", error: "bad gateway" }, 502),
			() => ({ httpStatus: 404 }),
			() => new TypeError("Failed to fetch"),
		]) {
			const request = endpointRejects(err);
			const client = makeClient({
				getClientWellKnown: vi.fn(() => WELL_KNOWN),
				http: { authedRequest: request },
			});
			await discoverLivekitFoci(client, EC, ROOM);
			await discoverLivekitFoci(client, EC, ROOM);
			expect(request).toHaveBeenCalledTimes(2);
		}
	});

	it("honours an empty answer: no .well-known, only the operator's EC fallback", async () => {
		// The endpoint is authenticated and per-user; a server that hands this
		// user no transport is not overridden by the global .well-known list.
		const client = makeClient({
			getClientWellKnown: vi.fn(() => WELL_KNOWN),
			getDomain: vi.fn(() => "example.com"),
			http: { authedRequest: endpointAnswers([]) },
		});
		const fetchImpl = vi.fn();
		const foci = await discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
		});
		expect(foci).toEqual(buildFallbackLivekitFoci(EC, ROOM));
		expect(client.getClientWellKnown).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("aborts a hung transports request at the deadline", async () => {
		// The request is cancelled on the wire through its abortSignal, not
		// abandoned in flight on the origin /sync shares.
		vi.useFakeTimers();
		let seen: RequestOpts | undefined;
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
			http: {
				authedRequest: transportsRequest((opts) => {
					seen = opts;
					return new Promise(() => {});
				}),
			},
		});
		const fetchImpl = vi.fn();
		const pending = discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
			timeoutMs: 1234,
		});
		await vi.advanceTimersByTimeAsync(1233);
		expect(seen?.abortSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(seen?.abortSignal?.aborted).toBe(true);
		expect(await pending).toEqual(buildFallbackLivekitFoci(EC, ROOM));
		// The budget is spent: the .well-known fetch is not even started.
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("treats a 2xx without the array as malformed, not as an empty answer", async () => {
		// A proxy's `200 {}` on the unstable path must not silence a working
		// .well-known.
		for (const body of [{}, null, { rtc_transports: "nope" }]) {
			const client = makeClient({
				getClientWellKnown: vi.fn(() => WELL_KNOWN),
				http: { authedRequest: transportsRequest(async () => body) },
			});
			const foci = await discoverLivekitFoci(client, EC, ROOM);
			expect(foci[0]?.livekit_service_url, JSON.stringify(body)).toBe(
				"https://wk.example.com",
			);
		}
	});

	it("shares one deadline with the .well-known fetch", async () => {
		// A transports request that eats 3 s of a 5 s budget leaves the
		// .well-known fetch 2 s, not a fresh 5: the join waits at most the
		// budget, not twice it.
		vi.useFakeTimers();
		const client = makeClient({
			getDomain: vi.fn(() => "example.com"),
			http: {
				authedRequest: transportsRequest(
					() =>
						new Promise((_resolve, reject) =>
							setTimeout(() => reject(new Error("slow")), 3_000),
						),
				),
			},
		});
		let abortedAt: number | undefined;
		const fetchImpl = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						abortedAt = Date.now();
						reject(
							new DOMException("The operation was aborted.", "AbortError"),
						);
					});
				}),
		);
		const start = Date.now();
		const pending = discoverLivekitFoci(client, EC, ROOM, {
			fetchImpl: asFetch(fetchImpl),
			timeoutMs: 5_000,
		});
		await vi.advanceTimersByTimeAsync(5_100);
		expect(await pending).toEqual(buildFallbackLivekitFoci(EC, ROOM));
		expect(abortedAt).toBeDefined();
		expect((abortedAt ?? 0) - start).toBeLessThanOrEqual(5_000);
	});

	it("stops waiting on the endpoint when the caller aborts", async () => {
		const controller = new AbortController();
		const client = makeClient({
			http: { authedRequest: transportsRequest(() => new Promise(() => {})) },
		});
		const pending = discoverLivekitFoci(client, EC, ROOM, {
			signal: controller.signal,
			timeoutMs: 10_000,
		});
		controller.abort();
		// The abort is honoured by every step, so the result is the EC
		// fallback rather than a hang.
		expect(await pending).toEqual(buildFallbackLivekitFoci(EC, ROOM));
	});

	it("survives a client shape without an HTTP layer", async () => {
		const client = makeClient({
			getClientWellKnown: vi.fn(() => WELL_KNOWN),
			http: undefined,
		});
		const foci = await discoverLivekitFoci(client, EC, ROOM);
		expect(foci[0]?.livekit_service_url).toBe("https://wk.example.com");
	});
});
