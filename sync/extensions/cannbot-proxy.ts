import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CannbotError as DiagnosticError, PLUGIN_API_KEY, applySyncPlan, buildSyncPlan, callbackTokens,
	configModels, readConfigSnapshot, readPiVk, readSecretJson, runOAuthLogin, savePiVk,
	serializeFileMutation, writeJsonAtomic,
} from "./cannbot-support/core.ts";
import type { ConfigSnapshot, OAuthTokens, SyncPlan } from "./cannbot-support/core.ts";
import { createCannbotMenu } from "./cannbot-support/menu.ts";

/** Upstream OpenAI-compatible gateway. Pi talks to this directly. */
export const UPSTREAM_GATEWAY = "https://cannbot.hicann.cn/gateway/compatible-mode/v1";
const UPSTREAM_API = "https://cannbot.hicann.cn/cannbot/api";
const LEGACY_BASE_URL = "http://127.0.0.1:8088/v1";
const SESSION_PATH = join(homedir(), ".cannbot", "session.json");
const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const EXPIRY_SKEW_MS = 60_000;

export interface CannbotCredentials {
	jwt?: string;
	vk?: string;
	sessionId?: string;
}

interface SessionFile {
	accessToken?: string;
	refreshToken?: string;
	expiresIn?: number;
	updatedAt?: number;
	sessionId?: string;
	[key: string]: unknown;
}

let loadQueue: Promise<CannbotCredentials> = Promise.resolve({});
let lastWarning: string | undefined;

function normalizeBaseUrl(url: string | undefined): string {
	return (url ?? "").replace(/\/+$/, "");
}

export function jwtExpired(jwt: string, now = Date.now()): boolean {
	try {
		const part = jwt.split(".")[1];
		if (!part) return true;
		const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
		const exp = payload.exp ?? 0;
		return now >= exp * 1000 - EXPIRY_SKEW_MS;
	} catch {
		return true;
	}
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const data = JSON.parse(await readFile(path, "utf8")) as unknown;
		return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export async function saveOAuthTokens(tokens: OAuthTokens, signal?: AbortSignal): Promise<void> {
	if (jwtExpired(tokens.accessToken)) throw new DiagnosticError("收到的 JWT 无效或已过期，未保存凭证");
	await serializeFileMutation(SESSION_PATH, async () => {
		signal?.throwIfAborted();
		const current = await readSecretJson(SESSION_PATH);
		await writeJsonAtomic(SESSION_PATH, {
			...current, ...tokens, updatedAt: Math.floor(Date.now() / 1000),
		}, async () => { signal?.throwIfAborted(); });
	});
}

async function refreshJwt(refreshToken: string, signal?: AbortSignal, strictRenewal = false): Promise<SessionFile | undefined> {
	const response = await fetch(`${UPSTREAM_API}/oauth/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken, ideType: "vscode" }),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		if (strictRenewal && response.status !== 401) throw new DiagnosticError(httpFailure(response.status), response.status);
		return undefined;
	}
	const fresh = (await response.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
	if (!fresh.accessToken || jwtExpired(fresh.accessToken)) {
		if (strictRenewal) throw new DiagnosticError("续期响应未提供有效授权；请稍后重试或从账号与设置手动授权");
		return undefined;
	}
	return serializeFileMutation(SESSION_PATH, async () => {
		signal?.throwIfAborted();
		const current = await readSecretJson(SESSION_PATH) as SessionFile;
		// A login completed while refresh was in flight: do not overwrite its credentials.
		if (current.refreshToken !== refreshToken) return current;
		const next: SessionFile = {
			...current, accessToken: fresh.accessToken,
			refreshToken: fresh.refreshToken || current.refreshToken || "",
			expiresIn: fresh.expiresIn ?? current.expiresIn ?? 3600,
			updatedAt: Math.floor(Date.now() / 1000),
		};
		await writeJsonAtomic(SESSION_PATH, next, async () => { signal?.throwIfAborted(); });
		return next;
	});
}

/** Load JWT + VK. Refreshes an expired JWT once, serialized across concurrent requests. */
export function loadCredentials(signal?: AbortSignal, strictRenewal = false): Promise<CannbotCredentials> {
	const run = loadQueue.then(() => loadCredentialsUnlocked(true, signal, strictRenewal), () => loadCredentialsUnlocked(true, signal, strictRenewal));
	loadQueue = run.then(
		() => ({}),
		() => ({}),
	);
	return run;
}

/** Diagnostics must not refresh tokens or write session files. */
export function inspectCredentials(): Promise<CannbotCredentials> {
	return loadCredentialsUnlocked(false);
}

async function loadCredentialsUnlocked(allowRefresh = true, signal?: AbortSignal, strictRenewal = false): Promise<CannbotCredentials> {
	signal?.throwIfAborted();
	const creds: CannbotCredentials = {};
	const session = (await readJson(SESSION_PATH)) as SessionFile | undefined;
	const token = typeof session?.accessToken === "string" ? session.accessToken : undefined;
	const refreshToken = typeof session?.refreshToken === "string" ? session.refreshToken : undefined;

	if (token && !jwtExpired(token)) {
		creds.jwt = token;
	} else if (refreshToken && allowRefresh) {
		try {
			const refreshed = await refreshJwt(refreshToken, signal, strictRenewal);
			if (refreshed?.accessToken && !jwtExpired(refreshed.accessToken)) creds.jwt = refreshed.accessToken;
		} catch (error) {
			if (strictRenewal) throw error;
			// Background refresh still returns VK; guided setup must not suggest login for network failures.
		}
	}

	signal?.throwIfAborted();
	if (typeof session?.sessionId === "string" && session.sessionId) creds.sessionId = session.sessionId;

	const piVk = await readPiVk();
	if (piVk) {
		creds.vk = piVk;
		return creds;
	}
	const auth = await readJson(AUTH_PATH);
	const cannbot = auth?.cannbot;
	if (cannbot && typeof cannbot === "object" && typeof (cannbot as { key?: unknown }).key === "string") {
		creds.vk = (cannbot as { key: string }).key;
	}
	return creds;
}

export function parseCallbackUrl(callbackUrl: string): OAuthTokens | undefined {
	return callbackTokens(callbackUrl);
}

export async function saveCallbackUrl(callbackUrl: string): Promise<boolean> {
	const parsed = parseCallbackUrl(callbackUrl);
	if (!parsed || jwtExpired(parsed.accessToken)) return false;
	await saveOAuthTokens(parsed);
	return true;
}

function clearAuthorization(headers: Record<string, string | null>): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === "authorization") headers[key] = null;
	}
}

function openBrowser(url: string): Promise<boolean> {
	return new Promise(resolve => {
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			child.once("error", () => resolve(false));
			child.once("spawn", () => { child.unref(); resolve(true); });
		} catch { resolve(false); }
	});
}

function warnOnce(ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, message: string): void {
	if (!ctx.hasUI || lastWarning === message) return;
	lastWarning = message;
	ctx.ui.notify(message, "error");
}

export interface CannbotModel {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

interface LocalConfig {
	baseUrl?: string;
	api?: string;
	models: (CannbotModel & { baseUrl?: string; api?: string })[];
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function displayId(id: string): string {
	return id.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160);
}

export function httpFailure(status: number): string {
	const reason = status === 401 ? "认证失败，请检查 JWT/VK 或运行 /cannbot-login"
		: status === 403 ? "权限不足，请检查账号和模型授权"
		: status === 404 ? "模型或接口不存在，请检查模型 ID 和路由"
		: status === 429 ? "限流或额度不足，请稍后重试并检查额度"
		: status >= 500 ? "上游服务异常，请稍后重试"
		: "请求被拒绝，请检查 API 类型、参数和模型配置";
	return `HTTP ${status}：${reason}`;
}

function diagnosticError(error: unknown): string {
	// Do not echo server bodies, fetch errors, or credentials to notifications.
	if (error instanceof DiagnosticError) return error.message;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return "请求超时或已取消";
	}
	return "网络/TLS/代理错误或响应无法解析；请检查网络与网关";
}

function credentialHeaders(creds: CannbotCredentials): Record<string, string> {
	if (!creds.jwt && !creds.vk) throw new DiagnosticError("JWT 和 VK 均不可用；运行 /cannbot-login 或 /cannbot-vk。只读检查不会自动续期");
	const headers: Record<string, string> = {};
	if (creds.jwt) headers.Authorization = `Bearer ${creds.jwt}`;
	if (creds.vk) headers["x-api-vkey"] = creds.vk;
	if (creds.sessionId) headers["X-Session-ID"] = creds.sessionId;
	return headers;
}

/** Native catalog endpoint; the compatible gateway does not expose /models. */
export async function fetchCannbotModels(creds: CannbotCredentials, callerSignal?: AbortSignal): Promise<CannbotModel[]> {
	const headers = credentialHeaders(creds);
	const models = new Map<string, CannbotModel>();
	const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
	signal.throwIfAborted();
	let expectedTotal: number | undefined;
	let expectedPages: number | undefined;
	let received = 0;
	for (let page = 1; page <= 20; page++) {
		const response = await fetch(`${UPSTREAM_API}/models/list?page=${page}&size=100`, {
			headers, signal, redirect: "error",
		});
		if (!response.ok) throw new DiagnosticError(httpFailure(response.status), response.status);
		const data = await response.json() as { models?: unknown; totalPages?: unknown; total?: unknown };
		signal.throwIfAborted();
		if (!data || !Array.isArray(data.models)) throw new DiagnosticError("模型列表响应格式异常，无法可靠对比");
		const totalPages = positiveInteger(data.totalPages) ?? (data.totalPages === 0 && data.models.length === 0 ? 1 : undefined);
		if (!totalPages || totalPages > 20 || page > totalPages) {
			throw new DiagnosticError("模型列表分页信息异常或超过 20 页，停止对比以免误报删除");
		}
		if (data.models.length === 0 && !(page === 1 && totalPages === 1 && data.total === 0)) {
			throw new DiagnosticError("模型列表出现意外空页，停止对比以免误报删除");
		}
		if (typeof data.total !== "number" || !Number.isSafeInteger(data.total) || data.total < 0 ||
			(expectedTotal !== undefined && expectedTotal !== data.total) ||
			(expectedPages !== undefined && expectedPages !== totalPages)) {
			throw new DiagnosticError("模型列表总数或分页在读取期间变化，请重试");
		}
		expectedTotal = data.total;
		expectedPages = totalPages;
		received += data.models.length;
		for (const item of data.models) {
			if (!item || typeof item !== "object" || typeof item.model !== "string" || !item.model || typeof item.status !== "number") {
				throw new DiagnosticError("模型条目格式异常，无法可靠对比");
			}
			if (item.status !== 1) continue;
			models.set(item.model, {
				id: item.model,
				contextWindow: positiveInteger(item.contextLength),
				maxTokens: positiveInteger(item.maxTokens),
			});
		}
		if (page === totalPages) {
			// The live API's total includes entries absent from the returned catalog (13 vs 7).
			// Follow totalPages; do not assume total equals the account-visible entry count.
			if (received > expectedTotal!) throw new DiagnosticError("模型列表条目超过总数，停止对比");
			return [...models.values()];
		}
	}
	throw new DiagnosticError("模型列表不完整，停止对比");
}

async function readLocalConfig(): Promise<LocalConfig> {
	const { config } = await readConfigSnapshot();
	const provider = (config.providers as Record<string, Record<string, unknown>>).cannbot;
	const models = configModels(config).map(item => ({
		id: item.id as string, contextWindow: positiveInteger(item.contextWindow), maxTokens: positiveInteger(item.maxTokens),
		baseUrl: typeof item.baseUrl === "string" ? item.baseUrl : undefined,
		api: typeof item.api === "string" ? item.api : undefined,
	}));
	return {
		baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
		api: typeof provider.api === "string" ? provider.api : undefined, models,
	};
}

export function previewModelChanges(local: CannbotModel[], upstream: CannbotModel[]): string[] {
	const localById = new Map(local.map(model => [model.id, model]));
	const upstreamById = new Map(upstream.map(model => [model.id, model]));
	const changes: string[] = [];
	for (const model of upstream) {
		const current = localById.get(model.id);
		if (!current) {
			changes.push(`新增：${displayId(model.id)}（contextWindow=${model.contextWindow ?? "未知"}，maxTokens=${model.maxTokens ?? "未知"}）`);
			continue;
		}
		for (const field of ["contextWindow", "maxTokens"] as const) {
			if (model[field] !== undefined && current[field] !== model[field]) {
				changes.push(`变更：${displayId(model.id)} ${field}：${current[field] ?? "未显式配置"} → ${model[field]}`);
			}
		}
	}
	for (const model of local) {
		if (!upstreamById.has(model.id)) changes.push(`上游未启用或未列出：${displayId(model.id)}（不自动删除）`);
	}
	return changes;
}

/** Explicit opt-in only: no transcript, no tools, and no arbitrary endpoint. */
export async function probeCannbotModel(modelId: string, creds: CannbotCredentials, callerSignal?: AbortSignal): Promise<void> {
	callerSignal?.throwIfAborted();
	const response = await fetch(`${UPSTREAM_GATEWAY}/chat/completions`, {
		method: "POST",
		headers: { ...credentialHeaders(creds), "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "Reply with OK only." }],
			max_tokens: 16,
			stream: false,
		}),
		signal: callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		redirect: "error",
	});
	if (!response.ok) throw new DiagnosticError(httpFailure(response.status), response.status);
	const data = await response.json() as { choices?: { message?: { role?: string; content?: unknown; reasoning_content?: unknown } }[] };
	callerSignal?.throwIfAborted();
	if (!data || !Array.isArray(data.choices) || !data.choices.length || data.choices[0]?.message?.role !== "assistant") {
		throw new DiagnosticError("接口返回 HTTP 200，但不是有效的 Chat Completions 响应");
	}
	const message = data.choices[0].message!;
	if (![message.content, message.reasoning_content].some(value => typeof value === "string" && value.trim())) {
		throw new DiagnosticError("接口响应未返回文本或推理内容，短测试未确认成功（可能输出限制过小）");
	}
}

export default function (pi: ExtensionAPI) {
	let loginController: AbortController | undefined;
	let loginStatus = "未开始";
	let menuController: AbortController | undefined;
	const legacyCommands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	function registerLegacyCommand(name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) {
		legacyCommands.set(name, definition);
		pi.registerCommand(name, definition);
	}
	pi.on("session_shutdown", () => { loginController?.abort(); menuController?.abort(); });
	pi.registerProvider("cannbot", {
		baseUrl: UPSTREAM_GATEWAY,
		apiKey: PLUGIN_API_KEY,
		authHeader: false,
	});

	pi.on("before_provider_headers", async (event, ctx) => {
		if (ctx.model?.provider !== "cannbot") return;
		const baseUrl = normalizeBaseUrl(ctx.model.baseUrl);
		if (baseUrl !== UPSTREAM_GATEWAY && baseUrl !== LEGACY_BASE_URL) return;

		let creds: CannbotCredentials;
		try {
			creds = await loadCredentials();
		} catch {
			warnOnce(ctx, "CANNBot 凭证读取失败。检查 ~/.cannbot/session.json 后重试，或运行 /cannbot-login");
			return;
		}

		clearAuthorization(event.headers);
		if (creds.jwt) {
			event.headers.Authorization = `Bearer ${creds.jwt}`;
			lastWarning = undefined;
		}
		if (creds.vk) event.headers["x-api-vkey"] = creds.vk;
		if (creds.sessionId) event.headers["X-Session-ID"] = creds.sessionId;
		if (!creds.jwt) {
			warnOnce(
				ctx,
				creds.vk
					? "CANNBot JWT 无效且续期失败，将尝试 VK。运行 /cannbot-login 重新授权"
					: "CANNBot 未登录。运行 /cannbot-login 授权，并通过 /cannbot-vk 设置 VK",
			);
		}
	});

	registerLegacyCommand("cannbot-models", {
		description: "预览上游模型变化；sync 经确认备份并更新配置，不自动删除模型",
		handler: async (args, ctx) => {
			const sync = args.trim() === "sync";
			if (args.trim() && !sync) {
				ctx.ui.notify("用法：/cannbot-models 预览；/cannbot-models sync 确认后备份更新", "warning");
				return;
			}
			if (sync && !ctx.hasUI) {
				ctx.ui.notify("配置更新需要交互确认；未修改配置", "warning");
				return;
			}
			try {
				if (sync) await ctx.waitForIdle();
				const snapshot = await readConfigSnapshot(true);
				const local = configModels(snapshot.config, true).map(model => ({
					id: model.id as string, contextWindow: positiveInteger(model.contextWindow), maxTokens: positiveInteger(model.maxTokens),
				}));
				const upstream = await fetchCannbotModels(await inspectCredentials());
				if (!sync) {
					const changes = previewModelChanges(local, upstream);
					ctx.ui.notify([
						`CANNBot 本地 ${local.length} 个，上游启用 ${upstream.length} 个。`,
						...(changes.length ? changes : ["模型 ID、显式上下文/输出限制无变化。"]),
						"仅预览，未修改配置。运行 /cannbot-models sync 查看可写入变更并确认。价格、图像能力和 reasoning 未比较。",
					].join("\n"), changes.length ? "warning" : "info");
					return;
				}
				const plan = buildSyncPlan(snapshot.config, upstream, UPSTREAM_GATEWAY);
				ctx.ui.notify([...plan.changes, ...plan.notes, "保留自定义字段；不自动删除模型。新增模型的价格、图像能力和 reasoning 未知，使用 Pi 默认值不代表实际费用或能力。"].join("\n"), "info");
				if (!plan.changes.length) {
					ctx.ui.notify("没有可写入的变化，未修改配置", "info");
					return;
				}
				if (!await ctx.ui.confirm("更新 CANNBot 模型配置？", `${plan.changes.join("\n")}\n现有文件先备份，再写入 models.json；未列出的模型将保留。`)) {
					ctx.ui.notify("已取消，未修改配置", "info");
					return;
				}
				await commitConfig(snapshot, plan, ctx);
			} catch (error) {
				ctx.ui.notify(`CANNBot 模型操作失败：${diagnosticError(error)}`, "error");
			}
		},
	});

	registerLegacyCommand("cannbot-check", {
		description: "只读检查认证/模型列表；指定 model-id 才发送可能计费的短推理测试",
		handler: async (args, ctx) => {
			const modelId = args.trim();
			if (/\s/.test(modelId)) {
				ctx.ui.notify("用法：/cannbot-check [model-id]；指定 ID 将发送可能计费的独立短推理请求", "warning");
				return;
			}
			try {
				const creds = await inspectCredentials();
				ctx.ui.notify(`JWT ${creds.jwt ? "本地未过期（不代表上游认可）" : "无或已过期"}，VK ${creds.vk ? "有（未验证有效性）" : "无"}。只读检查，不自动续期。`, creds.jwt && creds.vk ? "info" : "warning");
				const local = await readLocalConfig();
				const direct = normalizeBaseUrl(local.baseUrl) === UPSTREAM_GATEWAY;
				ctx.ui.notify(`本地模型 ${local.models.length} 个；网关${direct ? "配置匹配" : "配置不匹配（本命令仅检查官方直连网关）"}；API ${local.api === "openai-completions" ? "匹配" : "不是 openai-completions"}。`, direct && local.api === "openai-completions" ? "info" : "warning");
				try {
					const upstream = await fetchCannbotModels(creds);
					const changes = previewModelChanges(local.models, upstream);
					ctx.ui.notify(`原生模型列表可访问，启用 ${upstream.length} 个模型；${changes.length ? `发现 ${changes.length} 项差异，运行 /cannbot-models 查看` : "本地 ID 和已知限制一致"}。列表可访问不代表推理可用。`, changes.length ? "warning" : "info");
				} catch (error) {
					ctx.ui.notify(`模型列表检查失败：${diagnosticError(error)}`, "error");
				}
				if (!modelId) {
					ctx.ui.notify("未发送推理请求。使用 /cannbot-check <model-id> 进行可能计费的短测试，不携带会话内容。", "info");
					return;
				}
				const selected = local.models.find(model => model.id === modelId);
				if (!direct || local.api !== "openai-completions" || !selected ||
					(selected.baseUrl !== undefined && normalizeBaseUrl(selected.baseUrl) !== UPSTREAM_GATEWAY) ||
					(selected.api !== undefined && selected.api !== "openai-completions")) {
					ctx.ui.notify("未发送推理请求：要求官方直连网关、openai-completions API，以及已配置的 model-id。", "error");
					return;
				}
				ctx.ui.notify(`正在测试 ${displayId(modelId)}，可能计费；仅发送独立短提示词。`, "info");
				await probeCannbotModel(modelId, creds);
				ctx.ui.notify(`${displayId(modelId)} 推理接口返回有效响应。仅验证短文本请求，不代表长上下文、工具调用或流式响应均正常。`, "info");
			} catch (error) {
				ctx.ui.notify(`CANNBot 检查失败：${diagnosticError(error)}`, "error");
			}
		},
	});

	async function storeVkCommand(args: string, ctx: ExtensionCommandContext, signal?: AbortSignal) {
		if (!ctx.hasUI || (args.trim() && args.trim() !== "import")) {
			ctx.ui.notify("用法：/cannbot-vk 交互设置；/cannbot-vk import 导入旧 VK。不要把密钥写入命令参数。", "warning");
			return;
		}
		try {
			signal?.throwIfAborted();
			const existing = await readPiVk();
			let key: string | undefined;
			if (args.trim() === "import") {
				const auth = await readJson(AUTH_PATH);
				const old = auth?.cannbot as { key?: unknown } | undefined;
				if (typeof old?.key !== "string" || !old.key) throw new DiagnosticError("opencode 中没有可导入的 CANNBot VK");
				if (!await ctx.ui.confirm(existing ? "导入并替换 Pi 已保存的 VK？" : "导入旧 VK？", "保存到 Pi 专用 cannbot-auth.json（0600）；旧文件保留不动。")) return;
				key = old.key;
			} else {
				key = await ctx.ui.input("设置 CANNBot 连接密钥（VK，不写入聊天记录）", "粘贴连接密钥");
			}
			if (!key) return;
			if (existing && args.trim() !== "import" && !await ctx.ui.confirm("替换 Pi 已保存的 VK？", "不会修改其他 provider 或 opencode 的认证文件。")) return;
			await savePiVk(key, signal);
			ctx.ui.notify("连接密钥已保存到 Pi 专用 cannbot-auth.json（0600）；后续优先使用，不再依赖 opencode VK。", "info");
		} catch (error) {
			if (signal?.aborted) throw error;
			ctx.ui.notify(`CANNBot VK 设置失败：${diagnosticError(error)}`, "error");
		}
	}
	registerLegacyCommand("cannbot-vk", {
		description: "交互设置 Pi 专用 VK；import 确认导入 opencode 旧 VK，不把密钥放进命令参数",
		handler: storeVkCommand,
	});

	registerLegacyCommand("cannbot-login", {
		description: "独立浏览器授权 + SSE/手动兜底；status 查看状态，start 强制授权，manual 粘贴回调，cancel 取消",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "cancel") {
				loginController?.abort();
				ctx.ui.notify("已请求取消授权", "info");
				return;
			}
			if (action === "status") {
				try {
					const creds = await inspectCredentials();
					ctx.ui.notify(`授权流程：${loginController ? "进行中" : loginStatus}；JWT ${creds.jwt ? "本地未过期" : "无或已过期"}，VK ${creds.vk ? "有" : "无"}，VK 来源：${await readPiVk() ? "Pi 专用文件" : "旧 opencode 文件或未设置"}。`, "info");
				} catch (error) { ctx.ui.notify(diagnosticError(error), "error"); }
				return;
			}
			if (loginController) {
				ctx.ui.notify("已有授权流程进行中；请在当前输入框粘贴回调或按 Esc 取消", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("登录需要交互 UI；请在 Pi 中运行 /cannbot-login。不要通过日志或聊天传递 token。", "warning");
				return;
			}
			const controller = new AbortController();
			loginController = controller;
			loginStatus = "进行中";
			try {
				if (action && !["start", "manual"].includes(action)) {
					const parsed = parseCallbackUrl(action);
					const ok = !!parsed && !jwtExpired(parsed.accessToken);
					if (ok) await saveOAuthTokens(parsed!, controller.signal);
					loginStatus = ok ? "成功" : "失败";
					ctx.ui.notify(ok ? "CANNBot token 已保存；建议以后用 manual 对话粘贴，避免命令历史包含 token" : "无法解析有效回调；用法：/cannbot-login [start|manual|status|cancel]", ok ? "info" : "error");
					return;
				}
				if (!action) {
					const creds = await loadCredentials();
					ctx.ui.notify(`JWT ${creds.jwt ? "本地未过期" : "无或已过期"}，VK ${creds.vk ? "有" : "无"}。VK 可通过 /cannbot-vk 设置。`, "info");
					if (creds.jwt) { loginStatus = "凭证已存在"; return; }
				}
				let tokens: OAuthTokens | undefined;
				if (action === "manual") {
					const pasted = await ctx.ui.input("粘贴最终 vscode:// 回调（不写入聊天记录）", "vscode://...", { signal: controller.signal });
					if (pasted) {
						tokens = parseCallbackUrl(pasted);
						if (!tokens) throw new DiagnosticError("回调里没有有效 token；未保存凭证");
					}
				} else {
					tokens = await runOAuthLogin(ctx.ui, openBrowser, controller.signal);
				}
				controller.signal.throwIfAborted();
				if (!tokens) { loginStatus = "已取消"; ctx.ui.notify("已取消授权，未保存凭证", "info"); return; }
				await saveOAuthTokens(tokens, controller.signal);
				loginStatus = "成功";
				ctx.ui.notify("CANNBot token 已保存，无需本地 service。VK 独立通过 /cannbot-vk 设置或 import 导入。", "info");
			} catch (error) {
				loginStatus = controller.signal.aborted ? "已取消" : "失败";
				ctx.ui.notify(controller.signal.aborted ? "已取消授权，未保存凭证" : `CANNBot 登录失败：${diagnosticError(error)}`, controller.signal.aborted ? "info" : "error");
			} finally {
				controller.abort();
				if (loginController === controller) loginController = undefined;
			}
		},
	});

	async function commitConfig(snapshot: ConfigSnapshot, plan: SyncPlan, ctx: ExtensionCommandContext, signal?: AbortSignal) {
		await ctx.waitForIdle();
		signal?.throwIfAborted();
		const backup = await applySyncPlan(snapshot, plan, signal);
		ctx.ui.notify(`CANNBot 配置已保存。${backup ? `备份：${backup}` : "已创建 models.json。"}`, "info");
		try {
			const result = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: ["cannbot"] });
			if (result.aborted || result.errors.size || ctx.modelRegistry.getError()) throw new DiagnosticError("模型注册表刷新未成功");
			if (ctx.model?.provider === "cannbot") {
				const updated = ctx.modelRegistry.find("cannbot", ctx.model.id);
				if (updated && !await pi.setModel(updated)) throw new DiagnosticError("当前模型重新选择未成功");
			}
			ctx.ui.notify("Pi 模型列表已刷新，可运行 /model 选择模型", "info");
		} catch {
			ctx.ui.notify("配置已写入，但运行时刷新失败；请 /reload 后检查 /model，必要时从备份恢复", "warning");
		}
	}

	function guardedContext(ctx: ExtensionCommandContext, signal: AbortSignal): ExtensionCommandContext {
		const combined = (options?: { signal?: AbortSignal; timeout?: number }) => ({
			...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
		});
		return { ...ctx, ui: {
			...ctx.ui,
			notify: (message, type) => ctx.ui.notify(message, type),
			input: (title, placeholder, options) => ctx.ui.input(title, placeholder, combined(options)),
			confirm: (title, message, options) => ctx.ui.confirm(title, message, combined(options)),
			select: (title, options, dialogOptions) => ctx.ui.select(title, options, combined(dialogOptions)),
		} };
	}

	const menu = createCannbotMenu({
		gateway: UPSTREAM_GATEWAY,
		inspect: inspectCredentials,
		canRenew: async () => {
			const session = await readJson(SESSION_PATH);
			return typeof session?.refreshToken === "string" && !!session.refreshToken;
		},
		hasLegacyVk: async () => {
			const auth = await readJson(AUTH_PATH);
			const old = auth?.cannbot as { key?: unknown } | undefined;
			return typeof old?.key === "string" && !!old.key;
		},
		renew: signal => loadCredentials(signal, true),
		authorize: async (ctx, manual, signal) => {
			signal.throwIfAborted();
			if (loginController) { ctx.ui.notify("已有授权正在进行，请先完成或取消它。", "warning"); return false; }
			const cancel = () => loginController?.abort();
			signal.addEventListener("abort", cancel, { once: true });
			try {
				await legacyCommands.get("cannbot-login")!.handler(manual ? "manual" : "start", guardedContext(ctx, signal));
				signal.throwIfAborted();
				return loginStatus === "成功";
			} finally { signal.removeEventListener("abort", cancel); }
		},
		storeVk: async (ctx, importLegacy, signal) => {
			signal.throwIfAborted();
			await storeVkCommand(importLegacy ? "import" : "", guardedContext(ctx, signal), signal);
			signal.throwIfAborted();
			return !!await readPiVk();
		},
		catalog: fetchCannbotModels,
		probe: probeCannbotModel,
		commit: commitConfig,
		explain: diagnosticError,
	});
	pi.registerCommand("cannbot-proxy", {
		description: "状态引导首页：完成独立设置、检查连接、检查模型更新、账号与设置",
		handler: async (args, ctx) => {
			if (args.trim() || !ctx.hasUI) { ctx.ui.notify("在交互式 Pi 中运行 /cannbot-proxy 打开菜单，无需参数。", "warning"); return; }
			if (menuController) { ctx.ui.notify("CANNBot 菜单已打开，请先返回或退出当前菜单。", "warning"); return; }
			const controller = new AbortController();
			menuController = controller;
			try {
				await menu(ctx, controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) ctx.ui.notify(`CANNBot 菜单未完成：${diagnosticError(error)}`, "error");
			} finally {
				controller.abort();
				if (menuController === controller) menuController = undefined;
			}
		},
	});
}
