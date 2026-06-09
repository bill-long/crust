import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallOverlayView } from "./CallOverlayView";
import type {
	CallOverlayParticipant,
	CallOverlaySnapshot,
} from "./callOverlayBridge";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function participant(
	over: Partial<CallOverlayParticipant>,
): CallOverlayParticipant {
	return {
		identity: "id",
		displayName: "Someone",
		avatarUrl: null,
		isLocal: false,
		isMuted: false,
		isSpeaking: false,
		...over,
	};
}

function snapshot(
	over: Partial<CallOverlaySnapshot> = {},
): CallOverlaySnapshot {
	return {
		active: true,
		roomName: "General",
		participants: [],
		...over,
	};
}

function rowFor(name: string): HTMLElement {
	const li = screen.getByText(name).closest("li");
	if (!li) throw new Error(`No row for ${name}`);
	return li as HTMLElement;
}

describe("CallOverlayView", () => {
	afterEach(cleanup);

	it("renders a row per participant with the room name", () => {
		render(() => (
			<CallOverlayView
				snapshot={snapshot({
					roomName: "Gaming",
					participants: [
						participant({ identity: "a", displayName: "Alice" }),
						participant({ identity: "b", displayName: "Bob" }),
					],
				})}
			/>
		));
		expect(screen.getByText("Gaming")).toBeTruthy();
		expect(screen.getByText("Alice")).toBeTruthy();
		expect(screen.getByText("Bob")).toBeTruthy();
	});

	it("shows an idle state when no call is active", () => {
		render(() => <CallOverlayView snapshot={snapshot({ active: false })} />);
		expect(screen.getByText(/not in a call/i)).toBeTruthy();
		expect(screen.getByText(/no active call/i)).toBeTruthy();
	});

	it("shows an empty state when the call has no participants yet", () => {
		render(() => <CallOverlayView snapshot={snapshot({ participants: [] })} />);
		expect(screen.getByText(/nobody has joined/i)).toBeTruthy();
	});

	it("crosses out muted participants and not unmuted ones", () => {
		render(() => (
			<CallOverlayView
				snapshot={snapshot({
					participants: [
						participant({ identity: "m", displayName: "Muted", isMuted: true }),
						participant({ identity: "l", displayName: "Live", isMuted: false }),
					],
				})}
			/>
		));
		expect(
			within(rowFor("Muted")).getByLabelText("Microphone muted"),
		).toBeTruthy();
		expect(
			within(rowFor("Live")).queryByLabelText("Microphone muted"),
		).toBeNull();
	});

	it("only shows the speaking cue for unmuted active speakers", () => {
		render(() => (
			<CallOverlayView
				snapshot={snapshot({
					participants: [
						participant({
							identity: "t",
							displayName: "Talker",
							isSpeaking: true,
						}),
						participant({
							identity: "mt",
							displayName: "MutedTalker",
							isSpeaking: true,
							isMuted: true,
						}),
					],
				})}
			/>
		));
		expect(within(rowFor("Talker")).getByText(/speaking/i)).toBeTruthy();
		expect(within(rowFor("MutedTalker")).queryByText(/speaking/i)).toBeNull();
	});

	it("invokes onHangUp when the disconnect button is clicked", () => {
		const onHangUp = vi.fn();
		render(() => (
			<CallOverlayView
				snapshot={snapshot({
					participants: [participant({ displayName: "Me", isLocal: true })],
				})}
				onHangUp={onHangUp}
			/>
		));
		screen.getByLabelText("Disconnect from call").click();
		expect(onHangUp).toHaveBeenCalledTimes(1);
	});

	it("uses a translucent surface when asked (native shell see-through)", () => {
		const { container } = render(() => (
			<CallOverlayView snapshot={snapshot()} translucent />
		));
		const root = container.firstChild as HTMLElement;
		expect(root.classList.contains("backdrop-blur-md")).toBe(true);
		expect(root.classList.contains("bg-surface-0")).toBe(false);
	});

	it("uses an opaque surface by default", () => {
		const { container } = render(() => (
			<CallOverlayView snapshot={snapshot()} />
		));
		const root = container.firstChild as HTMLElement;
		expect(root.classList.contains("bg-surface-0")).toBe(true);
		expect(root.classList.contains("backdrop-blur-md")).toBe(false);
	});

	it("hides the hang-up control when inactive", () => {
		const onHangUp = vi.fn();
		render(() => (
			<CallOverlayView
				snapshot={snapshot({ active: false })}
				onHangUp={onHangUp}
			/>
		));
		expect(screen.queryByLabelText("Disconnect from call")).toBeNull();
	});
});
