import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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
		isUnresolved: false,
		isForeignSfu: false,
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

	it("shows the different-server state instead of the mute artifact for a foreign-SFU peer (#488)", () => {
		render(() => (
			<CallOverlayView
				snapshot={snapshot({
					participants: [
						participant({
							identity: "hashed-id",
							displayName: "Unknown participant",
							isMuted: true,
							isUnresolved: true,
							isForeignSfu: true,
						}),
					],
				})}
			/>
		));
		const row = rowFor("Unknown participant");
		expect(
			within(row).getByLabelText(
				"Connected via a different server - their audio is unavailable",
			),
		).toBeTruthy();
		expect(within(row).queryByLabelText("Microphone muted")).toBeNull();
		// Unresolved identity keeps the raw value as a debugging tooltip.
		const name = within(row).getByText("Unknown participant");
		expect(name.closest("[title]")?.getAttribute("title")).toBe("hashed-id");
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

describe("CallOverlayView avatar fallback (#457)", () => {
	afterEach(cleanup);

	const broken = (isSpeaking: boolean): CallOverlaySnapshot =>
		snapshot({
			participants: [
				participant({
					identity: "a",
					displayName: "Alice",
					avatarUrl: "https://example.com/broken.png",
					isSpeaking,
				}),
			],
		});

	it("falls back to the participant initial when the avatar errors", () => {
		render(() => <CallOverlayView snapshot={broken(false)} />);
		const row = rowFor("Alice");
		expect(row.querySelector("img")).not.toBeNull();

		fireEvent.error(row.querySelector("img") as HTMLImageElement);

		expect(rowFor("Alice").querySelector("img")).toBeNull();
		expect(within(rowFor("Alice")).getByText("A")).toBeTruthy();
	});

	it("keeps the fallback when a republished snapshot replaces the row", () => {
		const [snap, setSnap] = createSignal(broken(false));
		render(() => <CallOverlayView snapshot={snap()} />);
		fireEvent.error(rowFor("Alice").querySelector("img") as HTMLImageElement);

		// Snapshots cross the bridge structurally cloned, so every republish
		// brings new participant objects and rebuilds the row (#457).
		setSnap(broken(true));

		expect(rowFor("Alice").querySelector("img")).toBeNull();
		expect(within(rowFor("Alice")).getByText("A")).toBeTruthy();
	});
});
