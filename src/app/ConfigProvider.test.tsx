import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigProvider, useConfig } from "./ConfigProvider";
import { recallRemoteConfig, rememberRemoteConfig } from "./remoteConfigCache";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const shell = vi.hoisted(() => ({ native: false, overlay: false }));
vi.mock("./nativeShell", () => ({
	isNativeShell: () => shell.native,
	isOverlayWindow: () => shell.overlay,
}));

const GIF_ENV_VARS = [
	"VITE_GIF_API_KEY",
	"VITE_GIF_PROVIDER",
	"VITE_GIF_ENABLED",
	"VITE_GIF_TRENDING_ON_OPEN",
	"VITE_GIF_MAX_RATING",
] as const;

const REMOTE = "https://ops.example.com/config.json";

/** The template that ships inside the installer: GIF off, no key. */
const BUNDLED = {
	remoteConfigUrl: REMOTE,
	defaultHomeserver: "example.org",
	gif: { enabled: false, provider: "giphy", apiKey: "", maxRating: "g" },
};

/** What the deployment actually serves: GIF on, with a key. */
const LIVE = {
	defaultHomeserver: "example.org",
	gif: { enabled: true, provider: "klipy", apiKey: "live-key", maxRating: "g" },
};

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

/** Renders the provider and paints what the app would actually gate on. */
function Probe() {
	const config = useConfig();
	const available = () =>
		config.gif.enabled && config.gif.apiKey.trim().length > 0;
	return (
		<span data-testid="probe">
			{available() ? "gif-button" : "no-gif-button"}:{config.gif.provider}@
			{config.defaultHomeserver}
		</span>
	);
}

async function renderProbe() {
	render(() => (
		<ConfigProvider>
			<Probe />
		</ConfigProvider>
	));
	return await screen.findByTestId("probe");
}

describe("ConfigProvider operator config", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// A developer's .env.local (VITE_GIF_API_KEY=...) is inlined by Vite and
		// applied on top of every config, which would make these assertions pass
		// no matter which config the provider actually chose. Clear them so the
		// JSON under test is the only thing driving the result.
		for (const name of GIF_ENV_VARS) vi.stubEnv(name, "");
		// Same hazard, newer knob: normalizeRemoteConfigUrl accepts loopback
		// http:// so this feature can be driven locally, which makes a
		// VITE_REMOTE_CONFIG_URL in .env.local realistic. Left unstubbed it
		// rewrites BUNDLED.remoteConfigUrl and the regression test above stops
		// testing the regression, with nothing to point at why.
		vi.stubEnv("VITE_REMOTE_CONFIG_URL", "");
		shell.native = false;
		shell.overlay = false;
		// The last live config is remembered across launches (#581); a test
		// that read one must not hand it to the next test's fallback.
		localStorage.clear();
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		// Without this, a previous test's provider stays mounted and
		// findByTestId matches its probe instead of this test's.
		cleanup();
		localStorage.clear();
		fetchSpy.mockRestore();
		errorSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it("uses the served config in a browser and never fetches the remote", async () => {
		// A browser already loads config.json from the deployment serving it,
		// so reaching out again would be pointless - and cross-origin. Serve a
		// config that DOES carry remoteConfigUrl, so the only thing stopping a
		// second fetch is the native-shell gate rather than a missing field.
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(String(input) === REMOTE ? LIVE : BUNDLED),
		);

		expect((await renderProbe()).textContent).toBe(
			"no-gif-button:giphy@example.org",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).not.toBe(REMOTE);
	});

	it("prefers the live config in the desktop shell (#580)", async () => {
		// The regression itself: the installer embeds BUNDLED, so without the
		// remote fetch the GIF button can never appear on desktop.
		shell.native = true;
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(String(input) === REMOTE ? LIVE : BUNDLED),
		);

		expect((await renderProbe()).textContent).toBe(
			"gif-button:klipy@example.org",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("falls back to the bundled config when the deployment is unreachable", async () => {
		shell.native = true;
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
			if (String(input) === REMOTE) throw new TypeError("Failed to fetch");
			return jsonResponse(BUNDLED);
		});

		// Boots on what it shipped with rather than the load-failure screen.
		expect((await renderProbe()).textContent).toBe(
			"no-gif-button:giphy@example.org",
		);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("falls back when the deployment accepts but never answers", async () => {
		shell.native = true;
		fetchSpy.mockImplementation(
			(input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input) !== REMOTE) {
					return Promise.resolve(jsonResponse(BUNDLED));
				}
				// A hung request that only settles when the timeout aborts it, so
				// deleting the AbortController would hang this test rather than
				// pass it.
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				});
			},
		);

		render(() => (
			<ConfigProvider>
				<Probe />
			</ConfigProvider>
		));
		const probe = await screen.findByTestId("probe", {}, { timeout: 10_000 });
		expect(probe.textContent).toBe("no-gif-button:giphy@example.org");
	}, 15_000);

	it("shows the failure screen only when the bundled config is unreadable", async () => {
		// Tauri answers a missing asset with index.html, so .json() throws.
		shell.native = true;
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token <");
			},
		} as unknown as Response);

		render(() => (
			<ConfigProvider>
				<Probe />
			</ConfigProvider>
		));
		await waitFor(() =>
			expect(screen.getByText("Failed to load configuration")).toBeTruthy(),
		);
	});
	it("does not make the call overlay wait on the network", async () => {
		// The overlay is a chromeless, always-on-top window over a game, and
		// this provider paints an opaque panel until it resolves - so a stalled
		// fetch here would be a grey box on top of the game.
		shell.native = true;
		shell.overlay = true;
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(String(input) === REMOTE ? LIVE : BUNDLED),
		);

		expect((await renderProbe()).textContent).toBe(
			"no-gif-button:giphy@example.org",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects a remote body that is not a Crust config", async () => {
		// normalizeConfig() coerces anything into a defaults object pointing at
		// matrix.org, so a captive portal or WAF page would otherwise be
		// accepted as config and leave the client worse off than its bundle.
		shell.native = true;
		for (const body of [null, [], "ok", 42, { error: "blocked" }]) {
			cleanup();
			fetchSpy.mockClear();
			fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
				jsonResponse(String(input) === REMOTE ? body : BUNDLED),
			);

			const probe = await renderProbe();
			expect(probe.textContent).toBe("no-gif-button:giphy@example.org");
		}
	});

	it("ignores config keys that live only on the prototype", async () => {
		// Built with Object.create rather than by polluting Object.prototype,
		// which would leak into every other test in the file. An `in` check
		// treats this body as a config; an own-property check does not.
		shell.native = true;
		const inherited = Object.create({ gif: LIVE.gif, defaultHomeserver: "x" });
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(String(input) === REMOTE ? inherited : BUNDLED),
		);

		expect((await renderProbe()).textContent).toBe(
			"no-gif-button:giphy@example.org",
		);
	});

	it("accepts a live config that omits optional fields", async () => {
		// defaultHomeserver is optional - normalizeConfig defaults it. A shape
		// check that demanded it would reject a config every browser client
		// accepts, on the desktop path only.
		shell.native = true;
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(String(input) === REMOTE ? { gif: LIVE.gif } : BUNDLED),
		);

		// The remote gif block is taken, and example.org survives from the
		// bundled body rather than falling to the library's matrix.org - the
		// installer's own homeserver is a better answer than a default.
		expect((await renderProbe()).textContent).toBe(
			"gif-button:klipy@example.org",
		);
	});

	it("keeps the operator's homeserver when the remote config is genuine", async () => {
		// Guards the shape check from over-rejecting: a real config still wins.
		shell.native = true;
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(
				String(input) === REMOTE
					? { ...LIVE, defaultHomeserver: "live.example.org" }
					: BUNDLED,
			),
		);

		expect((await renderProbe()).textContent).toBe(
			"gif-button:klipy@live.example.org",
		);
	});

	/** The deployment is unreachable; only the bundled fetch answers. */
	function deploymentDown() {
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
			if (String(input) === REMOTE) throw new TypeError("Failed to fetch");
			return jsonResponse(BUNDLED);
		});
	}

	it("remembers a live config it accepted, and keeps it over one it rejected (#581)", async () => {
		shell.native = true;
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(String(input) === REMOTE ? LIVE : BUNDLED),
		);
		await renderProbe();
		expect(recallRemoteConfig(REMOTE)).toEqual(LIVE);

		// A captive portal or a WAF challenge answers 200 with a body that is
		// not a config. It must neither replace the remembered copy nor evict
		// it, or the next offline launch is on the template again.
		cleanup();
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			jsonResponse(String(input) === REMOTE ? { hello: "world" } : BUNDLED),
		);
		expect((await renderProbe()).textContent).toBe(
			"gif-button:klipy@example.org",
		);
		expect(recallRemoteConfig(REMOTE)).toEqual(LIVE);
	});

	it("boots on the last live config when the deployment is unreachable (#581)", async () => {
		// The plane case: the live config was read minutes ago, so the fallback
		// is that, not the installer's template with GIF search off.
		shell.native = true;
		rememberRemoteConfig(REMOTE, LIVE);
		deploymentDown();

		expect((await renderProbe()).textContent).toBe(
			"gif-button:klipy@example.org",
		);
	});

	it("honours a homeserver change in the last live config offline (#581)", async () => {
		// The remembered body is the operator's latest known intent, newer than
		// the template's: its homeserver wins offline as it would have online.
		shell.native = true;
		rememberRemoteConfig(REMOTE, {
			...LIVE,
			defaultHomeserver: "moved.example.org",
		});
		deploymentDown();

		expect((await renderProbe()).textContent).toBe(
			"gif-button:klipy@moved.example.org",
		);
	});

	it("forgets the last live config when the deployment withdraws the file (#581)", async () => {
		// 404 is the operator taking the file away - the one way to revert
		// desktop clients to the template, and how a leaked key stops living
		// on in a remembered copy.
		shell.native = true;
		rememberRemoteConfig(REMOTE, LIVE);
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			String(input) === REMOTE ? jsonResponse({}, 404) : jsonResponse(BUNDLED),
		);

		expect((await renderProbe()).textContent).toBe(
			"no-gif-button:giphy@example.org",
		);
		expect(recallRemoteConfig(REMOTE)).toBeNull();
	});

	it("keeps the last live config when the deployment is merely broken (#581)", async () => {
		// A 5xx is the deployment being down, not the file being withdrawn.
		shell.native = true;
		rememberRemoteConfig(REMOTE, LIVE);
		fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
			String(input) === REMOTE ? jsonResponse({}, 503) : jsonResponse(BUNDLED),
		);

		expect((await renderProbe()).textContent).toBe(
			"gif-button:klipy@example.org",
		);
		expect(recallRemoteConfig(REMOTE)).toEqual(LIVE);
	});
});
