import { Popover } from "@kobalte/core/popover";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createEffect, createSignal, Match, Show, Switch } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { appModalOpen } from "../stores/modalStack";
import "../styles/global.css";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("Modal", () => {
	it("replaces a sole dynamic panel without retaining old controls", async () => {
		render(() => {
			const [step, setStep] = createSignal(false);
			return (
				<Modal open onClose={() => {}} label="Step flow">
					<Switch>
						<Match when={step()}>
							<div>
								<button type="button" onClick={() => setStep(false)}>
									Back
								</button>
							</div>
						</Match>
						<Match when={true}>
							<div>
								<button type="button" onClick={() => setStep(true)}>
									Next
								</button>
							</div>
						</Match>
					</Switch>
				</Modal>
			);
		});
		await userEvent.click(screen.getByText("Next"));
		expect(screen.queryByText("Next")).toBeNull();
		await userEvent.click(screen.getByText("Back"));
		expect(screen.queryByText("Back")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
	it("restores fallback focus when a virtualized opener disappears", async () => {
		let removeOpener!: () => void;
		render(() => {
			const [open, setOpen] = createSignal(false);
			const [opener, setOpener] = createSignal(true);
			removeOpener = () => setOpener(false);
			let fallback!: HTMLButtonElement;
			return (
				<>
					<button ref={fallback} type="button">
						Timeline
					</button>
					<Show when={opener()}>
						<button type="button" onClick={() => setOpen(true)}>
							Image
						</button>
					</Show>
					<Modal
						open={open()}
						onClose={() => setOpen(false)}
						label="Image viewer"
						fallbackFocus={() => fallback}
					>
						<div>
							<button type="button">Image action</button>
						</div>
					</Modal>
				</>
			);
		});
		await userEvent.click(screen.getByText("Image"));
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Image action"));
		removeOpener();
		await userEvent.keyboard("{Escape}");
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Timeline"));
	});
	it("restores focus when the parent unmounts an open dialog", async () => {
		let unmount!: () => void;
		render(() => {
			const [mounted, setMounted] = createSignal(false);
			unmount = () => setMounted(false);
			return (
				<>
					<button type="button" onClick={() => setMounted(true)}>
						Mount
					</button>
					<Show when={mounted()}>
						<Modal open onClose={() => {}} label="Unmount test">
							<div>
								<button type="button">Inside mounted</button>
							</div>
						</Modal>
					</Show>
				</>
			);
		});
		await userEvent.click(screen.getByText("Mount"));
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Inside mounted"));
		unmount();
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Mount"));
		expect(appModalOpen()).toBe(false);
	});

	it("focuses a field mounted by the owner's open-time effect", async () => {
		render(() => {
			const [ready, setReady] = createSignal(false);
			let field: HTMLInputElement | undefined;
			createEffect(() => setReady(true));
			return (
				<Modal
					open
					onClose={() => {}}
					label="Late field"
					initialFocus={() => field}
				>
					<div>
						<Show when={ready()}>
							<input ref={field} aria-label="Ready field" />
						</Show>
					</div>
				</Modal>
			);
		});
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByLabelText("Ready field"));
	});
	it("does not close when a legacy child clears suspension during Escape", async () => {
		const close = vi.fn();
		render(() => {
			const [child, setChild] = createSignal(false);
			return (
				<>
					<Modal
						open
						onClose={close}
						suspended={child()}
						label="Suspended parent"
					>
						<div>
							<button type="button" onClick={() => setChild(true)}>
								Open legacy
							</button>
						</div>
					</Modal>
					<Show when={child()}>
						<div
							role="dialog"
							aria-modal="true"
							aria-label="Legacy child"
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.stopPropagation();
									setChild(false);
								}
							}}
						>
							<button type="button">Legacy</button>
						</div>
					</Show>
				</>
			);
		});
		await userEvent.click(screen.getByText("Open legacy"));
		screen.getByText("Legacy").focus();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Legacy child" })).toBeNull();
		expect(close).not.toHaveBeenCalled();
	});
	it("lets a portaled popover handle Escape before its dialog", async () => {
		const close = vi.fn();
		render(() => (
			<Modal open onClose={close} label="With popover">
				<div>
					<Popover>
						<Popover.Trigger>More</Popover.Trigger>
						<Popover.Portal>
							<Popover.Content class="portal-scale">
								<button type="button">Popover action</button>
							</Popover.Content>
						</Popover.Portal>
					</Popover>
				</div>
			</Modal>
		));
		await userEvent.click(screen.getByText("More"));
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Popover action"));
		await userEvent.keyboard("{Escape}");
		await expect.poll(() => screen.queryByText("Popover action")).toBeNull();
		expect(close).not.toHaveBeenCalled();
	});

	it("dismisses only a backdrop click, not a click inside the panel", async () => {
		const close = vi.fn();
		render(() => (
			<Modal open onClose={close} label="Backdrop">
				<div>
					<button type="button">Inside</button>
				</div>
			</Modal>
		));
		await userEvent.click(screen.getByText("Inside"));
		expect(close).not.toHaveBeenCalled();
		screen.getByRole("dialog").click();
		expect(close).toHaveBeenCalledOnce();
	});

	it("inherits UI zoom exactly once", () => {
		const root = document.createElement("div");
		root.style.zoom = "1.3";
		document.body.append(root);
		try {
			render(
				() => (
					<Modal open onClose={() => {}} label="Zoom">
						<div data-testid="panel" style={{ width: "200px" }}>
							<button type="button">Zoom action</button>
						</div>
					</Modal>
				),
				{ container: root },
			);
			expect(
				screen.getByTestId("panel").getBoundingClientRect().width,
			).toBeCloseTo(260, 0);
		} finally {
			cleanup();
			root.remove();
		}
	});

	it("does not leak Escape to an unmigrated parent overlay", async () => {
		const parentClose = vi.fn();
		render(() => {
			const [open, setOpen] = createSignal(true);
			return (
				<div
					role="dialog"
					aria-modal="true"
					aria-label="Old parent"
					onKeyDown={(event) => {
						if (event.key === "Escape") parentClose();
					}}
				>
					<Modal open={open()} onClose={() => setOpen(false)} label="New child">
						<div>
							<button type="button">Child</button>
						</div>
					</Modal>
				</div>
			);
		});
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Child"));
		await userEvent.keyboard("{Escape}");
		await expect
			.poll(() => screen.queryByRole("dialog", { name: "New child" }))
			.toBeNull();
		expect(parentClose).not.toHaveBeenCalled();
	});

	it("keeps focus inside when all controls become disabled", async () => {
		let disable!: (value: boolean) => void;
		const outside = document.createElement("button");
		document.body.append(outside);
		try {
			render(() => {
				const [pending, setPending] = createSignal(false);
				disable = setPending;
				let button!: HTMLButtonElement;
				return (
					<Modal
						open
						onClose={() => {}}
						label="Saving"
						initialFocus={() => button}
					>
						<div>
							<button ref={button} type="button" disabled={pending()}>
								Save
							</button>
						</div>
					</Modal>
				);
			});
			await expect
				.poll(() => document.activeElement)
				.toBe(screen.getByText("Save"));
			disable(true);
			outside.focus();
			expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
				true,
			);
			await userEvent.keyboard("{Tab}");
			expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
				true,
			);
		} finally {
			outside.remove();
		}
	});

	it("traps Tab in both directions and restores the opener on Escape", async () => {
		render(() => {
			const [open, setOpen] = createSignal(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Open
					</button>
					<Modal open={open()} onClose={() => setOpen(false)} label="Example">
						<div>
							<button type="button">First</button>
							<button type="button">Last</button>
						</div>
					</Modal>
				</>
			);
		});
		await userEvent.click(screen.getByText("Open"));
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("First"));
		expect(appModalOpen()).toBe(true);
		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expect(document.activeElement).toBe(screen.getByText("Last"));
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(screen.getByText("First"));
		await userEvent.keyboard("{Escape}");
		await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Open"));
		expect(appModalOpen()).toBe(false);
	});

	it("closes only the nested dialog and returns focus inside its parent", async () => {
		const parentClose = vi.fn();
		render(() => {
			const [nested, setNested] = createSignal(false);
			return (
				<Modal open onClose={parentClose} label="Parent">
					<div>
						<button type="button" onClick={() => setNested(true)}>
							Nested
						</button>
						<Modal
							open={nested()}
							onClose={() => setNested(false)}
							label="Child"
						>
							<div>
								<button type="button">Child action</button>
							</div>
						</Modal>
					</div>
				</Modal>
			);
		});
		await userEvent.click(screen.getByText("Nested"));
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Child action"));
		await userEvent.keyboard("{Escape}");
		await expect
			.poll(() => screen.queryByRole("dialog", { name: "Child" }))
			.toBeNull();
		expect(parentClose).not.toHaveBeenCalled();
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Nested"));
		expect(appModalOpen()).toBe(true);
	});

	it("blocks dismissal while pending and yields focus to a legacy modal", async () => {
		const close = vi.fn();
		let suspend!: (value: boolean) => void;
		render(() => {
			const [suspended, setSuspended] = createSignal(false);
			suspend = setSuspended;
			return (
				<>
					<Modal
						open
						onClose={close}
						dismissible={false}
						suspended={suspended()}
						label="Pending"
					>
						<div>
							<button type="button">Action</button>
						</div>
					</Modal>
					<Show when={suspended()}>
						<div role="dialog" aria-modal="true" aria-label="Legacy">
							<button type="button">Legacy action</button>
						</div>
					</Show>
				</>
			);
		});
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Action"));
		await userEvent.keyboard("{Escape}");
		expect(close).not.toHaveBeenCalled();
		suspend(true);
		screen.getByText("Legacy action").focus();
		expect(document.activeElement).toBe(screen.getByText("Legacy action"));
		expect(screen.getByRole("dialog", { name: "Pending" }).inert).toBe(true);
		expect(
			screen
				.getByRole("dialog", { name: "Pending" })
				.hasAttribute("aria-modal"),
		).toBe(false);
	});
});
