/**
 * Shared fixtures for tests that drive the UIA flow
 * (`features/crypto/uiaFlow.ts`) or the dialogs built on it.
 */

export type MakeRequest = (authData: unknown) => Promise<void>;
export type UiaCallback = (makeRequest: MakeRequest) => Promise<void>;

/**
 * Forge the SDK error for a UIA 401 challenge. `flows` is one stage list
 * per advertised flow, matching the wire shape's `flows[].stages`.
 */
export function uia401(
	session: string,
	flows: string[][],
	params?: unknown,
): Error {
	return Object.assign(new Error("Unauthorized"), {
		httpStatus: 401,
		data: { session, flows: flows.map((stages) => ({ stages })), params },
	});
}
