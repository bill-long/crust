import type { MatrixClient } from "matrix-js-sdk";
import { toAuthedMediaUrl } from "../lib/authedMedia";

/** Explicit actions cannot rely on a controlling service worker (new tabs and
 * downloads leave its scope). Bind requests to the client that owns the action,
 * while reading its current token so OAuth refreshes remain transparent. */
export function createMediaFetcher(client: MatrixClient) {
	return async (url: string, signal?: AbortSignal): Promise<Response> => {
		signal?.throwIfAborted();
		const target = toAuthedMediaUrl(url, client.baseUrl);
		const headers = new Headers();
		let requestUrl = url;
		if (target && (await client.isVersionSupported("v1.11"))) {
			const token = client.getAccessToken();
			if (!token) throw new Error("Sign in again to download this file.");
			headers.set("Authorization", `Bearer ${token}`);
			requestUrl = target;
		}
		signal?.throwIfAborted();
		const response = await fetch(requestUrl, {
			headers,
			signal: signal ?? null,
			credentials: "omit",
		});
		if (!response.ok) throw new Error("Couldn't download this file.");
		return response;
	};
}
