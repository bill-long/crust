import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import { ComposerContextBanner } from "./ComposerContextBanner";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(cleanup);

describe("ComposerContextBanner", () => {
	it("shows the same sanitized attachment name as the timeline chip", () => {
		const RLO = String.fromCharCode(0x202e);
		render(() => (
			<ComposerContextBanner
				replyTo={makeTimelineEvent({
					msgtype: "m.file",
					body: `invoice${RLO}gnp.exe`,
					mediaFilename: "invoicegnp.exe",
				})}
				onCancelEdit={vi.fn()}
				onCancelReply={vi.fn()}
			/>
		));
		expect(screen.getByText("invoicegnp.exe")).toBeTruthy();
		expect(screen.queryByText(`invoice${RLO}gnp.exe`)).toBeNull();
	});
});
