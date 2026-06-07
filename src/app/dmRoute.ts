/**
 * Canonicalization for direct-message deep links.
 *
 * In-app navigation routes direct messages to `/dm/<roomId>`, but deep links
 * and service-worker push opens always land on `/home/<roomId>` (the push
 * payload carries no is-DM hint and the worker has no SDK access — see
 * src/sw.ts roomUrl). This helper decides whether a `/home/<roomId>` route
 * should be canonicalized to `/dm/<roomId>`.
 *
 * Pure so it can be unit-tested without a router/store harness. The caller
 * (the createEffect in src/app/Layout.tsx) re-evaluates it reactively, so a
 * late `isDirect` flip (after sync populates m.direct) triggers the redirect.
 *
 * @param relativePath base-stripped pathname (e.g. "/home/!abc:server")
 * @param roomId decoded room id from the route params, if any
 * @param isDirect whether summaries currently know the room is a DM
 * @returns the `/dm/<roomId>` target to redirect to, or null to stay put
 */
export function dmCanonicalTarget(
	relativePath: string,
	roomId: string | undefined,
	isDirect: boolean | undefined,
): string | null {
	if (!roomId) return null;
	if (!relativePath.startsWith("/home/")) return null;
	if (isDirect !== true) return null;
	return `/dm/${encodeURIComponent(roomId)}`;
}
