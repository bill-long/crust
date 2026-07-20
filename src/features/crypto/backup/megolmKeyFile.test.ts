import { describe, expect, it } from "vitest";
import {
	decryptMegolmKeyFile,
	encryptMegolmKeyFile,
	isMegolmKeyExportFile,
} from "./megolmKeyFile";

// Low iteration count keeps the test fast; production uses the 500k default.
const ITERS = 1_000;

const SAMPLE_JSON = JSON.stringify([
	{
		room_id: "!room:example.com",
		session_id: "session1",
		session_key: "AQAAAA…",
		sender_key: "senderkey",
		algorithm: "m.megolm.v1.aes-sha2",
		forwarding_curve25519_key_chain: [],
		sender_claimed_keys: {},
	},
]);

describe("megolmKeyFile", () => {
	it("round-trips through encrypt/decrypt", async () => {
		const file = await encryptMegolmKeyFile(SAMPLE_JSON, "hunter2", ITERS);
		expect(isMegolmKeyExportFile(file)).toBe(true);
		const decrypted = await decryptMegolmKeyFile(file, "hunter2");
		expect(decrypted).toBe(SAMPLE_JSON);
	});

	it("wraps the payload in the standard markers", async () => {
		const file = await encryptMegolmKeyFile(SAMPLE_JSON, "pw", ITERS);
		expect(file.startsWith("-----BEGIN MEGOLM SESSION DATA-----\n")).toBe(true);
		expect(file.endsWith("\n-----END MEGOLM SESSION DATA-----")).toBe(true);
	});

	it("produces the documented binary structure (version ‖ salt ‖ iv ‖ iters ‖ ct ‖ hmac)", async () => {
		const plaintext = "x"; // 1 byte keeps offsets trivial
		const file = await encryptMegolmKeyFile(plaintext, "pw", ITERS);
		const body = file.split("\n")[1];
		const packed = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));

		// 1 version + 32 salt + 16 iv + 4 iters + 1 ct + 32 hmac
		expect(packed.length).toBe(86);
		expect(packed[0]).toBe(1); // format version
		// iterations are big-endian at offset 1+32+16
		expect(new DataView(packed.buffer, 49, 4).getUint32(0, false)).toBe(ITERS);
	});

	it("rejects a wrong passphrase", async () => {
		const file = await encryptMegolmKeyFile(SAMPLE_JSON, "right", ITERS);
		await expect(decryptMegolmKeyFile(file, "wrong")).rejects.toThrow(
			"Incorrect passphrase",
		);
	});

	it("rejects a tampered file (HMAC mismatch)", async () => {
		const file = await encryptMegolmKeyFile(SAMPLE_JSON, "pw", ITERS);
		const lines = file.split("\n");
		const body = atob(lines[1]);
		// Flip a byte inside the ciphertext region.
		const tampered = `${body.slice(0, 60)}${body[60] === "A" ? "B" : "A"}${body.slice(61)}`;
		const file2 = `${lines[0]}\n${btoa(tampered)}\n${lines[2]}`;
		await expect(decryptMegolmKeyFile(file2, "pw")).rejects.toThrow(
			"Incorrect passphrase, or the file is corrupted.",
		);
	});

	it("rejects truncated files", async () => {
		const file = await encryptMegolmKeyFile(SAMPLE_JSON, "pw", ITERS);
		const lines = file.split("\n");
		const short = `${lines[0]}\n${lines[1].slice(0, 20)}\n${lines[2]}`;
		await expect(decryptMegolmKeyFile(short, "pw")).rejects.toThrow(
			"corrupted",
		);
	});

	it("rejects non-export text", async () => {
		await expect(decryptMegolmKeyFile("hello world", "pw")).rejects.toThrow(
			"Not a megolm key export file",
		);
	});

	it("tolerates whitespace-wrapped base64 bodies", async () => {
		const file = await encryptMegolmKeyFile(SAMPLE_JSON, "pw", ITERS);
		const lines = file.split("\n");
		const wrapped = lines[1].replace(/(.{40})/g, "$1\n");
		const file2 = `${lines[0]}\n${wrapped}\n${lines[2]}`;
		await expect(decryptMegolmKeyFile(file2, "pw")).resolves.toBe(SAMPLE_JSON);
	});

	it("distinguishes export files from raw JSON", () => {
		expect(isMegolmKeyExportFile(SAMPLE_JSON)).toBe(false);
		expect(
			isMegolmKeyExportFile("  -----BEGIN MEGOLM SESSION DATA-----\nx"),
		).toBe(true);
	});
});
