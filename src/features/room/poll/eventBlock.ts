import {
	type EncryptedFileInfo,
	parseEncryptedFile,
} from "../composer/media/attachmentCrypto";

/**
 * Discord-style event cards (#418), built ON standard MSC3381 polls: a
 * disclosed poll with fixed Going/Maybe/Can't answers plus this module's
 * namespaced sibling block on the poll.start content. Clients that don't
 * know the key render a perfectly usable poll (the question text carries
 * the human-readable time); Crust upgrades the presentation to an event
 * card. Event content is open JSON, so unknown keys are ignored elsewhere.
 */
export const EVENT_BLOCK_KEY = "pizza.strange.event";

/** Fixed RSVP answers, in card order. `max_selections` is always 1. */
export const EVENT_ANSWERS = ["Going", "Maybe", "Can't make it"] as const;

/** Validated image reference for the cover (m.image-style fields). */
export interface EventImage {
	/** Cleartext mxc URL (unencrypted rooms); mutually exclusive with file. */
	url: string | null;
	/** Encrypted attachment descriptor (E2EE rooms), pre-validated. */
	file: EncryptedFileInfo | null;
	info: { w: number; h: number; mimetype: string; size: number };
}

/** The parsed, validated event block. All fields are render-ready. */
export interface EventInfo {
	title: string;
	/** Start time as epoch ms (never a preformatted string - every viewer
	 *  renders it in their own timezone). */
	startTs: number;
	/** Optional end time as epoch ms; always > startTs when present. */
	endTs: number | null;
	/** Target room (typically a voice room), or null for "this room". */
	roomId: string | null;
	image: EventImage | null;
}

/** Input for {@link buildEventBlock}: the validated, send-side shape. */
export interface EventBlockInput {
	title: string;
	startTs: number;
	endTs?: number | null;
	roomId?: string | null;
	image?: {
		url?: string;
		file?: EncryptedFileInfo;
		info: { w: number; h: number; mimetype: string; size: number };
	} | null;
}

/** Serialize the block for spreading into poll.start content. The send
 *  side is trusted input (the creation dialog), so this is a light
 *  projection, not a validation pass. */
export function buildEventBlock(
	input: EventBlockInput,
): Record<string, unknown> {
	return {
		title: input.title,
		start_ts: input.startTs,
		end_ts: input.endTs ?? null,
		room_id: input.roomId ?? null,
		...(input.image
			? {
					image: {
						...(input.image.url ? { url: input.image.url } : {}),
						...(input.image.file ? { file: input.image.file } : {}),
						info: input.image.info,
					},
				}
			: {}),
	};
}

/** Human-readable question text for the poll fallback (what foreign
 *  clients render). Uses the CREATOR's locale/timezone at creation time -
 *  the structured start_ts is what Crust cards localize per-viewer. */
export function buildEventQuestion(input: {
	title: string;
	startTs: number;
	roomName?: string | null;
}): string {
	const when = new Date(input.startTs).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
	const where = input.roomName ? ` in ${input.roomName}` : "";
	return `${input.title} — ${when}${where}`;
}

function validDimension(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0 &&
		value <= 100_000
	);
}

/** Validate the untrusted image sub-object. Returns null when anything is
 *  off - the card then renders WITHOUT an image, never broken. An image
 *  with neither a usable url nor file is useless; both present prefers
 *  file (the room's encryption state is unknown at parse time, and the
 *  presence of key material is the stronger signal). */
function parseEventImage(value: unknown): EventImage | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	const info = raw.info;
	if (typeof info !== "object" || info === null) return null;
	const i = info as Record<string, unknown>;
	if (!validDimension(i.w) || !validDimension(i.h)) return null;
	if (typeof i.mimetype !== "string" || !i.mimetype.startsWith("image/")) {
		return null;
	}
	if (typeof i.size !== "number" || !Number.isFinite(i.size) || i.size <= 0) {
		return null;
	}
	const file = parseEncryptedFile(raw.file);
	const url =
		typeof raw.url === "string" && raw.url.startsWith("mxc://")
			? raw.url
			: null;
	if (!file && !url) return null;
	return {
		url,
		file,
		info: { w: i.w, h: i.h, mimetype: i.mimetype, size: i.size },
	};
}

/**
 * Parse and validate the event block from an m.poll.start event's raw
 * content. Fail-closed on every field: any malformed/missing REQUIRED
 * field returns null (the poll renders as a plain poll); optional fields
 * degrade individually (bad end_ts drops to null, bad image drops to
 * null) so one poisoned sub-field can't kill the whole card.
 */
export function parseEventBlock(
	content: Record<string, unknown>,
): EventInfo | null {
	const raw = content[EVENT_BLOCK_KEY];
	if (typeof raw !== "object" || raw === null) return null;
	const block = raw as Record<string, unknown>;
	if (typeof block.title !== "string" || block.title.trim().length === 0) {
		return null;
	}
	const startTs = block.start_ts;
	if (
		typeof startTs !== "number" ||
		!Number.isFinite(startTs) ||
		startTs <= 0
	) {
		return null;
	}
	const rawEnd = block.end_ts;
	const endTs =
		typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd > startTs
			? rawEnd
			: null;
	const roomId =
		typeof block.room_id === "string" && block.room_id.startsWith("!")
			? block.room_id
			: null;
	return {
		title: block.title.trim(),
		startTs,
		endTs,
		roomId,
		image: parseEventImage(block.image),
	};
}

/** Card time line: the start instant in the VIEWER's locale + timezone. */
export function formatEventTime(startTs: number): string {
	return new Date(startTs).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Live relative line for the card: "in 3 days" / "starting now" /
 * "started 2 hours ago" / "ended". Pure function of (start, end, now) so
 * it's unit-testable without timers.
 */
export function formatEventRelative(
	startTs: number,
	endTs: number | null,
	now: number,
): string {
	if (endTs !== null && now >= endTs) return "Ended";
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const divisions: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
		{ amount: 60, unit: "second" },
		{ amount: 60, unit: "minute" },
		{ amount: 24, unit: "hour" },
		{ amount: 7, unit: "day" },
		{ amount: 4.345, unit: "week" },
		{ amount: 12, unit: "month" },
	];
	let duration = Math.trunc((startTs - now) / 1000);
	// Within a minute of start on either side reads as "now".
	if (Math.abs(duration) < 60) return "Starting now";
	for (const d of divisions) {
		if (Math.abs(duration) < d.amount) {
			return rtf.format(duration, d.unit);
		}
		duration = Math.trunc(duration / d.amount);
	}
	return rtf.format(duration, "year");
}
