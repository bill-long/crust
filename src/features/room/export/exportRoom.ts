import {
	Direction,
	EventTimelineSet,
	type MatrixClient,
	type Room,
	TimelineWindow,
} from "matrix-js-sdk";
import { sanitizeFilename } from "../../../lib/filename";
import { stripReplyFallback } from "../../../lib/replyFallback";
import { crc32Chunked, ZipWriter } from "../../../lib/zip";
import {
	decryptAttachment,
	type EncryptedFileInfo,
} from "../composer/media/attachmentCrypto";
import { createPollWatcher } from "../poll/pollWatcher";
import { eventToTimelineEvent } from "../timeline/eventProjection";
import type { TimelineEvent } from "../timeline/timelineTypes";
import {
	assembleHtml,
	assembleJson,
	assembleText,
	type ExportBundle,
	type ExportRow,
	htmlRow,
	jsonRow,
	textRow,
} from "./serializers";

export type ExportFormat = "html" | "text" | "json";

export interface ExportOptions {
	format: ExportFormat;
	/** Newest-N cap on exported messages; null exports the entire history. */
	limit: number | null;
	includeAttachments: boolean;
}

export interface ExportProgress {
	phase: "history" | "attachments" | "assembling";
	/** Exportable messages collected so far. */
	events: number;
	attachmentsDone: number;
	attachmentsTotal: number;
}

export interface ExportResult {
	blob: Blob;
	filename: string;
}

/** Events fetched per /messages page, matching the timeline's own size. */
const PAGE_SIZE = 50;

/** Rows serialized per main-thread slice during assembly. */
const SERIALIZE_CHUNK = 200;

/** Yield the main thread between chunks of work (AGENTS.md: never block
 *  it for more than ~5ms). */
const yieldToMain = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

const FORMAT_EXTENSION: Record<ExportFormat, string> = {
	html: "html",
	text: "txt",
	json: "json",
};

/** Whether the projection produced something worth exporting. */
function isExportable(te: TimelineEvent): boolean {
	// Local echoes (status non-null) are unconfirmed - skip them.
	if (te.status !== null) return false;
	return Boolean(
		te.body ||
			te.mediaFullUrl ||
			te.stateNotice ||
			te.poll ||
			te.isDecryptionFailure,
	);
}

/**
 * Export a room's history to a single file (#530). Everything is
 * assembled in memory and only becomes a Blob at the very end, so a
 * cancelled or failed export never leaves a partial file - the entire
 * point for decrypted E2EE history. Returns null when `isCancelled`
 * turned true.
 */
export async function exportRoom(
	client: MatrixClient,
	room: Room,
	opts: ExportOptions,
	onProgress: (p: ExportProgress) => void,
	isCancelled: () => boolean,
	/** Aborts in-flight attachment downloads when cancelling. */
	signal?: AbortSignal,
): Promise<ExportResult | null> {
	const pollWatcher = createPollWatcher(client, () => {});
	try {
		return await runExport(
			client,
			room,
			opts,
			onProgress,
			isCancelled,
			pollWatcher,
			signal,
		);
	} finally {
		pollWatcher.dispose();
	}
}

async function runExport(
	client: MatrixClient,
	room: Room,
	opts: ExportOptions,
	onProgress: (p: ExportProgress) => void,
	isCancelled: () => boolean,
	pollWatcher: ReturnType<typeof createPollWatcher>,
	signal?: AbortSignal,
): Promise<ExportResult | null> {
	const progress: ExportProgress = {
		phase: "history",
		events: 0,
		attachmentsDone: 0,
		attachmentsTotal: 0,
	};
	const report = (): void => onProgress({ ...progress });

	// --- Fetch history through a TimelineWindow (never raw scrollback),
	// projecting each page as it arrives so the requested limit counts
	// EXPORTABLE MESSAGES, not raw timeline events (reactions, state, and
	// redactions would otherwise silently shrink the export). The window
	// limit is effectively unbounded so paginating backward never drops
	// the near end.
	// A PRIVATE timeline set (same pattern as usePinnedEvents), so an
	// entire-history export doesn't permanently load the whole room into
	// the shared live timeline set's memory or replay pagination events
	// through it. Seeded at the room's newest event; an empty room falls
	// back to the shared set, where there is nothing to paginate anyway.
	const lastEventId = room.getLiveTimeline().getEvents().at(-1)?.getId();
	let timelineSet = room.getUnfilteredTimelineSet();
	if (lastEventId) {
		const privateSet = new EventTimelineSet(room, { timelineSupport: true });
		await client.getEventTimeline(privateSet, lastEventId);
		timelineSet = privateSet;
	}
	const tw = new TimelineWindow(client, timelineSet, {
		windowLimit: Number.MAX_SAFE_INTEGER,
	});
	await tw.load(lastEventId, PAGE_SIZE);

	// Rows in chronological order; new (older) pages prepend blocks.
	let rows: ExportRow[] = [];
	let processed = 0;

	const projectNewEvents = async (): Promise<ExportRow[] | null> => {
		const events = tw.getEvents();
		const added = events.length - processed;
		processed = events.length;
		// Backward pagination prepends: the first `added` entries are the
		// newly revealed (older) events, chronological among themselves.
		const fresh: ExportRow[] = [];
		for (let i = 0; i < added; i++) {
			if (i % PAGE_SIZE === 0 && i > 0) {
				if (isCancelled()) return null;
				await yieldToMain();
			}
			const event = events[i];
			if (event.isRedacted()) continue;
			// Edit events fold into their target via the projection; exporting
			// the m.replace event too would duplicate every edited message
			// (same filter as useTimeline / searchProjection).
			if (event.getRelation()?.rel_type === "m.replace") continue;
			try {
				await client.decryptEventIfNeeded(event);
			} catch {
				// The projection reports the decryption failure state itself.
			}
			const te = eventToTimelineEvent(
				event,
				room,
				client,
				undefined,
				pollWatcher,
			);
			if (!isExportable(te)) continue;
			fresh.push({
				te,
				bodyText: te.isDecryptionFailure ? "" : stripReplyFallback(te.body),
				undecryptable: te.isDecryptionFailure,
				attachmentPath: null,
				attachmentFailed: false,
			});
		}
		return fresh;
	};

	const initial = await projectNewEvents();
	if (initial === null) return null;
	rows = initial;
	progress.events = rows.length;
	report();

	while (
		(opts.limit === null || rows.length < opts.limit) &&
		tw.canPaginate(Direction.Backward)
	) {
		if (isCancelled()) return null;
		// Default requestLimit: the SDK retries through empty /messages
		// chunks itself, so a false return really means no further
		// progress is possible - breaking on it cannot truncate history
		// that another round would have reached.
		const advanced = await tw.paginate(Direction.Backward, PAGE_SIZE);
		const fresh = await projectNewEvents();
		if (fresh === null) return null;
		rows = [...fresh, ...rows];
		progress.events = rows.length;
		report();
		await yieldToMain();
		if (!advanced) break;
	}

	if (opts.limit !== null && rows.length > opts.limit) {
		// Chronological order; keep the newest N.
		rows = rows.slice(rows.length - opts.limit);
	}

	// --- Attachments (opt-in): fetch, decrypt, bundle.
	const attachments: { path: string; data: Uint8Array }[] = [];
	if (opts.includeAttachments) {
		const mediaRows = rows.filter((r) => r.te.mediaFullUrl);
		progress.phase = "attachments";
		progress.attachmentsTotal = mediaRows.length;
		report();
		for (const row of mediaRows) {
			if (isCancelled()) return null;
			const path = `media/${attachments.length + 1}_${sanitizeFilename(row.te.mediaFilename)}`;
			const data = await fetchAttachment(row.te, signal);
			if (data) {
				attachments.push({ path, data });
				row.attachmentPath = path;
			} else {
				row.attachmentFailed = true;
			}
			progress.attachmentsDone += 1;
			report();
			await yieldToMain();
		}
	}

	// --- Serialize row-by-row in main-thread slices, then assemble.
	progress.phase = "assembling";
	report();
	// Let the progress swap paint before the first serialization slice.
	await yieldToMain();

	const bundle: ExportBundle = {
		roomId: room.roomId,
		roomName: room.name || room.roomId,
		exportedAt: new Date(),
		rangeLabel:
			opts.limit === null ? "entire history" : `last ${opts.limit} messages`,
		encryptedRoom: room.hasEncryptionStateEvent(),
		messageCount: rows.length,
		mxcToHttp: (mxcUrl) => client.mxcUrlToHttp(mxcUrl, 64, 64, "scale"),
	};

	let text: string | null = null;
	if (opts.format === "json") {
		const rowObjects: Record<string, unknown>[] = [];
		for (let i = 0; i < rows.length; i++) {
			if (i % SERIALIZE_CHUNK === 0 && i > 0) {
				if (isCancelled()) return null;
				await yieldToMain();
			}
			rowObjects.push(jsonRow(rows[i]));
		}
		text = assembleJson(bundle, rowObjects);
	} else {
		const rowStrings: string[] = [];
		for (let i = 0; i < rows.length; i++) {
			if (i % SERIALIZE_CHUNK === 0 && i > 0) {
				if (isCancelled()) return null;
				await yieldToMain();
			}
			rowStrings.push(
				opts.format === "html" ? htmlRow(rows[i], bundle) : textRow(rows[i]),
			);
		}
		text =
			opts.format === "html"
				? assembleHtml(bundle, rowStrings)
				: assembleText(bundle, rowStrings);
	}

	const extension = FORMAT_EXTENSION[opts.format];
	const stamp = bundle.exportedAt
		.toISOString()
		.slice(0, 16)
		.replace(/[T:]/g, "-");
	const baseName = sanitizeFilename(`crust-${bundle.roomName}-${stamp}`);

	if (isCancelled()) return null;
	if (attachments.length === 0) {
		const mime = {
			html: "text/html",
			text: "text/plain",
			json: "application/json",
		}[opts.format];
		return {
			blob: new Blob([text], { type: `${mime};charset=utf-8` }),
			filename: `${baseName}.${extension}`,
		};
	}

	const zip = new ZipWriter();
	zip.addEntry(`export.${extension}`, new TextEncoder().encode(text));
	for (const attachment of attachments) {
		if (isCancelled()) return null;
		// CRC the attachment in main-thread slices with yields between them;
		// a single whole-buffer pass over a large video would freeze the UI
		// for seconds.
		const crc = await crc32Chunked(attachment.data, yieldToMain);
		zip.addEntry(attachment.path, attachment.data, crc);
	}
	return { blob: zip.toBlob(), filename: `${baseName}.zip` };
}

/**
 * The decrypted bytes of an event's attachment, or null when it can't be
 * exported (missing key material, fetch failure, integrity mismatch).
 * Fail closed: an encrypted attachment without usable key info is never
 * emitted as ciphertext.
 */
async function fetchAttachment(
	te: TimelineEvent,
	signal?: AbortSignal,
): Promise<Uint8Array | null> {
	const url = te.mediaFullUrl;
	if (!url) return null;
	let file: EncryptedFileInfo | null = null;
	if (te.mediaIsEncrypted) {
		file = te.mediaEncryptedFile;
		if (!file) return null;
	}
	try {
		const init: RequestInit = { credentials: "omit" };
		if (signal) init.signal = signal;
		const res = await fetch(url, init);
		if (!res.ok) return null;
		const bytes = await res.arrayBuffer();
		if (!file) return new Uint8Array(bytes);
		return new Uint8Array(await decryptAttachment(bytes, file));
	} catch {
		return null;
	}
}
