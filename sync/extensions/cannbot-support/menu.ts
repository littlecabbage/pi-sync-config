import { createHash } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CannbotError, buildSyncPlan, configModels, readConfigSnapshot, readPiVk,
} from "./core.ts";
import type { ConfigSnapshot, ModelMetadata, SyncPlan } from "./core.ts";

interface Credentials { jwt?: string; vk?: string; sessionId?: string }
export interface MenuServices {
	gateway: string;
	inspect(): Promise<Credentials>;
	canRenew(): Promise<boolean>;
	hasLegacyVk(): Promise<boolean>;
	renew(signal: AbortSignal): Promise<Credentials>;
	authorize(ctx: ExtensionCommandContext, manual: boolean, signal: AbortSignal): Promise<boolean>;
	storeVk(ctx: ExtensionCommandContext, importLegacy: boolean, signal: AbortSignal): Promise<boolean>;
	catalog(creds: Credentials, signal: AbortSignal): Promise<ModelMetadata[]>;
	probe(id: string, creds: Credentials, signal: AbortSignal): Promise<void>;
	commit(snapshot: ConfigSnapshot, plan: SyncPlan, ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void>;
	explain(error: unknown): string;
}

interface LocalState {
	creds: Credentials;
	ownVk: boolean;
	legacyVk: boolean;
	canRenew: boolean;
	models: Record<string, unknown>[];
	connectionChanges: string[];
	problems: string[];
	signature: string;
}
interface Failure { status?: number; recoverable: boolean; summary: string; details: string }
const HOME = "返回首页";
const DETAILS = "查看详情";
const CANCEL = "取消本次操作";
function displayId(id: string): string { return id.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160); }
function limit(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function metadata(models: Record<string, unknown>[]): ModelMetadata[] {
	return models.map(model => ({ id: model.id as string, contextWindow: limit(model.contextWindow), maxTokens: limit(model.maxTokens) }));
}

/** No network or writes on entry; all state and history remain outside the transcript. */
export function createCannbotMenu(services: MenuServices) {
	let recent: { signature: string; summary: string; time: string } | undefined;

	async function localState(): Promise<LocalState> {
		const problems: string[] = [];
		let creds: Credentials = {}, ownVk = false, legacyVk = false, canRenew = false;
		let models: Record<string, unknown>[] = [], connectionChanges: string[] = [];
		let raw: string | undefined;
		try {
			creds = await services.inspect();
			ownVk = !!await readPiVk();
			legacyVk = await services.hasLegacyVk();
			canRenew = await services.canRenew();
		} catch (error) { problems.push(services.explain(error)); }
		try {
			const snapshot = await readConfigSnapshot(true);
			raw = snapshot.raw;
			models = configModels(snapshot.config, true);
			connectionChanges = buildSyncPlan(snapshot.config, metadata(models), services.gateway).changes;
		} catch (error) { problems.push(services.explain(error)); }
		const signature = createHash("sha256").update(JSON.stringify({ raw, creds, ownVk, problems })).digest("hex");
		return { creds, ownVk, legacyVk, canRenew, models, connectionChanges, problems, signature };
	}

	function remember(state: LocalState, summary: string) {
		recent = { signature: state.signature, summary, time: new Date().toLocaleTimeString() };
	}

	async function failure(error: unknown): Promise<Failure> {
		const status = error instanceof CannbotError ? error.status : undefined;
		const vkOnly = status === 403 && !(await services.inspect().catch(() => ({} as Credentials))).jwt;
		const summary = status === 401 ? "账号授权未被上游接受，可以恢复授权后重试。"
			: vkOnly ? "仅凭连接密钥未获准访问；账号授权不可用，可以恢复授权后重试。"
			: status === 403 ? "账号或模型权限不足。请检查账号权限与连接密钥，不必反复登录。"
			: status === 429 ? "上游限流或额度不足，请检查额度或稍后重试。"
			: status !== undefined && status >= 500 ? "上游服务暂时异常，重新登录通常不能解决。"
			: status === 404 ? "模型或接口不存在，请检查模型更新和连接配置。"
			: "本次检查未成功；请查看详情判断是网络还是本地配置问题。";
		return { status, recoverable: status === 401 || vkOnly, summary, details: services.explain(error) };
	}

	async function choose(ctx: ExtensionCommandContext, signal: AbortSignal, title: string, options: string[]) {
		signal.throwIfAborted();
		const answer = await ctx.ui.select(title, options, { signal });
		signal.throwIfAborted();
		return answer;
	}

	/** Progress is a cancel dialog, not another navigation level. Losing work is aborted. */
	async function progress<T>(ctx: ExtensionCommandContext, signal: AbortSignal, title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		const dialog = new AbortController(), operation = new AbortController();
		const operationSignal = AbortSignal.any([signal, operation.signal]);
		const dialogSignal = AbortSignal.any([signal, dialog.signal]);
		const job = Promise.resolve().then(() => work(operationSignal)).then(
			value => ({ kind: "done" as const, value }),
			error => ({ kind: "error" as const, error }),
		);
		try {
			const cancel = ctx.ui.select(title, [CANCEL], { signal: dialogSignal }).then(() => ({ kind: "cancel" as const }), () => ({ kind: "cancel" as const }));
			const race = Promise.race([job, cancel]);
			void job.then(() => dialog.abort());
			const result = await race;
			signal.throwIfAborted();
			if (result.kind === "error") throw result.error;
			if (result.kind === "done") return result.value;
			ctx.ui.notify("已取消本次操作；此前成功完成的设置会保留。", "info");
			return undefined;
		} finally {
			dialog.abort();
			operation.abort();
		}
	}

	async function authorizeMissing(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<boolean> {
		if ((await services.inspect()).jwt) return true;
		if (await services.canRenew()) {
			const creds = await progress(ctx, signal, "正在更新已有授权…", current => services.renew(current));
			if (creds === undefined) return false;
			if (creds.jwt) return true;
			ctx.ui.notify("已有授权未能续期，需要在浏览器重新授权。", "warning");
		}
		return services.authorize(ctx, false, signal);
	}

	async function ensureCredentials(ctx: ExtensionCommandContext, signal: AbortSignal, task: string): Promise<boolean> {
		let creds = await services.inspect();
		// Match real requests: an expired JWT is renewed before checking, instead of silently falling back to VK.
		if (!creds.jwt && await services.canRenew()) {
			const renewed = await progress(ctx, signal, "正在更新已有授权…", current => services.renew(current));
			if (renewed === undefined) return false;
			creds = renewed;
			if (!creds.jwt) ctx.ui.notify(creds.vk ? "已有授权未能续期；本次先用连接密钥继续，若被拒绝可恢复授权。" : "已有授权未能续期。", "warning");
		}
		if (creds.jwt || creds.vk) return true;
		const action = `准备账号后继续${task}`;
		const selected = await choose(ctx, signal,
			`${task}需要先准备账号凭证。将打开浏览器授权；完成后自动继续，不需重新选任务。`, [action, HOME]);
		return selected === action && await services.authorize(ctx, false, signal);
	}

	async function confirmCommit(ctx: ExtensionCommandContext, signal: AbortSignal, snapshot: ConfigSnapshot, plan: SyncPlan): Promise<boolean> {
		if (!plan.changes.length) return true;
		const confirmed = await ctx.ui.confirm("备份并应用这些更新？", [
			...plan.changes, ...plan.notes,
			"现有配置先备份，再写入。保留其他 provider、自定义价格和能力，不删除未列出的模型。",
			"新模型未知的价格和能力使用 Pi 默认值，不代表免费或支持这些能力。",
		].join("\n"), { signal });
		signal.throwIfAborted();
		if (!confirmed) { ctx.ui.notify("已取消配置更新，未写入 models.json。", "info"); return false; }
		await services.commit(snapshot, plan, ctx, signal);
		return true;
	}

	async function setup(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
		const state = await localState();
		if (state.problems.length) { ctx.ui.notify(state.problems.join("\n"), "error"); return; }
		const steps = [
			...(!state.creds.jwt ? [state.canRenew ? "更新已有授权，失败时再引导浏览器授权" : "完成浏览器授权"] : []),
			...(!state.ownVk ? [state.legacyVk ? "导入已有连接密钥到 Pi，旧文件保留" : "设置 Pi 专用连接密钥"] : []),
			...(state.connectionChanges.length || !state.models.length ? ["检查模型并迁移直连配置；写入前展示变更和备份"] : []),
		];
		if (!steps.length) { ctx.ui.notify("独立配置已就绪；实际推理连接仍需单独验证。", "info"); return; }
		const start = `开始完成剩余 ${steps.length} 项`;
		if (await choose(ctx, signal, `已有准备会跳过：\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n中途取消或失败，已完成步骤会保留。`, [start, HOME]) !== start) return;
		const completed: string[] = [];
		try {
			if (!state.creds.jwt) {
				if (!await authorizeMissing(ctx, signal)) return;
				completed.push("账号授权");
			}
			if (!await readPiVk()) {
				if (!await services.storeVk(ctx, await services.hasLegacyVk(), signal)) return;
				completed.push("连接密钥保存");
			}
			const current = await localState();
			if (current.connectionChanges.length || !current.models.length) {
				const upstream = await progress(ctx, signal, "正在检查模型和直连配置…", currentSignal => services.catalog(current.creds, currentSignal));
				if (upstream === undefined) return;
				const snapshot = await readConfigSnapshot(true);
				const plan = buildSyncPlan(snapshot.config, upstream, services.gateway);
				if (!await confirmCommit(ctx, signal, snapshot, plan)) return;
				completed.push("模型配置更新");
			}
			const after = await localState();
			if (!after.creds.jwt || !after.ownVk || after.connectionChanges.length || !after.models.length || after.problems.length) {
				ctx.ui.notify("部分准备已完成；仍有缺项。首页会继续推荐剩余步骤，不会重复已完成设置。", "warning");
			} else {
				ctx.ui.notify("独立配置已就绪，无需本地 service。尚未发送真实推理测试。", "info");
			}
		} finally {
			if (completed.length) ctx.ui.notify(`已完成并保留：${completed.join("、")}。`, "info");
		}
	}

	async function failureAction(ctx: ExtensionCommandContext, signal: AbortSignal, problem: Failure, task: string): Promise<boolean> {
		const retry = `重新${task}`;
		const recover = `恢复授权并重新${task}`;
		while (true) {
			const selected = await choose(ctx, signal, problem.summary, [
				...(problem.recoverable ? [recover] : []), retry, DETAILS, HOME,
			]);
			if (!selected || selected === HOME) return false;
			if (selected === DETAILS) { ctx.ui.notify(problem.details, "info"); continue; }
			if (selected === recover) return services.authorize(ctx, false, signal);
			if (selected === retry) return true;
		}
	}

	async function modelsTask(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
		while (true) {
			try {
				if (!await ensureCredentials(ctx, signal, "检查模型更新")) return;
				const upstream = await progress(ctx, signal, "正在检查模型更新…", current => services.inspect().then(creds => services.catalog(creds, current)));
				if (upstream === undefined) return;
				const snapshot = await readConfigSnapshot(true);
				const plan = buildSyncPlan(snapshot.config, upstream, services.gateway);
				const apply = `备份并应用这 ${plan.changes.length} 项更新`;
				const added = plan.changes.filter(change => change.startsWith("新增：")).length;
				const limits = plan.changes.filter(change => change.startsWith("更新：")).length;
				const connection = plan.changes.filter(change => change.startsWith("连接配置：")).length;
				while (true) {
					const selected = await choose(ctx, signal,
						plan.changes.length ? `发现 ${plan.changes.length} 项可应用更新：新增 ${added} 个模型、调整 ${limits} 项限制、${connection} 项连接配置。保留自定义设置，不删除模型。` : "模型和连接配置没有可写入更新。未修改文件。",
						[...(plan.changes.length ? [apply] : []), DETAILS, HOME]);
					if (!selected || selected === HOME) return;
					if (selected === DETAILS) {
						ctx.ui.notify([...plan.changes, ...plan.notes, `上游启用 ${upstream.length} 个模型。价格、图像能力和 reasoning 未自动补全。`].join("\n"), "info");
						continue;
					}
					if (selected === apply && await confirmCommit(ctx, signal, snapshot, plan)) {
						ctx.ui.notify("更新已应用；可从首页继续检查连接。", "info");
						return;
					}
				}
			} catch (error) {
				signal.throwIfAborted();
				if (!await failureAction(ctx, signal, await failure(error), "检查模型更新")) return;
			}
		}
	}

	function probeModels(snapshot: ConfigSnapshot): string[] {
		const provider = (snapshot.config.providers as Record<string, Record<string, unknown>> | undefined)?.cannbot;
		if (!provider || typeof provider.baseUrl !== "string" || provider.baseUrl.replace(/\/+$/, "") !== services.gateway || provider.api !== "openai-completions") return [];
		return configModels(snapshot.config).filter(model =>
			(model.baseUrl === undefined || typeof model.baseUrl === "string" && model.baseUrl.replace(/\/+$/, "") === services.gateway) &&
			(model.api === undefined || model.api === "openai-completions")
		).map(model => model.id as string);
	}

	async function testModel(ctx: ExtensionCommandContext, signal: AbortSignal, pickOther: boolean): Promise<Failure | undefined> {
		const ids = probeModels(await readConfigSnapshot(true));
		if (!ids.length) { ctx.ui.notify("尚无可测试的官方直连模型，请先完成独立设置或检查模型更新。", "warning"); return; }
		let id = ctx.model?.provider === "cannbot" && ids.includes(ctx.model.id) ? ctx.model.id : undefined;
		if (pickOther || !id) {
			const labels = ids.map((model, index) => `${index + 1}. ${displayId(model)}`);
			const selected = await choose(ctx, signal, "选择要测试的模型（短测试可能计费）", [...labels, "返回检查结果"]);
			if (!selected || selected === "返回检查结果") return;
			id = ids[labels.indexOf(selected)];
		}
		if (!id || !await ctx.ui.confirm("发送可能计费的短测试？", `模型：${displayId(id)}\n只发送独立短提示词，不包含当前会话、附件或工具。不会自动重试；取消后已发送的请求仍可能计费。`, { signal })) return;
		signal.throwIfAborted();
		try {
			const creds = await services.inspect();
			const result = await progress(ctx, signal, `正在测试 ${displayId(id)}…（已确认可能计费）`, async current => { await services.probe(id!, creds, current); return true; });
			if (result) {
				remember(await localState(), `${displayId(id)} 已通过独立短文本测试；不代表长上下文、工具或流式均正常`);
				ctx.ui.notify("模型返回有效短文本响应。未验证长上下文、工具调用和流式响应。", "info");
			}
		} catch (error) { signal.throwIfAborted(); return await failure(error); }
	}

	async function connectionTask(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
		let problem: Failure | undefined;
		let checkNeeded = true;
		while (true) {
			if (checkNeeded && !problem) {
				try {
					const state = await localState();
					if (state.problems.length) throw new CannbotError(state.problems.join("\n"));
					if (!await ensureCredentials(ctx, signal, "检查连接")) return;
					const upstream = await progress(ctx, signal, "正在检查账号和模型列表…（不发送推理）", current => services.inspect().then(creds => services.catalog(creds, current)));
					if (upstream === undefined) return;
					const after = await localState();
					remember(after, `模型列表可访问，启用 ${upstream.length} 个；推理未在此次检查中测试`);
					if (after.connectionChanges.length || !after.models.length) ctx.ui.notify("上游列表可访问，但本地独立配置尚未完成；可从首页完成设置。", "warning");
					checkNeeded = false;
				} catch (error) { signal.throwIfAborted(); problem = await failure(error); }
			}
			if (problem) {
				remember(await localState(), problem.summary);
				if (!await failureAction(ctx, signal, problem, "检查连接")) return;
				problem = undefined;
				checkNeeded = true;
				continue;
			}
			const state = await localState();
			if (recent && recent.signature !== state.signature) { checkNeeded = true; continue; }
			const directIds = probeModels(await readConfigSnapshot(true));
			const current = ctx.model?.provider === "cannbot" && directIds.includes(ctx.model.id);
			const testCurrent = "测试当前模型（可能计费）", testOther = "选择模型做短测试（可能计费）";
			const selected = await choose(ctx, signal, recent?.summary ?? "账号凭证能够访问模型列表；实际回答需单独短测试。", [
				...(current ? [testCurrent] : []), ...(directIds.length ? [testOther] : []), "重新检查连接", DETAILS, HOME,
			]);
			if (!selected || selected === HOME) return;
			if (selected === DETAILS) {
				ctx.ui.notify(`本地配置 ${state.models.length} 个模型；${state.ownVk ? "密钥由 Pi 独立保存" : "密钥尚未独立保存"}。${state.connectionChanges.join("\n")}\n基础检查不验证推理、完整权限、工具调用或流式响应。`, "info");
			} else if (selected === "重新检查连接") {
				checkNeeded = true;
				continue;
			} else {
				problem = await testModel(ctx, signal, selected === testOther);
			}
		}
	}

	async function accountTask(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
		while (true) {
			const state = await localState();
			const status = "查看本地状态", auth = "重新进行浏览器授权", manual = "粘贴已有授权回调", key = state.ownVk ? "更换连接密钥" : "设置连接密钥", legacy = "导入已有连接密钥";
			const selected = await choose(ctx, signal, "账号与设置（只有选中的操作会执行）", [status, auth, manual, ...(state.legacyVk ? [legacy] : []), key, HOME]);
			if (!selected || selected === HOME) return;
			if (selected === status) {
				ctx.ui.notify([
					`账号授权：${state.creds.jwt ? "本地未过期，尚不代表上游认可" : state.canRenew ? "待续期" : "未准备"}`,
					`连接密钥：${state.ownVk ? "Pi 专用文件" : state.legacyVk ? "旧文件可导入" : "未设置"}`,
					`本地配置 ${state.models.length} 个模型；不会显示密钥或 token。`,
					...state.connectionChanges, ...state.problems,
				].join("\n"), state.problems.length ? "warning" : "info");
			} else if (selected === auth || selected === manual) {
				await services.authorize(ctx, selected === manual, signal);
			} else {
				await services.storeVk(ctx, selected === legacy, signal);
			}
		}
	}

	return async function run(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			const state = await localState();
			if (recent?.signature !== state.signature) recent = undefined;
			const setupNeeded = !state.creds.jwt || !state.ownVk || !state.models.length || !!state.connectionChanges.length;
			const setupLabel = state.creds.jwt || state.creds.vk ? "完成独立设置【推荐】" : "完成首次设置【推荐】";
			const accountLabel = state.problems.length ? "账号与设置【需检查】" : "账号与设置";
			const selected = await choose(ctx, signal, [
				"CANNBot Proxy",
				`${state.creds.jwt ? "已有本地授权" : state.creds.vk ? "已有连接密钥" : "账号尚未准备"} · 本地配置 ${state.models.length} 个模型`,
				state.problems.length ? "发现本地配置或凭证问题，请查看账号与设置。" : setupNeeded ? "尚未完成独立设置；已有准备会跳过。" : "独立配置就绪（不等于推理已验证）。",
				recent ? `最近检查 ${recent.time}：${recent.summary}` : "连接及推理尚未在本菜单中验证。",
			].join("\n"), [
				...(setupNeeded && !state.problems.length ? [setupLabel] : []), "检查连接", "检查模型更新", accountLabel, "退出",
			]);
			if (!selected || selected === "退出") return;
			try {
				if (selected === setupLabel) await setup(ctx, signal);
				else if (selected === "检查连接") await connectionTask(ctx, signal);
				else if (selected === "检查模型更新") await modelsTask(ctx, signal);
				else await accountTask(ctx, signal);
			} catch (error) {
				if (signal.aborted) return;
				ctx.ui.notify(`操作未完成：${services.explain(error)}。已成功完成的设置会保留。`, "error");
			}
		}
	};
}
