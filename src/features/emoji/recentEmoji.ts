const STORAGE_KEY = "crust:recent-emoji";
const MAX_RECENT = 32;

interface RecentEntry {
	/** Unicode character for standard emoji, or mxc:// URL for custom. */
	key: string;
	/** Timestamp of last use. */
	ts: number;
}

function loadEntries(): RecentEntry[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e: unknown) =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as RecentEntry).key === "string" &&
				typeof (e as RecentEntry).ts === "number",
		);
	} catch {
		return [];
	}
}

function saveEntries(entries: RecentEntry[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	} catch {
		// localStorage full or unavailable — best-effort
	}
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
