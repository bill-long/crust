import {
	loadPersisted,
	safeLocalStorage,
	savePersisted,
} from "../lib/persistedSignal";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { looksLikeCrustConfig } from "../types/config";

/**
 * The last operator config the desktop shell successfully read (#581).
 *
 * `ConfigProvider` prefers the deployment's live config.json over the copy
 * baked into the installer, because that copy is a template: GIF search off,
 * Web Push unconfigured, upstream homeserver defaults (#580). When the live
 * file cannot be read - offline, or the deployment is down - the template used
 * to be the only fallback, so a user who had pulled the live config a hundred
 * times still got a degraded session on a plane. This remembers the live body
 * so that fallback is the config the operator most recently served.
 *
 * Three decisions, made here rather than left implicit:
 *
 * - **Staleness.** A remembered config is discarded once its read time is more
 *   than {@link REMOTE_CONFIG_MAX_AGE_MS} from now, in either direction. The
 *   body carries keys the operator rotates and endpoints they move; a month is
 *   long enough to cover any trip and short enough that a laptop out of a
 *   drawer does not boot on a deployment this app no longer knows. Measuring
 *   in both directions is what keeps the cap honest: a clock that has since
 *   moved back by less than the cap still reads as fresh (the config was the
 *   live one when it was read), while one that was far ahead when the config
 *   was read cannot keep it fresh long past the cap once corrected.
 * - **A homeserver change is honoured.** The remembered body IS the operator's
 *   latest known intent, newer than the template's, so its homeserver defaults
 *   win on an offline launch exactly as they would have online. Those fields
 *   only drive the login screen; a stored session carries its own homeserver
 *   URL. The one field that does act on a stored session is `push`: a
 *   remembered gateway URL and VAPID key are replayed into the device's pusher
 *   on a deployment-down boot, which the template (unconfigured) never did.
 *   That is the accepted side of the same trade - bounded by the cap, and put
 *   right by the next live read.
 * - **A withdrawn file wins.** A deployment that answers 404 or 410 has taken
 *   the file away, which is the one way an operator can revert desktop clients
 *   to the template early (a leaked key must not outlive the file it was
 *   served in). `ConfigProvider` calls {@link forgetRemoteConfig} on that
 *   answer, and only on that answer: offline, a timeout, a 5xx, a 403 from a
 *   mis-mounted file or a proxy, a 200 that is not a config - all of those are
 *   the deployment being down, which is what the remembered copy is for, and
 *   the copy then lives out the cap. `deploy/README.md` says how to produce
 *   the 404.
 *
 * The body is keyed by the URL it was read from: an installer that points at a
 * different deployment must not boot on the previous one's config. An entry
 * that is unreadable, from another URL or no longer shaped like a config is
 * removed rather than left behind with its key; a stale one is only skipped,
 * because the clock that judged it stale may itself be the thing that is
 * wrong (an RTC reset on an offline launch), and the next live read replaces
 * it anyway. It is the raw body that passed `looksLikeCrustConfig`, not the
 * merged result, so it is merged over the CURRENT bundled copy at read time,
 * the same way the live one is. Storage is best-effort throughout: a rejected
 * write or unreadable entry just means the template stands, as before.
 */
export const REMOTE_CONFIG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface RememberedRemoteConfig {
	url: string;
	fetchedAt: number;
	body: Record<string, unknown>;
}

/** Remember `body` as the live config read from `url` just now. */
export function rememberRemoteConfig(
	url: string,
	body: Record<string, unknown>,
	now: number = Date.now(),
): void {
	const entry: RememberedRemoteConfig = { url, fetchedAt: now, body };
	savePersisted(STORAGE_KEYS.remoteConfig, entry);
}

/** Drop the remembered config; the template is the fallback again. */
export function forgetRemoteConfig(): void {
	safeLocalStorage.remove(STORAGE_KEYS.remoteConfig);
}

/**
 * The remembered live config for `url`, or null when there is none worth
 * using: nothing stored, unreadable, read from a different URL, no longer
 * shaped like a Crust config (all of which are forgotten on the way out), or
 * more than {@link REMOTE_CONFIG_MAX_AGE_MS} from now (skipped, kept).
 */
export function recallRemoteConfig(
	url: string,
	now: number = Date.now(),
): Record<string, unknown> | null {
	const entry = loadPersisted(
		STORAGE_KEYS.remoteConfig,
		(raw) => asEntryFor(raw, url),
		null,
	);
	if (entry === null) {
		forgetRemoteConfig();
		return null;
	}
	if (Math.abs(now - entry.fetchedAt) > REMOTE_CONFIG_MAX_AGE_MS) return null;
	return entry.body;
}

/** The one list of what makes a stored entry usable for `url`, age aside. */
function asEntryFor(raw: unknown, url: string): RememberedRemoteConfig | null {
	if (typeof raw !== "object" || raw === null) return null;
	const entry = raw as Partial<RememberedRemoteConfig>;
	if (
		entry.url !== url ||
		typeof entry.fetchedAt !== "number" ||
		!Number.isFinite(entry.fetchedAt) ||
		!looksLikeCrustConfig(entry.body)
	) {
		return null;
	}
	return entry as RememberedRemoteConfig;
}
