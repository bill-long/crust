import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
const locationState: { value: unknown } = { value: null };
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useLocation: () => ({
		pathname: "/login",
		search: "",
		hash: "",
		get state() {
			return locationState.value;
		},
	}),
}));

import {
	carryNoticeIntoSession,
	clearNotices,
	notices,
	pushNotice,
	takeCarriedNotice,
} from "../../stores/notices";
import { addSession, type Session } from "../../stores/session";
import { LoginGate } from "./LoginGate";
import { markLogoutLanding, takeLogoutLanding } from "./logoutLanding";

const ALICE: Session = {
	accessToken: "syt_alice",
	userId: "@alice:example.com",
	deviceId: "DEVICE_A",
	homeserverUrl: "https://matrix.example.com",
};

/** The gate renders a marker so "did the login form mount" is observable. */
const renderGate = (): void => {
	render(() => (
		<LoginGate>
			<p>login form</p>
		</LoginGate>
	));
};

const formShown = (): boolean => screen.queryByText("login form") !== null;

/** Stand in for the app root taking delivery of whatever the gate carried. */
const deliverCarried = (): void => {
	const carried = takeCarriedNotice();
	if (carried !== null) pushNotice(carried.message, carried.tone);
};

beforeEach(() => {
	localStorage.clear();
	// Drains the carry slot as well as the visible list.
	clearNotices();
	// One-shot and module-scoped: unarm it so each test starts from a plain
	// arrival.
	takeLogoutLanding();
	locationState.value = null;
	navigateMock.mockClear();
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	clearNotices();
});

describe("LoginGate", () => {
	it("shows the login form when no account is logged in", () => {
		renderGate();

		expect(formShown()).toBe(true);
		expect(navigateMock).not.toHaveBeenCalled();
		deliverCarried();
		expect(notices()).toHaveLength(0);
	});

	it("paints while it redirects, rather than flashing the page background", () => {
		// Nothing below #root sets a background, and the router holds this frame
		// for the whole transition, so rendering nothing shows the UA white.
		addSession(ALICE);

		const { container } = render(() => (
			<LoginGate>
				<p>login form</p>
			</LoginGate>
		));

		expect(container.querySelector(".bg-surface-0")).not.toBeNull();
		expect(formShown()).toBe(false);
	});

	it("redirects an already-signed-in visitor into the app", () => {
		addSession(ALICE);

		renderGate();

		// Never rendered at all - not merely hidden. A login form that mounts
		// would prefetch, probe the homeserver, and be one submit away from
		// replacing the account that is signed in.
		expect(formShown()).toBe(false);
		expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
	});

	it("says why rather than silently swallowing the URL", () => {
		addSession(ALICE);

		renderGate();

		// Nothing is visible yet: the toast renderer lives inside the session this
		// redirect leads to, and it clears what it finds as it mounts. The message
		// has to be handed over, not pushed, or the app root eats it on arrival.
		expect(notices()).toHaveLength(0);
		deliverCarried();

		expect(notices()).toHaveLength(1);
		expect(notices()[0]?.message).toMatch(/already signed in/i);
		expect(notices()[0]?.message).toMatch(/account switcher/i);
	});

	it("lets the switcher's add-account arrival through", () => {
		addSession(ALICE);
		locationState.value = { addAccount: true };

		renderGate();

		expect(formShown()).toBe(true);
		expect(navigateMock).not.toHaveBeenCalled();
		// Nothing went wrong, so nothing to say.
		deliverCarried();
		expect(notices()).toHaveLength(0);
	});

	it("lets a logout landing through with the account still in storage", () => {
		// The logout tail routes here when it could not persist the removal, so
		// the account is still listed while its token has already been revoked.
		// Bouncing back into it would boot a dead session that logs out and lands
		// here again: a loop.
		addSession(ALICE);
		markLogoutLanding();

		renderGate();

		expect(formShown()).toBe(true);
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("spends the logout waiver on the arrival it was armed for", () => {
		// The waiver must not outlive the navigation that armed it. A tab left on
		// the post-logout login page while another tab signs a healthy account in
		// would otherwise still be waived, and a login there replaces it.
		addSession(ALICE);
		markLogoutLanding();
		renderGate();
		expect(formShown()).toBe(true);

		cleanup();
		navigateMock.mockClear();

		renderGate();

		expect(formShown()).toBe(false);
		expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
	});

	it("spends the waiver even when nobody is signed in", () => {
		// Read unconditionally, not short-circuited by the account check: left
		// armed it would waive some later, unrelated visit to this route.
		markLogoutLanding();

		renderGate();

		expect(formShown()).toBe(true);
		expect(takeLogoutLanding()).toBe(false);
	});

	it("ignores a returnTo-only state, which any deep link can produce", () => {
		// `AuthGuard` sets exactly this when it sends a logged-out visitor here.
		// It carries no waiver, so an account in storage still wins - but the
		// deep-linked room is where the bounce should land, not the app root.
		addSession(ALICE);
		locationState.value = { returnTo: "/home/!room:example.com" };

		renderGate();

		expect(formShown()).toBe(false);
		expect(navigateMock).toHaveBeenCalledWith("/home/!room:example.com", {
			replace: true,
		});
	});

	it("sanitizes the returnTo it bounces to", () => {
		// Router state cannot be set by a crafted link, so this is
		// defence-in-depth - and it is what keeps the bounce from re-entering
		// this very guard.
		addSession(ALICE);
		locationState.value = { returnTo: "//evil.example/phish" };

		renderGate();

		expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });

		navigateMock.mockClear();
		cleanup();
		locationState.value = { returnTo: "/login?next=/home" };

		renderGate();

		expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
	});

	it("carries the deep-linked returnTo through for a logged-out visitor", () => {
		// The deep-link path is the one this guard must not break: no accounts,
		// so the form renders and keeps the state the auth guard handed it.
		locationState.value = { returnTo: "/space/!s:example.com/!r:example.com" };

		renderGate();

		expect(formShown()).toBe(true);
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("reads storage rather than this tab's account mirror", () => {
		// Another tab logged in after this module was imported, so the reactive
		// mirror seeded at import time still says "logged out". Storage is the
		// authority on what exists (#533, invariant 2).
		localStorage.setItem(
			"crust:session",
			JSON.stringify({ activeUserId: ALICE.userId, sessions: [ALICE] }),
		);

		renderGate();

		expect(formShown()).toBe(false);
		expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
	});

	it("drops a carried notice when it shows the form instead", () => {
		// The gate carried one, the app never took delivery (another tab logged
		// out, so the auth guard sent the visitor straight back here). Left in the
		// slot it would surface on top of whatever session they log into next.
		carryNoticeIntoSession("you're already signed in");

		renderGate();

		expect(formShown()).toBe(true);
		deliverCarried();
		expect(notices()).toEqual([]);
	});

	it("does not re-evaluate once the visitor is on the form", () => {
		// The password flow persists the session and THEN navigates. If the gate
		// tracked storage it would notice the account it just created and redirect
		// over the login page's own navigation.
		renderGate();
		expect(formShown()).toBe(true);

		addSession(ALICE);

		expect(formShown()).toBe(true);
		expect(navigateMock).not.toHaveBeenCalled();
	});
});
