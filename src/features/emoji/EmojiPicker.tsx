import {
	type Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	createUniqueId,
	For,
	on,
	Show,
} from "solid-js";
import { addRecentEmoji, getRecentEmoji } from "./recentEmoji";
import type {
	ImagePack,
	PickerEmoji,
	ResolvedEmote,
	UnicodeEmoji,
} from "./types";
import { EMOJI_GROUP_LABELS, PICKER_GROUPS } from "./types";
import { getEmojiByGroup, searchUnicodeEmoji } from "./unicode";

const GRID_COLS = 8;

const EmojiPicker: Component<{
	packs: ImagePack[];
	onSelect: (emoji: PickerEmoji) => void;
	onClose: () => void;
}> = (props) => {
	const pickerId = createUniqueId();
	const [query, setQuery] = createSignal("");
	const [activeTab, setActiveTab] = createSignal("recent");
	let searchRef: HTMLInputElement | undefined;
	let gridRef: HTMLDivElement | undefined;

	// Lazy-load Unicode emoji data
	const [unicodeData] = createResource(async () => {
		const grouped = await getEmojiByGroup();
		return grouped;
	});

	// All Unicode emoji (flat) for searching
	const allUnicode = createMemo(() => {
		const data = unicodeData();
		if (!data) return [];
		const result: UnicodeEmoji[] = [];
		for (const group of PICKER_GROUPS) {
			const emojis = data.get(group);
			if (emojis) result.push(...emojis);
		}
		return result;
	});

	// Recent emoji keys
	const [recentKeys, setRecentKeys] = createSignal(getRecentEmoji());

	// Build custom emote lookup by mxc URL for recent resolution
	const customByMxc = createMemo(() => {
		const map = new Map<string, ResolvedEmote>();
		for (const pack of props.packs) {
			for (const emote of pack.emotes) {
				if (!map.has(emote.mxcUrl)) map.set(emote.mxcUrl, emote);
			}
		}
		return map;
	});

	// Build Unicode lookup by character for recent resolution
	const unicodeByChar = createMemo(() => {
		const map = new Map<string, UnicodeEmoji>();
		for (const e of allUnicode()) {
			map.set(e.unicode, e);
		}
		return map;
	});

	// Resolve recent keys to PickerEmoji items
	const recentEmoji = createMemo((): PickerEmoji[] => {
		const keys = recentKeys();
		const result: PickerEmoji[] = [];
		for (const key of keys) {
			if (key.startsWith("mxc://")) {
				const emote = customByMxc().get(key);
				if (emote) result.push({ kind: "custom", emote });
			} else {
				const ue = unicodeByChar().get(key);
				if (ue) result.push({ kind: "unicode", emoji: ue });
			}
		}
		return result;
	});

	// Tab definitions
	const tabs = createMemo(() => {
		const result: { id: string; label: string; icon: string }[] = [];
		result.push({ id: "recent", label: "Recently Used", icon: "🕐" });
		for (const pack of props.packs) {
			result.push({
				id: `pack:${pack.id}`,
				label: pack.displayName,
				icon: pack.emotes[0] ? "" : "📦",
			});
		}
		if (unicodeData()) {
			for (const group of PICKER_GROUPS) {
				const label = EMOJI_GROUP_LABELS[group] ?? `Group ${group}`;
				const groupEmoji = unicodeData()?.get(group);
				result.push({
					id: `unicode:${group}`,
					label,
					icon: groupEmoji?.[0]?.unicode ?? "😀",
				});
			}
		}
		return result;
	});

	// Current items to display
	const displayItems = createMemo((): PickerEmoji[] => {
		const q = query().trim();

		// Search mode: search across all emoji
		if (q) {
			const results: PickerEmoji[] = [];

			// Search custom packs
			const lowerQ = q.toLowerCase();
			for (const pack of props.packs) {
				for (const emote of pack.emotes) {
					if (
						emote.shortcode.toLowerCase().includes(lowerQ) ||
						emote.body.toLowerCase().includes(lowerQ)
					) {
						results.push({ kind: "custom", emote });
					}
				}
			}

			// Search Unicode
			const unicodeResults = searchUnicodeEmoji(allUnicode(), q);
			for (const ue of unicodeResults) {
				results.push({ kind: "unicode", emoji: ue });
			}

			return results;
		}

		const tab = activeTab();

		// Recent
		if (tab === "recent") {
			return recentEmoji();
		}

		// Custom pack
		if (tab.startsWith("pack:")) {
			const packId = tab.slice(5);
			const pack = props.packs.find((p) => p.id === packId);
			if (pack) {
				return pack.emotes.map(
					(emote): PickerEmoji => ({ kind: "custom", emote }),
				);
			}
			return [];
		}

		// Unicode group
		if (tab.startsWith("unicode:")) {
			const group = Number.parseInt(tab.slice(8), 10);
			const data = unicodeData();
			if (data) {
				const emojis = data.get(group);
				if (emojis) {
					return emojis.map(
						(emoji): PickerEmoji => ({ kind: "unicode", emoji }),
					);
				}
			}
			return [];
		}

		return [];
	});

	// Focus search on mount
	createEffect(() => {
		requestAnimationFrame(() => searchRef?.focus());
	});

	// Reset active tab when packs change and current tab no longer exists
	createEffect(
		on(
			() => props.packs,
			() => {
				const tab = activeTab();
				if (tab.startsWith("pack:")) {
					const packId = tab.slice(5);
					if (!props.packs.some((p) => p.id === packId)) {
						setActiveTab("recent");
					}
				}
			},
		),
	);

	function handleSelect(item: PickerEmoji): void {
		const key = item.kind === "custom" ? item.emote.mxcUrl : item.emoji.unicode;
		addRecentEmoji(key);
		setRecentKeys(getRecentEmoji());
		props.onSelect(item);
	}

	function handleKeyDown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			props.onClose();
		}
	}

	return (
		<div
			class="flex h-[360px] w-[352px] flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-800 shadow-xl"
			onKeyDown={handleKeyDown}
			role="dialog"
			aria-label="Emoji picker"
		>
			{/* Search */}
			<div class="shrink-0 px-2 pt-2">
				<input
					ref={searchRef}
					type="text"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					placeholder="Search emoji…"
					class="w-full rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-pink-500"
					aria-label="Search emoji"
				/>
			</div>

			{/* Tab bar */}
			<Show when={!query()}>
				<div
					class="flex shrink-0 gap-0.5 overflow-x-auto border-b border-neutral-700 px-1 py-1"
					role="tablist"
					aria-label="Emoji categories"
				>
					<For each={tabs()}>
						{(tab) => {
							const isActive = () => activeTab() === tab.id;
							const packForTab = () => {
								if (tab.id.startsWith("pack:")) {
									const packId = tab.id.slice(5);
									return props.packs.find((p) => p.id === packId);
								}
								return null;
							};

							return (
								<button
									type="button"
									role="tab"
									aria-selected={isActive()}
									class={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-sm transition-colors ${
										isActive()
											? "bg-pink-900/40 text-neutral-100"
											: "text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
									}`}
									onClick={() => setActiveTab(tab.id)}
									title={tab.label}
									aria-label={tab.label}
								>
									<Show when={packForTab()?.emotes[0]} fallback={tab.icon}>
										{(emote) => (
											<img
												src={emote().httpUrl}
												alt={tab.label}
												class="h-5 w-5 object-contain"
											/>
										)}
									</Show>
								</button>
							);
						}}
					</For>
				</div>
			</Show>

			{/* Emoji list */}
			<div
				ref={gridRef}
				class="min-h-0 flex-1 overflow-y-auto p-1"
				role="listbox"
				aria-label="Emoji"
				id={`emoji-grid-${pickerId}`}
			>
				<Show
					when={displayItems().length > 0}
					fallback={
						<div class="flex h-full items-center justify-center text-sm text-neutral-500">
							{query() ? "No emoji found" : "No recently used emoji"}
						</div>
					}
				>
					<div
						class="grid gap-0.5"
						style={{ "grid-template-columns": `repeat(${GRID_COLS}, 1fr)` }}
					>
						<For each={displayItems()}>
							{(item) => {
								const label =
									item.kind === "unicode"
										? item.emoji.label
										: `:${item.emote.shortcode}:`;
								const title =
									item.kind === "unicode"
										? `${item.emoji.label} :${item.emoji.shortcodes[0] ?? ""}:`
										: `:${item.emote.shortcode}:`;

								return (
									<button
										type="button"
										role="option"
										class="flex h-9 w-9 items-center justify-center rounded text-xl transition-colors hover:bg-neutral-700"
										onClick={() => handleSelect(item)}
										title={title}
										aria-label={label}
									>
										{item.kind === "unicode" ? (
											item.emoji.unicode
										) : (
											<img
												src={item.emote.httpUrl}
												alt={label}
												class="h-7 w-7 object-contain"
											/>
										)}
									</button>
								);
							}}
						</For>
					</div>
				</Show>
			</div>
		</div>
	);
};

export default EmojiPicker;
