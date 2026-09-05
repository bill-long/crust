import { describe, expect, it, vi } from "vitest";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import { messagePreviewText } from "./MessagePreview";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

describe("messagePreviewText", () => {
	it("uses the projected filename for attachments instead of the raw body", () => {
		const RLO = String.fromCharCode(0x202e);
		expect(
			messagePreviewText(
				makeTimelineEvent({
					msgtype: "m.file",
					body: `invoice${RLO}gnp.exe`,
					mediaFilename: "invoicegnp.exe",
				}),
			),
		).toBe("invoicegnp.exe");
	});

	it("prefers a distinct attachment caption over the filename", () => {
		expect(
			messagePreviewText(
				makeTimelineEvent({
					msgtype: "m.file",
					body: "Quarterly report",
					mediaCaption: "Quarterly report",
					mediaFilename: "report.pdf",
				}),
			),
		).toBe("Quarterly report");
	});

	it("does not apply filename policy to prose", () => {
		const RLO = String.fromCharCode(0x202e);
		const body = `mixed ${RLO}direction`;
		expect(messagePreviewText(makeTimelineEvent({ body }))).toBe(body);
	});
});
