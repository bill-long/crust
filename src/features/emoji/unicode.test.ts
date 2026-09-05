import { describe, expect, it, vi } from "vitest";
import { PICKER_GROUPS, type UnicodeEmoji } from "./types";

vi.mock("emojibase-data/en/compact.json", () => ({
	default: [
		{
			unicode: "late",
			label: "Late entry",
			hexcode: "LATE",
			group: 0,
			order: 20,
			tags: ["after"],
		},
		{
			unicode: "early",
			label: "Early entry",
			hexcode: "EARLY",
			group: 0,
			order: 1,
		},
		{
			unicode: "default-order",
			label: "Default order",
			hexcode: "DEFAULT",
			group: 3,
		},
		{
			unicode: "flag",
			label: "Flag entry",
			hexcode: "FLAG",
			group: 9,
			order: 10,
			tags: ["banner"],
		},
		{
			unicode: "component",
			label: "Excluded component",
			hexcode: "COMPONENT",
			group: 2,
			order: 2,
		},
		{
			unicode: "ungrouped",
			label: "Missing group",
			hexcode: "UNGROUPED",
			order: 3,
		},
	],
}));

vi.mock("emojibase-data/en/shortcodes/emojibase.json", () => ({
	default: {
		LATE: "late_code",
		EARLY: ["early_code", "first"],
		FLAG: "flag_code",
	},
}));

import {
	getEmojiByGroup,
	loadUnicodeEmoji,
	searchUnicodeEmoji,
} from "./unicode";

describe("loadUnicodeEmoji", () => {
	it("filters unsupported records, fills optional fields, and sorts by order", async () => {
		const emoji = await loadUnicodeEmoji();

		expect(emoji).toEqual([
			{
				unicode: "default-order",
				label: "Default order",
				hexcode: "DEFAULT",
				group: 3,
				order: 0,
				tags: [],
				shortcodes: [],
			},
			{
				unicode: "early",
				label: "Early entry",
				hexcode: "EARLY",
				group: 0,
				order: 1,
				tags: [],
				shortcodes: ["early_code", "first"],
			},
			{
				unicode: "flag",
				label: "Flag entry",
				hexcode: "FLAG",
				group: 9,
				order: 10,
				tags: ["banner"],
				shortcodes: ["flag_code"],
			},
			{
				unicode: "late",
				label: "Late entry",
				hexcode: "LATE",
				group: 0,
				order: 20,
				tags: ["after"],
				shortcodes: ["late_code"],
			},
		]);
		expect(emoji.every((entry) => PICKER_GROUPS.includes(entry.group))).toBe(
			true,
		);
	});

	it("returns the cached list on subsequent loads", async () => {
		const first = await loadUnicodeEmoji();
		const second = await loadUnicodeEmoji();

		expect(second).toBe(first);
	});
});

describe("getEmojiByGroup", () => {
	it("groups the sorted entries and caches the resulting map", async () => {
		const all = await loadUnicodeEmoji();
		const first = await getEmojiByGroup();
		const second = await getEmojiByGroup();

		expect(second).toBe(first);
		expect([...first.keys()]).toEqual([3, 0, 9]);
		expect(first.get(0)).toEqual([all[1], all[3]]);
		expect(first.get(3)).toEqual([all[0]]);
		expect(first.get(9)).toEqual([all[2]]);
		expect(first.has(2)).toBe(false);
	});
});

describe("searchUnicodeEmoji", () => {
	const emoji: UnicodeEmoji[] = [
		{
			unicode: "one",
			label: "Raised Hand",
			hexcode: "ONE",
			group: 0,
			order: 0,
			tags: ["gesture"],
			shortcodes: ["wave"],
		},
		{
			unicode: "two",
			label: "Banner",
			hexcode: "TWO",
			group: 9,
			order: 1,
			tags: ["country"],
			shortcodes: ["flag_code"],
		},
	];

	it("matches labels, shortcodes, and tags case-insensitively", () => {
		expect(searchUnicodeEmoji(emoji, "HAND")).toEqual([emoji[0]]);
		expect(searchUnicodeEmoji(emoji, "WAVE")).toEqual([emoji[0]]);
		expect(searchUnicodeEmoji(emoji, "COUNTRY")).toEqual([emoji[1]]);
	});

	it("returns no entries when nothing matches", () => {
		expect(searchUnicodeEmoji(emoji, "missing")).toEqual([]);
	});

	it("returns the original list for an empty query", () => {
		expect(searchUnicodeEmoji(emoji, "")).toBe(emoji);
	});
});
