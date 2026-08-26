import type { MatrixClient, RoomMember } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import {
	isRoomMentionCandidate,
	type MentionCandidate,
	ROOM_MENTION_CANDIDATE,
	useMentions,
} from "./useMentions";

function makeMember(userId: string, name: string): RoomMember {
	return { userId, name } as RoomMember;
}

/** Unwrap the member rows of a candidate list (dropping the @room entry). */
function memberIds(candidates: MentionCandidate[]): string[] {
	return candidates
		.filter((c): c is RoomMember => !isRoomMentionCandidate(c))
		.map((c) => c.userId);
}

function setup(
	members: RoomMember[],
	opts: { canRoomMention?: boolean; textarea?: boolean } = {},
) {
	const client = {
		getUserId: () => "@me:example.com",
		getRoom: () => ({
			getJoinedMembers: () => members,
			currentState: {
				mayTriggerNotifOfType: (_key: string, _userId: string) =>
					opts.canRoomMention === true,
			},
		}),
	} as unknown as MatrixClient;
	// Minimal textarea stand-in for the insertion paths; `value` mirrors the
	// text signal set by setText below.
	const textarea = opts.textarea
		? ({
				selectionStart: 0,
				value: "",
				setSelectionRange: () => {},
				focus: () => {},
			} as unknown as HTMLTextAreaElement)
		: undefined;
	let currentText = "";
	return createRoot((dispose) => {
		const mentions = useMentions({
			client,
			roomId: () => "!room:example.com",
			getTextarea: () => textarea,
			text: () => currentText,
			setText: (v) => {
				currentText = v;
				if (textarea) (textarea as { value: string }).value = v;
			},
			autoResize: () => {},
		});
		return {
			mentions,
			dispose,
			textarea,
			getText: () => currentText,
			setCaret: (pos: number) => {
				if (textarea)
					(textarea as { selectionStart: number }).selectionStart = pos;
			},
			type: (v: string) => {
				currentText = v;
				if (textarea) (textarea as { value: string }).value = v;
			},
		};
	});
}

describe("useMentions mentionCandidates", () => {
	it("returns every match - no result cap (the picker windows its rows)", () => {
		const members = Array.from({ length: 120 }, (_, i) =>
			makeMember(`@user${i}:example.com`, `Member ${i}`),
		);
		const { mentions, dispose } = setup(members);
		try {
			mentions.setMentionQuery("member");
			expect(mentions.mentionCandidates().length).toBe(120);
		} finally {
			dispose();
		}
	});

	it("matches by display name or user ID, case-insensitively", () => {
		const members = [
			makeMember("@alice:example.com", "Alice"),
			makeMember("@bob:example.com", "Bob"),
			makeMember("@carol:example.com", "carlisle"),
		];
		const { mentions, dispose } = setup(members);
		try {
			mentions.setMentionQuery("AL");
			expect(memberIds(mentions.mentionCandidates())).toEqual([
				"@alice:example.com",
			]);
			mentions.setMentionQuery("carol");
			// carlisle's name doesn't contain "carol" but the user ID does.
			expect(memberIds(mentions.mentionCandidates())).toEqual([
				"@carol:example.com",
			]);
		} finally {
			dispose();
		}
	});

	it("sees a live display-name change (the SDK mutates RoomMember in place)", () => {
		const bob = makeMember("@bob:example.com", "Bob");
		const { mentions, dispose } = setup([bob]);
		try {
			// Prime a query so any identity-keyed cache would be built now.
			mentions.setMentionQuery("bob");
			expect(mentions.mentionCandidates().length).toBe(1);
			// matrix-js-sdk updates the member object in place on rename; the
			// members array identity does not change.
			(bob as { name: string }).name = "Robert";
			mentions.setMentionQuery("rob");
			expect(memberIds(mentions.mentionCandidates())).toEqual([
				"@bob:example.com",
			]);
		} finally {
			dispose();
		}
	});

	it("is empty when no mention is being typed (null query)", () => {
		const { mentions, dispose } = setup([
			makeMember("@alice:example.com", "Alice"),
		]);
		try {
			expect(mentions.mentionCandidates()).toEqual([]);
		} finally {
			dispose();
		}
	});
});

describe("useMentions @room candidate (#448)", () => {
	const alice = () => makeMember("@alice:example.com", "Alice");

	it("trails the member matches when the query prefixes 'room' and the sender may notify", () => {
		const { mentions, dispose } = setup([alice()], { canRoomMention: true });
		try {
			// Trailing, never index 0: the picker's default Enter target is
			// the first row, and the everyone-ping must not be one
			// muscle-memory keystroke away from a member named "Ro...".
			mentions.setMentionQuery("");
			const all = mentions.mentionCandidates();
			expect(all[all.length - 1]).toBe(ROOM_MENTION_CANDIDATE);
			expect(all[0]).not.toBe(ROOM_MENTION_CANDIDATE);
			mentions.setMentionQuery("ro");
			expect(mentions.mentionCandidates()).toEqual([ROOM_MENTION_CANDIDATE]);
			mentions.setMentionQuery("roomx");
			expect(mentions.mentionCandidates()).toEqual([]);
		} finally {
			dispose();
		}
	});

	it("never offers @room without the room-notification power level", () => {
		const { mentions, dispose } = setup([alice()], { canRoomMention: false });
		try {
			mentions.setMentionQuery("");
			expect(mentions.mentionCandidates().some(isRoomMentionCandidate)).toBe(
				false,
			);
			mentions.setMentionQuery("room");
			expect(mentions.mentionCandidates()).toEqual([]);
		} finally {
			dispose();
		}
	});

	it("selecting @room inserts the plain token and arms the intent", () => {
		const h = setup([alice()], { canRoomMention: true, textarea: true });
		try {
			h.type("hey @ro");
			h.setCaret(7);
			h.mentions.setMentionQuery("ro");
			h.mentions.onMentionSelect(ROOM_MENTION_CANDIDATE);
			expect(h.getText()).toBe("hey @room ");
			expect(h.mentions.roomMentionIntent()).toBe(true);
			expect(h.mentions.reconcileRoomMention(h.getText())).toBe(true);
		} finally {
			h.dispose();
		}
	});

	it("reconcile drops the intent when the token is gone or code-fenced", () => {
		const h = setup([alice()], { canRoomMention: true, textarea: true });
		try {
			h.type("@ro");
			h.setCaret(3);
			h.mentions.setMentionQuery("ro");
			h.mentions.onMentionSelect(ROOM_MENTION_CANDIDATE);
			expect(h.mentions.reconcileRoomMention("@room hi")).toBe(true);
			expect(h.mentions.reconcileRoomMention("no token any more")).toBe(false);
			expect(h.mentions.reconcileRoomMention("`@room` in code")).toBe(false);
			expect(h.mentions.reconcileRoomMention("mail@roomba")).toBe(false);
		} finally {
			h.dispose();
		}
	});

	it("code spans strip to spaces, so spliced text cannot form a phantom @room", () => {
		const h = setup([makeMember("@alice:example.com", "Alice")], {
			canRoomMention: true,
			textarea: true,
		});
		try {
			h.type("@ro");
			h.setCaret(3);
			h.mentions.setMentionQuery("ro");
			h.mentions.onMentionSelect(ROOM_MENTION_CANDIDATE);
			// "@ro`x`om" must NOT read as "@room" after code stripping - an
			// empty-string splice would fuse the halves into a phantom token.
			expect(h.mentions.reconcileRoomMention("@ro`x`om")).toBe(false);
		} finally {
			h.dispose();
		}
	});

	it("a plain-typed @room without a pick carries no intent", () => {
		const h = setup([alice()], { canRoomMention: true });
		try {
			expect(h.mentions.reconcileRoomMention("@room everyone!")).toBe(false);
		} finally {
			h.dispose();
		}
	});
});

describe("useMentions @room intent lifecycle", () => {
	it("disarms on input once the picked token is deleted, so a re-typed @room does not ping", () => {
		const h = setup([makeMember("@alice:example.com", "Alice")], {
			canRoomMention: true,
			textarea: true,
		});
		try {
			h.type("@ro");
			h.setCaret(3);
			h.mentions.setMentionQuery("ro");
			h.mentions.onMentionSelect(ROOM_MENTION_CANDIDATE);
			expect(h.mentions.roomMentionIntent()).toBe(true);
			// User deletes the token; the input handler re-detects.
			h.type("quoting ");
			h.setCaret(8);
			h.mentions.detectMention();
			expect(h.mentions.roomMentionIntent()).toBe(false);
			// A later hand-typed @room must not ride the stale intent.
			expect(h.mentions.reconcileRoomMention("quoting @room here")).toBe(false);
		} finally {
			h.dispose();
		}
	});

	it("a member display-named 'room' inserts their user-id form, never the @room token", () => {
		const evil = makeMember("@evil:example.com", "room");
		const h = setup([evil], { canRoomMention: true, textarea: true });
		try {
			h.type("@ro");
			h.setCaret(3);
			h.mentions.setMentionQuery("ro");
			h.mentions.onMentionSelect(evil);
			expect(h.getText()).toBe("@evil:example.com ");
			expect(h.mentions.roomMentionIntent()).toBe(false);
			expect(h.mentions.mentions()).toEqual([
				{ userId: "@evil:example.com", displayName: "evil:example.com" },
			]);
		} finally {
			h.dispose();
		}
	});

	it("resetMentionState clears mentions, intent, and query together", () => {
		const h = setup([makeMember("@alice:example.com", "Alice")], {
			canRoomMention: true,
			textarea: true,
		});
		try {
			h.type("@ro");
			h.setCaret(3);
			h.mentions.setMentionQuery("ro");
			h.mentions.onMentionSelect(ROOM_MENTION_CANDIDATE);
			h.mentions.resetMentionState();
			expect(h.mentions.roomMentionIntent()).toBe(false);
			expect(h.mentions.mentions()).toEqual([]);
			expect(h.mentions.mentionQuery()).toBeNull();
		} finally {
			h.dispose();
		}
	});
});
