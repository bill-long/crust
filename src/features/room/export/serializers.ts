import { escapeAttr, escapeHtml } from "../../../lib/htmlEscape";
import { sanitizeMatrixHtmlToDiv } from "../../../lib/matrixHtml";
import type { TimelineEvent } from "../timeline/timelineTypes";

/** One exported message plus where its attachment ended up (if any). */
export interface ExportRow {
	te: TimelineEvent;
	/**
	 * The plain body with the legacy reply fallback stripped (the
	 * machine-readable reply context is carried separately), empty when
	 * the event could not be decrypted.
	 */
	bodyText: string;
	/** The event exists but its content could not be decrypted. */
	undecryptable: boolean;
	/** Path inside the archive when the attachment was bundled. */
	attachmentPath: string | null;
	/** True when an attachment existed but could not be exported. */
	attachmentFailed: boolean;
}

export interface ExportBundle {
	roomId: string;
	roomName: string;
	exportedAt: Date;
	/** Human summary of the requested range ("last 100 messages", ...). */
	rangeLabel: string;
	encryptedRoom: boolean;
	messageCount: number;
	/** Rewrites an mxc:// URL to HTTP for inline custom emotes. */
	mxcToHttp: (mxcUrl: string) => string | null;
}

const UNDECRYPTABLE_TEXT = "[Unable to decrypt this message]";

function timestampIso(ms: number): string {
	return new Date(ms).toISOString();
}

function reactionSummary(te: TimelineEvent): { key: string; count: number }[] {
	return Object.entries(te.reactions).map(([key, agg]) => ({
		key,
		count: agg.count,
	}));
}

/**
 * The attachment's link target: the bundled path when it was exported.
 * An unbundled ENCRYPTED attachment gets no link at all - mediaFullUrl
 * is ciphertext, and a link named like the real file that downloads
 * AES-CTR garbage (or 401s) must never be emitted. Fail closed, same
 * rule as fetchAttachment.
 */
function attachmentHref(row: ExportRow): string | null {
	if (row.attachmentPath) return row.attachmentPath;
	if (row.te.mediaIsEncrypted) return null;
	return row.te.mediaFullUrl;
}

// ---------------------------------------------------------------- JSON

export function jsonRow(row: ExportRow): Record<string, unknown> {
	const te = row.te;
	const out: Record<string, unknown> = {
		event_id: te.eventId,
		sender: te.senderId,
		sender_name: te.senderName,
		timestamp: timestampIso(te.timestamp),
		type: te.type,
	};
	if (te.msgtype) out.msgtype = te.msgtype;
	if (te.stateNotice) {
		out.notice = te.stateNotice.text;
		return out;
	}
	if (row.undecryptable) {
		// Never record the SDK's internal placeholder string as if it were
		// the sender's message text.
		out.undecryptable = true;
		return out;
	}
	if (row.bodyText) out.body = row.bodyText;
	// The raw formatted body is source data in a data document - the
	// sanitizer applies where HTML is re-emitted into a page, not here.
	if (te.formattedBody) out.formatted_body = te.formattedBody;
	if (te.isEdited) out.edited = true;
	if (te.replyToId) out.reply_to = te.replyToId;
	const reactions = reactionSummary(te);
	if (reactions.length > 0) {
		out.reactions = Object.fromEntries(reactions.map((r) => [r.key, r.count]));
	}
	if (te.mediaFullUrl) {
		const href = attachmentHref(row);
		out.media = {
			filename: te.mediaFilename,
			mimetype: te.mediaMimetype,
			size: te.mediaSize,
			encrypted: te.mediaIsEncrypted,
			...(row.attachmentPath
				? { path: row.attachmentPath }
				: href
					? { url: href }
					: { exported: false }),
			...(row.attachmentFailed ? { export_failed: true } : {}),
		};
	}
	if (te.poll) {
		// No vote tallies: the export's poll snapshots are provisional
		// (responses are fetched asynchronously by the live view's watcher,
		// which the export deliberately doesn't run), and confidently
		// exporting zeros would misrepresent every poll.
		out.poll = {
			question: te.poll.question,
			answers: te.poll.answers.map((a) => a.text),
		};
	}
	return out;
}

export function assembleJson(
	bundle: ExportBundle,
	rows: Record<string, unknown>[],
): string {
	return JSON.stringify(
		{
			room_id: bundle.roomId,
			room_name: bundle.roomName,
			exported_at: bundle.exportedAt.toISOString(),
			range: bundle.rangeLabel,
			encrypted_room: bundle.encryptedRoom,
			message_count: rows.length,
			messages: rows,
		},
		null,
		2,
	);
}

// ---------------------------------------------------------------- text

export function textRow(row: ExportRow): string {
	const te = row.te;
	const ts = timestampIso(te.timestamp);
	const lines: string[] = [];
	if (te.stateNotice) {
		return `[${ts}] -- ${te.stateNotice.text}`;
	}
	if (row.undecryptable) {
		return `[${ts}] ${te.senderName}: ${UNDECRYPTABLE_TEXT}`;
	}
	if (te.poll) {
		lines.push(`[${ts}] ${te.senderName} started a poll: ${te.poll.question}`);
		for (const a of te.poll.answers) {
			lines.push(`    - ${a.text}`);
		}
		return lines.join("\n");
	}
	const edited = te.isEdited ? " (edited)" : "";
	if (row.bodyText) {
		// Indent continuation lines so multi-line bodies stay attached to
		// their header line.
		const body = row.bodyText.split("\n").join("\n    ");
		lines.push(`[${ts}] ${te.senderName}: ${body}${edited}`);
	}
	if (te.mediaFullUrl) {
		const name = te.mediaFilename ?? "attachment";
		const href = attachmentHref(row);
		const target = row.attachmentFailed
			? "export failed"
			: (href ?? "not exported (encrypted)");
		const header = row.bodyText ? "    " : `[${ts}] ${te.senderName}: `;
		lines.push(`${header}[attachment: ${name} -> ${target}]`);
	}
	const reactions = reactionSummary(te);
	if (reactions.length > 0) {
		lines.push(
			`    reactions: ${reactions.map((r) => `${r.key} x${r.count}`).join(", ")}`,
		);
	}
	return lines.join("\n");
}

export function assembleText(bundle: ExportBundle, rows: string[]): string {
	const header: string[] = [
		`Chat export: ${bundle.roomName} (${bundle.roomId})`,
		`Exported ${bundle.exportedAt.toISOString()} - ${bundle.rangeLabel}, ${bundle.messageCount} messages`,
	];
	if (bundle.encryptedRoom) {
		header.push(
			"This room is end-to-end encrypted; this export contains its decrypted history.",
		);
	}
	header.push("");
	return `${[...header, ...rows].join("\n")}\n`;
}

// ---------------------------------------------------------------- HTML

const HTML_STYLE = `
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 46rem; padding: 1.5rem 1rem; background: #fff; color: #1a1a1a; }
@media (prefers-color-scheme: dark) { body { background: #1e1f22; color: #dbdee1; } .msg { border-color: #3a3c41; } .meta, .notice, .reactions { color: #949ba4; } }
header { margin-bottom: 1.5rem; }
header h1 { font-size: 1.3rem; margin: 0 0 0.25rem; }
.meta, .notice, .reactions { color: #6a6f78; font-size: 0.8rem; }
.warning { border: 1px solid #b8860899; border-radius: 6px; padding: 0.5rem 0.75rem; margin: 0.75rem 0; font-size: 0.85rem; }
.msg { padding: 0.4rem 0; border-top: 1px solid #e3e5e8; }
.msg .sender { font-weight: 600; margin-right: 0.5rem; }
.msg .body { margin: 0.15rem 0 0; overflow-wrap: anywhere; }
.msg .body blockquote { border-left: 3px solid #9997; margin: 0.25rem 0; padding-left: 0.6rem; }
.msg .body pre { overflow-x: auto; background: #8881; padding: 0.5rem; border-radius: 4px; }
.msg img.attachment { max-width: 100%; max-height: 24rem; border-radius: 6px; display: block; margin-top: 0.25rem; }
img.emoji-inline { width: 1.2em; height: 1.2em; vertical-align: -0.2em; }
.reply { font-size: 0.8rem; color: #6a6f78; border-left: 2px solid #9997; padding-left: 0.5rem; margin-bottom: 0.1rem; }
.poll { border: 1px solid #9995; border-radius: 6px; padding: 0.5rem 0.75rem; margin-top: 0.25rem; }
.undecryptable { font-style: italic; }
`;

/**
 * The sanitized HTML for one message body, adapted for a static export
 * document: spoilers become native <details> (there is no script to run
 * a reveal control), links open in a new tab.
 */
function exportBodyHtml(row: ExportRow, bundle: ExportBundle): string {
	const te = row.te;
	if (!(te.format === "org.matrix.custom.html" && te.formattedBody)) {
		return escapeHtml(row.bodyText).split("\n").join("<br>");
	}
	const div = sanitizeMatrixHtmlToDiv(te.formattedBody, bundle.mxcToHttp);
	for (const img of div.querySelectorAll("img")) {
		img.classList.add("emoji-inline");
	}
	for (const a of div.querySelectorAll("a")) {
		a.setAttribute("target", "_blank");
		a.setAttribute("rel", "noopener noreferrer");
	}
	for (const el of div.querySelectorAll("[data-mx-spoiler]")) {
		const reason = el.getAttribute("data-mx-spoiler");
		const details = document.createElement("details");
		const summary = document.createElement("summary");
		summary.textContent = reason ? `Spoiler: ${reason}` : "Spoiler";
		details.appendChild(summary);
		el.replaceWith(details);
		details.appendChild(el);
		el.removeAttribute("data-mx-spoiler");
	}
	return div.innerHTML;
}

function attachmentHtml(row: ExportRow): string {
	const te = row.te;
	const name = escapeHtml(te.mediaFilename ?? "attachment");
	if (row.attachmentFailed) {
		return `<p class="meta">[attachment "${name}" could not be exported]</p>`;
	}
	const href = attachmentHref(row);
	if (!href) {
		if (te.mediaIsEncrypted) {
			return `<p class="meta">[encrypted attachment "${name}" - not exported]</p>`;
		}
		return "";
	}
	if (row.attachmentPath && te.mediaMimetype?.startsWith("image/")) {
		return `<a href="${escapeAttr(href)}"><img class="attachment" src="${escapeAttr(href)}" alt="${name}"></a>`;
	}
	return `<p><a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${name}</a></p>`;
}

export function htmlRow(row: ExportRow, bundle: ExportBundle): string {
	const te = row.te;
	const ts = timestampIso(te.timestamp);
	if (te.stateNotice) {
		return `<div class="msg notice">${escapeHtml(ts)} - ${escapeHtml(te.stateNotice.text)}</div>`;
	}
	const chunks: string[] = [
		`<div class="msg">`,
		`<div><span class="sender">${escapeHtml(te.senderName)}</span><span class="meta">${escapeHtml(ts)}${te.isEdited ? " (edited)" : ""}</span></div>`,
	];
	if (row.undecryptable) {
		chunks.push(
			`<div class="body meta undecryptable">${escapeHtml(UNDECRYPTABLE_TEXT)}</div>`,
			"</div>",
		);
		return chunks.join("\n");
	}
	if (te.replyToId && te.replyToSender) {
		chunks.push(
			`<div class="reply">↩ ${escapeHtml(te.replyToSender.name)}: ${escapeHtml(te.replyToBody ?? "")}</div>`,
		);
	}
	if (te.poll) {
		const answers = te.poll.answers
			.map((a) => `<li>${escapeHtml(a.text)}</li>`)
			.join("");
		chunks.push(
			`<div class="poll"><strong>${escapeHtml(te.poll.question)}</strong><ul>${answers}</ul></div>`,
		);
	} else if (row.bodyText || te.formattedBody) {
		chunks.push(`<div class="body">${exportBodyHtml(row, bundle)}</div>`);
	}
	if (te.mediaFullUrl) chunks.push(attachmentHtml(row));
	const reactions = reactionSummary(te);
	if (reactions.length > 0) {
		chunks.push(
			`<div class="reactions">${reactions.map((r) => `${escapeHtml(r.key)} ×${r.count}`).join("  ")}</div>`,
		);
	}
	chunks.push("</div>");
	return chunks.join("\n");
}

export function assembleHtml(bundle: ExportBundle, rows: string[]): string {
	const warning = bundle.encryptedRoom
		? `<p class="warning">This room is end-to-end encrypted; this export contains its decrypted history.</p>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(bundle.roomName)} - chat export</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<header>
<h1>${escapeHtml(bundle.roomName)}</h1>
<p class="meta">${escapeHtml(bundle.roomId)} · exported ${escapeHtml(bundle.exportedAt.toISOString())} · ${escapeHtml(bundle.rangeLabel)} · ${bundle.messageCount} messages</p>
${warning}
</header>
${rows.join("\n")}
</body>
</html>
`;
}
