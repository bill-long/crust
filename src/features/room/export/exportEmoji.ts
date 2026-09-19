import type { MatrixClient } from "matrix-js-sdk";
import { createMediaFetcher } from "../../../client/media";
import { sanitizeMatrixHtmlToDiv } from "../../../lib/matrixHtml";
import type { ExportRow } from "./serializers";

/** Only fetch images admitted by the same sanitizer used by the transcript.
 * Deduplicate before downloading so a repeated custom emoji is bundled once. */
export async function exportEmoji(
	client: MatrixClient,
	rows: ExportRow[],
	signal?: AbortSignal,
	isCancelled: () => boolean = () => false,
): Promise<{
	paths: Map<string, string>;
	files: { path: string; data: Uint8Array }[];
}> {
	const checkCancelled = () => {
		signal?.throwIfAborted();
		if (isCancelled()) throw new DOMException("Export cancelled", "AbortError");
	};
	const sources = new Set<string>();
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (
			row &&
			!row.undecryptable &&
			row.te.format === "org.matrix.custom.html" &&
			row.te.formattedBody
		) {
			sanitizeMatrixHtmlToDiv(row.te.formattedBody, (mxc) => {
				sources.add(mxc);
				return null;
			});
		}
		if (i % 50 === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			checkCancelled();
		}
	}
	const fetchMedia = createMediaFetcher(client);
	const paths = new Map<string, string>();
	const files: { path: string; data: Uint8Array }[] = [];
	for (const mxc of sources) {
		checkCancelled();
		const url = client.mxcUrlToHttp(mxc, 64, 64, "scale");
		if (!url) continue;
		try {
			const response = await fetchMedia(url, signal);
			const data = new Uint8Array(await response.arrayBuffer());
			const path = `media/emoji-${files.length + 1}`;
			files.push({ path, data });
			paths.set(mxc, path);
		} catch {
			checkCancelled();
			// A missing emoji remains readable through its text label.
		}
	}
	return { paths, files };
}
