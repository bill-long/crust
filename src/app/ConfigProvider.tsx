import {
	createContext,
	createResource,
	type ParentComponent,
	Show,
	useContext,
} from "solid-js";
import { reportError } from "../lib/reportError";
import type { CrustConfig } from "../types/config";
import { looksLikeCrustConfig, normalizeConfig } from "../types/config";
import { isNativeShell, isOverlayWindow } from "./nativeShell";

const ConfigContext = createContext<CrustConfig>();

/**
 * How long the desktop shell waits for the operator's live config before
 * falling back to its bundled copy.
 *
 * This blocks boot: consumers read the context value non-reactively, so
 * "paint the bundled config and swap later" would mean making it a store.
 * Until then the budget is what bounds the damage, and the bad case is not a
 * refused connection (which fails fast) but one that is accepted and then
 * black-holed - hotel wifi, a split-tunnel VPN - where the wait is paid in
 * full on every launch, against an embedded file that used to be instant.
 * Two seconds still covers a healthy round-trip several times over.
 */
const REMOTE_CONFIG_TIMEOUT_MS = 2000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`Failed to load config.json (${res.status})`);
	return await res.json();
}

/**
 * Load the operator config.
 *
 * In a browser the bundled copy IS the operator's - the deployment serves its
 * own config.json over the one baked into the image. The desktop shell has no
 * such seam: it embeds dist/ at build time, so it would ship whatever
 * public/config.json held when the installer was cut, which is a template with
 * GIF search off and Web Push unconfigured (#580). So when a bundled
 * `remoteConfigUrl` is present, the native shell prefers the live file.
 *
 * The bundled copy is always read first and is the fallback: a desktop client
 * that is offline, or pointed at a deployment that is down, still boots on the
 * config it shipped with rather than showing the load-failure screen. Only a
 * failure to read the BUNDLED config is fatal.
 */
async function fetchConfig(): Promise<CrustConfig> {
	const bundledRaw = await fetchJson(`${import.meta.env.BASE_URL}config.json`);
	const bundled = normalizeConfig(bundledRaw);
	if (!isNativeShell() || !bundled.remoteConfigUrl) return bundled;
	// The overlay is a second, chromeless, always-on-top window over a game,
	// and this provider renders an opaque panel while it resolves. Making it
	// wait on the network would put a grey box on top of the game for as long
	// as the request takes. It shares an origin and its call state with the
	// main window, so the bundled copy is enough for the short time it lives.
	if (isOverlayWindow()) return bundled;

	// An explicit controller rather than AbortSignal.timeout() so the timer is
	// cleared once the request settles, instead of staying pending for the full
	// timeout after a fast success.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REMOTE_CONFIG_TIMEOUT_MS);
	try {
		const raw = await fetchJson(bundled.remoteConfigUrl, {
			signal: controller.signal,
			// The operator edits this file in place to rotate keys or flip a
			// feature on; a cached copy would defer that to a cache eviction.
			cache: "no-store",
		});
		if (!looksLikeCrustConfig(raw)) {
			throw new Error("Remote config.json is not a Crust config");
		}
		// Merged over the bundled body, not swapped for it. Every field is
		// optional, so a served config that omits one would otherwise fall to
		// the library default - booting the client on matrix.org while its own
		// installer carried the right homeserver, which is the "worse than the
		// copy it shipped with" outcome the check above exists to prevent. A
		// key the operator did supply still wins outright, nested objects
		// included: half a gif block is not a configuration.
		const base = looksLikeCrustConfig(bundledRaw)
			? (bundledRaw as Record<string, unknown>)
			: {};
		return normalizeConfig({ ...base, ...(raw as Record<string, unknown>) });
	} catch (err) {
		// Background best-effort work with a working fallback: console only,
		// no toast (see AGENTS.md "Error handling").
		reportError(err, { logLabel: "remote config" });
		return bundled;
	} finally {
		clearTimeout(timer);
	}
}

export const ConfigProvider: ParentComponent = (props) => {
	const [config] = createResource(fetchConfig);

	return (
		<Show
			when={!config.error}
			fallback={
				<div class="flex h-full items-center justify-center bg-surface-0">
					<div class="text-center">
						<p class="text-danger-text">Failed to load configuration</p>
						<p class="mt-1 text-sm text-text-disabled">
							Check that config.json is accessible and try refreshing.
						</p>
					</div>
				</div>
			}
		>
			<Show
				when={config()}
				fallback={
					<div class="flex h-full items-center justify-center bg-surface-0 text-text-muted">
						Loading…
					</div>
				}
			>
				{(cfg) => (
					<ConfigContext.Provider value={cfg()}>
						{props.children}
					</ConfigContext.Provider>
				)}
			</Show>
		</Show>
	);
};

export function useConfig(): CrustConfig {
	const ctx = useContext(ConfigContext);
	if (!ctx) throw new Error("useConfig must be used within ConfigProvider");
	return ctx;
}
