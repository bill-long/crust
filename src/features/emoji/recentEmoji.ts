import { loadPersisted, savePersisted } from "../../lib/persistedSignal";

const STORAGE_KEY = "crust:recent-emoji";
const MAX_RECENT = 32;

interface RecentEntry {
	/** Unicode character for standard emoji, or mxc:// URL for custom. */
	key: string;
	/** Timestamp of last use. */
	ts: number;
}

function loadEntries(): RecentEntry[] {
	return loadPersisted(
		STORAGE_KEY,
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
	savePersisted(STORAGE_KEY, entries);
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
