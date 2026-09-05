import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { clearNotices, notices } from "../../../stores/notices";
import { createMockClient } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";
import { ReportMessageDialog } from "./ReportMessageDialog";
import type { TimelineEvent } from "./timelineTypes";

afterEach(() => {
	cleanup();
	clearNotices();
});

function setup(targetEvent?: TimelineEvent) {
	const client = createMockClient();
	const [target, setTarget] = createSignal<TimelineEvent | null>(
		targetEvent ??
			({
				eventId: "$bad",
				body: "offensive",
			} as unknown as TimelineEvent),
	);
	const onClose = vi.fn(() => setTarget(null));
	render(() => (
		<TestClientProvider client={client}>
			<ReportMessageDialog
				target={target}
				roomId={() => "!room:server"}
				onClose={onClose}
			/>
		</TestClientProvider>
	));
	return { client, onClose };
}

describe("ReportMessageDialog", () => {
	it("reports with the trimmed reason and a fixed -100 score, then closes with a notice", async () => {
		const { client, onClose } = setup();
		expect(screen.getByText("offensive")).toBeTruthy();
		fireEvent.input(screen.getByPlaceholderText(/What's wrong/), {
			target: { value: "  spam  " },
		});
		fireEvent.click(screen.getByText("Report"));
		await waitFor(() =>
			expect(client.reportEvent).toHaveBeenCalledWith(
				"!room:server",
				"$bad",
				-100,
				"spam",
			),
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(notices().some((n) => n.message.includes("Report sent"))).toBe(true);
	});

	it("sends an empty reason (not whitespace) when only spaces were typed", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByPlaceholderText(/What's wrong/), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByText("Report"));
		await waitFor(() =>
			expect(client.reportEvent).toHaveBeenCalledWith(
				"!room:server",
				"$bad",
				-100,
				"",
			),
		);
	});

	it("surfaces a submit failure inline and keeps the dialog open", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, onClose } = setup();
		client.reportEvent.mockRejectedValue(new TypeError("Failed to fetch"));
		fireEvent.click(screen.getByText("Report"));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Couldn't send the report. Try again.",
			),
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(notices()).toHaveLength(0);
		vi.restoreAllMocks();
	});

	it("previews an attachment with its sanitized filename", () => {
		const RLO = String.fromCharCode(0x202e);
		const rawBody = `invoice${RLO}gnp.exe`;
		setup({
			eventId: "$bad",
			msgtype: "m.file",
			body: rawBody,
			mediaFilename: "invoicegnp.exe",
		} as unknown as TimelineEvent);
		expect(screen.getByText("invoicegnp.exe")).toBeTruthy();
		expect(screen.queryByText(rawBody)).toBeNull();
	});
});
