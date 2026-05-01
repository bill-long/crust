/** MSC2545 image pack content (from account data or room state). */
export interface ImagePackContent {
	pack?: {
		display_name?: string;
		avatar_url?: string;
		usage?: PackUsage[];
	};
	images?: Record<string, PackImage>;
}

export interface PackImage {
	url: string;
	body?: string;
	usage?: PackUsage[];
	info?: {
		w?: number;
		h?: number;
		mimetype?: string;
		size?: number;
	};
}

export type PackUsage = "emoticon" | "sticker";

/** Emote rooms account data: maps room IDs to state keys. */
export interface EmoteRoomsContent {
	rooms?: Record<string, Record<string, object>>;
}

/** A resolved image pack with HTTP URLs ready to render. */
export interface ImagePack {
	id: string;
	displayName: string;
	avatarUrl: string | null;
	emotes: ResolvedEmote[];
}

/** A single resolved emote with both MXC and HTTP URLs. */
export interface ResolvedEmote {
	shortcode: string;
	mxcUrl: string;
	httpUrl: string;
	body: string;
	packId: string;
	packName: string;
}

/** A Unicode emoji entry for the picker. */
export interface UnicodeEmoji {
	unicode: string;
	label: string;
	hexcode: string;
	group: number;
	order: number;
	tags: string[];
	shortcodes: string[];
}

/** Emoji category names (emojibase group numbers → labels). */
export const EMOJI_GROUP_LABELS: Record<number, string> = {
	0: "Smileys & People",
	1: "People & Body",
	2: "Component",
	3: "Animals & Nature",
	4: "Food & Drink",
	5: "Travel & Places",
	6: "Activities",
	7: "Objects",
	8: "Symbols",
	9: "Flags",
};

/** Groups to display in the picker (skip "Component" group 2). */
export const PICKER_GROUPS = [0, 1, 3, 4, 5, 6, 7, 8, 9];

/** An item in the emoji picker — either Unicode or custom. */
export type PickerEmoji =
	| { kind: "unicode"; emoji: UnicodeEmoji }
	| { kind: "custom"; emote: ResolvedEmote };
