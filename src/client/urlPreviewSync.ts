import {
	ClientEvent,
	type MatrixClient,
	type MatrixEvent,
} from "matrix-js-sdk";
import { updateSetting, userSettings } from "../stores/settings";

/**
 * Matrix account-data event type for the user's URL preview preference.
 *
 * Format: `{ disable: boolean }`. `disable: true` means previews are
 * off; absence of the event or `disable: false` means previews are on.
 * This is the de-facto convention used by Element and Cinny — the key
 * has been stable for years and lives outside `WritableAccountDataEvents`
 * in the SDK's known-event union, which is why callers below cast
 * through `unknown`.
 */
const PREVIEW_URLS_EVENT_TYPE = "m.room.preview_urls";

/**
 * After a local toggle we briefly ignore *matching* remote echoes to
 * avoid local → write → echo → local-overwrite ping-pong if the
 * homeserver sends the account-data event back before our setter
 * has settled. Non-matching remote updates (e.g. a different value
 * pushed from another device) are still applied immediately.
 */
const LOCAL_WRITE_DEBOUNCE_MS = 250;

type ClientState = {
	pendingDisable: boolean | null;
	pendingExpiresAt: number;
	writeGeneration: number;
	// Desired `disable` value of the most recent in-flight write. Used
	// for the skip-if-matching check so that rapid toggles (off→on)
	// aren't dropped: `getAccountData()` only reflects values that have
	// completed a /sync round-trip, so it can be stale while a write is
	// pending. Without this, a quick second toggle that "looks like" it
	// matches the (stale) server view would be skipped and never reach
	// the homeserver.
	inFlightTarget: boolean | null;
};

const clientState = new WeakMap<MatrixClient, ClientState>();

function getState(client: MatrixClient): ClientState {
	let s = clientState.get(client);
	if (!s) {
		s = {
			pendingDisable: null,
			pendingExpiresAt: 0,
			writeGeneration: 0,
			inFlightTarget: null,
		};
		clientState.set(client, s);
	}
	return s;
}

function readDisable(event: MatrixEvent | null | undefined): boolean | null {
	if (!event) return null;
	const content = event.getContent();
	if (typeof content !== "object" || content === null) return null;
	const v = (content as { disable?: unknown }).disable;
	if (typeof v !== "boolean") return null;
	return v;
}

function getAccountDataEvent(client: MatrixClient): MatrixEvent | undefined {
	// SDK constrains `getAccountData` to a keyof union that doesn't include
	// our convention-only event type.
	const key = PREVIEW_URLS_EVENT_TYPE as unknown as Parameters<
		MatrixClient["getAccountData"]
	>[0];
	return client.getAccountData(key);
}

function applyRemote(client: MatrixClient, disable: boolean | null): void {
	const s = getState(client);
	// Suppress only the matching echo of our own recent write — different
	// values from another device should still take effect immediately.
	if (
		s.pendingDisable !== null &&
		Date.now() < s.pendingExpiresAt &&
		disable === s.pendingDisable
	) {
		return;
	}
	// Absence of the event = previews on.
	const remoteEnabled = disable === null ? true : !disable;
	if (userSettings().urlPreviews === remoteEnabled) return;
	updateSetting("urlPreviews", remoteEnabled);
}

/**
 * Subscribe to `m.room.preview_urls` account-data updates and mirror
 * them into the local `urlPreviews` setting. Returns a disposer.
 *
 * Reads the current value once on attach in case the event was
 * delivered before this listener was wired up.
 */
export function attachUrlPreviewAccountDataSync(
	client: MatrixClient,
): () => void {
	applyRemote(client, readDisable(getAccountDataEvent(client)));

	const onAccountData = (event: MatrixEvent): void => {
		if (event.getType() !== PREVIEW_URLS_EVENT_TYPE) return;
		applyRemote(client, readDisable(event));
	};

	client.on(ClientEvent.AccountData, onAccountData);
	return () => {
		client.removeListener(ClientEvent.AccountData, onAccountData);
		clientState.delete(client);
	};
}

/**
 * Persist a local URL-preview setting change to the homeserver. Skips
 * the write when the remote already matches to avoid no-op traffic.
 *
 * Marks the moment of the write so that `applyRemote` ignores the
 * matching echo within `LOCAL_WRITE_DEBOUNCE_MS`.
 */
export async function pushLocalUrlPreviewSetting(
	client: MatrixClient,
	enabled: boolean,
): Promise<void> {
	const s = getState(client);
	// Compare against the in-flight target first: getAccountData() only
	// reflects post-/sync state, so it can be stale while a write is in
	// flight. Using the latest desired value (in-flight or current
	// remote) avoids dropping a rapid second toggle.
	const current = readDisable(getAccountDataEvent(client));
	const effectiveDisable =
		s.inFlightTarget !== null ? s.inFlightTarget : current;
	const effectiveEnabled = effectiveDisable === null ? true : !effectiveDisable;
	if (effectiveEnabled === enabled) return;
	const targetDisable = !enabled;
	const gen = ++s.writeGeneration;
	s.inFlightTarget = targetDisable;
	try {
		const key = PREVIEW_URLS_EVENT_TYPE as unknown as Parameters<
			MatrixClient["setAccountData"]
		>[0];
		await client.setAccountData(key, { disable: targetDisable });
		// Only the most recent in-flight write may arm echo suppression
		// and clear `inFlightTarget`. A stale resolution from an earlier
		// toggle must not overwrite either with its older value, or a
		// newer remote echo could be incorrectly suppressed and the
		// local/remote states would diverge.
		if (gen !== s.writeGeneration) return;
		s.inFlightTarget = null;
		// Only arm echo suppression after a successful write — otherwise
		// a failed write would block legitimate remote updates for 250ms.
		s.pendingDisable = targetDisable;
		s.pendingExpiresAt = Date.now() + LOCAL_WRITE_DEBOUNCE_MS;
	} catch {
		// Network error — leave local state alone; user can retry. Only
		// clear the in-flight marker if it still belongs to this write.
		if (gen === s.writeGeneration) s.inFlightTarget = null;
	}
}
