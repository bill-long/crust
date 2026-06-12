/**
 * Human-readable byte size, e.g. `1536` → `"1.5 KB"`. Returns `""` for
 * non-finite or negative input. One decimal place below 10 of a unit,
 * whole numbers at 10 and above.
 */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "";
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
