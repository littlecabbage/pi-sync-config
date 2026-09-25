import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Startup resource listing ([Context]/[Skills]/…) as an unordered list.
 *
 * Compact view currently joins names with commas. This wraps
 * InteractiveMode.showLoadedResources (same host-patch style as
 * better-claude-code-ui) so collapsed rows become `- item` lines,
 * with optional descriptions from welcome-metadata.json.
 */

const PATCH_FLAG = Symbol.for("welcome-list:loaded-resources");

export const WELCOME_METADATA_FILENAME = "welcome-metadata.json";

export const WELCOME_SECTION_KEYS = [
	"context",
	"skills",
	"prompts",
	"extensions",
	"themes",
] as const;

export type WelcomeSectionKey = (typeof WELCOME_SECTION_KEYS)[number];

export type WelcomeMetadata = {
	[K in WelcomeSectionKey]?: Record<string, string>;
};

export type WelcomeMetadataStore = {
	get(section: WelcomeSectionKey, name: string): string | undefined;
	register(section: WelcomeSectionKey, names: string[]): void;
};

export type ListTransformContext = {
	section?: WelcomeSectionKey;
	store?: WelcomeMetadataStore;
};

const SECTION_BY_HEADER: Record<string, WelcomeSectionKey> = {
	Context: "context",
	Skills: "skills",
	Prompts: "prompts",
	Extensions: "extensions",
	Themes: "themes",
};

export const HIDDEN_WELCOME_SECTIONS = new Set<WelcomeSectionKey>(["themes"]);

const ANSI_RE =
	/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function wrapAnsiLine(original: string, visible: string): string {
	const lead = original.match(/^(?:\x1b\[[0-9;?]*[ -/]*[@-~])+/ )?.[0] ?? "";
	const trail = original.match(/(?:\x1b\[[0-9;?]*[ -/]*[@-~])+$/)?.[0] ?? "";
	return `${lead}${visible}${trail}`;
}

function splitNl(text: string): { nl: string; lines: string[] } {
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	return { nl, lines: text.split(/\r?\n/) };
}

export function parseSectionKey(header: string): WelcomeSectionKey | undefined {
	const match = stripAnsi(header).trim().match(/^\[(Context|Skills|Prompts|Extensions|Themes)\]$/);
	return match ? SECTION_BY_HEADER[match[1]] : undefined;
}

export function isHiddenWelcomeSectionText(text: string): boolean {
	const header = text.split(/\r?\n/, 1)[0] ?? "";
	const key = parseSectionKey(header);
	return key !== undefined && HIDDEN_WELCOME_SECTIONS.has(key);
}

function shouldHideLoadedChild(child: unknown): boolean {
	if (!child || typeof child !== "object") return false;
	const getCollapsed = (child as ExpandableChild).getCollapsedText;
	if (typeof getCollapsed !== "function") return false;
	return isHiddenWelcomeSectionText(getCollapsed.call(child));
}

function isSpacerChild(child: unknown): boolean {
	if (!child || typeof child !== "object") return false;
	if ("spacer" in child && Boolean((child as { spacer?: unknown }).spacer)) return true;
	const candidate = child as { lines?: unknown; render?: unknown };
	return typeof candidate.lines === "number" && typeof candidate.render === "function";
}

export function emptyWelcomeMetadata(): WelcomeMetadata {
	return {
		context: {},
		skills: {},
		prompts: {},
		extensions: {},
		themes: {},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeWelcomeMetadata(value: unknown): WelcomeMetadata {
	const out = emptyWelcomeMetadata();
	if (!isPlainObject(value)) return out;
	for (const key of WELCOME_SECTION_KEYS) {
		const section = value[key];
		if (!isPlainObject(section)) continue;
		const entries: Record<string, string> = {};
		for (const [name, description] of Object.entries(section)) {
			if (typeof description === "string") entries[name] = description;
		}
		out[key] = entries;
	}
	return out;
}

export function serializeWelcomeMetadata(data: WelcomeMetadata): string {
	const ordered: WelcomeMetadata = {};
	for (const key of WELCOME_SECTION_KEYS) {
		const section = data[key];
		if (section && Object.keys(section).length > 0) ordered[key] = section;
	}
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function createMemoryMetadataStore(
	initial?: WelcomeMetadata,
): WelcomeMetadataStore & { data: WelcomeMetadata } {
	const data = normalizeWelcomeMetadata(initial);
	return {
		data,
		get(section, name) {
			return data[section]?.[name];
		},
		register(section, names) {
			if (!data[section]) data[section] = {};
			for (const name of names) {
				if (!(name in data[section]!)) data[section]![name] = "";
			}
		},
	};
}

export function createFileMetadataStore(filePath: string): WelcomeMetadataStore {
	let writable = true;
	const load = (): WelcomeMetadata => {
		try {
			return normalizeWelcomeMetadata(JSON.parse(readFileSync(filePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWelcomeMetadata();
			writable = false;
			return emptyWelcomeMetadata();
		}
	};

	let data = load();

	const persist = (): void => {
		if (!writable) return;
		try {
			writeFileSync(filePath, serializeWelcomeMetadata(data));
		} catch {
			writable = false;
		}
	};

	return {
		get(section, name) {
			return data[section]?.[name];
		},
		register(section, names) {
			if (!data[section]) data[section] = {};
			let changed = false;
			for (const name of names) {
				if (!(name in data[section]!)) {
					data[section]![name] = "";
					changed = true;
				}
			}
			if (changed) persist();
		},
	};
}

function formatBullets(
	indent: string,
	items: string[],
	ctx?: ListTransformContext,
): string[] {
	const { section, store } = ctx ?? {};
	if (section && store) store.register(section, items);

	const descriptions = items.map((item) => {
		if (!section || !store) return "";
		return store.get(section, item)?.trim() ?? "";
	});
	const nameWidth = items.reduce((width, item, index) => {
		if (!descriptions[index]) return width;
		return Math.max(width, item.length);
	}, 0);

	return items.map((item, index) => {
		const description = descriptions[index];
		if (!description) return `${indent}- ${item}`;
		const pad = " ".repeat(nameWidth - item.length + 2);
		return `${indent}- ${item}${pad}${description}`;
	});
}

/** Compact body: `  a, b, c` → one `- item` per line. */
export function compactBodyToList(body: string, ctx?: ListTransformContext): string {
	const stripped = stripAnsi(body).replace(/\r?\n/g, "");
	const match = stripped.match(/^([ \t]*)(.*)$/);
	if (!match) return body;
	const indent = match[1] || "  ";
	const content = match[2];
	if (!content || content.startsWith("- ")) return body;
	const items = content.split(", ").map((item) => item.trim()).filter(Boolean);
	if (items.length === 0) return body;
	return formatBullets(indent, items, ctx)
		.map((line) => wrapAnsiLine(body, line))
		.join("\n");
}

const SCOPE_HEADERS = new Set(["user", "project", "path"]);

/** Expanded body: bullet leaf rows; keep user/project/path and npm:/git: group labels. */
export function expandedBodyToList(body: string): string {
	const { nl, lines } = splitNl(body);
	return lines
		.map((line) => {
			const stripped = stripAnsi(line);
			if (!stripped.trim()) return line;
			const match = stripped.match(/^([ \t]*)(.*)$/);
			if (!match) return line;
			const indent = match[1];
			const content = match[2];
			if (!content || content.startsWith("- ")) return line;
			if (indent.length <= 2 && SCOPE_HEADERS.has(content)) return line;
			if (/^(npm:|git:)/.test(content)) return line;
			return wrapAnsiLine(line, `${indent}- ${content}`);
		})
		.join(nl);
}

export function sectionToList(
	text: string,
	mode: "compact" | "expanded",
	ctx?: Pick<ListTransformContext, "store">,
): string {
	const { nl, lines } = splitNl(text);
	if (lines.length < 2) return text;
	const header = lines[0];
	const body = lines.slice(1).join(nl);
	const next = mode === "compact"
		? compactBodyToList(body, { section: parseSectionKey(header), store: ctx?.store })
		: expandedBodyToList(body);
	return `${header}${nl}${next}`;
}

type ExpandableChild = {
	getCollapsedText?: () => string;
	getExpandedText?: () => string;
	setExpanded?: (expanded: boolean) => void;
	setText?: (text: string) => void;
};

function patchExpandable(
	child: ExpandableChild,
	expanded: boolean,
	store?: WelcomeMetadataStore,
): void {
	if (typeof child.getCollapsedText !== "function") return;
	const origCollapsed = child.getCollapsedText.bind(child);
	const origExpanded = typeof child.getExpandedText === "function"
		? child.getExpandedText.bind(child)
		: undefined;
	child.getCollapsedText = () => sectionToList(origCollapsed(), "compact", { store });
	if (origExpanded) {
		child.getExpandedText = () => sectionToList(origExpanded(), "expanded");
	}
	if (typeof child.setExpanded === "function") {
		child.setExpanded(expanded);
		return;
	}
	if (typeof child.setText === "function") {
		const text = expanded && child.getExpandedText
			? child.getExpandedText()
			: child.getCollapsedText();
		child.setText(text);
	}
}

type HostInteractiveMode = {
	prototype?: {
		showLoadedResources?: (options?: unknown) => unknown;
		[PATCH_FLAG]?: boolean;
	};
};

export function installWelcomeListPatch(
	InteractiveMode: HostInteractiveMode,
	store?: WelcomeMetadataStore,
): boolean {
	const proto = InteractiveMode?.prototype as {
		showLoadedResources?: (options?: unknown) => unknown;
		[PATCH_FLAG]?: boolean;
	} | undefined;
	if (!proto || typeof proto.showLoadedResources !== "function" || proto[PATCH_FLAG]) {
		return false;
	}
	const original = proto.showLoadedResources;
	proto.showLoadedResources = function patchedShowLoadedResources(options?: unknown) {
		const container = (this as { loadedResourcesContainer?: { addChild: (child: unknown) => unknown } })
			.loadedResourcesContainer;
		if (!container || typeof container.addChild !== "function") {
			return original.call(this, options);
		}
		const origAdd = container.addChild;
		const expanded = typeof (this as { getStartupExpansionState?: () => boolean }).getStartupExpansionState === "function"
			? Boolean((this as { getStartupExpansionState: () => boolean }).getStartupExpansionState())
			: false;
		let skipFollowingSpacer = false;
		container.addChild = function patchedAddChild(child: unknown) {
			if (shouldHideLoadedChild(child)) {
				skipFollowingSpacer = true;
				return child;
			}
			if (skipFollowingSpacer) {
				skipFollowingSpacer = false;
				if (isSpacerChild(child)) return child;
			}
			if (child && typeof child === "object") {
				patchExpandable(child as ExpandableChild, expanded, store);
			}
			return origAdd.call(this, child);
		};
		try {
			return original.call(this, options);
		} finally {
			container.addChild = origAdd;
		}
	};
	proto[PATCH_FLAG] = true;
	return true;
}

export default async function welcomeListExtension(_pi: ExtensionAPI) {
	const { InteractiveMode, getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const store = createFileMetadataStore(join(getAgentDir(), WELCOME_METADATA_FILENAME));
	installWelcomeListPatch(InteractiveMode, store);
}
