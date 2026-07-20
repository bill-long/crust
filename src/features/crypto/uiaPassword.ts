import { AuthType } from "matrix-js-sdk";
import type { UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth";

/**
 * Build an `authUploadDeviceSigningKeys` UIA callback that authorizes with
 * the account password. Shared by the cross-signing bootstrap and the
 * encryption reset flows — both upload device-signing keys and hit the same
 * UIA dance: try unauthenticated first to learn the session id, then retry
 * with `m.login.password` on the expected 401.
 */
export function passwordUiaCallback(
	userId: string,
	password: string,
): UIAuthCallback<void> {
	return async (makeRequest) => {
		// First attempt without auth to get the session ID
		try {
			await makeRequest(null);
			return;
		} catch (uiaError: unknown) {
			// Expected: server returns 401 with UIA flow info
			const err = uiaError as {
				httpStatus?: number;
				data?: { session?: string };
			};
			if (err.httpStatus !== 401 || !err.data?.session) {
				throw uiaError;
			}

			await makeRequest({
				type: AuthType.Password,
				identifier: {
					type: "m.id.user",
					user: userId,
				},
				password,
				session: err.data.session,
			});
		}
	};
}
