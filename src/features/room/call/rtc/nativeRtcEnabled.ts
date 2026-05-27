/**
 * Build-time feature flag for the native MatrixRTC client.
 *
 * Phase 1 of the native client (see issue #122) is intentionally hidden
 * behind an env flag — NOT a Settings toggle — because joining a session
 * publishes membership state events that other clients (and crust's own
 * `summaries.ts` `callActive` flag) treat as a real call-in-progress.
 * Membership-only joins with no media would create bogus "active call"
 * state in shared rooms. Settings exposure is deferred until Phase 5,
 * after audio (Phase 2) and E2EE (Phase 4) land.
 *
 * Enable for local dev with `VITE_NATIVE_RTC=1 pnpm dev`.
 */
export const NATIVE_RTC_ENABLED: boolean =
	import.meta.env.VITE_NATIVE_RTC === "1";
