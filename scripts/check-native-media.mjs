// Windows smoke test against a compiled shell, using an isolated WebView2 profile.
// Build first: pnpm build; cargo build --locked --features tauri/custom-protocol
// (the cargo command runs in desktop/src-tauri).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

if (process.platform !== "win32") throw new Error("Requires Windows WebView2");
const socket = net.createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const profile = await mkdtemp(join(tmpdir(), "crust-media-test-"));
const child = spawn(resolve("desktop/src-tauri/target/debug/crust.exe"), [], {
	windowsHide: true,
	stdio: "ignore",
	env: {
		...process.env,
		CRUST_NO_UPDATE: "1",
		WEBVIEW2_USER_DATA_FOLDER: profile,
		WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
	},
});
let browser;
try {
	const endpoint = `http://127.0.0.1:${port}`;
	for (let attempt = 0; ; attempt++) {
		try {
			browser = await chromium.connectOverCDP(endpoint);
			break;
		} catch (error) {
			if (attempt === 30) throw error;
			await new Promise((done) => setTimeout(done, 500));
		}
	}
	const context = browser.contexts()[0];
	const main = context.pages()[0];
	await main.waitForFunction(
		() => typeof window.__TAURI_INTERNALS__?.invoke === "function",
	);
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><script>window.pwned=true</script></svg>';
	const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	const opened = context.waitForEvent("page");
	await main.evaluate(
		(dataUrl) =>
			window.__TAURI_INTERNALS__.invoke("open_image_preview", { dataUrl }),
		dataUrl,
	);
	const viewer = await opened;
	try {
		await viewer.waitForFunction(
			() => document.querySelector("img")?.naturalWidth === 16,
			null,
			{ timeout: 5000 },
		);
	} catch (error) {
		console.error(
			await viewer.evaluate(() => ({
				url: location.href,
				html: document.documentElement.outerHTML,
				origin: location.origin,
			})),
		);
		throw error;
	}
	assert.equal(viewer.url(), "about:blank");
	assert.equal(await viewer.evaluate(() => window.pwned), undefined);
	assert.equal(await viewer.evaluate(() => location.origin), "null");
	// A preview cannot create more privileged windows, even if IPC is injected.
	const denied = await viewer.evaluate(async (dataUrl) => {
		try {
			await window.__TAURI_INTERNALS__.invoke("open_image_preview", {
				dataUrl,
			});
			return false;
		} catch {
			return true;
		}
	}, dataUrl);
	assert.equal(denied, true);
	await viewer.close();
	console.log(
		"Native image preview: decoded image, script isolation, opaque origin, and IPC denial passed.",
	);
} finally {
	await browser?.close();
	if (child.pid)
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
			windowsHide: true,
			stdio: "ignore",
		});
	// Keep the isolated profile for diagnosing failures; it contains no login.
}
