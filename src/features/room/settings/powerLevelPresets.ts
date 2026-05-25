/**
 * Power-level preset helpers for the Room Settings → Permissions tab.
 *
 * Matrix spec defaults for `m.room.power_levels`:
 *   events_default: 0     state_default: 50    users_default: 0
 *   invite: 0             kick: 50             ban: 50           redact: 50
 *
 * v1 surfaces a small fixed set of presets — Anyone (0) or
 * Moderators only (50) — for the top-level defaults of each gated
 * action. The per-user `users` map and the per-type `events` map are
 * preserved verbatim on every write.
 */
export type Preset = "anyone" | "moderators" | "custom";

export const PRESET_LEVELS = {
	anyone: 0,
	moderators: 50,
} as const;

/** Gated top-level keys this surface exposes for editing. */
export type GatedKey =
	| "events_default"
	| "state_default"
	| "invite"
	| "redact"
	| "kick"
	| "ban";

/** Spec defaults — used when the key is missing from the PL content. */
export const SPEC_DEFAULTS: Record<GatedKey, number> = {
	events_default: 0,
	state_default: 50,
	invite: 0,
	redact: 50,
	kick: 50,
	ban: 50,
};

/** Spec default for `users_default` — used to decide delete-vs-zero on demote. */
export const USERS_DEFAULT_FALLBACK = 0;

export interface PowerLevelContent {
	users?: Record<string, number>;
	events?: Record<string, number>;
	users_default?: number;
	events_default?: number;
	state_default?: number;
	invite?: number;
	redact?: number;
	kick?: number;
	ban?: number;
	notifications?: Record<string, number>;
	historical?: number;
	[other: string]: unknown;
}

/** Read the effective level for a gated key, falling back to spec defaults. */
export function effectiveLevel(
	content: PowerLevelContent | null | undefined,
	key: GatedKey,
): number {
	const raw = content?.[key];
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	return SPEC_DEFAULTS[key];
}

/** Read users_default, falling back to spec default 0. */
export function effectiveUsersDefault(
	content: PowerLevelContent | null | undefined,
): number {
	const raw = content?.users_default;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	return USERS_DEFAULT_FALLBACK;
}

/** Detect which preset (if any) a numeric level corresponds to. */
export function presetForLevel(level: number): Preset {
	if (level === PRESET_LEVELS.anyone) return "anyone";
	if (level === PRESET_LEVELS.moderators) return "moderators";
	return "custom";
}

/**
 * Build the next `m.room.power_levels` content with one gated key
 * overridden to a preset. Preserves `users`, `events`, and every
 * untouched top-level key.
 */
export function withPreset(
	current: PowerLevelContent | null | undefined,
	key: GatedKey,
	preset: Exclude<Preset, "custom">,
): PowerLevelContent {
	const base: PowerLevelContent = current ? { ...current } : {};
	if (base.users) base.users = { ...base.users };
	if (base.events) base.events = { ...base.events };
	if (base.notifications) base.notifications = { ...base.notifications };
	base[key] = PRESET_LEVELS[preset];
	return base;
}

/**
 * Build the next PL content with `users[userId]` set to a level.
 * Pass `null` to remove the entry (falls back to `users_default`).
 *
 * When demoting to "member", callers typically want the user to fall
 * back to `users_default`. If `users_default` is the spec default 0
 * that means deleting the key; if it's some nonzero value, deleting
 * would *promote* the user. `levelForDemote` resolves this correctly.
 */
export function withUserLevel(
	current: PowerLevelContent | null | undefined,
	userId: string,
	level: number | null,
): PowerLevelContent {
	const base: PowerLevelContent = current ? { ...current } : {};
	if (base.events) base.events = { ...base.events };
	if (base.notifications) base.notifications = { ...base.notifications };
	const users = { ...(base.users ?? {}) };
	if (level === null) {
		delete users[userId];
	} else {
		users[userId] = level;
	}
	base.users = users;
	return base;
}

/**
 * Resolve the demote write for "drop a user back to the room baseline":
 *  - If `users_default === 0`, return `{ level: null }` so the caller
 *    deletes the `users[userId]` key — the user falls through to the
 *    default of 0.
 *  - Otherwise, return `{ level: 0 }`. Deleting would *promote* the
 *    user to a non-zero `users_default`, which is not what "demote to
 *    member" means in this UI; writing an explicit 0 keeps them below
 *    the (raised) default. Note that this is *below* the room's
 *    default — by design — and the caller still needs PL > 0 to write
 *    it; gating is handled by `canChangePowerLevel`.
 */
export function levelForDemote(content: PowerLevelContent | null | undefined): {
	level: number | null;
} {
	return effectiveUsersDefault(content) === 0 ? { level: null } : { level: 0 };
}

/**
 * Lowering `state_default` to 0 makes the room wide-open for any
 * state event without a per-type override — a moderation change that
 * warrants an extra confirm. Returns true when (key === "state_default"
 * && nextLevel === 0 && currentLevel > 0).
 */
export function requiresStateDefaultConfirm(
	content: PowerLevelContent | null | undefined,
	key: GatedKey,
	nextLevel: number,
): boolean {
	if (key !== "state_default") return false;
	if (nextLevel !== 0) return false;
	return effectiveLevel(content, "state_default") > 0;
}

/**
 * Count the number of per-event-type overrides currently present in
 * `m.room.power_levels.events`. Surfaced as a small note ("N
 * per-event overrides preserved") so the user understands the
 * preset only changes the default.
 */
export function eventOverrideCount(
	content: PowerLevelContent | null | undefined,
): number {
	const events = content?.events;
	if (!events || typeof events !== "object") return 0;
	let n = 0;
	for (const v of Object.values(events)) {
		if (Number.isFinite(v)) n++;
	}
	return n;
}
