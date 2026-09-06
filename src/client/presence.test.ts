import { ClientEvent, type MatrixClient, type User } from "matrix-js-sdk";
import { createEffect, createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { requiredAt } from "../test/assertions";
import {
	attachPresence,
	MAX_STATUS_MSG_LENGTH,
	presenceOf,
	recordSelfPresence,
	recordSelfStatusMsg,
	sanitizeStatusMsg,
	selfRawStatusMsg,
	toPresenceInfo,
} from "./presence";

function mkUser(
	userId: string,
	presence: string,
	presenceStatusMsg: string | null = null,
): User {
	return { userId, presence, presenceStatusMsg } as unknown as User;
}

function mkClient(users: User[]) {
	const listeners = new Map<string, Set<(e: unknown, u: User) => void>>();
	const client = {
		getUsers: () => users,
		getUserId: () => "@me:x",
		on: vi.fn((event: string, fn: (e: unknown, u: User) => void) => {
			const set = listeners.get(event) ?? new Set();
			set.add(fn);
			listeners.set(event, set);
		}),
		off: vi.fn((event: string, fn: (e: unknown, u: User) => void) => {
			listeners.get(event)?.delete(fn);
		}),
	} as unknown as MatrixClient;
	// Named, not a method: callers destructure the returned object, so `this`
	// is undefined by the time `emit` runs.
	const emitSync = (
		event: string,
		user: User,
		content?: Record<string, unknown>,
	): void => {
		const ev =
			content === undefined ? undefined : { getContent: () => content };
		for (const fn of [...(listeners.get(event) ?? [])]) fn(ev, user);
	};
	// A raw client-level emit (ClientEvent.Event carries a MatrixEvent-shaped
	// object, not a User).
	const emitRaw = (event: string, ...args: unknown[]): void => {
		for (const fn of [...(listeners.get(event) ?? [])])
			(fn as (...a: unknown[]) => void)(...args);
	};
	return {
		client,
		emitSync,
		/**
		 * Emit, then let the microtask that flushes the batch run. Presence
		 * writes are coalesced per sync batch, so they are one tick behind
		 * the event.
		 */
		async emit(event: string, user: User, content?: Record<string, unknown>) {
			emitSync(event, user, content);
			await Promise.resolve();
		},
		emitRaw,
		listenerCount: () =>
			[...listeners.values()].reduce((n, s) => n + s.size, 0),
	};
}

/**
 * Attach under a reactive root and hand back the disposer.
 *
 * Deliberately not `createRoot(async ...)`: an assertion inside an
 * un-awaited async callback never reaches vitest, so the whole suite passed
 * against broken code until a mutation check caught it.
 */
function withPresence(client: MatrixClient): () => void {
	return createRoot((dispose) => {
		attachPresence(client);
		return dispose;
	});
}

describe("sanitizeStatusMsg", () => {
	it("keeps ordinary text", () => {
		expect(sanitizeStatusMsg("In a meeting")).toBe("In a meeting");
	});

	it("flattens a message that would take more than its one line", () => {
		// A status renders in a single-line slot next to a name; a newline
		// would push the layout apart. It becomes a space rather than
		// vanishing, or the words on either side glue together.
		expect(sanitizeStatusMsg("away\nback at 5")).toBe("away back at 5");
	});

	it("collapses runs of whitespace", () => {
		expect(sanitizeStatusMsg("  heads   down  ")).toBe("heads down");
	});

	it("treats a whitespace-only status as no status", () => {
		// So "cleared it" and "set it to spaces" render identically.
		expect(sanitizeStatusMsg("   ")).toBeNull();
		expect(sanitizeStatusMsg("")).toBeNull();
	});

	it("does not split an emoji at the length cap", () => {
		// Slicing by UTF-16 unit can leave half a surrogate pair, which
		// renders as a replacement character.
		// 118 filler + astral chars puts the cut index (MAX-1 = 119) *inside*
		// the first surrogate pair, which is the only place it can break.
		const out = sanitizeStatusMsg(
			`${"x".repeat(118)}\u{1F600}\u{1F600}\u{1F600}`,
		);
		expect(out?.endsWith("…")).toBe(true);
		expect([...(out ?? "")].length).toBe(MAX_STATUS_MSG_LENGTH);
		// The real tell: a surviving unpaired surrogate. It still counts as
		// one code point, so a length check alone cannot see it - it only
		// shows up as a replacement glyph on screen.
		const lone = [...(out ?? "")].some((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return code >= 0xd800 && code <= 0xdfff;
		});
		expect(lone).toBe(false);
	});

	it("ignores a non-string from the wire", () => {
		expect(sanitizeStatusMsg(undefined)).toBeNull();
		expect(sanitizeStatusMsg(42)).toBeNull();
	});

	it("caps a long message with an ellipsis", () => {
		const out = sanitizeStatusMsg("x".repeat(500));
		expect(out).toHaveLength(MAX_STATUS_MSG_LENGTH);
		expect(out?.endsWith("…")).toBe(true);
	});
});

describe("toPresenceInfo", () => {
	it("names Matrix's `unavailable` what every other client calls it", () => {
		expect(toPresenceInfo({ presence: "unavailable" }).status).toBe("idle");
	});

	it("maps online and offline through", () => {
		expect(toPresenceInfo({ presence: "online" }).status).toBe("online");
		expect(toPresenceInfo({ presence: "offline" }).status).toBe("offline");
	});

	it("does not claim someone is offline just because we have not heard", () => {
		// unknown must stay distinct: the indicator is omitted rather than
		// asserting a state the server never told us.
		expect(toPresenceInfo({}).status).toBe("unknown");
	});

	it("reads the status from the event, not the SDK's User field", () => {
		// setPresenceEvent only assigns presenceStatusMsg on truthy values, so
		// reading that field would keep showing a cleared status.
		expect(
			toPresenceInfo({ presence: "online", status_msg: "brb" }).statusMsg,
		).toBe("brb");
		expect(toPresenceInfo({ presence: "online" }).statusMsg).toBeNull();
	});
});

describe("sanitizeStatusMsg bounds", () => {
	it("caps the work it does on an unbounded status message", () => {
		// status_msg is unbounded on the wire and re-emitted every sync, so
		// the input is sliced before any per-character work. The cap-length
		// output must be identical to what the unsliced path produced.
		const huge = `${"a".repeat(500_000)} tail`;
		expect(sanitizeStatusMsg(huge)).toBe(
			`${"a".repeat(MAX_STATUS_MSG_LENGTH - 1)}…`,
		);
	});

	it("marks astral text as truncated, like any other overflow", () => {
		// The bound plus the lone-surrogate pop used to land an all-emoji
		// value exactly on the cap, so the over-cap branch never fired and
		// 80 emoji vanished with no ellipsis to say so.
		const many = "\u{1F600}".repeat(200);
		const out = sanitizeStatusMsg(many);
		expect(out?.endsWith("…")).toBe(true);
		expect(Array.from(out ?? "")).toHaveLength(MAX_STATUS_MSG_LENGTH);
	});

	it("drops a trailing lone surrogate rather than rendering it", () => {
		// It falls under the cap, so the truncation branch that otherwise
		// always removes a mid-pair cut never runs, and the value would
		// render as a replacement glyph.
		expect(sanitizeStatusMsg("Back soon\ud83d")).toBe("Back soon");
		expect(sanitizeStatusMsg("\ud83d")).toBeNull();
	});

	it("keeps text that arrives behind a long run of padding", () => {
		// Bounding before normalising would spend the whole budget on the
		// newlines and render this as "no status" - hiding text the cap
		// would have kept.
		const padded = `${"\n".repeat(5_000)}Back at 3`;
		expect(sanitizeStatusMsg(padded)).toBe("Back at 3");
	});

	it("still keeps a full-length message that sits right at the cap", () => {
		// The bound is 2x the cap plus one, because a code point is at most
		// two UTF-16 units; a cap-length run of astral characters must
		// survive it whole.
		const astral = "\u{1F600}".repeat(MAX_STATUS_MSG_LENGTH);
		expect(sanitizeStatusMsg(astral)).toBe(astral);
	});
});

describe("attachPresence", () => {
	it("fills from presence events rather than a seed", async () => {
		// attachPresence runs during provider setup, before startClient, so
		// client.getUsers() is always empty there - a seed loop would be dead
		// code. The listener is registered first, so nothing is missed.
		const { client, emit } = mkClient([mkUser("@a:x", "online")]);
		const dispose = withPresence(client);
		expect(presenceOf("@a:x").status).toBe("unknown");
		await emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			presence: "online",
		});
		expect(presenceOf("@a:x").status).toBe("online");
		dispose();
	});

	it("lets the publisher's rollback survive the provider effect", async () => {
		// The provider calls this from inside a createEffect. If the no-op
		// guard's read were tracked, that effect would subscribe to our own
		// presence key - so the rollback after a refused publish would
		// notify it, it would re-run with sharing still on, and write
		// `online` straight back. The rollback would never survive on the
		// presence-disabled homeserver it exists for.
		const stop = createRoot((d) => {
			const [sharing] = createSignal(true);
			createEffect(() => recordSelfPresence("@me:x", sharing()));
			return d;
		});
		await Promise.resolve();
		expect(presenceOf("@me:x").status).toBe("online");

		recordSelfPresence("@me:x", false);
		await Promise.resolve();
		await Promise.resolve();

		expect(presenceOf("@me:x").status).toBe("unknown");
		stop();
	});

	it("does not write our own presence when it has not changed", () => {
		// Every key is subscribed by the member list's flat list, so a
		// redundant write costs a full partition and array rebuild. A fresh
		// object would be a new reference and defeat Solid's equality check.
		const { client } = mkClient([]);
		const dispose = withPresence(client);
		recordSelfPresence("@me:x", true);

		let runs = 0;
		const stop = createRoot((d) => {
			createEffect(() => {
				presenceOf("@me:x");
				runs++;
			});
			return d;
		});
		runs = 0;
		recordSelfPresence("@me:x", true);

		expect(runs).toBe(0);
		stop();
		dispose();
	});

	it("reports unknown for a user it has never heard about", () => {
		const { client } = mkClient([]);
		const dispose = withPresence(client);
		expect(presenceOf("@nobody:x")).toEqual({
			status: "unknown",
			statusMsg: null,
		});
		dispose();
	});

	it("follows a user going idle", async () => {
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("@a:x", "unavailable"), {
			presence: "unavailable",
		});
		expect(presenceOf("@a:x").status).toBe("idle");
		dispose();
	});

	it("derives status from presence alone", async () => {
		// Deliberately not subscribed to User.currentlyActive: that event
		// fires precisely when `presence` did not change, so it could never
		// move a status derived this way. Idle arrives as an explicit
		// `unavailable` instead.
		const { client, emit } = mkClient([mkUser("@a:x", "online")]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			presence: "online",
		});
		await emit("User.currentlyActive", mkUser("@a:x", "online"));
		expect(presenceOf("@a:x").status).toBe("online");
		dispose();
	});

	it("sanitizes a status message set from another client", async () => {
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			presence: "online",
			status_msg: "on a\ncall",
		});
		expect(presenceOf("@a:x").statusMsg).toBe("on a call");
		dispose();
	});

	it("does not erase a peer on an event carrying no content", async () => {
		// No event is no information. Synthesizing empty content resolves to
		// `unknown`, which would drop the dot and re-section the member row on
		// the strength of nothing at all.
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			presence: "online",
		});
		expect(presenceOf("@a:x").status).toBe("online");

		await emit("User.lastPresenceTs", mkUser("@a:x", "online"));

		expect(presenceOf("@a:x").status).toBe("online");
		dispose();
	});

	it("applies every user in one sync batch", async () => {
		// Writes are coalesced into one store update per batch; all of them
		// still have to land.
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await Promise.all([
			emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
				presence: "online",
			}),
			emit("User.lastPresenceTs", mkUser("@b:x", "unavailable"), {
				presence: "unavailable",
			}),
		]);

		expect(presenceOf("@a:x").status).toBe("online");
		expect(presenceOf("@b:x").status).toBe("idle");
		dispose();
	});

	it("costs one update cycle no matter how many people are in the batch", async () => {
		// The reason the batch exists. MemberList's flat list reads every
		// member's presence key in one computation, so a write per user means
		// a full O(members) partition per user. Asserting the values landed -
		// which the test above does - passes just as happily against a write
		// inside the loop, so this counts the flushes instead.
		const ids = Array.from({ length: 10 }, (_, i) => `@u${i}:x`);
		const { client, emit } = mkClient([]);

		let runs = 0;
		const dispose = createRoot((d) => {
			attachPresence(client);
			createEffect(() => {
				for (const id of ids) presenceOf(id);
				runs++;
			});
			return d;
		});
		await Promise.resolve();
		runs = 0;

		await Promise.all(
			ids.map((id) =>
				emit("User.lastPresenceTs", mkUser(id, "online"), {
					presence: "online",
				}),
			),
		);

		expect(presenceOf(requiredAt(ids, 9, "last user id")).status).toBe(
			"online",
		);
		expect(runs).toBe(1);
		dispose();
	});

	it("survives a presence event with no sender", async () => {
		// The SDK builds its User from presenceEvent.getSender(), so a
		// sender-less event arrives with userId undefined. This runs in a
		// microtask, where the TypeError would be uncaught and would take
		// the rest of the batch down with it.
		const { client, emitSync } = mkClient([]);
		const dispose = withPresence(client);

		emitSync("User.lastPresenceTs", { userId: undefined } as unknown as User, {
			presence: "online",
		});
		emitSync("User.lastPresenceTs", mkUser("@later:x", "online"), {
			presence: "online",
		});
		await Promise.resolve();

		// Queued after the bad entry, so it is the one a throw would lose.
		expect(presenceOf("@later:x").status).toBe("online");
		dispose();
	});

	it("does not let a server-controlled key reach Object.prototype", async () => {
		// m.direct keys and presence senders are server-controlled. Reading
		// `presences["__proto__"]` returns Object.prototype - which renders as
		// `aria-label="undefined"` on a DM row - and writing it through
		// `produce` sets the store's prototype instead of adding an entry.
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("__proto__", "online"), {
			presence: "online",
		});

		expect(presenceOf("__proto__")).toEqual({
			status: "unknown",
			statusMsg: null,
		});
		// The write must not have landed on the prototype either: a real user
		// the server has said nothing about still reads as unknown.
		expect(presenceOf("@untouched:x").status).toBe("unknown");
		dispose();
	});

	it("keeps a known status when an event omits the presence field", async () => {
		// Same erasure the missing-event guard prevents, through another door:
		// an event that resolves to `unknown` has told us nothing, so it must
		// not drop the dot of someone we know is online.
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			presence: "online",
			status_msg: "Reviewing",
		});
		expect(presenceOf("@a:x").status).toBe("online");

		await emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			status_msg: "Still reviewing",
		});

		expect(presenceOf("@a:x")).toEqual({
			status: "online",
			// The message rides the same event, so its change is real.
			statusMsg: "Still reviewing",
		});
		dispose();
	});

	it("does not refill a new session from the previous client's queue", async () => {
		// A session swap resolving out of order: B attaches (clearing the
		// store and taking ownership) before A's cleanup runs, while A
		// already has a batch queued. A's microtask must not write the
		// previous account's peers into B's store, where they would sit
		// until each of those users next changed state.
		const first = mkClient([]);
		const disposeFirst = withPresence(first.client);
		// Queued but not yet flushed - no await here.
		first.emitSync("User.lastPresenceTs", mkUser("@old:x", "online"), {
			presence: "online",
		});

		const second = mkClient([]);
		const disposeSecond = withPresence(second.client);
		await Promise.resolve();
		await Promise.resolve();

		expect(presenceOf("@old:x").status).toBe("unknown");
		disposeFirst();
		disposeSecond();
	});

	it("does not hand a new session the previous account's contacts", async () => {
		// detach skips the wipe when a newer client already owns the store, so
		// attach has to clear too or an out-of-order swap inherits them.
		const first = mkClient([]);
		const disposeFirst = withPresence(first.client);
		await first.emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			presence: "online",
		});
		expect(presenceOf("@a:x").status).toBe("online");

		const second = mkClient([]);
		const disposeSecond = withPresence(second.client);

		expect(presenceOf("@a:x").status).toBe("unknown");
		disposeFirst();
		disposeSecond();
	});

	it("removes its listeners when the owner is disposed", () => {
		const { client, listenerCount } = mkClient([]);
		const dispose = withPresence(client);
		// Two: the per-User path for peers and the ClientEvent.Event path for
		// our own echo.
		expect(listenerCount()).toBe(2);
		dispose();
		expect(listenerCount()).toBe(0);
	});

	it("sees a status set by someone who was already online", async () => {
		// The SDK emits UserEvent.Presence only when the presence *value*
		// changed, so this - the primary custom-status flow - fires nothing on
		// that event. LastPresenceTs is pushed on every presence event.
		const { client, emit } = mkClient([mkUser("@a:x", "online")]);
		const dispose = withPresence(client);
		await emit(
			"User.lastPresenceTs",
			mkUser("@a:x", "online", "In a meeting"),
			{
				presence: "online",
				status_msg: "In a meeting",
			},
		);
		expect(presenceOf("@a:x").statusMsg).toBe("In a meeting");
		dispose();
	});

	it("clears a status the peer cleared", async () => {
		// The SDK only assigns presenceStatusMsg when the incoming value is
		// truthy, so reading that field would keep showing a status its owner
		// removed. The event content is the truth.
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit(
			"User.lastPresenceTs",
			mkUser("@a:x", "online", "In a meeting"),
			{
				presence: "online",
				status_msg: "In a meeting",
			},
		);
		expect(presenceOf("@a:x").statusMsg).toBe("In a meeting");
		await emit(
			"User.lastPresenceTs",
			mkUser("@a:x", "online", "In a meeting"),
			{
				presence: "online",
			},
		);
		expect(presenceOf("@a:x").statusMsg).toBeNull();
		dispose();
	});

	it("forgets the previous account's presence on detach", async () => {
		// The store outlives the client, so a stale entry would show the last
		// user's contacts as online to whoever logs in next.
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("@a:x", "online"), {
			presence: "online",
		});
		expect(presenceOf("@a:x").status).toBe("online");
		dispose();
		expect(presenceOf("@a:x").status).toBe("unknown");
	});
});

describe("recordSelfPresence", () => {
	it("records our own presence, which no event delivers", () => {
		// startClient builds our own User with `new User(userId)` rather than
		// User.createUser, so it has no re-emitter: setPresenceEvent fires on
		// that object alone and never on the client this store listens to.
		const { client } = mkClient([]);
		const dispose = withPresence(client);
		expect(presenceOf("@me:x").status).toBe("unknown");
		recordSelfPresence("@me:x", true);
		expect(presenceOf("@me:x").status).toBe("online");
		dispose();
	});

	it("does not demote us out of our own member list when sharing is off", () => {
		// partitionByPresence moves anyone reading exactly `offline` into the
		// Offline section, so writing that for ourselves would tell the user
		// they are absent from their own client.
		const { client } = mkClient([]);
		const dispose = withPresence(client);
		recordSelfPresence("@me:x", false);
		expect(presenceOf("@me:x").status).toBe("unknown");
		dispose();
	});

	it("keeps a status the server told us about", async () => {
		const { client, emit } = mkClient([]);
		const dispose = withPresence(client);
		await emit("User.lastPresenceTs", mkUser("@me:x", "online"), {
			presence: "online",
			status_msg: "In a meeting",
		});
		recordSelfPresence("@me:x", false);
		// `unknown`, not `offline`: publishing offline is how the privacy
		// switch works, but drawing ourselves offline would demote our own
		// row into the Offline section of our own member list.
		expect(presenceOf("@me:x")).toEqual({
			status: "unknown",
			statusMsg: "In a meeting",
		});
		dispose();
	});

	describe("own echo (#538)", () => {
		const presenceEvent = (
			sender: string,
			content: Record<string, unknown>,
		) => ({
			getType: () => "m.presence",
			getSender: () => sender,
			getContent: () => content,
		});

		it("takes our own status message from the client-level presence event", async () => {
			// Our own User has no re-emitter, so the per-User path never fires
			// for us; SyncApi's ClientEvent.Event does, and carries the message.
			const { client, emitRaw } = mkClient([]);
			const dispose = withPresence(client);
			recordSelfPresence("@me:x", true);
			emitRaw(
				ClientEvent.Event,
				presenceEvent("@me:x", {
					presence: "offline",
					status_msg: "  from\nElement  ",
				}),
			);
			await Promise.resolve();
			// The message, sanitised for display; the wire's `offline` is not
			// drawn - our own status comes from the sharing preference.
			expect(presenceOf("@me:x")).toEqual({
				status: "online",
				statusMsg: "from Element",
			});
			dispose();
		});

		it("clears our own message when the echo omits it", async () => {
			const { client, emitRaw } = mkClient([]);
			const dispose = withPresence(client);
			recordSelfPresence("@me:x", true);
			recordSelfStatusMsg("@me:x", "old");
			emitRaw(
				ClientEvent.Event,
				presenceEvent("@me:x", { presence: "online" }),
			);
			await Promise.resolve();
			expect(presenceOf("@me:x")).toEqual({
				status: "online",
				statusMsg: null,
			});
			dispose();
		});

		it("leaves peers to the per-User path and ignores other event types", async () => {
			const { client, emitRaw } = mkClient([]);
			const dispose = withPresence(client);
			emitRaw(
				ClientEvent.Event,
				presenceEvent("@peer:x", { presence: "online" }),
			);
			emitRaw(ClientEvent.Event, {
				getType: () => "m.room.message",
				getSender: () => "@me:x",
				getContent: () => ({ status_msg: "nope" }),
			});
			await Promise.resolve();
			expect(presenceOf("@peer:x").status).toBe("unknown");
			expect(presenceOf("@me:x").statusMsg).toBeNull();
			dispose();
		});

		it("recordSelfStatusMsg renders the raw value and keeps our status", () => {
			recordSelfPresence("@me:x", true);
			recordSelfStatusMsg("@me:x", "  busy\t\tnow  ");
			expect(presenceOf("@me:x")).toEqual({
				status: "online",
				statusMsg: "busy now",
			});
			const before = presenceOf("@me:x");
			recordSelfStatusMsg("@me:x", "busy now");
			// Same rendering: no write, so the member list is not re-partitioned.
			expect(presenceOf("@me:x")).toBe(before);
			recordSelfStatusMsg("@me:x", "");
			expect(presenceOf("@me:x")).toEqual({
				status: "online",
				statusMsg: null,
			});
		});
	});

	describe("echoed raw status (#538)", () => {
		it("tracks the raw value from the echo and from a round trip, and resets on attach", async () => {
			const { client, emitRaw } = mkClient([]);
			const dispose = withPresence(client);
			expect(selfRawStatusMsg()).toBeNull();
			emitRaw(ClientEvent.Event, {
				getType: () => "m.presence",
				getSender: () => "@me:x",
				getContent: () => ({ presence: "online", status_msg: "  raw  " }),
			});
			await Promise.resolve();
			expect(selfRawStatusMsg()).toBe("  raw  ");
			recordSelfStatusMsg("@me:x", "");
			expect(selfRawStatusMsg()).toBe("");
			dispose();
			expect(selfRawStatusMsg()).toBeNull();
		});

		it("writes only the message leaf when the status is unchanged", () => {
			recordSelfPresence("@me:x", true);
			recordSelfStatusMsg("@me:x", "one");
			const entry = presenceOf("@me:x");
			recordSelfStatusMsg("@me:x", "two");
			// Same entry object: the member list's per-key subscription is not
			// notified, only the message line re-runs.
			expect(presenceOf("@me:x")).toBe(entry);
			expect(entry.statusMsg).toBe("two");
		});
	});
});
