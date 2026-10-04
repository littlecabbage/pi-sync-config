import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class CannbotError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}
const mutationQueues = new Map<string, Promise<void>>();
const API = "https://cannbot.hicann.cn/cannbot/api";
export const PLUGIN_API_KEY = "cannbot-extension";

export function agentDirectory(): string {
	return (process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")).replace(/^~(?=\/)/, homedir());
}

export function serializeFileMutation<T>(path: string, work: () => Promise<T>): Promise<T> {
	const run = (mutationQueues.get(path) ?? Promise.resolve()).then(work, work);
	const tail = run.then(() => {}, () => {});
	mutationQueues.set(path, tail);
	void tail.then(() => { if (mutationQueues.get(path) === tail) mutationQueues.delete(path); });
	return run;
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function readOptionalText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new CannbotError("文件读取失败；请检查权限，未覆盖原文件");
	}
}

export async function readSecretJson(path: string): Promise<Record<string, unknown>> {
	const raw = await readOptionalText(path);
	if (raw === undefined) return {};
	try {
		const data: unknown = JSON.parse(raw);
		if (record(data)) return data;
	} catch {}
	throw new CannbotError("凭证文件格式异常；请检查文件，未覆盖原文件");
}

/** Only generated temporary files are removed; the original is replaced atomically. */
export async function writeJsonAtomic(path: string, value: unknown, beforeCommit?: () => Promise<void>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await beforeCommit?.();
		await rename(tmp, path);
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

export async function readPiVk(): Promise<string | undefined> {
	const data = await readSecretJson(join(agentDirectory(), "cannbot-auth.json"));
	if (data.vk === undefined) return undefined;
	if (typeof data.vk !== "string" || !data.vk || /\s/.test(data.vk)) {
		throw new CannbotError("Pi 保存的 VK 格式异常；请检查 cannbot-auth.json，未覆盖文件");
	}
	return data.vk;
}

export async function savePiVk(vk: string, signal?: AbortSignal): Promise<void> {
	const key = vk.trim();
	if (!key || /\s/.test(key)) throw new CannbotError("VK 不能为空或包含空白字符");
	const path = join(agentDirectory(), "cannbot-auth.json");
	await serializeFileMutation(path, async () => {
		signal?.throwIfAborted();
		const current = await readSecretJson(path);
		await writeJsonAtomic(path, { ...current, vk: key }, async () => { signal?.throwIfAborted(); });
	});
}

export interface ModelMetadata { id: string; contextWindow?: number; maxTokens?: number }
export interface ConfigSnapshot { path: string; raw?: string; config: Record<string, unknown> }
export interface SyncPlan { config: Record<string, unknown>; changes: string[]; notes: string[] }
function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function safeId(id: string): string { return id.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160); }
function normalizeUrl(value: unknown): unknown { return typeof value === "string" ? value.replace(/\/+$/, "") : value; }

export function configModels(config: Record<string, unknown>, allowMissing = false): Record<string, unknown>[] {
	const providers = config.providers;
	if (providers !== undefined && !record(providers)) throw new CannbotError("models.json providers 必须是对象");
	const provider = record(providers) ? providers.cannbot : undefined;
	if (provider === undefined && allowMissing) return [];
	if (!record(provider)) throw new CannbotError("models.json 中没有有效的 cannbot provider");
	if (provider.models === undefined && allowMissing) return [];
	if (!Array.isArray(provider.models)) throw new CannbotError("models.json 中没有 cannbot.models 数组");
	const ids = new Set<string>();
	for (const model of provider.models) {
		if (!record(model) || typeof model.id !== "string" || !model.id || ids.has(model.id)) {
			throw new CannbotError("本地模型 ID 无效或重复，无法可靠对比");
		}
		ids.add(model.id);
	}
	return provider.models;
}

export async function readConfigSnapshot(allowMissing = false): Promise<ConfigSnapshot> {
	const path = join(agentDirectory(), "models.json");
	const raw = await readOptionalText(path);
	if (raw === undefined && allowMissing) return { path, raw, config: {} };
	try {
		const config: unknown = JSON.parse(raw ?? "");
		if (record(config)) {
			configModels(config, allowMissing);
			return { path, raw, config };
		}
	} catch (error) {
		if (error instanceof CannbotError) throw error;
	}
	throw new CannbotError("无法读取或解析 Pi models.json；未修改配置");
}

/** Preserve every field except explicit catalog limits and recognized legacy helper settings. */
export function buildSyncPlan(config: Record<string, unknown>, upstream: ModelMetadata[], gateway: string): SyncPlan {
	const next = structuredClone(config);
	const existing = configModels(next, true);
	const providers = (next.providers ??= {}) as Record<string, unknown>;
	const provider = (providers.cannbot ??= {}) as Record<string, unknown>;
	const changes: string[] = [];
	const notes: string[] = [];
	const oldUrl = normalizeUrl(provider.baseUrl);
	if (oldUrl !== undefined && oldUrl !== gateway && oldUrl !== "http://127.0.0.1:8088/v1") {
		throw new CannbotError("检测到自定义 cannbot 网关；不会自动覆盖，请先确认直连配置");
	}
	if (provider.api !== undefined && provider.api !== "openai-completions") {
		throw new CannbotError("检测到自定义 cannbot API；不会自动覆盖");
	}
	if (provider.baseUrl !== gateway) { provider.baseUrl = gateway; changes.push("连接配置：使用 CANNBot 官方直连网关"); }
	if (provider.api === undefined) { provider.api = "openai-completions"; changes.push("连接配置：设置 openai-completions API"); }
	if (provider.compat === undefined) {
		provider.compat = { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" };
		changes.push("连接配置：补充已验证的 CANNBot 兼容参数");
	}
	const isHelper = (value: unknown) => typeof value === "string" && value.startsWith("!") && value.includes("cannbot-credential.mjs");
	if (provider.apiKey === undefined || isHelper(provider.apiKey)) {
		provider.apiKey = PLUGIN_API_KEY;
		changes.push("连接配置：由插件注入认证，移除 JWT credential helper 依赖");
	}
	if (record(provider.headers)) {
		for (const key of Object.keys(provider.headers)) {
			if (key.toLowerCase() === "x-api-vkey" && isHelper(provider.headers[key])) {
				delete provider.headers[key];
				changes.push("连接配置：移除 VK credential helper 依赖");
			}
		}
	}
	const models = existing.map(model => ({ ...model }));
	const byId = new Map(models.map(model => [model.id, model]));
	for (const remote of upstream) {
		const current = byId.get(remote.id);
		if (!current) {
			if (!positiveInteger(remote.contextWindow) || !positiveInteger(remote.maxTokens) || remote.maxTokens > remote.contextWindow) {
				notes.push(`未添加：${safeId(remote.id)}，缺少有效上下文/输出限制`);
				continue;
			}
			const model = { id: remote.id, contextWindow: remote.contextWindow, maxTokens: remote.maxTokens };
			models.push(model);
			byId.set(remote.id, model);
			changes.push(`新增：${safeId(remote.id)}`);
			continue;
		}
		const proposal = { ...current };
		for (const field of ["contextWindow", "maxTokens"] as const) {
			if (positiveInteger(remote[field])) proposal[field] = remote[field];
		}
		if (positiveInteger(proposal.contextWindow) && positiveInteger(proposal.maxTokens) && proposal.maxTokens > proposal.contextWindow) {
			notes.push(`未更新：${safeId(remote.id)}，输出限制超过上下文长度`);
			continue;
		}
		for (const field of ["contextWindow", "maxTokens"] as const) {
			if (proposal[field] !== current[field]) {
				changes.push(`更新：${safeId(remote.id)} ${field}：${positiveInteger(current[field]) ? current[field] : "未配置或无效"} → ${proposal[field]}`);
				current[field] = proposal[field];
			}
		}
	}
	const enabled = new Set(upstream.map(model => model.id));
	for (const model of existing) {
		if (!enabled.has(model.id as string)) notes.push(`保留：${safeId(model.id as string)}，上游未启用或未列出，不自动删除`);
	}
	if (provider.modelOverrides !== undefined) notes.push("modelOverrides 未修改，可能覆盖更新后的模型参数");
	provider.models = models;
	return { config: next, changes, notes };
}

export async function applySyncPlan(snapshot: ConfigSnapshot, plan: SyncPlan, signal?: AbortSignal): Promise<string | undefined> {
	return serializeFileMutation(snapshot.path, async () => {
		signal?.throwIfAborted();
		try {
			if ((await lstat(snapshot.path)).isSymbolicLink()) throw new CannbotError("models.json 是符号链接；停止更新，避免替换链接");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const checkUnchanged = async () => {
			signal?.throwIfAborted();
			if (await readOptionalText(snapshot.path) !== snapshot.raw) {
				throw new CannbotError("models.json 已被其他操作修改，请重新预览；未覆盖最新配置");
			}
		};
		await checkUnchanged();
		let backup: string | undefined;
		if (snapshot.raw !== undefined) {
			backup = `${snapshot.path}.cannbot-${Date.now()}-${randomUUID()}.bak`;
			await writeFile(backup, snapshot.raw, { mode: 0o600, flag: "wx" });
		}
		await writeJsonAtomic(snapshot.path, plan.config, checkUnchanged);
		return backup;
	});
}

export interface OAuthTokens { accessToken: string; refreshToken: string; expiresIn: number; sessionId?: string }
function validTokens(value: unknown): OAuthTokens | undefined {
	if (!record(value) || typeof value.accessToken !== "string" || !value.accessToken) return undefined;
	return {
		accessToken: value.accessToken,
		refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : "",
		expiresIn: positiveInteger(value.expiresIn) ? value.expiresIn : 3600,
		...(typeof value.sessionId === "string" && value.sessionId ? { sessionId: value.sessionId } : {}),
	};
}

export function callbackTokens(raw: string): OAuthTokens | undefined {
	try {
		const url = new URL(raw.trim().replace(/^['"]|['"]$/g, ""));
		if (url.protocol !== "vscode:" && !(url.protocol === "https:" && url.origin === "https://cannbot.hicann.cn")) return undefined;
		return validTokens({ accessToken: url.searchParams.get("token"), refreshToken: url.searchParams.get("refreshToken"), expiresIn: Number(url.searchParams.get("expiresIn") ?? 3600) });
	} catch { return undefined; }
}

export async function requestOAuthAuthorization(signal: AbortSignal): Promise<{ authorizeUrl: string; state: string }> {
	signal.throwIfAborted();
	const response = await fetch(`${API}/oauth/authorize?ideType=vscode`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error" });
	if (!response.ok) throw new CannbotError(`获取授权地址失败：HTTP ${response.status}`);
	const data: unknown = await response.json();
	if (!record(data) || typeof data.authorizeUrl !== "string" || typeof data.state !== "string" || !data.state) {
		throw new CannbotError("授权响应缺少 authorizeUrl 或 state");
	}
	try {
		const url = new URL(data.authorizeUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.searchParams.has("token") || url.searchParams.has("accessToken")) throw new Error();
	} catch { throw new CannbotError("授权地址格式异常，未打开浏览器"); }
	return { authorizeUrl: data.authorizeUrl, state: data.state };
}

/** Decode complete SSE blocks; never log event bodies, including error payloads. */
export async function waitOAuthTokens(state: string, signal: AbortSignal): Promise<OAuthTokens> {
	signal.throwIfAborted();
	const response = await fetch(`${API}/oauth/sse/connect?state=${encodeURIComponent(state)}`, { signal, redirect: "error" });
	if (!response.ok) throw new CannbotError(`授权结果监听失败：HTTP ${response.status}`);
	if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
		throw new CannbotError("授权结果接口不是 SSE 响应，请手动粘贴回调");
	}
	const reader = response.body.getReader();
	const abort = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			if (buffer.length > 131072) throw new CannbotError("授权事件过大，停止监听，请手动粘贴回调");
			let separator: RegExpExecArray | null;
			while ((separator = /\r?\n\r?\n/.exec(buffer))) {
				const block = buffer.slice(0, separator.index);
				buffer = buffer.slice(separator.index + separator[0].length);
				const lines = block.split(/\r?\n/);
				const payload = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
				if (!payload) continue;
				let data: unknown;
				try { data = JSON.parse(payload); } catch { continue; }
				if (record(data) && data.state !== undefined && data.state !== state) throw new CannbotError("授权事件 state 不匹配，未保存凭证");
				if (record(data) && (data.error || lines.includes("event: error"))) throw new CannbotError("上游返回授权失败，请重试或手动粘贴回调");
				const tokens = validTokens(data);
				if (tokens) return tokens;
			}
		}
		throw new CannbotError("授权结果连接已关闭，未收到 token，请手动粘贴回调");
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

interface LoginUi {
	input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Race SSE against manual callback input. The losing branch is cancelled before returning. */
export async function runOAuthLogin(ui: LoginUi, open: (url: string) => Promise<boolean>, signal: AbortSignal): Promise<OAuthTokens | undefined> {
	const authorization = await requestOAuthAuthorization(signal);
	const sseCancel = new AbortController();
	const inputCancel = new AbortController();
	const inputSignal = AbortSignal.any([signal, inputCancel.signal]);
	const sseSignal = AbortSignal.any([signal, sseCancel.signal, AbortSignal.timeout(90_000)]);
	try {
		const sse = waitOAuthTokens(authorization.state, sseSignal).then(tokens => ({ kind: "sse" as const, tokens })).catch(() => {
			if (!signal.aborted && !sseCancel.signal.aborted) ui.notify("自动接收未取得 token（不支持、超时或连接失败）。可继续粘贴 vscode:// 回调，或按 Esc 取消。", "warning");
			return { kind: "fallback" as const };
		});
		if (!await open(authorization.authorizeUrl)) ui.notify(`无法自动打开浏览器，请手动打开：${authorization.authorizeUrl}`, "warning");
		signal.throwIfAborted();
		ui.notify("请在浏览器完成授权。自动监听最长 90 秒；桌面授权可直接粘贴最终 vscode:// 回调。", "info");
		const manual = ui.input("等待自动接收，或粘贴 vscode:// 回调（Esc 取消）", "vscode://...", { signal: inputSignal })
			.then(value => ({ kind: "manual" as const, value })).catch(() => ({ kind: "manual" as const, value: undefined }));
		let result = await Promise.race([sse, manual]);
		if (result.kind === "fallback") result = await manual;
		signal.throwIfAborted();
		if (result.kind === "sse") return result.tokens;
		if (!result.value) return undefined;
		const tokens = callbackTokens(result.value);
		if (!tokens) throw new CannbotError("回调里没有有效 token；未保存凭证");
		return tokens;
	} finally {
		inputCancel.abort();
		sseCancel.abort();
	}
}
