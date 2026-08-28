import { sanitizeFilename } from "./filename";

/**
 * Hand a Blob to the browser's download flow. The object URL is revoked
 * on a later task: revoking in the same task cancels the download in
 * Firefox (see ExportKeysDialog, where this snippet originated).
 */
export function saveBlobToDisk(blob: Blob, filename: string): void {
	const objUrl = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = objUrl;
	a.download = sanitizeFilename(filename);
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(objUrl), 0);
}
