import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "./slashCommands";

describe("parseSlashCommand", () => {
	it("passes ordinary text through untouched", () => {
		expect(parseSlashCommand("hello world")).toEqual({
			text: "hello world",
			msgtype: "m.text",
			plain: false,
			spoiler: false,
		});
	});

	it("parses /me into an emote", () => {
		expect(parseSlashCommand("/me waves at everyone")).toEqual({
			text: "waves at everyone",
			msgtype: "m.emote",
			plain: false,
			spoiler: false,
		});
	});

	it("is case-insensitive on the command", () => {
		expect(parseSlashCommand("/ME waves").msgtype).toBe("m.emote");
	});

	it("prepends the shrug emoticon and sends plain", () => {
		expect(parseSlashCommand("/shrug no idea")).toEqual({
			text: "¯\\_(ツ)_/¯ no idea",
			msgtype: "m.text",
			plain: true,
			spoiler: false,
		});
		expect(parseSlashCommand("/shrug").text).toBe("¯\\_(ツ)_/¯");
	});

	it("supports the other emoticon conveniences", () => {
		expect(parseSlashCommand("/tableflip").text).toContain("┻━┻");
		expect(parseSlashCommand("/unflip").text).toContain("┬─┬");
		expect(parseSlashCommand("/lenny").text).toContain("͜ʖ");
	});

	it("marks /plain to skip markdown", () => {
		expect(parseSlashCommand("/plain **not bold**")).toEqual({
			text: "**not bold**",
			msgtype: "m.text",
			plain: true,
			spoiler: false,
		});
	});

	it("marks /spoiler for spoiler wrapping", () => {
		expect(parseSlashCommand("/spoiler the ending")).toEqual({
			text: "the ending",
			msgtype: "m.text",
			plain: false,
			spoiler: true,
		});
	});

	it("keeps multiline command arguments intact", () => {
		expect(parseSlashCommand("/spoiler line one\nline two").text).toBe(
			"line one\nline two",
		);
	});

	it("sends // as a literal leading slash", () => {
		expect(parseSlashCommand("//me is not a command")).toEqual({
			text: "/me is not a command",
			msgtype: "m.text",
			plain: false,
			spoiler: false,
		});
	});

	it("passes unknown commands through as literal text", () => {
		expect(parseSlashCommand("/notacommand hello").text).toBe(
			"/notacommand hello",
		);
	});

	it("passes text-consuming commands with no argument through literally", () => {
		expect(parseSlashCommand("/me").text).toBe("/me");
		expect(parseSlashCommand("/spoiler ").text).toBe("/spoiler ");
		expect(parseSlashCommand("/plain").text).toBe("/plain");
	});

	it("does not treat mid-word or pathless slashes as commands", () => {
		expect(parseSlashCommand("/ me").text).toBe("/ me");
		expect(parseSlashCommand("/2cents").text).toBe("/2cents");
	});

	it("does not resolve commands through Object.prototype", () => {
		expect(parseSlashCommand("/constructor").text).toBe("/constructor");
		expect(parseSlashCommand("/hasOwnProperty hi").text).toBe(
			"/hasOwnProperty hi",
		);
	});
});

describe("newline after the command", () => {
	it("accepts Shift+Enter between command and argument", () => {
		expect(parseSlashCommand("/me\nwaves at everyone")).toEqual({
			text: "waves at everyone",
			msgtype: "m.emote",
			plain: false,
			spoiler: false,
		});
		expect(parseSlashCommand("/spoiler\nsecret").spoiler).toBe(true);
	});
});
