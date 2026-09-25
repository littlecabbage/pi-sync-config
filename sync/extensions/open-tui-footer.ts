/**
 * open-tui-footer — standalone local footer extension.
 *
 * 自包含复刻 pi-open-tui 的底栏（两行 + 扩展状态行），渲染逻辑与
 * pi-open-tui/extensions/open-tui/footer.ts 保持一致：
 *   行1: cwd · 会话名 · git 分支/状态 · 运行时 · working/done 计时  …  上下文进度条
 *   行2: 模型（provider · model · effort）  …  tokens in/out · cache 命中 · 费用
 *   行3: 扩展状态行（footerSegments.extensionStatuses）
 *
 * 配置沿用 ~/.pi/agent/open-tui.json（enabled / icons.mode / footerSegments），
 * 不改任何 node_modules；在 session_start 之后延迟一拍注册 footer，
 * 保证覆盖 better-claude-code-ui / pi-open-tui 的注册（setFooter 后写者生效）。
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// config（读取 ~/.pi/agent/open-tui.json，缺失字段回退到 open-tui 默认值）
// ---------------------------------------------------------------------------

type IconMode = "auto" | "nerd" | "ascii";

interface FooterSegments {
	cwd: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
}

interface FooterConfig {
	enabled: boolean;
	icons: { mode: IconMode };
	footerSegments: FooterSegments;
}

const DEFAULT_SEGMENTS: FooterSegments = {
	cwd: true,
	sessionName: false,
	gitBranch: true,
	gitStatus: true,
	gitCommit: false,
	runtime: true,
	context: true,
	tokens: true,
	cost: true,
	extensionStatuses: true,
};

const DEFAULT_FOOTER_CONFIG: FooterConfig = {
	enabled: true,
	icons: { mode: "auto" },
	footerSegments: { ...DEFAULT_SEGMENTS },
};

function loadFooterConfig(): FooterConfig {
	const config: FooterConfig = {
		enabled: DEFAULT_FOOTER_CONFIG.enabled,
		icons: { ...DEFAULT_FOOTER_CONFIG.icons },
		footerSegments: { ...DEFAULT_FOOTER_CONFIG.footerSegments },
	};
	try {
		const raw = JSON.parse(readFileSync(join(getAgentDir(), "open-tui.json"), "utf8")) as Record<string, unknown>;
		if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
		const icons = raw.icons as { mode?: unknown } | undefined;
		if (icons && (icons.mode === "auto" || icons.mode === "nerd" || icons.mode === "ascii")) {
			config.icons.mode = icons.mode;
		}
		const segs = raw.footerSegments as Record<string, unknown> | undefined;
		if (segs && typeof segs === "object") {
			for (const key of Object.keys(config.footerSegments) as (keyof FooterSegments)[]) {
				if (typeof segs[key] === "boolean") config.footerSegments[key] = segs[key];
			}
		}
	} catch {
		// config 缺失或解析失败时使用默认值
	}
	return config;
}

// ---------------------------------------------------------------------------
// icons（NERD/ASCII 字形与运行时符号，原样取自 pi-open-tui icons.ts）
// ---------------------------------------------------------------------------

interface IconGlyphs {
	cwd: string;
	session: string;
	git: string;
	working: string;
	done: string;
	context: string;
	model: string;
	thinking: string;
	input: string;
	output: string;
	cacheHit: string;
	cost: string;
	speed: string;
	latency: string;
	stall: string;
	extensions: string;
	ahead: string;
	behind: string;
	diverged: string;
	conflicted: string;
	stashed: string;
	modified: string;
	staged: string;
	untracked: string;
	renamed: string;
	deleted: string;
}

const NERD_GLYPHS: IconGlyphs = {
	cwd: "",
	session: "",
	git: "",
	working: "",
	done: "",
	context: "",
	model: "",
	thinking: "",
	// client network view: input = upload to API, output = download from API
	input: "",
	output: "",
	cacheHit: "",
	cost: "",
	speed: "󰓅",
	latency: "",
	stall: "",
	extensions: "",
	ahead: "↑",
	behind: "↓",
	diverged: "⇕",
	conflicted: "=",
	stashed: "$",
	modified: "!",
	staged: "+",
	untracked: "?",
	renamed: "»",
	deleted: "✘",
};

const ASCII_GLYPHS: IconGlyphs = {
	cwd: "@",
	session: "s",
	git: "*",
	working: "o",
	done: "+",
	context: "#",
	model: "M",
	thinking: "~",
	input: "↑",
	output: "↓",
	cacheHit: "c",
	cost: "$",
	speed: ">",
	latency: "~",
	stall: "!",
	extensions: "&",
	ahead: "^",
	behind: "v",
	diverged: "^v",
	conflicted: "=",
	stashed: "S",
	modified: "!",
	staged: "A",
	untracked: "?",
	renamed: "r",
	deleted: "x",
};

const NERD_FONT_TERMINALS = new Set([
	"iTerm.app",
	"Ghostty",
	"WezTerm",
	"kitty",
	"rio",
	"tabby",
	"WindowsTerminal",
	"vscode",
]);

export function detectNerdFont(): boolean {
	const termProgram = process.env.TERM_PROGRAM;
	if (termProgram && NERD_FONT_TERMINALS.has(termProgram)) return true;

	const lcTerminal = process.env.LC_TERMINAL;
	if (lcTerminal && NERD_FONT_TERMINALS.has(lcTerminal)) return true;

	if (process.env.TERM === "xterm-kitty") return true;

	if (process.env.WT_SESSION) return true;

	if (process.env.TERM_PROGRAM === "vscode") return true;

	return false;
}

function resolveIconMode(mode: IconMode): "nerd" | "ascii" {
	if (mode === "nerd") return "nerd";
	if (mode === "ascii") return "ascii";
	return detectNerdFont() ? "nerd" : "ascii";
}

function resolveGlyphs(mode: IconMode): IconGlyphs {
	return resolveIconMode(mode) === "nerd" ? NERD_GLYPHS : ASCII_GLYPHS;
}

const RUNTIME_SYMBOLS: Record<string, string> = {
	nodejs: "\uE718",
	rust: "\uE7A8",
	go: "\uE626",
	python: "\uE73C",
	ruby: "\uE739",
	java: "\uE256",
	cpp: "\uE61D",
	c: "\uE61E",
	swift: "\uE755",
	kotlin: "\uE634",
	deno: "\uE7FB",
	bun: "\uE76F",
	php: "\uE73D",
	haskell: "\uE777",
	julia: "\uE624",
	lua: "\uE620",
	elixir: "\uE62B",
	erlang: "\uE7B1",
	gleam: "\uE6B4",
	crystal: "\uE62F",
	dart: "\uE7C0",
	nim: "\uE677",
	zig: "\uE6A9",
	ocaml: "\uE67A",
	clojure: "\uE76A",
	scala: "\uE747",
	perl: "\uE769",
	r: "\uE68A",
	elm: "\uE62C",
	haxe: "\uE7B7",
	vagrant: "\uE21A",
	terraform: "\uE1A5",
};

const RUNTIME_ASCII_SYMBOLS: Record<string, string> = {
	nodejs: "node",
	rust: "rs",
	go: "go",
	python: "py",
	ruby: "rb",
	java: "java",
	swift: "swift",
	kotlin: "kt",
	cpp: "c++",
	c: "c",
	deno: "deno",
	bun: "bun",
	php: "php",
	haskell: "hs",
	julia: "jl",
	lua: "lua",
	elixir: "ex",
	erlang: "erl",
	gleam: "gleam",
	crystal: "cr",
	dart: "dart",
	nim: "nim",
	zig: "zig",
	ocaml: "ml",
	clojure: "clj",
	scala: "scala",
	perl: "pl",
	r: "R",
	elm: "elm",
	haxe: "hx",
	vagrant: "vag",
	terraform: "tf",
};

function runtimeSymbol(name: string, mode: IconMode): string {
	if (resolveIconMode(mode) === "ascii") return RUNTIME_ASCII_SYMBOLS[name] ?? name;
	return RUNTIME_SYMBOLS[name] ?? "";
}

// ---------------------------------------------------------------------------
// utils（取自 pi-open-tui utils.ts 的 footer 相关子集）
// ---------------------------------------------------------------------------

// pi-tui 处理常见 ANSI/OSC/APC 形式；这里补一个通用 CSI 清理。
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return stripTerminalSequences(text.replace(CSI_SEQUENCE, ""));
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

function basenamePath(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function truncateBranch(branch: string, maxLen: number): string {
	if (branch.length <= maxLen) return branch;
	if (maxLen <= 3) return "...".slice(0, maxLen);
	return `${branch.slice(0, maxLen - 3)}...`;
}

function truncatePath(path: string, maxLen: number): string {
	if (path.length <= maxLen) return path;
	if (maxLen <= 3) return "...".slice(0, maxLen);
	const sepChar = path.includes("/") ? "/" : "\\";
	const parts = path.split(/[\\/]/);
	if (parts.length <= 2) return path.slice(0, maxLen - 3) + "...";
	const tail: string[] = [];
	let tailLen = 0;
	for (let i = parts.length - 1; i >= 1; i--) {
		const seg = parts[i]!;
		if (tailLen + seg.length + 4 > maxLen) break;
		tail.unshift(seg);
		tailLen += seg.length + 1;
	}
	const head = parts[0]!;
	const result = `${head}${sepChar}...${sepChar}${tail.join(sepChar)}`;
	return result.length > maxLen ? result.slice(0, maxLen - 3) + "..." : result;
}

function finiteOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function formatInputBreakdown(uncached: number, cacheRead: number): string {
	const total = fmtTokens(uncached + cacheRead);
	return cacheRead > 0
		? `${total} (U ${fmtTokens(uncached)} + R ${fmtTokens(cacheRead)})`
		: total;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m ${s}s`;
}

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function alignRight(left: string, right: string, width: number, theme: Theme): string {
	const rightW = visibleWidth(right);
	if (rightW > width) {
		right = truncateToWidth(right, width, theme.fg("dim", "..."));
	}
	const leftW = visibleWidth(left);
	const rightW2 = visibleWidth(right);
	const pad = width - leftW - rightW2;
	if (pad >= 1) {
		return left + " ".repeat(pad) + right;
	}
	const availableForLeft = Math.max(0, width - rightW2 - 1);
	const truncatedLeft =
		availableForLeft > 0 ? truncateToWidth(left, availableForLeft, theme.fg("dim", "...")) : "";
	return truncatedLeft ? truncatedLeft + " " + right : right;
}

interface PrioritizedSegment {
	text: string;
	priority: number;
	compactText?: string;
	truncate?: (text: string, maxWidth: number, ellipsis: string) => string;
}

function fitSegmentsByPriority(
	segs: readonly PrioritizedSegment[],
	maxW: number,
	ellipsis = "...",
): string[] {
	const items = segs.map((s) => ({
		text: s.text,
		compactText: s.compactText,
		priority: s.priority,
		truncate: s.truncate,
		w: visibleWidth(s.text),
	}));
	const totalW = () => {
		const active = items.filter((it) => it.text !== "");
		return active.reduce((a, it) => a + it.w, 0) + Math.max(0, active.length - 1);
	};
	if (totalW() > maxW) {
		for (const item of items) {
			if (!item.compactText || visibleWidth(item.compactText) >= item.w) continue;
			item.text = item.compactText;
			item.w = visibleWidth(item.text);
			if (totalW() <= maxW) break;
		}
	}
	while (totalW() > maxW) {
		let target = -1;
		for (let i = 0; i < items.length; i++) {
			if (items[i].text !== "" && (target === -1 || items[i].priority < items[target].priority)) {
				target = i;
			}
		}
		if (target === -1) break;
		const others = items.filter((_, i) => i !== target && items[i].text !== "");
		const otherW = others.reduce((a, it) => a + it.w, 0) + Math.max(0, others.length - 1);
		const avail = maxW - otherW - (others.length > 0 ? 1 : 0);
		if (avail <= visibleWidth(ellipsis)) {
			items[target].text = "";
			items[target].w = 0;
		} else if (avail < items[target].w) {
			const truncate = items[target].truncate;
			items[target].text = truncate
				? truncate(items[target].text, avail, ellipsis)
				: truncateToWidth(items[target].text, avail, ellipsis);
			items[target].w = visibleWidth(items[target].text);
		} else {
			break;
		}
	}
	return items.filter((it) => it.text !== "").map((it) => it.text);
}

function stressColor(value: number, warn = 70, danger = 90): ThemeColor {
	if (value >= danger) return "error";
	if (value >= warn) return "warning";
	return "accent";
}

function cacheHitColor(value: number): ThemeColor {
	if (value < 30) return "error";
	if (value < 70) return "warning";
	return "success";
}

function providerColor(provider: string): ThemeColor {
	switch (provider.toLowerCase()) {
		case "anthropic":
			return "accent";
		case "openai":
		case "openai-codex":
			return "success";
		case "google":
		case "google-vertex":
			return "warning";
		case "amazon-bedrock":
			return "thinkingHigh";
		case "github-copilot":
			return "mdLink";
		case "deepseek":
			return "thinkingLow";
		case "xai":
		case "groq":
			return "error";
		default:
			return "muted";
	}
}

function effortColor(level: string | undefined): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "thinkingMedium";
	}
}

function sanitizeStatus(text: string): string {
	return stripAnsi(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// git（取自 pi-open-tui git.ts）
// ---------------------------------------------------------------------------

interface GitCommitInfo {
	oid: string | null;
	detached: boolean;
	tag: string | null;
}

interface GitStatus {
	branch: string | undefined;
	ahead: number;
	behind: number;
	modified: number;
	untracked: number;
	staged: number;
	stashed: number;
	conflicted: number;
	renamed: number;
	deleted: number;
	commit: GitCommitInfo | null;
}

function emptyGitStatus(): GitStatus {
	return {
		branch: undefined,
		ahead: 0,
		behind: 0,
		modified: 0,
		untracked: 0,
		staged: 0,
		stashed: 0,
		conflicted: 0,
		renamed: 0,
		deleted: 0,
		commit: null,
	};
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2000;

async function gitExec(args: string[], cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		return stdout;
	} catch {
		return null;
	}
}

async function readGitStatus(
	cwd: string,
	options: { readCommit?: boolean; readTag?: boolean; readCounts?: boolean } = {},
): Promise<GitStatus> {
	if (!existsSync(join(cwd, ".git"))) {
		return emptyGitStatus();
	}

	const stdout = await gitExec(
		["status", "--porcelain=v1", "--branch", "--show-stash"],
		cwd,
	);
	if (stdout === null) {
		return emptyGitStatus();
	}

	const status = emptyGitStatus();
	const lines = stdout.split("\n");

	for (const line of lines) {
		if (line.startsWith("## ")) {
			const branchPart = line.slice(3);
			const detached = branchPart.startsWith("HEAD (no branch)");
			if (detached) {
				status.branch = undefined;
				status.commit = { oid: null, detached: true, tag: null };
			} else {
				const branchMatch = branchPart.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(ahead|behind) (\d+)\])?$/);
				if (branchMatch) {
					status.branch = branchMatch[1];
					if (branchMatch[3] === "ahead") status.ahead = parseInt(branchMatch[4]!, 10);
					if (branchMatch[3] === "behind") status.behind = parseInt(branchMatch[4]!, 10);
				}
			}
			continue;
		}

		if (line.startsWith("# stash ")) {
			const stashCount = parseInt(line.slice(8).trim(), 10);
			if (!Number.isNaN(stashCount)) {
				status.stashed = stashCount;
			}
			continue;
		}

		if (options.readCounts === false) continue;
		if (line.length < 3) continue;
		const x = line[0]!;
		const y = line[1]!;

		if (x === "U" || y === "U" || (x === "C" && y === "C")) status.conflicted++;
		else if (x === "?" && y === "?") status.untracked++;
		else if (x === "R") status.renamed++;
		else if (x === "D" || y === "D") status.deleted++;
		else {
			if (x !== " " && x !== "?") status.staged++;
			if (y === "M" || y === "D") status.modified++;
		}
	}

	if (options.readCounts !== false && status.stashed === 0 && !stdout.includes("# stash")) {
		const stashOut = await gitExec(["stash", "list", "--count"], cwd);
		if (stashOut !== null) {
			const count = parseInt(stashOut.trim(), 10);
			if (!Number.isNaN(count)) status.stashed = count;
		}
	}

	if (options.readCommit && status.commit?.detached) {
		const oid = await gitExec(["rev-parse", "HEAD"], cwd);
		if (oid) {
			status.commit.oid = oid.trim();
		}
		if (options.readTag) {
			const tag = await gitExec(["describe", "--tags", "--exact-match", "HEAD"], cwd);
			if (tag) {
				status.commit.tag = tag.trim();
			}
		}
	}

	return status;
}

// ---------------------------------------------------------------------------
// runtime（取自 pi-open-tui runtime.ts）
// ---------------------------------------------------------------------------

interface RuntimeInfo {
	name: string;
	version?: string;
}

interface RuntimeDef {
	name: string;
	files: readonly string[];
	folders?: readonly string[];
	extensions?: readonly string[];
	env?: string;
	versionCommand?: { cmd: string; args?: string[]; pattern?: RegExp };
}

const RUNTIMES: readonly RuntimeDef[] = [
	{ name: "bun", files: ["bun.lock", "bun.lockb"], versionCommand: { cmd: "bun", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "nodejs", files: ["package.json", ".nvmrc", ".node-version"], versionCommand: { cmd: "node", args: ["--version"], pattern: /v(\d+\.\d+\.\d+)/ } },
	{ name: "rust", files: ["Cargo.toml"], versionCommand: { cmd: "rustc", args: ["--version"], pattern: /rustc\s+(\d+\.\d+\.\d+)/ } },
	{ name: "go", files: ["go.mod"], versionCommand: { cmd: "go", args: ["version"], pattern: /go(\d+\.\d+\.\d+)/ } },
	{ name: "python", files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", ".python-version"], versionCommand: { cmd: "python3", args: ["--version"], pattern: /Python\s+(\d+\.\d+\.\d+)/ } },
	{ name: "ruby", files: ["Gemfile", ".ruby-version"], versionCommand: { cmd: "ruby", args: ["--version"], pattern: /ruby\s+(\d+\.\d+\.\d+)/ } },
	{ name: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"], versionCommand: { cmd: "java", args: ["-version"], pattern: /version\s+"(\d+\.\d+[\.\d]*)"/ } },
	{ name: "swift", files: ["Package.swift"], versionCommand: { cmd: "swift", args: ["--version"], pattern: /Swift\s+(\d+\.\d+)/ } },
	{ name: "kotlin", files: ["build.gradle.kts", "settings.gradle.kts"] },
	{ name: "cpp", files: ["CMakeLists.txt", "Makefile"] },
	{ name: "c", files: ["Makefile", "CMakeLists.txt"] },
	{ name: "deno", files: ["deno.json", "deno.jsonc", "deno.lock"], versionCommand: { cmd: "deno", args: ["--version"], pattern: /deno\s+(\d+\.\d+\.\d+)/ } },
	{ name: "php", files: ["composer.json"], versionCommand: { cmd: "php", args: ["--version"], pattern: /PHP\s+(\d+\.\d+\.\d+)/ } },
	{ name: "haskell", files: ["stack.yaml", "cabal.project", ".cabal"], versionCommand: { cmd: "ghc", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "julia", files: ["Project.toml", "Manifest.toml"], versionCommand: { cmd: "julia", args: ["--version"], pattern: /julia\s+(\d+\.\d+\.\d+)/ } },
	{ name: "lua", files: ["stylua.toml", ".luarc.json"], versionCommand: { cmd: "lua", args: ["-v"], pattern: /Lua\s+(\d+\.\d+)/ } },
	{ name: "elixir", files: ["mix.exs"], versionCommand: { cmd: "elixir", args: ["--version"], pattern: /Elixir\s+(\d+\.\d+\.\d+)/ } },
	{ name: "erlang", files: ["rebar.config", "erlang.mk"] },
	{ name: "gleam", files: ["gleam.toml"], versionCommand: { cmd: "gleam", args: ["--version"], pattern: /gleam\s+(\d+\.\d+\.\d+)/ } },
	{ name: "crystal", files: ["shard.yml"], versionCommand: { cmd: "crystal", args: ["--version"], pattern: /Crystal\s+(\d+\.\d+\.\d+)/ } },
	{ name: "dart", files: ["pubspec.yaml"], versionCommand: { cmd: "dart", args: ["--version"], pattern: /Dart\s+SDK\s+version:\s+(\d+\.\d+\.\d+)/ } },
	{ name: "nim", files: ["nim.cfg", ".nimble"] },
	{ name: "zig", files: ["build.zig"], versionCommand: { cmd: "zig", args: ["version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ name: "ocaml", files: [".opam", "dune", "dune-project"] },
	{ name: "clojure", files: ["project.clj", "deps.edn"] },
	{ name: "scala", files: ["build.sbt", ".scala", ".metals"] },
	{ name: "perl", files: ["Makefile.PL", "cpanfile"] },
	{ name: "r", files: [".Rproj", "DESCRIPTION"] },
	{ name: "elm", files: ["elm.json"] },
	{ name: "haxe", files: ["haxelib.json", ".haxerc"] },
	{ name: "vagrant", files: ["Vagrantfile"] },
	{ name: "terraform", files: ["main.tf", "variables.tf"], folders: [".terraform"] },
	{ name: "helm", files: ["Chart.yaml", "helmfile.yaml"] },
	{ name: "solidity", files: [], extensions: [".sol"] },
	{ name: "fortran", files: ["fpm.toml"], extensions: [".f", ".f90", ".f95"] },
	{ name: "mojo", files: [], extensions: [".mojo"] },
	{ name: "red", files: [], extensions: [".red", ".reds"] },
	{ name: "raku", files: ["META6.json"], extensions: [".raku", ".rakumod"] },
	{ name: "purescript", files: ["spago.dhall", "spago.yaml"] },
	{ name: "fennel", files: [], extensions: [".fnl"] },
	{ name: "odin", files: [], extensions: [".odin"] },
	{ name: "v", files: ["v.mod", "vpkg.json"], extensions: [".v"] },
	{ name: "xmake", files: ["xmake.lua"] },
	{ name: "gradle", files: ["build.gradle", "build.gradle.kts"], folders: ["gradle"] },
	{ name: "maven", files: ["pom.xml"] },
	{ name: "cmake", files: ["CMakeLists.txt", "CMakeCache.txt"] },
	{ name: "meson", files: ["meson.build"], env: "MESON_DEVENV" },
	{ name: "nix", files: ["flake.nix", "shell.nix"], env: "IN_NIX_SHELL" },
	{ name: "guix", files: [], env: "GUIX_ENVIRONMENT" },
	{ name: "conda", files: [], env: "CONDA_DEFAULT_ENV" },
	{ name: "pixi", files: ["pixi.toml", "pixi.lock"], env: "PIXI_ENVIRONMENT_NAME" },
	{ name: "spack", files: [], env: "SPACK_ENV" },
	{ name: "pulumi", files: ["Pulumi.yaml", "Pulumi.yml"] },
	{ name: "typst", files: ["template.typ"], extensions: [".typ"] },
	{ name: "buf", files: ["buf.yaml", "buf.gen.yaml", "buf.work.yaml"] },
	{ name: "dotnet", files: [".csproj", ".fsproj", "global.json", "Directory.Build.props"] },
	{ name: "cobol", files: [], extensions: [".cbl", ".cob"] },
];

interface RuntimeCacheEntry {
	fingerprint: string;
	runtime: RuntimeInfo | null;
}

const runtimeCache = new Map<string, RuntimeCacheEntry>();
const RUNTIME_CACHE_MAX = 32;
const VERSION_TIMEOUT_MS = 2500;

function runtimeFingerprint(cwd: string, def: RuntimeDef): string {
	const parts: string[] = [];
	for (const f of def.files) {
		try {
			const stat = statSync(join(cwd, f));
			parts.push(`${f}:${stat.mtimeMs}`);
		} catch { /* ignore */ }
	}
	if (def.extensions || def.folders) {
		try {
			const entries = readdirSync(cwd);
			parts.push(...entries.slice().sort());
		} catch { /* ignore */ }
	}
	if (def.env && process.env[def.env]) {
		parts.push(`${def.env}=${process.env[def.env]}`);
	}
	return parts.join("\0");
}

function matchesDef(cwd: string, def: RuntimeDef): boolean {
	if (def.env && process.env[def.env]) return true;
	if (def.files.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.folders?.some((f) => existsSync(join(cwd, f)))) return true;
	if (def.extensions) {
		try {
			const entries = readdirSync(cwd);
			if (entries.some((e) => def.extensions!.some((ext) => e.endsWith(ext)))) return true;
		} catch { /* ignore */ }
	}
	return false;
}

async function fetchVersion(def: RuntimeDef, cwd: string): Promise<string | undefined> {
	if (!def.versionCommand) return undefined;
	try {
		const { stdout } = await execFileAsync(def.versionCommand.cmd, def.versionCommand.args ?? [], {
			cwd,
			timeout: VERSION_TIMEOUT_MS,
			maxBuffer: 64 * 1024,
		});
		if (def.versionCommand.pattern) {
			const match = stdout.match(def.versionCommand.pattern);
			return match?.[1];
		}
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function readRuntimeInfo(cwd: string): Promise<RuntimeInfo | null> {
	for (const def of RUNTIMES) {
		if (!matchesDef(cwd, def)) continue;
		const fp = runtimeFingerprint(cwd, def);
		const cacheKey = `${cwd}\0${def.name}`;
		const cached = runtimeCache.get(cacheKey);
		if (cached && cached.fingerprint === fp) {
			return cached.runtime;
		}

		for (const key of runtimeCache.keys()) {
			if (key === cacheKey || key.startsWith(`${cwd}\0`)) runtimeCache.delete(key);
		}

		const version = await fetchVersion(def, cwd);
		const info: RuntimeInfo = {
			name: def.name,
			version,
		};
		runtimeCache.set(cacheKey, { fingerprint: fp, runtime: info });
		while (runtimeCache.size > RUNTIME_CACHE_MAX) {
			const oldest = runtimeCache.keys().next().value;
			if (oldest === undefined) break;
			runtimeCache.delete(oldest);
		}
		return info;
	}
	return null;
}

// ---------------------------------------------------------------------------
// state（usage 汇总与模型元信息，取自 pi-open-tui state.ts）
// ---------------------------------------------------------------------------

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

interface UsageEntry {
	type: string;
	message?: { role: string; usage?: UsageLike };
	usage?: UsageLike;
	timestamp?: string;
}

let usageCache: { key: string; totals: UsageTotals } | undefined;

function entriesKey(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries() as unknown as UsageEntry[];
	const last = entries.at(-1);
	return `${entries.length}:${(last as { id?: string } | undefined)?.id ?? ""}:${last?.timestamp ?? ""}`;
}

function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const key = entriesKey(ctx);
	if (usageCache && usageCache.key === key) return usageCache.totals;

	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: undefined,
	};
	const entries = ctx.sessionManager.getEntries() as unknown as UsageEntry[];
	for (const entry of entries) {
		let u: UsageLike | undefined;
		let updateCacheHitRate = false;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			u = entry.message.usage;
			updateCacheHitRate = true;
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			u = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			u = entry.usage;
		}
		if (!u) continue;
		const input = finiteOrZero(u.input);
		const cacheRead = finiteOrZero(u.cacheRead);
		const cacheWrite = finiteOrZero(u.cacheWrite);
		// input 与 /session 的"未缓存"口径一致：cacheWrite 按接近全价计费，
		// 只有 cacheRead 是打折的重复内容。
		totals.input += input + cacheWrite;
		totals.output += finiteOrZero(u.output);
		totals.cacheRead += cacheRead;
		totals.cacheWrite += cacheWrite;
		totals.cost += finiteOrZero(u.cost?.total);
		if (updateCacheHitRate) {
			const promptTokens = input + cacheRead + cacheWrite;
			totals.latestCacheHitRate = promptTokens > 0
				? (cacheRead / promptTokens) * 100
				: undefined;
		}
	}
	usageCache = { key, totals };
	return totals;
}

function invalidateUsageCache(): void {
	usageCache = undefined;
}

interface FooterState {
	git: GitStatus;
	runtime: RuntimeInfo | null;
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
}

interface ModelMeta {
	provider: string;
	model: string;
	effort: string | undefined;
}

// ---------------------------------------------------------------------------
// footer 渲染（与 pi-open-tui footer.ts 逐段一致）
// ---------------------------------------------------------------------------

function renderBar(theme: Theme, pct: number, barWidth: number, ascii: boolean): string {
	const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const empty = barWidth - filled;
	const color = stressColor(pct);
	const filledCell = ascii ? "#" : "█";
	const emptyCell = ascii ? "-" : "░";
	return (
		theme.fg("dim", "[") +
		theme.fg(color, filledCell.repeat(filled)) +
		theme.fg("dim", emptyCell.repeat(empty)) +
		theme.fg("dim", "]")
	);
}

function renderContextCompact(theme: Theme, ctx: ExtensionContext, glyphs: IconGlyphs): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return "";
	const contextPct = contextUsage?.percent ?? 0;
	return `${theme.fg(stressColor(contextPct), glyphs.context)} ${theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`)}`;
}

function renderGitSegment(
	theme: Theme,
	git: GitStatus,
	glyphs: IconGlyphs,
	segments: FooterSegments,
	maxBranchLen = 20,
): string {
	const parts: string[] = [];
	if (segments.gitBranch) {
		if (git.branch) {
			parts.push(theme.fg("mdLink", glyphs.git));
			parts.push(theme.fg("mdLink", truncateBranch(git.branch, maxBranchLen)));
		} else if (git.commit?.detached) {
			parts.push(theme.fg("warning", glyphs.git));
			parts.push(theme.fg("warning", "HEAD"));
			if (git.commit.oid) {
				const shortHash = git.commit.oid.slice(0, 7);
				const tag = git.commit.tag ? ` ${git.commit.tag}` : "";
				parts.push(theme.fg("dim", `${shortHash}${tag}`));
			}
		}
	}

	if (segments.gitStatus) {
		const statusIcons: string[] = [];
		const addStatus = (count: number, glyph: string, color: ThemeColor) => {
			if (count > 0) statusIcons.push(theme.fg(color, `${glyph}${count}`));
		};
		addStatus(git.conflicted, glyphs.conflicted, "error");
		addStatus(git.deleted, glyphs.deleted, "error");
		addStatus(git.modified, glyphs.modified, "warning");
		addStatus(git.renamed, glyphs.renamed, "warning");
		addStatus(git.staged, glyphs.staged, "success");
		addStatus(git.untracked, glyphs.untracked, "muted");
		addStatus(git.stashed, glyphs.stashed, "muted");

		if (git.ahead > 0 && git.behind > 0) {
			statusIcons.push(theme.fg("warning", `${glyphs.diverged}${git.ahead}/${git.behind}`));
		} else if (git.ahead > 0) {
			statusIcons.push(theme.fg("success", `${glyphs.ahead}${git.ahead}`));
		} else if (git.behind > 0) {
			statusIcons.push(theme.fg("warning", `${glyphs.behind}${git.behind}`));
		}

		const statusBlock = statusIcons.join(" ");
		if (statusBlock) {
			parts.push(`${theme.fg("dim", "[")}${statusBlock}${theme.fg("dim", "]")}`);
		}
	}

	return parts.join(" ");
}

function renderRuntimeSegment(
	theme: Theme,
	runtime: RuntimeInfo | null,
	iconMode: IconMode,
): string {
	if (!runtime) return "";
	const symbol = theme.fg("success", runtimeSymbol(runtime.name, iconMode));
	const version = runtime.version ? theme.fg("muted", runtime.version) : "";
	const label = [symbol, version].filter(Boolean).join(" ");
	return label;
}

function renderTimerSegment(theme: Theme, state: FooterState, glyphs: IconGlyphs): string {
	if (state.workingSince !== undefined) {
		return `${theme.fg("accent", glyphs.working)} ${theme.fg("dim", "working")} ${theme.fg("accent", formatDuration(Date.now() - state.workingSince))}`;
	}
	if (state.lastDoneIn !== undefined) {
		return `${theme.fg("success", glyphs.done)} ${theme.fg("success", "done")} ${theme.fg("text", formatDuration(state.lastDoneIn))}`;
	}
	return "";
}

function renderContextBar(
	theme: Theme,
	ctx: ExtensionContext,
	width: number,
	glyphs: IconGlyphs,
	iconMode: IconMode,
): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextTokens = contextUsage?.tokens ?? 0;
	const contextPct = contextUsage?.percent ?? 0;

	if (contextWindow <= 0) return "";

	const pctText = theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`);
	const ctxText = `${theme.fg("text", fmtTokens(contextTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(contextWindow))}`;
	const contextIcon = theme.fg(stressColor(contextPct), glyphs.context);
	const reserved = visibleWidth(contextIcon) + visibleWidth(pctText) + visibleWidth(ctxText) + 5 + 2;
	const barWidth = Math.max(4, Math.min(12, width - reserved));
	return `${contextIcon} ${renderBar(theme, contextPct, barWidth, resolveIconMode(iconMode) === "ascii")} ${pctText} ${theme.fg("dim", "·")} ${ctxText}`;
}

function renderStatsBlock(
	theme: Theme,
	totals: UsageTotals,
	glyphs: IconGlyphs,
	segments: FooterSegments,
): string {
	const stats: string[] = [];
	if (segments.tokens) {
		stats.push(theme.fg("accent", `${glyphs.input} ${formatInputBreakdown(totals.input, totals.cacheRead)}`));
		stats.push(theme.fg("success", `${glyphs.output} ${fmtTokens(totals.output)}`));
		const hasCacheTokens = totals.cacheRead > 0 || totals.cacheWrite > 0;
		if (hasCacheTokens && totals.latestCacheHitRate !== undefined) {
			stats.push(theme.fg(cacheHitColor(totals.latestCacheHitRate), `${glyphs.cacheHit} ${totals.latestCacheHitRate.toFixed(1)}%`));
		}
	}
	if (segments.cost) {
		stats.push(theme.fg("warning", `${glyphs.cost} $${totals.cost.toFixed(3)}`));
	}

	return stats.join(` ${theme.fg("dim", "|")} `);
}

function renderExtensionStatusLines(
	theme: Theme,
	extensionStatuses: ReadonlyMap<string, string>,
	glyphs: IconGlyphs,
	width: number,
): string[] {
	const statuses = Array.from(extensionStatuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatus(text))
		.filter((text) => text.length > 0);
	if (statuses.length === 0) return [];

	const separator = ` ${theme.fg("dim", "|")} `;
	const statusText = statuses.map((status) => theme.fg("muted", status)).join(separator);
	const line = `${theme.fg("mdLink", glyphs.extensions)} ${statusText}`;
	return wrapTextWithAnsi(line, width);
}

interface FooterHooks {
	setRequestRender: (fn: (() => void) | undefined) => void;
	scheduleGitRefresh: () => void;
}

function installFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getConfig: () => FooterConfig,
	getModelMeta: () => ModelMeta,
	hooks: FooterHooks,
): { cleanup: () => void; factory: (tui: any, theme: any, footerData: any) => unknown } {
	const footerFactory = (tui: any, theme: any, footerData: any) => {
		hooks.setRequestRender(() => tui.requestRender());
		const unsubBranch = footerData.onBranchChange(() => {
			hooks.scheduleGitRefresh();
			tui.requestRender();
		});

		return {
			dispose() {
				unsubBranch();
				hooks.setRequestRender(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				dbgLog(`render called w=${width}`);
				const state = getState();
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				const segments = config.footerSegments;
				const meta = getModelMeta();

				const totals = getUsageTotals(ctx);

				const leftParts: PrioritizedSegment[] = [];
				if (segments.cwd) {
					const maxCwd = Math.min(30, Math.max(10, Math.floor(width * 0.4)));
					const cwd = formatCwd(ctx.sessionManager.getCwd());
					const cwdPrefix = `${theme.fg("mdLink", glyphs.cwd)} `;
					const accent = (text: string) => theme.fg("accent", text);
					leftParts.push({
						text: `${cwdPrefix}${accent(truncatePath(cwd, maxCwd))}`,
						compactText: `${cwdPrefix}${accent(truncatePath(basenamePath(cwd), maxCwd))}`,
						priority: 0,
						truncate: (_text, maxWidth, ellipsis) => {
							const pathWidth = maxWidth - visibleWidth(cwdPrefix);
							if (pathWidth <= visibleWidth(ellipsis)) {
								return truncateToWidth(`${cwdPrefix}${accent(basenamePath(cwd))}`, maxWidth, ellipsis);
							}
							return `${cwdPrefix}${accent(truncatePath(basenamePath(cwd), pathWidth))}`;
						},
					});
				}
				if (segments.sessionName) {
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						leftParts.push({
							text: `${theme.fg("dim", glyphs.session)} ${theme.fg("text", truncateToWidth(sessionName, 24, theme.fg("dim", "...")))}`,
							priority: 2,
						});
					}
				}
				const gitSeg = renderGitSegment(theme, state.git, glyphs, segments);
				if (gitSeg) leftParts.push({ text: gitSeg, priority: 3 });
				if (segments.runtime) {
					const runtimeSeg = renderRuntimeSegment(theme, state.runtime, config.icons.mode);
					if (runtimeSeg) leftParts.push({ text: runtimeSeg, priority: 4 });
				}
				const timerSeg = renderTimerSegment(theme, state, glyphs);
				if (timerSeg) leftParts.push({ text: timerSeg, priority: 1 });

				let contextText = "";
				let contextCompact: string | undefined;
				if (segments.context) {
					contextText = renderContextBar(theme, ctx, width, glyphs, config.icons.mode);
					const compact = renderContextCompact(theme, ctx, glyphs);
					if (compact && visibleWidth(compact) < visibleWidth(contextText)) {
						contextCompact = compact;
					}
				}
				const allParts: PrioritizedSegment[] = [...leftParts];
				if (contextText) {
					allParts.push({ text: contextText, compactText: contextCompact, priority: 4 });
				}

				const fitted = fitSegmentsByPriority(allParts, width, theme.fg("dim", "..."));
				const fittedContext = contextText ? fitted.pop() ?? "" : "";
				const line1 = alignRight(fitted.join(" "), fittedContext, width, theme);

				const modelParts: string[] = [];
				modelParts.push(theme.fg("mdLink", glyphs.model));
				if (meta.provider && meta.provider !== "Unknown") {
					modelParts.push(theme.fg(providerColor(ctx.model?.provider ?? "none"), meta.provider));
				}
				modelParts.push(theme.fg("text", meta.model));
				if (meta.effort && meta.effort !== "off") {
					modelParts.push(theme.fg(effortColor(meta.effort), `${glyphs.thinking} ${meta.effort}`));
				}
				const modelBlock = modelParts.join(theme.fg("dim", " · "));

				const statsBlock = renderStatsBlock(theme, totals, glyphs, segments);

				const line2 = alignRight(modelBlock, statsBlock, width, theme);

				const mainLines = [line1, line2]
					.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
				return segments.extensionStatuses
					? [
						...mainLines,
						...renderExtensionStatusLines(
							theme,
							footerData.getExtensionStatuses(),
							glyphs,
							width,
						),
					]
					: mainLines;
			},
		};
	};
	ctx.ui.setFooter(footerFactory);
	return {
		cleanup: () => {
			ctx.ui.setFooter(undefined);
		},
		factory: footerFactory,
	};
}

// ---------------------------------------------------------------------------
// 扩展接线（事件与生命周期，取自 pi-open-tui index.ts 的 footer 相关部分）
// ---------------------------------------------------------------------------

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

function dbgLog(msg: string): void {
	try {
		appendFileSync("/tmp/otf-debug.log", `${new Date().toISOString()} ${msg}\n`);
	} catch { /* ignore */ }
}

try {
	dbgLog("module loaded");
} catch { /* ignore */ }

export default function (pi: ExtensionAPI) {
	let generation = 0;
	let dead = false;
	const isCurrent = (gen?: number): boolean => !dead && (gen === undefined || gen === generation);

	const state: FooterState = {
		git: emptyGitStatus(),
		runtime: null,
		workingSince: undefined,
		lastDoneIn: undefined,
	};

	let config: FooterConfig = loadFooterConfig();
	let installed = false;
	let installTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanupFooter: (() => void) | undefined;
	let footerFactoryRef: ((tui: any, theme: any, footerData: any) => unknown) | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;

	const getThinkingLevel = (): string => (isCurrent() ? pi.getThinkingLevel() : "off");
	const getModelMeta = (): ModelMeta => {
		const provider = formatProviderLabel(ctxModelProvider());
		const model = ctxModel()?.name ?? ctxModel()?.id ?? "no-model";
		const reasoning = ctxModel()?.reasoning ?? false;
		const effort = reasoning ? getThinkingLevel() : undefined;
		return { provider, model, effort };
	};

	// session_start 之后才会赋值
	let currentCtx: ExtensionContext | undefined;
	const ctxModel = () => currentCtx?.model;
	const ctxModelProvider = () => currentCtx?.model?.provider;

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!isCurrent()) return;
		const gen = generation;
		const segs = config.footerSegments;
		if (!segs.gitBranch && !segs.gitStatus && !segs.gitCommit) {
			state.git = emptyGitStatus();
			requestFooterRender?.();
			return;
		}
		const git = await readGitStatus(ctx.cwd, {
			readCommit: true,
			readTag: segs.gitCommit,
			readCounts: segs.gitStatus,
		});
		if (!isCurrent(gen)) return;
		state.git = git;
		requestFooterRender?.();
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!isCurrent()) return;
		const gen = generation;
		const runtime = await readRuntimeInfo(ctx.cwd);
		if (!isCurrent(gen)) return;
		state.runtime = runtime;
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (!isCurrent() || !installed) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	function stopWorkingTimer() {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	}

	const uninstallUi = (ctx: ExtensionContext) => {
		dbgLog("uninstallUi called");
		if (installTimer) {
			clearTimeout(installTimer);
			installTimer = undefined;
		}
		if (installed) {
			cleanupFooter?.();
			cleanupFooter = undefined;
			footerFactoryRef = undefined;
			requestFooterRender = undefined;
			installed = false;
		}
		void ctx;
	};

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (installed || installTimer) return;
		// 延迟一拍注册：让本扩展在所有 session_start 处理器（含
		// better-claude-code-ui / pi-open-tui 的 setFooter）之后写入，
		// setFooter 后写者生效，因此本 footer 必然胜出。
		installTimer = setTimeout(() => {
			installTimer = undefined;
			dbgLog("install timer fired");
			if (!isCurrent() || installed) return;
			currentCtx = ctx;
			const installedFooter = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
					scheduleGitRefresh: () => {
						void scheduleGitRefresh(ctx);
					},
				},
			);
			cleanupFooter = installedFooter.cleanup;
			footerFactoryRef = installedFooter.factory;
			installed = true;
			dbgLog("footer INSTALLED");
			requestFooterRender?.();
			// TODO(temp): 诊断自愈——30s 内每 2s 重注册，验证是否被其它扩展覆盖
			let reasserts = 0;
			const reassertTimer = setInterval(() => {
				reasserts++;
				if (!isCurrent() || !installed || reasserts > 15) {
					clearInterval(reassertTimer);
					return;
				}
				dbgLog(`re-assert #${reasserts}`);
				ctx.ui.setFooter((t, th, fd) => {
					dbgLog(`re-assert factory ran #${reasserts}`);
					return footerFactoryRef?.(t, th, fd);
				});
			}, 2000);
			reassertTimer.unref?.();
		}, 0);
	};

	pi.on("session_start", async (_event, ctx) => {
		dbgLog(`session_start mode=${(ctx as ExtensionContext & { mode?: string }).mode} hasUI=${ctx.hasUI}`);
		generation++;
		dead = false;
		currentCtx = ctx;
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		stopWorkingTimer();
		invalidateUsageCache();

		config = loadFooterConfig();

		applyUi(ctx);

		void scheduleGitRefresh(ctx);
		void refreshRuntime(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		dbgLog("session_shutdown");
		dead = true;
		stopWorkingTimer();
		uninstallUi(ctx);
		currentCtx = undefined;
	});

	pi.on("agent_start", async () => {
		if (!isCurrent()) return;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", async () => {
		if (!isCurrent()) return;
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("message_end", async (_event, ctx) => {
		if (!isCurrent() || !isTuiContext(ctx)) return;
		invalidateUsageCache();
		requestFooterRender?.();
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (!isCurrent() || !isTuiContext(ctx)) return;
		requestFooterRender?.();
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!isCurrent() || !isTuiContext(ctx)) return;
		invalidateUsageCache();
		requestFooterRender?.();
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!isCurrent() || !isTuiContext(ctx)) return;
		invalidateUsageCache();
		requestFooterRender?.();
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!isCurrent() || !isTuiContext(ctx)) return;
		requestFooterRender?.();
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (!isCurrent() || !isTuiContext(ctx)) return;
		requestFooterRender?.();
	});
}
