import { cleanup, render, screen } from "@solidjs/testing-library";
import { lazy, Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./callSessionStore";
import { makeFakeCallSession } from "./fakeCallSession.test-utils";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

/**
 * Code-splitting smoke test (#307): the FullCallOverlay boundary introduced
 * in src/app/Layout.tsx must resolve its dynamic import and mount through
 * Suspense. Mirrors the production lazy() declaration so a dropped boundary
 * or renamed export fails here instead of at runtime.
 */
describe("FullCallOverlay lazy boundary (#307)", () => {
	const fakes: Array<{ dispose: () => void }> = [];
	const track = <T extends { dispose: () => void }>(fake: T): T => {
		fakes.push(fake);
		return fake;
	};

	afterEach(() => {
		cleanup();
		for (const f of fakes.splice(0)) f.dispose();
		_resetCallSessionForTests();
	});

	it("lazy chunk resolves and mounts with a published session", async () => {
		// Mirrors src/app/Layout.tsx.
		const FullCallOverlay = lazy(() =>
			import("./FullCallOverlay").then((m) => ({
				default: m.FullCallOverlay,
			})),
		);
		const fake = track(makeFakeCallSession({ roomName: "Standup" }));
		publishCallSession(fake.api);
		render(() => (
			<Suspense fallback={<div class="absolute inset-0 z-30 bg-surface-0" />}>
				<FullCallOverlay />
			</Suspense>
		));
		expect(
			await screen.findByRole(
				"region",
				{ name: "Native call in Standup" },
				{ timeout: 5000 },
			),
		).toBeTruthy();
	});
});
