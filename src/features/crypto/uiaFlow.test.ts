import { AuthType, type MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { uia401 } from "../../test/uiaFixtures";
import { createUiaFlow, UiaCancelledError } from "./uiaFlow";

interface FakeClientOverrides {
	/** Preflight probe behaviour, given the request's auth dict (if any).
	 *  Defaults to a server that needs no auth. */
	probe?: (auth?: unknown) => Promise<unknown>;
	getAuthMetadata?: () => Promise<unknown>;
}

function fakeClient(overrides?: FakeClientOverrides): MatrixClient {
	const probe = overrides?.probe ?? (async () => ({}));
	return {
		getUserId: () => "@u:example.com",
		getAuthMetadata:
			overrides?.getAuthMetadata ??
			(async () => {
				throw new Error("no oauth metadata");
			}),
		http: {
			authedRequest: vi.fn(
				async (
					_method: unknown,
					_path: unknown,
					_qs: unknown,
					body?: { auth?: unknown },
				) => probe(body?.auth),
			),
		},
	} as unknown as MatrixClient;
}

const PASSWORD_FLOW = [["m.login.password"]];
const OAUTH_FLOW = [["m.oauth"]];

describe("createUiaFlow preflight", () => {
	it("resolves without prompting when the probe needs no auth", async () => {
		const flow = createUiaFlow(fakeClient());
		await flow.preflight();
		expect(flow.prompt()).toBeNull();
	});

	it("resolves without prompting when the probe fails with a non-UIA error", async () => {
		const flow = createUiaFlow(
			fakeClient({
				probe: async () => {
					throw Object.assign(new Error("nope"), { httpStatus: 404 });
				},
			}),
		);
		await flow.preflight();
		expect(flow.prompt()).toBeNull();
	});

	it("collects the password when the server offers m.login.password", async () => {
		const flow = createUiaFlow(
			fakeClient({
				probe: async (auth) => {
					if (!auth) throw uia401("probe-sess", PASSWORD_FLOW);
				},
			}),
		);
		const done = flow.preflight();
		await vi.waitFor(() => expect(flow.prompt()).toEqual({ kind: "password" }));
		flow.submitPassword("pw");
		await done;
		expect(flow.prompt()).toBeNull();
	});

	it("collects the approval when the server offers m.oauth", async () => {
		const flow = createUiaFlow(
			fakeClient({
				probe: async (auth) => {
					if (!auth)
						throw uia401("probe-sess", OAUTH_FLOW, {
							"m.oauth": { url: "https://op.example/approve" },
						});
				},
			}),
		);
		const done = flow.preflight();
		await vi.waitFor(() =>
			expect(flow.prompt()).toEqual({
				kind: "oauth",
				url: "https://op.example/approve",
				notYetApproved: false,
			}),
		);
		flow.confirmOauthApproved();
		await done;
	});

	it("re-prompts with an error until the password verifies against the probe", async () => {
		let attempts = 0;
		const flow = createUiaFlow(
			fakeClient({
				probe: async (auth) => {
					if (!auth) throw uia401("probe-sess", PASSWORD_FLOW);
					attempts += 1;
					// First entry is wrong: the server refuses the stage.
					if (attempts === 1) throw uia401("probe-sess-2", PASSWORD_FLOW);
				},
			}),
		);
		const done = flow.preflight();
		await vi.waitFor(() => expect(flow.prompt()).toEqual({ kind: "password" }));
		flow.submitPassword("wrong");
		await vi.waitFor(() =>
			expect(flow.prompt()).toEqual({
				kind: "password",
				error: "Incorrect password. Try again.",
			}),
		);
		flow.submitPassword("right");
		await done;
		expect(flow.prompt()).toBeNull();
	});

	it("rejects with UiaCancelledError on a prompt cancel, account untouched", async () => {
		const flow = createUiaFlow(
			fakeClient({
				probe: async (auth) => {
					if (!auth) throw uia401("probe-sess", PASSWORD_FLOW);
				},
			}),
		);
		const done = flow.preflight();
		await vi.waitFor(() => expect(flow.prompt()).toEqual({ kind: "password" }));
		flow.cancel();
		await expect(done).rejects.toBeInstanceOf(UiaCancelledError);
		expect(flow.prompt()).toBeNull();
	});

	it("fails when no advertised flow is a supported single stage", async () => {
		const flow = createUiaFlow(
			fakeClient({
				probe: async () => {
					// A multi-stage flow this client cannot chain, plus an
					// unsupported single stage.
					throw uia401("probe-sess", [
						["m.login.password", "m.login.terms"],
						["m.login.sso"],
					]);
				},
			}),
		);
		await expect(flow.preflight()).rejects.toThrow(/no way to confirm/);
		expect(flow.prompt()).toBeNull();
	});
});

describe("createUiaFlow uiaCallback", () => {
	/** Preflight against a server challenging with `flows`, answering the
	 *  prompt, so the callback runs with collected credentials. */
	async function preflighted(
		flows: string[][],
		answer: (flow: ReturnType<typeof createUiaFlow>) => void,
		params?: unknown,
	): Promise<ReturnType<typeof createUiaFlow>> {
		const flow = createUiaFlow(
			fakeClient({
				probe: async (auth) => {
					if (!auth) throw uia401("probe-sess", flows, params);
				},
			}),
		);
		const done = flow.preflight();
		await vi.waitFor(() => expect(flow.prompt()).not.toBeNull());
		answer(flow);
		await done;
		return flow;
	}

	it("completes silently when the operation needs no auth", async () => {
		const flow = createUiaFlow(fakeClient());
		await flow.preflight();
		const makeRequest = vi.fn(async () => {});
		await flow.uiaCallback(makeRequest);
		expect(makeRequest).toHaveBeenCalledTimes(1);
		expect(makeRequest).toHaveBeenCalledWith(null);
		expect(flow.prompt()).toBeNull();
	});

	it("rethrows a non-401 failure", async () => {
		const flow = createUiaFlow(fakeClient());
		await flow.preflight();
		const boom = Object.assign(new Error("server down"), { httpStatus: 500 });
		const makeRequest = vi.fn().mockRejectedValue(boom);
		await expect(flow.uiaCallback(makeRequest)).rejects.toBe(boom);
	});

	it("rethrows a 401 without a session", async () => {
		const flow = createUiaFlow(fakeClient());
		await flow.preflight();
		const noSession = Object.assign(new Error("Unauthorized"), {
			httpStatus: 401,
			data: {},
		});
		const makeRequest = vi.fn().mockRejectedValue(noSession);
		await expect(flow.uiaCallback(makeRequest)).rejects.toBe(noSession);
	});

	it("submits the preflight-collected password against the operation's own session", async () => {
		const flow = await preflighted(PASSWORD_FLOW, (f) =>
			f.submitPassword("hunter2"),
		);
		const makeRequest = vi
			.fn()
			.mockRejectedValueOnce(uia401("op-sess", PASSWORD_FLOW))
			.mockResolvedValueOnce(undefined);
		await flow.uiaCallback(makeRequest);
		expect(makeRequest).toHaveBeenLastCalledWith({
			type: AuthType.Password,
			identifier: { type: "m.id.user", user: "@u:example.com" },
			password: "hunter2",
			session: "op-sess",
		});
		// No second prompt: the password came from preflight.
		expect(flow.prompt()).toBeNull();
	});

	it("propagates a wrong-password failure instead of re-prompting", async () => {
		const flow = await preflighted(PASSWORD_FLOW, (f) =>
			f.submitPassword("nope"),
		);
		const wrongPw = uia401("op-sess", PASSWORD_FLOW);
		const makeRequest = vi.fn().mockRejectedValue(wrongPw);
		await expect(flow.uiaCallback(makeRequest)).rejects.toBe(wrongPw);
		expect(makeRequest).toHaveBeenCalledTimes(2);
	});

	it("prefers the password stage when the server offers both", async () => {
		const flow = await preflighted([...OAUTH_FLOW, ...PASSWORD_FLOW], (f) =>
			f.submitPassword("pw"),
		);
		const makeRequest = vi
			.fn()
			.mockRejectedValueOnce(
				uia401("op-sess", [...OAUTH_FLOW, ...PASSWORD_FLOW]),
			)
			.mockResolvedValueOnce(undefined);
		await flow.uiaCallback(makeRequest);
		expect(makeRequest).toHaveBeenLastCalledWith(
			expect.objectContaining({ type: AuthType.Password }),
		);
	});

	it("submits m.oauth immediately after a preflight approval", async () => {
		const flow = await preflighted(
			OAUTH_FLOW,
			(f) => f.confirmOauthApproved(),
			{ "m.oauth": { url: "https://op.example/approve" } },
		);
		const makeRequest = vi
			.fn()
			.mockRejectedValueOnce(
				uia401("op-sess", OAUTH_FLOW, {
					"m.oauth": { url: "https://op.example/approve" },
				}),
			)
			.mockResolvedValueOnce(undefined);
		await flow.uiaCallback(makeRequest);
		expect(makeRequest).toHaveBeenLastCalledWith({
			type: AuthType.OAuth,
			session: "op-sess",
		});
		expect(flow.prompt()).toBeNull();
	});

	it("echoes the pre-MSC4312 alias stage name the server advertised", async () => {
		const aliasFlow = [["org.matrix.cross_signing_reset"]];
		const flow = await preflighted(aliasFlow, (f) => f.confirmOauthApproved(), {
			"org.matrix.cross_signing_reset": { url: "https://op.example/r" },
		});
		const makeRequest = vi
			.fn()
			.mockRejectedValueOnce(
				uia401("op-sess", aliasFlow, {
					"org.matrix.cross_signing_reset": { url: "https://op.example/r" },
				}),
			)
			.mockResolvedValueOnce(undefined);
		await flow.uiaCallback(makeRequest);
		expect(makeRequest).toHaveBeenLastCalledWith({
			type: "org.matrix.cross_signing_reset",
			session: "op-sess",
		});
	});

	it("re-prompts with the refusal's fresh session and url while unapproved", async () => {
		const flow = await preflighted(
			OAUTH_FLOW,
			(f) => f.confirmOauthApproved(),
			{ "m.oauth": { url: "https://op.example/approve" } },
		);
		const makeRequest = vi
			.fn()
			.mockRejectedValueOnce(
				uia401("op-sess", OAUTH_FLOW, {
					"m.oauth": { url: "https://op.example/approve" },
				}),
			)
			// Refusal rotates the session and issues a fresh ticket URL.
			.mockRejectedValueOnce(
				uia401("op-sess-2", OAUTH_FLOW, {
					"m.oauth": { url: "https://op.example/approve-2" },
				}),
			)
			.mockResolvedValueOnce(undefined);
		const done = flow.uiaCallback(makeRequest);
		await vi.waitFor(() =>
			expect(flow.prompt()).toEqual({
				kind: "oauth",
				url: "https://op.example/approve-2",
				notYetApproved: true,
			}),
		);
		flow.confirmOauthApproved();
		await done;
		expect(makeRequest).toHaveBeenLastCalledWith({
			type: AuthType.OAuth,
			session: "op-sess-2",
		});
	});

	it("refuses a non-web url from the 401 params", async () => {
		const flow = createUiaFlow(
			fakeClient({
				probe: async (auth) => {
					if (!auth)
						throw uia401("probe-sess", OAUTH_FLOW, {
							"m.oauth": { url: "javascript:alert(1)" },
						});
				},
			}),
		);
		const done = flow.preflight();
		// No metadata fallback either (fakeClient's getAuthMetadata throws),
		// so the prompt renders without a link.
		await vi.waitFor(() =>
			expect(flow.prompt()).toEqual({
				kind: "oauth",
				url: null,
				notYetApproved: false,
			}),
		);
		flow.confirmOauthApproved();
		await done;
	});

	it("falls back to the account-management deeplink when the 401 has no url", async () => {
		const flow = createUiaFlow(
			fakeClient({
				probe: async (auth) => {
					if (!auth) throw uia401("probe-sess", OAUTH_FLOW);
				},
				getAuthMetadata: vi.fn(async () => ({
					account_management_uri: "https://op.example/account",
					account_management_actions_supported: [
						"org.matrix.cross_signing_reset",
					],
				})),
			}),
		);
		const done = flow.preflight();
		await vi.waitFor(() =>
			expect(flow.prompt()).toEqual({
				kind: "oauth",
				url: "https://op.example/account?action=org.matrix.cross_signing_reset",
				notYetApproved: false,
			}),
		);
		flow.confirmOauthApproved();
		await done;
	});

	it("carries the preflight-resolved deeplink into the refusal re-prompt without re-fetching", async () => {
		const getAuthMetadata = vi.fn(async () => ({
			account_management_uri: "https://op.example/account",
			account_management_actions_supported: ["org.matrix.cross_signing_reset"],
		}));
		const flow = createUiaFlow(
			fakeClient({
				getAuthMetadata,
				probe: async () => {
					// No url in the 401 params: preflight resolves the link from
					// the auth metadata.
					throw uia401("probe-sess", OAUTH_FLOW);
				},
			}),
		);
		const preflightDone = flow.preflight();
		const deeplink =
			"https://op.example/account?action=org.matrix.cross_signing_reset";
		await vi.waitFor(() => expect(flow.prompt()?.kind).toBe("oauth"));
		flow.confirmOauthApproved();
		await preflightDone;

		const makeRequest = vi
			.fn()
			.mockRejectedValueOnce(uia401("op-sess", OAUTH_FLOW))
			.mockRejectedValueOnce(uia401("op-sess", OAUTH_FLOW))
			.mockResolvedValueOnce(undefined);
		const done = flow.uiaCallback(makeRequest);
		await vi.waitFor(() =>
			expect(flow.prompt()).toEqual({
				kind: "oauth",
				url: deeplink,
				notYetApproved: true,
			}),
		);
		flow.confirmOauthApproved();
		await done;
		expect(getAuthMetadata).toHaveBeenCalledTimes(1);
	});

	it("settles the operation when cancel lands while no prompt is pending", async () => {
		// A cancel (e.g. the dialog unmounting) that lands mid-request has
		// no pending prompt to reject; the next ask() must reject instead
		// of suspending the SDK operation forever.
		const flow = createUiaFlow(fakeClient());
		await flow.preflight();
		const makeRequest = vi.fn(async () => {
			flow.cancel();
			throw uia401("op-sess", OAUTH_FLOW, {
				"m.oauth": { url: "https://op.example/approve" },
			});
		});
		await expect(flow.uiaCallback(makeRequest)).rejects.toBeInstanceOf(
			UiaCancelledError,
		);
		expect(flow.prompt()).toBeNull();
	});
});
