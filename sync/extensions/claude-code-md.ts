import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Display-only H3–H6 → H2. H1/H2 and the stored message stay unchanged.
 * This is a heading enhancement, not a replacement Markdown renderer.
 * Only top-level ATX headings are transformed; nested container syntax is
 * deliberately left alone rather than guessing at list/blockquote parsing.
 */
export function transformMarkdown(markdown: string): string {
	// Container fences need a full block parser. Leave the document untouched
	// when an explicit container fence is detected; this is not a full parser.
	if (/^ {0,3}(?:>.*|(?:[-+*]|\d{1,9}[.)])[ \t]+.*)(?:`{3,}|~{3,})/m.test(markdown)) return markdown;
	let fence: { marker: string; length: number } | undefined;
	// Keep original line endings and whitespace, including during streaming.
	return markdown.split(/(\r\n|\n|\r)/).map((line, index) => {
		if (index % 2) return line;
		const candidate = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (candidate && candidate[1][0] === fence.marker &&
				candidate[1].length >= fence.length && /^[ \t]*$/.test(candidate[2])) {
				fence = undefined;
			}
			return line;
		}
		if (candidate && (candidate[1][0] === "~" || !candidate[2].includes("`"))) {
			fence = { marker: candidate[1][0], length: candidate[1].length };
			return line;
		}
		return line.replace(/^( {0,3})#{3,6}(?=[ \t]|$)/, "$1##");
	}).join("");
}

export default function claudeCodeMdExtension(pi: ExtensionAPI) {
	let calls = 0;
	let changes = 0;
	pi.registerMarkdownTransformer((markdown) => {
		calls++;
		const result = transformMarkdown(markdown);
		if (result !== markdown) changes++;
		return result;
	});
	// No message content is logged or persisted. Counters reset on /reload.
	pi.registerCommand("claude-md-status", {
		description: "Check heading transformer loading and render invocation counts",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`claude-code-md loaded · mode=${ctx.mode} · calls=${calls} · changes=${changes} (render calls, not messages)`, "info");
		},
	});
}
