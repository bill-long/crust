/**
 * Whether the login route was reached by the tail of a logout in THIS document
 * (#549).
 *
 * `/login` turns an already-signed-in visitor away, and `finishAccountLogout`
 * is the one arrival that has to be let through with accounts still in storage:
 * it also routes here when storage REFUSED to forget the account it just
 * revoked, and bouncing back into that account would boot a dead session that
 * logs out and lands here again - a loop.
 *
 * A module flag rather than router state, which is what the `addAccount`
 * waiver uses. Router state is persisted into `history.state` by
 * `@solidjs/router`, so it survives a reload and a session restore of that
 * entry: a tab left sitting on the post-logout `/login` would still be waived
 * days later, and by then another tab may have signed a perfectly healthy
 * account in - which a login there would then replace, unrevoked, which is the
 * whole harm this guard exists to prevent. The waiver is about a navigation
 * this document just performed, so it lives for exactly as long as this
 * document does, and no longer.
 *
 * One-shot: taking it clears it, so a second arrival at `/login` is judged on
 * its own merits. The cost is that reloading the post-logout login page is a
 * fresh arrival - it bounces once through the dead account and comes back here
 * with the flag re-armed. That self-heals; a stale waiver does not.
 */
let landedFromLogout = false;

/** Arm the waiver, immediately before navigating to `/login`. */
export function markLogoutLanding(): void {
	landedFromLogout = true;
}

/**
 * Consume the waiver. Call unconditionally on arrival - reading it is what
 * disarms it, so a short-circuited read leaves it primed for a later, unrelated
 * visit.
 */
export function takeLogoutLanding(): boolean {
	const landed = landedFromLogout;
	landedFromLogout = false;
	return landed;
}
