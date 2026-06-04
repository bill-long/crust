import { MemoryRouter, Route, useNavigate } from "@solidjs/router";
import { cleanup, render } from "@solidjs/testing-library";
import {
	type Component,
	createSignal,
	onCleanup,
	onMount,
	type ParentComponent,
} from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

// solid-refresh shim — these tests don't go through Vite's HMR pipeline,
// so the dev-time refresh wrapper would otherwise throw.
vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

describe("route topology — call session survives shape changes", () => {
	afterEach(() => {
		cleanup();
	});

	// Regression for the "click Return → call is silently killed" bug.
	// Before PersistentCallSurface was hoisted into SyncGate, the call
	// controller lived inside Layout (which is the leaf-route component
	// of multiple `<Route path="...">` declarations). SolidJS Router
	// treats each Route declaration as a distinct key even when several
	// declarations share the same component, so navigating between
	// /space/X/Y and /home/Y disposed the old Layout subtree and built
	// a new one — running CallSessionController's onCleanup which
	// synchronously fires leaveRoomSession(). The fix is to mount the
	// controller as a SIBLING of the per-route children at the parent
	// route level, so navigation between sub-route shapes leaves it
	// untouched. This test asserts that property without exercising the
	// full Matrix/LiveKit stack — it stands in for the controller with
	// a mount-counter component and verifies the structural invariant.
	it("a sibling-of-children component at the parent route is NOT remounted when sub-routes navigate between different path shapes", async () => {
		let mountCount = 0;
		let cleanupCount = 0;

		const PersistentStandIn: Component = () => {
			onMount(() => {
				mountCount++;
			});
			onCleanup(() => {
				cleanupCount++;
			});
			return null;
		};

		// Mirrors the SyncGate shape: renders {props.children} for the
		// active route AND a persistent sibling. This is the structural
		// invariant that PersistentCallSurface relies on.
		const Parent: ParentComponent = (props) => (
			<>
				<div data-testid="children">{props.children}</div>
				<PersistentStandIn />
			</>
		);

		// Distinct leaf components so we can confirm navigation actually
		// happened (i.e. the test isn't a no-op).
		const [activeLeaf, setActiveLeaf] = createSignal<"space" | "home">("space");
		const SpaceLeaf: Component = () => {
			onMount(() => setActiveLeaf("space"));
			return <div data-testid="space-leaf">space</div>;
		};
		const HomeLeaf: Component = () => {
			onMount(() => setActiveLeaf("home"));
			return <div data-testid="home-leaf">home</div>;
		};

		// Capture the navigate function from inside the router so we can
		// drive a navigation programmatically without using <A>. Use a
		// holder object so TS doesn't narrow the closure-assigned slot
		// to `never` after the null check.
		const navHolder: { fn: ((to: string) => void) | null } = { fn: null };
		const NavCapture: Component = () => {
			const n = useNavigate();
			navHolder.fn = (to) => n(to);
			return null;
		};

		render(() => (
			<MemoryRouter>
				<Route path="/" component={Parent}>
					<Route path="/" component={NavCapture} />
					<Route path="/space/:spaceId/:roomId" component={SpaceLeaf} />
					<Route path="/home/:roomId" component={HomeLeaf} />
				</Route>
			</MemoryRouter>
		));

		const tick = (): Promise<void> =>
			new Promise<void>((r) => {
				queueMicrotask(() => r());
			});

		// Flush initial render — wait for NavCapture to mount.
		await tick();
		if (!navHolder.fn) throw new Error("navigate not captured");

		// Navigate to /space/X/Y — SpaceLeaf mounts, persistent stand-in
		// stays mounted (mountCount stays at 1).
		navHolder.fn("/space/!s/!r");
		await tick();
		await tick();
		expect(activeLeaf()).toBe("space");

		const mountsAfterSpace = mountCount;
		const cleanupsAfterSpace = cleanupCount;
		expect(mountsAfterSpace).toBe(1);
		expect(cleanupsAfterSpace).toBe(0);

		// Navigate to /home/Y — DIFFERENT route shape, same parent. This
		// is the navigation that triggered the original bug. If the
		// stand-in were mounted inside the leaf instead of the parent,
		// mountCount would jump and cleanupCount would jump too.
		navHolder.fn("/home/!r");
		await tick();
		await tick();
		expect(activeLeaf()).toBe("home");

		expect(mountCount).toBe(1);
		expect(cleanupCount).toBe(0);
	});
});
