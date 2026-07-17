import type { RemoteVideoTrack } from "livekit-client";
import { vi } from "vitest";

/**
 * Shared stats fixtures for the trackStats/TrackStatsOverlay/FullCallOverlay
 * test suites, so the inbound-rtp shape and the duck-typed track surface the
 * overlay reads live in one place and can't drift between copies when they
 * change (e.g. #409 adding outbound-rtp fields).
 */

// A minimal RTCStatsReport stand-in: the real thing is a maplike, and the
// reader only uses `forEach` and `get`, both of which Map provides.
export function makeReport(entries: Record<string, unknown>[]): RTCStatsReport {
	return new Map(
		entries.map((e) => [e.id as string, e]),
	) as unknown as RTCStatsReport;
}

export const inboundVideo = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	id: "in-1",
	type: "inbound-rtp",
	kind: "video",
	frameWidth: 2560,
	frameHeight: 1440,
	framesPerSecond: 60,
	framesDropped: 0,
	freezeCount: 0,
	codecId: "codec-1",
	...overrides,
});

export const vp9Codec: Record<string, unknown> = {
	id: "codec-1",
	type: "codec",
	mimeType: "video/VP9",
};

export interface FakeStatsTrackOptions {
	statsEntries?: Record<string, unknown>[];
	/**
	 * Model livekit-client's "no stats surface" case: getRTCStatsReport
	 * resolves undefined (not a rejection) when receiver.getStats is
	 * unavailable.
	 */
	reportUnavailable?: boolean;
}

/**
 * Duck-typed video track exposing exactly the surface TrackStatsOverlay
 * reads, plus attach/detach spies so the same fake serves tile-level tests.
 * The stats getter is a spy so tests can count polls; `setStatsEntries` /
 * `setReportUnavailable` swap the stats behavior between polls.
 */
export function makeFakeStatsTrack(opts: FakeStatsTrackOptions = {}): {
	track: RemoteVideoTrack;
	attach: ReturnType<typeof vi.fn>;
	detach: ReturnType<typeof vi.fn>;
	getRTCStatsReport: ReturnType<typeof vi.fn>;
	setStatsEntries: (entries: Record<string, unknown>[]) => void;
	setReportUnavailable: (unavailable: boolean) => void;
} {
	let entries = opts.statsEntries ?? [];
	let unavailable = opts.reportUnavailable ?? false;
	const getRTCStatsReport = vi.fn(async () =>
		unavailable ? undefined : makeReport(entries),
	);
	const attach = vi.fn();
	const detach = vi.fn();
	const track = {
		attach,
		detach,
		getRTCStatsReport,
	} as unknown as RemoteVideoTrack;
	return {
		track,
		attach,
		detach,
		getRTCStatsReport,
		setStatsEntries: (next) => {
			entries = next;
		},
		setReportUnavailable: (next) => {
			unavailable = next;
		},
	};
}
