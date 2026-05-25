import { describe, expect, it } from "vitest";
import {
	effectiveLevel,
	effectiveUsersDefault,
	eventOverrideCount,
	levelForDemote,
	type PowerLevelContent,
	presetForLevel,
	requiresStateDefaultConfirm,
	SPEC_DEFAULTS,
	withPreset,
	withUserLevel,
} from "./powerLevelPresets";

describe("powerLevelPresets", () => {
	describe("effectiveLevel", () => {
		it("returns spec defaults when key is missing", () => {
			expect(effectiveLevel(null, "events_default")).toBe(0);
			expect(effectiveLevel(undefined, "state_default")).toBe(50);
			expect(effectiveLevel({}, "kick")).toBe(50);
			expect(effectiveLevel({}, "invite")).toBe(0);
		});
		it("returns explicit value when present", () => {
			expect(effectiveLevel({ kick: 25 }, "kick")).toBe(25);
			expect(effectiveLevel({ invite: 75 }, "invite")).toBe(75);
		});
		it("ignores non-numeric values", () => {
			expect(effectiveLevel({ kick: "50" as unknown as number }, "kick")).toBe(
				SPEC_DEFAULTS.kick,
			);
		});
	});

	describe("presetForLevel", () => {
		it("maps 0 → anyone and 50 → moderators", () => {
			expect(presetForLevel(0)).toBe("anyone");
			expect(presetForLevel(50)).toBe("moderators");
		});
		it("returns custom for anything else", () => {
			expect(presetForLevel(25)).toBe("custom");
			expect(presetForLevel(75)).toBe("custom");
			expect(presetForLevel(100)).toBe("custom");
		});
	});

	describe("withPreset", () => {
		it("writes the preset numeric value for the target key", () => {
			const next = withPreset(null, "kick", "moderators");
			expect(next.kick).toBe(50);
			const next2 = withPreset({ kick: 50 }, "kick", "anyone");
			expect(next2.kick).toBe(0);
		});
		it("preserves the users map verbatim", () => {
			const current: PowerLevelContent = {
				users: { "@a:s": 100, "@b:s": 50 },
				users_default: 0,
				kick: 50,
			};
			const next = withPreset(current, "events_default", "anyone");
			expect(next.users).toEqual({ "@a:s": 100, "@b:s": 50 });
			expect(next.users_default).toBe(0);
			expect(next.kick).toBe(50);
		});
		it("preserves the events map verbatim", () => {
			const current: PowerLevelContent = {
				events: { "m.reaction": 0, "m.room.tombstone": 100 },
				kick: 50,
			};
			const next = withPreset(current, "events_default", "moderators");
			expect(next.events).toEqual({
				"m.reaction": 0,
				"m.room.tombstone": 100,
			});
		});
		it("does not mutate the input content", () => {
			const current: PowerLevelContent = {
				users: { "@a:s": 100 },
				events: { "m.reaction": 0 },
			};
			const snapshot = JSON.parse(JSON.stringify(current));
			withPreset(current, "kick", "anyone");
			expect(current).toEqual(snapshot);
		});
	});

	describe("withUserLevel", () => {
		it("sets the user level", () => {
			const next = withUserLevel({ users: {} }, "@a:s", 100);
			expect(next.users).toEqual({ "@a:s": 100 });
		});
		it("removes the entry when level is null", () => {
			const next = withUserLevel({ users: { "@a:s": 100 } }, "@a:s", null);
			expect(next.users).toEqual({});
		});
		it("preserves other entries", () => {
			const next = withUserLevel(
				{ users: { "@a:s": 100, "@b:s": 50 } },
				"@a:s",
				null,
			);
			expect(next.users).toEqual({ "@b:s": 50 });
		});
		it("does not mutate the input", () => {
			const current: PowerLevelContent = {
				users: { "@a:s": 100 },
			};
			withUserLevel(current, "@a:s", 50);
			expect(current.users).toEqual({ "@a:s": 100 });
		});
	});

	describe("levelForDemote", () => {
		it("returns delete (null) when users_default is 0", () => {
			expect(levelForDemote({ users_default: 0 })).toEqual({ level: null });
			expect(levelForDemote({})).toEqual({ level: null });
			expect(levelForDemote(null)).toEqual({ level: null });
		});
		it("returns explicit 0 when users_default is non-zero", () => {
			expect(levelForDemote({ users_default: 25 })).toEqual({ level: 0 });
			expect(levelForDemote({ users_default: 50 })).toEqual({ level: 0 });
		});
	});

	describe("effectiveUsersDefault", () => {
		it("falls back to 0", () => {
			expect(effectiveUsersDefault(null)).toBe(0);
			expect(effectiveUsersDefault({})).toBe(0);
		});
		it("reads explicit value", () => {
			expect(effectiveUsersDefault({ users_default: 25 })).toBe(25);
		});
	});

	describe("requiresStateDefaultConfirm", () => {
		it("returns true only when lowering state_default to 0", () => {
			expect(
				requiresStateDefaultConfirm({ state_default: 50 }, "state_default", 0),
			).toBe(true);
		});
		it("returns false for the spec-default-already-50 → 50 no-op", () => {
			expect(requiresStateDefaultConfirm({}, "state_default", 50)).toBe(false);
		});
		it("returns false for state_default → 50 (raising)", () => {
			expect(
				requiresStateDefaultConfirm({ state_default: 50 }, "state_default", 50),
			).toBe(false);
		});
		it("returns false when state_default is already 0", () => {
			expect(
				requiresStateDefaultConfirm({ state_default: 0 }, "state_default", 0),
			).toBe(false);
		});
		it("returns false for non state_default keys", () => {
			expect(requiresStateDefaultConfirm({ kick: 50 }, "kick", 0)).toBe(false);
		});
	});

	describe("eventOverrideCount", () => {
		it("counts numeric overrides only", () => {
			expect(eventOverrideCount(null)).toBe(0);
			expect(eventOverrideCount({})).toBe(0);
			expect(eventOverrideCount({ events: {} })).toBe(0);
			expect(
				eventOverrideCount({ events: { "m.reaction": 0, "m.room.x": 50 } }),
			).toBe(2);
			expect(
				eventOverrideCount({
					events: {
						"m.reaction": 0,
						"m.bogus": "50" as unknown as number,
					},
				}),
			).toBe(1);
		});

		it("ignores non-finite numeric overrides (NaN, Infinity)", () => {
			expect(
				eventOverrideCount({
					events: {
						"m.reaction": 0,
						"m.nan": Number.NaN,
						"m.posinf": Number.POSITIVE_INFINITY,
						"m.neginf": Number.NEGATIVE_INFINITY,
					},
				}),
			).toBe(1);
		});
	});
});
