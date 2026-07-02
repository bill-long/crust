import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "../../../test/mockClient";
import { CreatePollDialog } from "./CreatePollDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(cleanup);

const ROOM_ID = "!room:example.com";

function setup() {
	const client = createMockClient();
	const [open, setOpen] = createSignal(true);
	const onClose = vi.fn(() => setOpen(false));
	render(() => (
		<CreatePollDialog
			client={client as unknown as MatrixClient}
			roomId={ROOM_ID}
			open={open}
			onClose={onClose}
		/>
	));
	return { client, onClose, setOpen };
}

function questionInput(): HTMLInputElement {
	return screen.getByLabelText("Question") as HTMLInputElement;
}

function optionInput(n: number): HTMLInputElement {
	return screen.getByLabelText(`Option ${n}`) as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
	return screen.getByText("Create poll", {
		selector: "button",
	}) as HTMLButtonElement;
}

function fillValidPoll(): void {
	fireEvent.input(questionInput(), { target: { value: "Best pizza?" } });
	fireEvent.input(optionInput(1), { target: { value: "Margherita" } });
	fireEvent.input(optionInput(2), { target: { value: "Pepperoni" } });
}

/** The single (type, content) pair sent through client.sendEvent. */
function sentEvent(client: ReturnType<typeof createMockClient>): {
	roomId: string;
	type: string;
	content: Record<string, unknown>;
} {
	expect(client.sendEvent).toHaveBeenCalledOnce();
	const [roomId, type, content] = client.sendEvent.mock.calls[0] as [
		string,
		string,
		Record<string, unknown>,
	];
	return { roomId, type, content };
}

describe("CreatePollDialog", () => {
	it("renders nothing while closed", () => {
		const client = createMockClient();
		const [open] = createSignal(false);
		render(() => (
			<CreatePollDialog
				client={client as unknown as MatrixClient}
				roomId={ROOM_ID}
				open={open}
				onClose={vi.fn()}
			/>
		));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("disables submit until a question and two non-empty options exist", () => {
		setup();
		expect(submitButton().disabled).toBe(true);
		fireEvent.input(questionInput(), { target: { value: "Best pizza?" } });
		expect(submitButton().disabled).toBe(true);
		fireEvent.input(optionInput(1), { target: { value: "Margherita" } });
		expect(submitButton().disabled).toBe(true);
		// Whitespace-only options don't count.
		fireEvent.input(optionInput(2), { target: { value: "   " } });
		expect(submitButton().disabled).toBe(true);
		fireEvent.input(optionInput(2), { target: { value: "Pepperoni" } });
		expect(submitButton().disabled).toBe(false);
	});

	it("sends a disclosed single-select poll by default and closes", () => {
		const { client, onClose } = setup();
		fillValidPoll();
		fireEvent.click(submitButton());

		const { roomId, type, content } = sentEvent(client);
		expect(roomId).toBe(ROOM_ID);
		expect(type).toBe("org.matrix.msc3381.poll.start");
		const start = content["org.matrix.msc3381.poll.start"] as {
			question: Record<string, unknown>;
			kind: string;
			max_selections: number;
			answers: { id: string }[];
		};
		expect(start.question["org.matrix.msc1767.text"]).toBe("Best pizza?");
		expect(start.kind).toBe("org.matrix.msc3381.poll.disclosed");
		expect(start.max_selections).toBe(1);
		expect(start.answers).toHaveLength(2);
		// Distinct generated answer ids.
		expect(new Set(start.answers.map((a) => a.id)).size).toBe(2);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("sends an undisclosed poll when live results are unchecked", () => {
		const { client } = setup();
		fillValidPoll();
		fireEvent.click(screen.getByLabelText("Show results while voting"));
		fireEvent.click(submitButton());
		const start = sentEvent(client).content[
			"org.matrix.msc3381.poll.start"
		] as { kind: string };
		expect(start.kind).toBe("org.matrix.msc3381.poll.undisclosed");
	});

	it("sends max_selections for multi-select polls", () => {
		const { client } = setup();
		fillValidPoll();
		fireEvent.click(screen.getByText("+ Add option"));
		fireEvent.input(optionInput(3), { target: { value: "Hawaiian" } });
		fireEvent.click(screen.getByLabelText("Allow choosing multiple answers"));
		const maxInput = screen.getByLabelText(/Up to/) as HTMLInputElement;
		// The input's constraint tracks the usable answer count, so native
		// form validation blocks out-of-range values before submit.
		expect(maxInput.max).toBe("3");
		fireEvent.input(maxInput, { target: { value: "3" } });
		fireEvent.click(submitButton());
		const start = sentEvent(client).content[
			"org.matrix.msc3381.poll.start"
		] as { max_selections: number };
		expect(start.max_selections).toBe(3);
	});

	it("blocks submit while the multi-select cap is out of range", () => {
		const { client } = setup();
		fillValidPoll();
		fireEvent.click(screen.getByLabelText("Allow choosing multiple answers"));
		const maxInput = screen.getByLabelText(/Up to/) as HTMLInputElement;
		// Only 2 usable answers exist; 7 violates the input's max so native
		// validation keeps the form from submitting.
		fireEvent.input(maxInput, { target: { value: "7" } });
		fireEvent.click(submitButton());
		expect(client.sendEvent).not.toHaveBeenCalled();
	});

	it("adds and removes option rows within the 2..20 bounds", () => {
		setup();
		// No remove buttons at the 2-option minimum.
		expect(screen.queryByLabelText("Remove option 1")).toBeNull();
		fireEvent.click(screen.getByText("+ Add option"));
		expect(optionInput(3)).toBeTruthy();
		expect(screen.getByLabelText("Remove option 3")).toBeTruthy();
		fireEvent.click(screen.getByLabelText("Remove option 3"));
		expect(screen.queryByLabelText("Option 3")).toBeNull();

		for (let i = 0; i < 18; i++) {
			fireEvent.click(screen.getByText("+ Add option"));
		}
		expect(optionInput(20)).toBeTruthy();
		expect(
			(screen.getByText("+ Add option") as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("skips blank option rows when sending", () => {
		const { client } = setup();
		fireEvent.input(questionInput(), { target: { value: "Q?" } });
		fireEvent.click(screen.getByText("+ Add option"));
		fireEvent.input(optionInput(1), { target: { value: "A" } });
		// Option 2 left blank.
		fireEvent.input(optionInput(3), { target: { value: "C" } });
		fireEvent.click(submitButton());
		const start = sentEvent(client).content[
			"org.matrix.msc3381.poll.start"
		] as { answers: { "org.matrix.msc1767.text": string }[] };
		expect(start.answers.map((a) => a["org.matrix.msc1767.text"])).toEqual([
			"A",
			"C",
		]);
	});

	it("closes on Escape without sending", () => {
		const { client, onClose } = setup();
		fillValidPoll();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
		expect(client.sendEvent).not.toHaveBeenCalled();
	});

	it("resets the form when reopened", () => {
		const { setOpen } = setup();
		fillValidPoll();
		fireEvent.click(screen.getByText("+ Add option"));
		setOpen(false);
		setOpen(true);
		expect(questionInput().value).toBe("");
		expect(optionInput(1).value).toBe("");
		expect(screen.queryByLabelText("Option 3")).toBeNull();
	});
});
