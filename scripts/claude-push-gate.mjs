#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: Bash).
//
// Blocks `git push` tool calls unless the current HEAD has passed local code
// review. Claude pipes the tool call as JSON on stdin; exit code 2 tells Claude
// to block the call and feed stderr back to the model as the reason. Any other
// command (and `--dry-run` pushes) is allowed with exit 0.

import { reviewStatus, unreviewedMessage } from "./review-gate-lib.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
	raw += c;
});
process.stdin.on("end", () => {
	let command = "";
	try {
		command = JSON.parse(raw)?.tool_input?.command ?? "";
	} catch {
		process.exit(0); // unparseable input is not ours to judge
	}
	// Only gate real pushes. Match `git push` only at a command position (start
	// of the command, or after a shell separator / newline / subshell paren) so
	// that `git push` appearing inside quoted data - an echo, a commit message,
	// a grep pattern - does not trip the gate. Dry runs are allowed.
	const isPush =
		/(?:^|[\n;&|(])\s*git\s+push\b/.test(command) &&
		!/--dry-run\b/.test(command);
	if (!isPush) {
		process.exit(0);
	}
	let status;
	try {
		status = reviewStatus();
	} catch {
		process.exit(0); // not in a git repo / git unavailable - don't block
	}
	if (status.ok) {
		process.exit(0);
	}
	process.stderr.write(`Blocked git push.\n${unreviewedMessage(status)}`);
	process.exit(2);
});
