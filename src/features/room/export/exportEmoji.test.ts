import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import { exportEmoji } from "./exportEmoji";
import { type ExportBundle, type ExportRow, htmlRow } from "./serializers";

afterEach(() => vi.unstubAllGlobals());

it("bundles each sanitized emoji once and keeps failed images readable", async () => {
	const client = {
		baseUrl: "https://hs",
		getAccessToken: () => "token",
		isVersionSupported: async () => true,
		mxcUrlToHttp: (mxc: string) =>
			mxc.replace("mxc://", "https://hs/_matrix/media/v3/thumbnail/"),
	} as unknown as MatrixClient;
	const row: ExportRow = {
		te: makeTimelineEvent({
			format: "org.matrix.custom.html",
			formattedBody:
				'<img data-mx-emoticon src="mxc://hs/ok" alt=":ok:"><img data-mx-emoticon src="mxc://hs/missing" alt=":missing:"><img src="https://tracker/pixel"><mx-reply><img data-mx-emoticon src="mxc://hs/reply"></mx-reply>',
		}),
		bodyText: ":ok: :missing:",
		undecryptable: false,
		attachmentPath: null,
		attachmentFailed: false,
	};
	const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");
		expect(url).toContain("/_matrix/client/v1/media/thumbnail/");
		return url.endsWith("/ok")
			? new Response("image bytes", {
					headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
				})
			: new Response(null, { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	const result = await exportEmoji(client, [row, row]);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(result.files).toHaveLength(1);
	expect(new TextDecoder().decode(result.files[0]?.data)).toBe("image bytes");
	const html = htmlRow(row, {
		emojiPath: (mxc: string) => result.paths.get(mxc) ?? null,
	} as ExportBundle);
	expect(html).toContain('src="media/emoji-1.svg"');
	expect(html).toContain(":missing:");
	expect(html).not.toContain("https://");
	expect(html).not.toContain("mxc://");
});
