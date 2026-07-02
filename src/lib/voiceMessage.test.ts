import { describe, expect, it } from "vitest";
import { isVoiceMessageContent, parseVoiceInfo } from "./voiceMessage";

/** Element-shaped voice message content. */
function voiceContent(overrides?: Record<string, unknown>) {
	return {
		msgtype: "m.audio",
		body: "Voice message",
		url: "mxc://example.com/abc",
		info: { duration: 6541, mimetype: "audio/ogg", size: 42967 },
		"org.matrix.msc1767.audio": {
			duration: 6541,
			waveform: [0, 256, 512, 1024],
		},
		"org.matrix.msc3245.voice": {},
		...overrides,
	};
}

describe("isVoiceMessageContent", () => {
	it("accepts an m.audio with the voice marker", () => {
		expect(isVoiceMessageContent(voiceContent())).toBe(true);
	});

	it("rejects plain audio without the marker", () => {
		expect(
			isVoiceMessageContent(
				voiceContent({ "org.matrix.msc3245.voice": undefined }),
			),
		).toBe(false);
	});

	it("rejects the marker on a non-audio msgtype", () => {
		expect(isVoiceMessageContent(voiceContent({ msgtype: "m.file" }))).toBe(
			false,
		);
	});

	it.each([
		["null", null],
		["string content", "hi"],
		["non-object marker", voiceContent({ "org.matrix.msc3245.voice": "yes" })],
		["array marker", voiceContent({ "org.matrix.msc3245.voice": [] })],
	])("rejects %s", (_label, content) => {
		expect(isVoiceMessageContent(content)).toBe(false);
	});
});

describe("parseVoiceInfo", () => {
	it("reads duration and normalizes the waveform to 0..1", () => {
		const info = parseVoiceInfo(voiceContent());
		expect(info.durationMs).toBe(6541);
		expect(info.waveform).toEqual([0, 0.25, 0.5, 1]);
	});

	it("falls back to info.duration when the msc1767 block lacks one", () => {
		const info = parseVoiceInfo(
			voiceContent({ "org.matrix.msc1767.audio": { waveform: [512] } }),
		);
		expect(info.durationMs).toBe(6541);
	});

	it("falls back to info.duration when the msc1767 duration is invalid", () => {
		// A present-but-hostile MSC value must not mask a usable
		// info.duration (each candidate validates independently).
		const info = parseVoiceInfo(
			voiceContent({
				"org.matrix.msc1767.audio": { duration: 1e13, waveform: [512] },
			}),
		);
		expect(info.durationMs).toBe(6541);
	});

	it("clamps out-of-range waveform values", () => {
		const info = parseVoiceInfo(
			voiceContent({
				"org.matrix.msc1767.audio": { duration: 100, waveform: [-5, 2048] },
			}),
		);
		expect(info.waveform).toEqual([0, 1]);
	});

	it("drops the whole waveform when any sample is non-numeric", () => {
		const info = parseVoiceInfo(
			voiceContent({
				"org.matrix.msc1767.audio": {
					duration: 100,
					waveform: [1, "x", 3],
				},
			}),
		);
		expect(info.waveform).toBeNull();
		expect(info.durationMs).toBe(100);
	});

	it("caps hostile waveform lengths", () => {
		const info = parseVoiceInfo(
			voiceContent({
				"org.matrix.msc1767.audio": {
					duration: 100,
					waveform: new Array(100_000).fill(512),
				},
			}),
		);
		expect(info.waveform?.length).toBe(1024);
	});

	it.each([
		["missing blocks", { msgtype: "m.audio" }],
		[
			"zero duration",
			voiceContent({ "org.matrix.msc1767.audio": { duration: 0 }, info: {} }),
		],
		[
			"non-finite duration",
			voiceContent({
				"org.matrix.msc1767.audio": { duration: Number.NaN },
				info: {},
			}),
		],
		[
			"a hostile enormous duration",
			voiceContent({
				"org.matrix.msc1767.audio": { duration: 1e12 },
				info: {},
			}),
		],
	])("nulls unusable fields for %s", (_label, content) => {
		const info = parseVoiceInfo(content);
		expect(info.durationMs).toBeNull();
	});

	it("handles an empty waveform array", () => {
		const info = parseVoiceInfo(
			voiceContent({
				"org.matrix.msc1767.audio": { duration: 100, waveform: [] },
			}),
		);
		expect(info.waveform).toBeNull();
	});
});
