import type { UnicodeEmoji } from "./types";
import { PICKER_GROUPS } from "./types";

interface ShortcodeMap {
	[hexcode: string]: string | string[];
}

let cachedEmoji: UnicodeEmoji[] | null = null;
let cachedByGroup: Map<number, UnicodeEmoji[]> | null = null;

/** Lazy-load and index Unicode emoji data. Returns sorted list with shortcodes merged. */
export async function loadUnicodeEmoji(): Promise<UnicodeEmoji[]> {
	if (cachedEmoji) return cachedEmoji;

	const [compactMod, shortcodeMod] = await Promise.all([
		import("emojibase-data/en/compact.json"),
		import("emojibase-data/en/shortcodes/emojibase.json"),
	]);

	const compact = compactMod.default as Array<{
		unicode: string;
		label: string;
		hexcode: string;
		group?: number;
		order?: number;
		tags?: string[];
	}>;
	const shortcodeMap = shortcodeMod.default as ShortcodeMap;

	const result: UnicodeEmoji[] = [];
	for (const entry of compact) {
		if (entry.group === undefined) continue;
		if (!PICKER_GROUPS.includes(entry.group)) continue;

		const rawSc = shortcodeMap[entry.hexcode];
		const shortcodes = rawSc ? (Array.isArray(rawSc) ? rawSc : [rawSc]) : [];

		result.push({
			unicode: entry.unicode,
			label: entry.label,
			hexcode: entry.hexcode,
			group: entry.group,
			order: entry.order ?? 0,
			tags: entry.tags ?? [],
			shortcodes,
		});
	}

	result.sort((a, b) => a.order - b.order);
	cachedEmoji = result;
	cachedByGroup = null;
	return result;
}

/** Get emoji grouped by emojibase group number. */
export async function getEmojiByGroup(): Promise<Map<number, UnicodeEmoji[]>> {
	if (cachedByGroup) return cachedByGroup;

	const all = await loadUnicodeEmoji();
	const grouped = new Map<number, UnicodeEmoji[]>();

	for (const emoji of all) {
		let list = grouped.get(emoji.group);
		if (!list) {
			list = [];
			grouped.set(emoji.group, list);
		}
		list.push(emoji);
	}

	cachedByGroup = grouped;
	return grouped;
}

/** Search Unicode emoji by label, shortcode, or tags. */
export function searchUnicodeEmoji(
	emoji: UnicodeEmoji[],
	query: string,
): UnicodeEmoji[] {
	if (!query) return emoji;
	const lower = query.toLowerCase();

	return emoji.filter(
		(e) =>
			e.label.toLowerCase().includes(lower) ||
			e.shortcodes.some((sc) => sc.toLowerCase().includes(lower)) ||
			e.tags.some((t) => t.toLowerCase().includes(lower)),
	);
}
