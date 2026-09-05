import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import { exportRoom } from "./exportRoom";

// The engine's collaborators are heavy (TimelineWindow drives real
// pagination, the projection needs live MatrixEvents) - both are mocked
// at the module seam so these tests exercise the engine's own logic:
// the pagination loop, range capping, filtering, attachment handling,
// cancellation, and assembly.

const windowState: {
	/** Synthetic events, oldest first; `paginate` reveals PAGE-sized
	 *  slices from the end backwards. */
	all: { id: string; redacted?: boolean; editOf?: boolean }[];
	revealed: number;
} = { all: [], revealed: 0 };

vi.mock("matrix-js-sdk", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	class FakeTimelineWindow {
		async load(_eventId: unknown, size: number): Promise<void> {
			windowState.revealed = Math.min(size, windowState.all.length);
		}
		canPaginate(): boolean {
			return windowState.revealed < windowState.all.length;
		}
		async paginate(_dir: unknown, size: number): Promise<boolean> {
			const before = windowState.revealed;
			windowState.revealed = Math.min(
				windowState.revealed + size,
				windowState.all.length,
			);
			return windowState.revealed > before;
		}
		getEvents(): MatrixEvent[] {
			return windowState.all
				.slice(windowState.all.length - windowState.revealed)
				.map(
					(e) =>
						({
							getId: () => e.id,
							isRedacted: () => e.redacted === true,
							getRelation: () => (e.editOf ? { rel_type: "m.replace" } : null),
						}) as unknown as MatrixEvent,
				);
		}
	}
	class FakeEventTimelineSet {}
	return {
		...original,
		TimelineWindow: FakeTimelineWindow,
		EventTimelineSet: FakeEventTimelineSet,
	};
});

const projected = vi.fn();
vi.mock("../timeline/eventProjection", () => ({
	eventToTimelineEvent: (event: MatrixEvent) => projected(event.getId()),
}));

const disposePollWatcher = vi.fn();
vi.mock("../poll/pollWatcher", () => ({
	createPollWatcher: () => ({
		getSnapshot: () => null,
		dispose: disposePollWatcher,
	}),
}));

const getEventTimeline = vi.fn(async () => null);

function fakeClient(): MatrixClient {
	return {
		decryptEventIfNeeded: async () => {},
		mxcUrlToHttp: () => null,
		getEventTimeline,
	} as unknown as MatrixClient;
}

function fakeRoom(): Room {
	return {
		roomId: "!r:example.com",
		name: "Room",
		getUnfilteredTimelineSet: () => ({}),
		// The engine seeds a private timeline set at the newest live event.
		getLiveTimeline: () => ({
			getEvents: () =>
				windowState.all.length > 0
					? [{ getId: () => windowState.all.at(-1)?.id }]
					: [],
		}),
		hasEncryptionStateEvent: () => false,
	} as unknown as Room;
}

function setEvents(count: number, redactedIds: Set<string> = new Set()): void {
	windowState.all = Array.from({ length: count }, (_, i) => ({
		id: `$e${i}`,
		redacted: redactedIds.has(`$e${i}`),
	}));
	windowState.revealed = 0;
	projected.mockImplementation((id: string) =>
		makeTimelineEvent({ eventId: id, body: `msg ${id}`, status: null }),
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

const noProgress = (): void => {};
const never = (): boolean => false;

describe("exportRoom", () => {
	it("paginates until the requested limit and keeps the newest N", async () => {
		setEvents(200);
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: 120, includeAttachments: false },
			noProgress,
			never,
		);
		expect(result).not.toBeNull();
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.message_count).toBe(120);
		// Newest-N: the last synthetic event is included, the oldest is not.
		expect(out.messages.at(-1).event_id).toBe("$e199");
		expect(
			out.messages.some((m: { event_id: string }) => m.event_id === "$e0"),
		).toBe(false);
	});

	it("drains the entire history when no limit is set", async () => {
		setEvents(180);
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.message_count).toBe(180);
	});

	it("skips redacted events", async () => {
		setEvents(3, new Set(["$e1"]));
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.messages.map((m: { event_id: string }) => m.event_id)).toEqual([
			"$e0",
			"$e2",
		]);
	});

	it("returns null on cancellation without producing anything", async () => {
		setEvents(500);
		let calls = 0;
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			() => ++calls > 3,
		);
		expect(result).toBeNull();
	});

	it("bundles fetched attachments into a zip and fails closed on missing keys", async () => {
		setEvents(2);
		projected.mockImplementation((id: string) =>
			id === "$e0"
				? makeTimelineEvent({
						eventId: id,
						body: "",
						status: null,
						mediaFullUrl: "https://hs/plain",
						mediaFilename: "a.bin",
					})
				: makeTimelineEvent({
						eventId: id,
						body: "",
						status: null,
						mediaFullUrl: "https://hs/enc",
						mediaFilename: "b.bin",
						mediaIsEncrypted: true,
						// Encrypted but no key material: must never be emitted.
						mediaEncryptedFile: null,
					}),
		);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer,
		}));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await exportRoom(
				fakeClient(),
				fakeRoom(),
				{ format: "json", limit: null, includeAttachments: true },
				noProgress,
				never,
			);
			expect(result?.filename.endsWith(".zip")).toBe(true);
			// Only the plaintext attachment was fetched; the keyless
			// encrypted one was refused without a network call.
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledWith("https://hs/plain", {
				credentials: "omit",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("skips m.replace edit events so edits never export twice", async () => {
		setEvents(3);
		windowState.all[1].editOf = true;
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.messages.map((m: { event_id: string }) => m.event_id)).toEqual([
			"$e0",
			"$e2",
		]);
	});

	it("counts the limit in exportable messages, not raw timeline events", async () => {
		// 6 events, alternating exportable / empty: a raw-event limit of 3
		// would net fewer messages than asked for.
		setEvents(6);
		projected.mockImplementation((id: string) => {
			const n = Number(id.slice(2));
			return makeTimelineEvent({
				eventId: id,
				body: n % 2 === 0 ? `msg ${id}` : "",
				status: null,
			});
		});
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: 3, includeAttachments: false },
			noProgress,
			never,
		);
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.message_count).toBe(3);
		expect(out.messages.map((m: { event_id: string }) => m.event_id)).toEqual([
			"$e0",
			"$e2",
			"$e4",
		]);
	});

	it("keeps undecryptable events as flagged placeholders", async () => {
		setEvents(2);
		projected.mockImplementation((id: string) =>
			id === "$e0"
				? makeTimelineEvent({ eventId: id, body: "readable", status: null })
				: makeTimelineEvent({
						eventId: id,
						body: "** Unable to decrypt: key not found **",
						isDecryptionFailure: true,
						status: null,
					}),
		);
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const raw = await textOf(result?.blob);
		const out = JSON.parse(raw);
		expect(out.messages[1].undecryptable).toBe(true);
		expect(raw).not.toContain("key not found");
	});

	it("strips the legacy reply fallback from exported bodies", async () => {
		setEvents(1);
		projected.mockImplementation((id: string) =>
			makeTimelineEvent({
				eventId: id,
				body: "> <@alice:hs> quoted line\n\nactual reply",
				replyToId: "$parent",
				status: null,
			}),
		);
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.messages[0].body).toBe("actual reply");
	});

	it("does not export an attachment's raw body as prose", async () => {
		const RLO = String.fromCharCode(0x202e);
		const rawBody = `invoice${RLO}gnp.exe`;
		setEvents(1);
		projected.mockImplementation((id: string) =>
			makeTimelineEvent({
				eventId: id,
				msgtype: "m.file",
				body: rawBody,
				mediaFullUrl: "https://hs/file",
				mediaFilename: "invoicegnp.exe",
				status: null,
			}),
		);
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const raw = await textOf(result?.blob);
		const out = JSON.parse(raw);
		expect(out.messages[0].body).toBeUndefined();
		expect(out.messages[0].media.filename).toBe("invoicegnp.exe");
		expect(raw).not.toContain(rawBody);
	});

	it("exports a non-image attachment caption without its reply fallback", async () => {
		setEvents(1);
		projected.mockImplementation((id: string) =>
			makeTimelineEvent({
				eventId: id,
				msgtype: "m.file",
				body: "> <@alice:hs> quoted\n\nactual caption",
				mediaCaption: "actual caption",
				mediaFullUrl: "https://hs/file",
				mediaFilename: "report.pdf",
				status: null,
			}),
		);
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.messages[0].body).toBe("actual caption");
		expect(out.messages[0].media.filename).toBe("report.pdf");
	});

	it("seeds a private timeline set at the newest event instead of the shared one", async () => {
		setEvents(2);
		await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		expect(getEventTimeline).toHaveBeenCalledWith(expect.anything(), "$e1");
	});

	it("disposes the poll watcher it created", async () => {
		setEvents(1);
		await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		expect(disposePollWatcher).toHaveBeenCalled();
	});

	it("skips local echoes and empty projections", async () => {
		setEvents(3);
		projected.mockImplementation((id: string) =>
			id === "$e0"
				? makeTimelineEvent({ eventId: id, body: "keep", status: null })
				: id === "$e1"
					? makeTimelineEvent({
							eventId: id,
							body: "echo",
							// biome-ignore lint/suspicious/noExplicitAny: EventStatus enum stand-in
							status: "sending" as any,
						})
					: makeTimelineEvent({ eventId: id, body: "", status: null }),
		);
		const result = await exportRoom(
			fakeClient(),
			fakeRoom(),
			{ format: "json", limit: null, includeAttachments: false },
			noProgress,
			never,
		);
		const out = JSON.parse(await textOf(result?.blob));
		expect(out.messages.map((m: { event_id: string }) => m.event_id)).toEqual([
			"$e0",
		]);
	});
});

/** jsdom Blob lacks .text()/.arrayBuffer() - read via FileReader. */
function textOf(blob: Blob | undefined): Promise<string> {
	if (!blob) throw new Error("no blob");
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsText(blob);
	});
}
