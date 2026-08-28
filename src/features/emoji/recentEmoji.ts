import { loadPersisted, savePersisted } from "../../lib/persistedSignal";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { currentAccountKey } from "../../stores/accountScoped";

// Per-account (#532): an emoji picker ordered by someone else's habits is a
// small thing, but the recent list is also a fingerprint of what an account
// sends. The key is resolved per call rather than cached, so it always follows
// the active account.
const STORAGE_KEY = STORAGE_KEYS.recentEmoji;
const MAX_RECENT = 32;

interface RecentEntry {
	/** Unicode character for standard emoji, or mxc:// URL for custom. */
	key: string;
	/** Timestamp of last use. */
	ts: number;
}

function loadEntries(): RecentEntry[] {
	const key = currentAccountKey(STORAGE_KEY);
	if (key === null) return [];
	return loadPersisted(
		key,
		(raw): RecentEntry[] =>
			Array.isArray(raw)
				? raw.filter(
						(e: unknown): e is RecentEntry =>
							typeof e === "object" &&
							e !== null &&
							typeof (e as RecentEntry).key === "string" &&
							typeof (e as RecentEntry).ts === "number",
					)
				: [],
		[],
	);
}

function saveEntries(entries: RecentEntry[]): void {
	const key = currentAccountKey(STORAGE_KEY);
	if (key === null) return;
	savePersisted(key, entries);
}

/** Get recently used emoji keys (most recent first). */
export function getRecentEmoji(): string[] {
	return loadEntries()
		.sort((a, b) => b.ts - a.ts)
		.map((e) => e.key);
}

/** Record an emoji as recently used. */
export function addRecentEmoji(key: string): void {
	const entries = loadEntries().filter((e) => e.key !== key);
	entries.unshift({ key, ts: Date.now() });
	saveEntries(entries.slice(0, MAX_RECENT));
}
