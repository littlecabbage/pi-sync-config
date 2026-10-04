import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keep all credential/config fixtures outside the real user directories.
const home = await mkdtemp(join(tmpdir(), "cannbot-test-"));
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
const extension = await import(process.env.CANNBOT_EXTENSION
	? pathToFileURL(process.env.CANNBOT_EXTENSION).href
	: new URL("../sync/extensions/cannbot-proxy.ts", import.meta.url).href);
const { default: register, UPSTREAM_GATEWAY, inspectCredentials, loadCredentials,
	fetchCannbotModels, previewModelChanges, probeCannbotModel, httpFailure, saveOAuthTokens, saveCallbackUrl } = extension;
const supportUrl = process.env.CANNBOT_EXTENSION
	? new URL("./cannbot-support/core.ts", pathToFileURL(process.env.CANNBOT_EXTENSION))
	: new URL("../sync/extensions/cannbot-support/core.ts", import.meta.url);
const { readPiVk, savePiVk, readConfigSnapshot, buildSyncPlan, applySyncPlan, callbackTokens,
	waitOAuthTokens, runOAuthLogin, requestOAuthAuthorization } = await import(supportUrl.href);
const { createCannbotMenu } = await import(new URL("./menu.ts", supportUrl).href);
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});
const jwt = exp => `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const validJwt = jwt(Math.floor(Date.now() / 1000) + 3600);
const sessionPath = join(home, ".cannbot", "session.json");
const authPath = join(home, ".local", "share", "opencode", "auth.json");
const configPath = join(home, "agent", "models.json");
const piVkPath = join(home, "agent", "cannbot-auth.json");
async function jsonFile(path, value) {
	await mkdir(new URL(".", pathToFileURL(path)), { recursive: true });
	await writeFile(path, JSON.stringify(value));
}
async function fixtures({ expired = false, baseUrl = UPSTREAM_GATEWAY, model = {} } = {}) {
	await jsonFile(sessionPath, { accessToken: expired ? jwt(1) : validJwt, refreshToken: "fixture-refresh", sessionId: "fixture-session" });
	await jsonFile(authPath, { cannbot: { key: "fixture-vk" } });
	await jsonFile(piVkPath, {});
	await jsonFile(configPath, { providers: { cannbot: { baseUrl, api: "openai-completions", models: [{ id: "test-model", contextWindow: 1000, maxTokens: 100, ...model }] } } });
}
const nativeModel = { model: "test-model", status: 1, contextLength: 1000, maxTokens: 100 };
const catalog = (models = [nativeModel], totalPages = 1, total = models.length) => ({ models, totalPages, total });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function commands() {
	const registered = new Map();
	register({ registerProvider() {}, on() {}, registerCommand(name, command) { registered.set(name, command); } });
	return registered;
}
async function run(name, args = "", overrides = {}) {
	const notices = [];
	const ui = { notify: (message, type) => notices.push({ message, type }), ...overrides.ui };
	await commands().get(name).handler(args, {
		hasUI: true, waitForIdle: async () => {},
		modelRegistry: { refresh: async () => ({ aborted: false, errors: new Map() }), getError: () => undefined },
		...overrides, ui,
	});
	return notices;
}

test("read-only credentials never refresh or write an expired session", async () => {
	await fixtures({ expired: true });
	const before = await readFile(sessionPath, "utf8");
	globalThis.fetch = () => { throw new Error("unexpected fetch"); };
	assert.deepEqual(await inspectCredentials(), { vk: "fixture-vk", sessionId: "fixture-session" });
	assert.equal(await readFile(sessionPath, "utf8"), before);
});

test("existing loadCredentials still refreshes once for concurrent calls", async () => {
	await fixtures({ expired: true });
	let calls = 0;
	globalThis.fetch = async (url, options) => {
		calls++;
		assert.match(url, /oauth\/refresh$/);
		assert.deepEqual(JSON.parse(options.body), { refreshToken: "fixture-refresh", ideType: "vscode" });
		return response({ accessToken: validJwt, refreshToken: "fixture-new-refresh", expiresIn: 3600 });
	};
	const results = await Promise.all([loadCredentials(), loadCredentials()]);
	assert.equal(calls, 1);
	assert.ok(results.every(creds => creds.jwt === validJwt));
});

test("catalog fetch paginates, injects headers, filters disabled entries, normalizes limits", async () => {
	let calls = 0;
	globalThis.fetch = async (url, options) => {
		calls++;
		assert.match(url, new RegExp(`page=${calls}&size=100$`));
		assert.deepEqual(options.headers, { Authorization: "Bearer fixture-jwt", "x-api-vkey": "fixture-vk", "X-Session-ID": "fixture-session" });
		assert.equal(options.redirect, "error");
		return response(calls === 1
			? catalog([nativeModel, { model: "disabled", status: 0 }], 2, 3)
			: catalog([{ model: "new", status: 1, contextLength: -1, maxTokens: "100" }], 2, 3));
	};
	assert.deepEqual(await fetchCannbotModels({ jwt: "fixture-jwt", vk: "fixture-vk", sessionId: "fixture-session" }), [
		{ id: "test-model", contextWindow: 1000, maxTokens: 100 },
		{ id: "new", contextWindow: undefined, maxTokens: undefined },
	]);
	assert.equal(calls, 2);
});

test("catalog rejects HTTP errors and incomplete or malformed snapshots", async () => {
	globalThis.fetch = async () => response({ secret: "must-not-print" }, 401);
	await assert.rejects(fetchCannbotModels({ jwt: "fixture" }), /HTTP 401/);
	for (const body of [null, { models: [] }, catalog([], 2, 1), catalog([nativeModel], 21), catalog([nativeModel], 1, 0), catalog([{ id: "wrong" }])]) {
		globalThis.fetch = async () => response(body);
		await assert.rejects(fetchCannbotModels({ jwt: "fixture" }));
	}
	globalThis.fetch = async () => response(catalog([nativeModel], 1, 13));
	assert.equal((await fetchCannbotModels({ jwt: "fixture" })).length, 1);
	let page = 0;
	globalThis.fetch = async () => response(catalog([nativeModel], 2, ++page === 1 ? 2 : 3));
	await assert.rejects(fetchCannbotModels({ jwt: "fixture" }), /读取期间变化/);
	globalThis.fetch = async () => response(catalog([], 0, 0));
	assert.deepEqual(await fetchCannbotModels({ jwt: "fixture" }), []);
});

test("preview reports additions, inactive/missing models and known metadata only", () => {
	assert.deepEqual(previewModelChanges([
		{ id: "existing", contextWindow: 1000, maxTokens: 100 }, { id: "gone" },
	], [{ id: "existing", contextWindow: 2000 }, { id: "new", maxTokens: 16 }]), [
		"变更：existing contextWindow：1000 → 2000",
		"新增：new（contextWindow=未知，maxTokens=16）",
		"上游未启用或未列出：gone（不自动删除）",
	]);
	assert.deepEqual(previewModelChanges([{ id: "same", maxTokens: 16 }], [{ id: "same", maxTokens: 16 }]), []);
});

test("default commands only GET catalog and preserve config/session bytes", async () => {
	await fixtures();
	const before = await Promise.all([readFile(sessionPath, "utf8"), readFile(configPath, "utf8")]);
	let calls = 0;
	globalThis.fetch = async (url, options) => {
		calls++;
		assert.match(url, /models\/list/);
		assert.equal(options.method, undefined);
		return response(catalog());
	};
	assert.ok((await run("cannbot-check")).some(n => n.message.includes("未发送推理请求")));
	assert.ok((await run("cannbot-models")).some(n => n.message.includes("无变化")));
	assert.equal(calls, 2);
	assert.deepEqual(await Promise.all([readFile(sessionPath, "utf8"), readFile(configPath, "utf8")]), before);
});

test("explicit model check sends minimal isolated prompt and no transcript/tools", async () => {
	await fixtures();
	let calls = 0;
	globalThis.fetch = async (url, options) => {
		calls++;
		if (url.includes("models/list")) return response(catalog());
		assert.equal(url, `${UPSTREAM_GATEWAY}/chat/completions`);
		assert.equal(options.method, "POST");
		assert.deepEqual(JSON.parse(options.body), { model: "test-model", messages: [{ role: "user", content: "Reply with OK only." }], max_tokens: 16, stream: false });
		return response({ choices: [{ message: { role: "assistant", content: "OK" } }] });
	};
	assert.ok((await run("cannbot-check", "test-model")).some(n => n.message.includes("推理接口返回有效响应")));
	assert.equal(calls, 2);
});

test("unknown models, endpoint overrides and malformed args never trigger inference", async () => {
	globalThis.fetch = async (url, options) => {
		assert.equal(options.method, undefined);
		assert.match(url, /models\/list/);
		return response(catalog());
	};
	await fixtures();
	assert.ok((await run("cannbot-check", "unknown")).some(n => n.message.includes("未发送推理请求")));
	await fixtures({ model: { baseUrl: "https://elsewhere.invalid/v1" } });
	assert.ok((await run("cannbot-check", "test-model")).some(n => n.message.includes("未发送推理请求")));
	await fixtures({ baseUrl: "http://127.0.0.1:8088/v1" });
	assert.ok((await run("cannbot-check", "test-model")).some(n => n.message.includes("未发送推理请求")));
	globalThis.fetch = () => { throw new Error("unexpected fetch"); };
	assert.ok((await run("cannbot-check", "two ids")).some(n => n.message.includes("用法")));
	assert.ok((await run("cannbot-models", "write")).some(n => n.message.includes("用法")));
});

test("VK-only diagnosis never refreshes and errors omit raw network details", async () => {
	await fixtures({ expired: true });
	const before = await readFile(sessionPath, "utf8");
	let calls = 0;
	globalThis.fetch = (url, options) => {
		calls++;
		assert.ok(!url.includes("oauth/refresh"));
		assert.equal(options.headers.Authorization, undefined);
		assert.equal(options.headers["x-api-vkey"], "fixture-vk");
		throw new Error("secret-fixture-error");
	};
	const result = await run("cannbot-check", "test-model");
	assert.equal(calls, 2);
	assert.ok(result.some(n => n.message.includes("无或已过期")));
	assert.equal(await readFile(sessionPath, "utf8"), before);
	await writeFile(configPath, "invalid json");
	assert.ok((await run("cannbot-models")).some(n => n.message.includes("无法读取或解析")));
	await fixtures();
	const errors = await run("cannbot-check");
	assert.ok(errors.some(n => n.message.includes("网络/TLS/代理")));
	assert.ok(errors.every(n => !n.message.includes("secret-fixture-error")));
});

test("probe rejects malformed and empty successes, accepts reasoning text, classifies status", async () => {
	for (const body of [null, {}, { choices: [] }, { choices: [{ message: { role: "assistant", content: null } }] }]) {
		globalThis.fetch = async () => response(body);
		await assert.rejects(probeCannbotModel("test-model", { jwt: "fixture" }));
	}
	globalThis.fetch = async () => response({ choices: [{ message: { role: "assistant", reasoning_content: "Thinking" } }] });
	await probeCannbotModel("test-model", { jwt: "fixture" });
	for (const [status, fragment] of [[401, "认证"], [403, "权限"], [404, "模型或接口"], [429, "额度"], [503, "上游"], [400, "API 类型"]]) {
		assert.match(httpFailure(status), new RegExp(fragment));
	}
});

const loginTokens = { accessToken: validJwt, refreshToken: "fixture-oauth-refresh", expiresIn: 3600 };
const callback = `vscode://CANN-PUB.cannbot-toolkit/oauth-callback?token=${encodeURIComponent(validJwt)}&refreshToken=fixture-oauth-refresh&expiresIn=3600`;
function sseResponse(text, split = 3) {
	const bytes = new TextEncoder().encode(text);
	return new Response(new ReadableStream({ start(controller) {
		for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
		controller.close();
	} }), { headers: { "Content-Type": "text/event-stream" } });
}
function pendingInput(_title, _placeholder, { signal }) {
	return new Promise(resolve => {
		if (signal.aborted) resolve(undefined);
		else signal.addEventListener("abort", () => resolve(undefined), { once: true });
	});
}

test("Pi VK takes precedence, survives without opencode and is written with 0600", async () => {
	await fixtures();
	const legacyBefore = await readFile(authPath, "utf8");
	await savePiVk("fixture-independent-vk");
	assert.equal(await readPiVk(), "fixture-independent-vk");
	assert.equal((await inspectCredentials()).vk, "fixture-independent-vk");
	assert.equal((await stat(piVkPath)).mode & 0o777, 0o600);
	assert.equal(await readFile(authPath, "utf8"), legacyBefore);
	await jsonFile(authPath, {});
	assert.equal((await inspectCredentials()).vk, "fixture-independent-vk");
	await assert.rejects(savePiVk("bad key"), /空白/);
	await writeFile(piVkPath, "broken secret JSON");
	await assert.rejects(savePiVk("replacement"), /凭证文件格式异常/);
	assert.equal(await readFile(piVkPath, "utf8"), "broken secret JSON");
});

test("VK command imports only after confirmation and never prints the key", async () => {
	await fixtures();
	const before = await readFile(piVkPath, "utf8");
	await run("cannbot-vk", "import", { ui: { confirm: async () => false } });
	assert.equal(await readFile(piVkPath, "utf8"), before);
	const notices = await run("cannbot-vk", "import", { ui: { confirm: async () => true } });
	assert.equal(await readPiVk(), "fixture-vk");
	assert.ok(notices.every(n => !n.message.includes("fixture-vk")));
	await run("cannbot-vk", "", { ui: { input: async () => "replacement-vk", confirm: async () => false } });
	assert.equal(await readPiVk(), "fixture-vk");
	assert.ok((await run("cannbot-vk", "do-not-accept-key")).some(n => n.message.includes("不要把密钥")));
});

test("sync plan preserves custom fields and other providers, migrates only recognized helper calls", () => {
	const config = { custom: true, providers: {
		other: { apiKey: "fixture-other-key", models: [{ id: "other-model" }] },
		cannbot: { baseUrl: "http://127.0.0.1:8088/v1", api: "openai-completions", apiKey: "!node cannbot-credential.mjs jwt",
			headers: { "x-api-vkey": "!node cannbot-credential.mjs vk", "X-Custom": "keep" }, compat: { maxTokensField: "max_tokens" },
			models: [{ id: "test-model", contextWindow: 1000, maxTokens: 100, reasoning: true, input: ["text", "image"], cost: { input: 1 }, custom: "keep" }, { id: "gone", custom: "keep-too" }] },
	} };
	const original = structuredClone(config);
	const plan = buildSyncPlan(config, [{ id: "test-model", contextWindow: 2000, maxTokens: 200 }, { id: "new", contextWindow: 3000, maxTokens: 300 }, { id: "unknown" }], UPSTREAM_GATEWAY);
	assert.deepEqual(config, original);
	assert.deepEqual(plan.config.providers.other, config.providers.other);
	assert.equal(plan.config.providers.cannbot.apiKey, "cannbot-extension");
	assert.deepEqual(plan.config.providers.cannbot.headers, { "X-Custom": "keep" });
	assert.deepEqual(plan.config.providers.cannbot.models[0], { ...config.providers.cannbot.models[0], contextWindow: 2000, maxTokens: 200 });
	assert.deepEqual(plan.config.providers.cannbot.models[1], config.providers.cannbot.models[1]);
	assert.deepEqual(plan.config.providers.cannbot.models[2], { id: "new", contextWindow: 3000, maxTokens: 300 });
	assert.ok(plan.notes.some(n => n.includes("未添加：unknown")));
	assert.ok(plan.notes.some(n => n.includes("保留：gone")));
});

test("sync protects custom gateways/API, explicit auth and unknown limits", () => {
	for (const provider of [{ baseUrl: "https://custom.invalid/v1", models: [] }, { api: "anthropic-messages", models: [] }]) {
		assert.throws(() => buildSyncPlan({ providers: { cannbot: provider } }, [], UPSTREAM_GATEWAY), /自定义/);
	}
	const cfg = { providers: { cannbot: { baseUrl: UPSTREAM_GATEWAY, api: "openai-completions", apiKey: "!custom-helper", headers: { "x-api-vkey": "!custom-vk" }, modelOverrides: { existing: { maxTokens: 10 } }, models: [{ id: "existing", contextWindow: 100, maxTokens: 50 }] } } };
	const plan = buildSyncPlan(cfg, [{ id: "existing", maxTokens: 200 }], UPSTREAM_GATEWAY);
	assert.equal(plan.config.providers.cannbot.models[0].maxTokens, 50);
	assert.equal(plan.config.providers.cannbot.apiKey, "!custom-helper");
	assert.equal(plan.config.providers.cannbot.headers["x-api-vkey"], "!custom-vk");
	assert.deepEqual(plan.config.providers.cannbot.modelOverrides, cfg.providers.cannbot.modelOverrides);
	assert.ok(plan.notes.some(n => n.includes("未更新")));
});

test("config apply backs up exact bytes, uses 0600, detects concurrent changes and symlinks", async () => {
	await fixtures();
	const snapshot = await readConfigSnapshot();
	const plan = buildSyncPlan(snapshot.config, [{ id: "test-model", contextWindow: 2000, maxTokens: 200 }], UPSTREAM_GATEWAY);
	const backup = await applySyncPlan(snapshot, plan);
	assert.equal(await readFile(backup, "utf8"), snapshot.raw);
	assert.equal((await stat(backup)).mode & 0o777, 0o600);
	assert.equal((await stat(configPath)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), plan.config);
	await assert.rejects(applySyncPlan(snapshot, plan), /已被其他操作修改/);
	const linkPath = join(home, "model-link.json");
	await symlink(configPath, linkPath);
	const fresh = await readConfigSnapshot();
	await assert.rejects(applySyncPlan({ ...fresh, path: linkPath }, plan), /符号链接/);
	assert.ok(!(await readdir(join(home, "agent"))).some(name => name.endsWith(".tmp")));
});

test("sync command cancellation and preview never change configuration", async () => {
	await fixtures();
	const before = await readFile(configPath, "utf8");
	const beforeFiles = await readdir(join(home, "agent"));
	globalThis.fetch = async () => response(catalog([{ ...nativeModel, contextLength: 2000 }]));
	await run("cannbot-models");
	const notices = await run("cannbot-models", "sync", { ui: { confirm: async () => false } });
	assert.ok(notices.some(n => n.message.includes("已取消")));
	assert.equal(await readFile(configPath, "utf8"), before);
	assert.deepEqual(await readdir(join(home, "agent")), beforeFiles);
});

test("confirmed sync refreshes only cannbot without network; refresh failure keeps saved backup", async () => {
	await fixtures();
	globalThis.fetch = async () => response(catalog([{ ...nativeModel, contextLength: 2000 }]));
	let refreshOptions;
	const result = await run("cannbot-models", "sync", {
		ui: { confirm: async () => true },
		modelRegistry: { refresh: async options => { refreshOptions = options; throw new Error("fixture-refresh-failure"); } },
	});
	assert.deepEqual(refreshOptions, { allowNetwork: false, providers: ["cannbot"] });
	assert.equal(JSON.parse(await readFile(configPath, "utf8")).providers.cannbot.models[0].contextWindow, 2000);
	assert.ok(result.some(n => n.message.includes("配置已写入，但运行时刷新失败")));
	assert.ok(result.every(n => !n.message.includes("fixture-refresh-failure")));
	assert.ok((await readdir(join(home, "agent"))).some(name => name.endsWith(".bak")));
});

test("confirmation-time configuration edits are not overwritten", async () => {
	await fixtures();
	globalThis.fetch = async () => response(catalog());
	const changed = { providers: { cannbot: { models: [{ id: "user-edited" }] } }, userChange: true };
	const result = await run("cannbot-models", "sync", { ui: { confirm: async () => { await jsonFile(configPath, changed); return true; } } });
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), changed);
	assert.ok(result.some(n => n.message.includes("已被其他操作修改")));
});

test("sync bootstraps missing models.json without inventing capability metadata", async () => {
	const original = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(home, "fresh-agent");
	try {
		const snapshot = await readConfigSnapshot(true);
		const plan = buildSyncPlan(snapshot.config, [{ id: "new", contextWindow: 1000, maxTokens: 100 }], UPSTREAM_GATEWAY);
		assert.equal(await applySyncPlan(snapshot, plan), undefined);
		assert.deepEqual(plan.config.providers.cannbot.models, [{ id: "new", contextWindow: 1000, maxTokens: 100 }]);
		assert.equal(plan.config.providers.cannbot.compat.maxTokensField, "max_tokens");
	} finally { process.env.PI_CODING_AGENT_DIR = original; }
});

test("SSE parser handles fragmented UTF-8, CRLF, multiple data lines and ignores heartbeats", async () => {
	const text = `: 心跳\r\n\r\ndata: {"type":"connected"}\r\n\r\nevent: token\r\ndata: {"accessToken":${JSON.stringify(validJwt)},\r\ndata: "refreshToken":"fixture-oauth-refresh","expiresIn":3600,"state":"fixture-state"}\r\n\r\n`;
	globalThis.fetch = async url => { assert.match(url, /state=fixture-state$/); return sseResponse(text); };
	assert.deepEqual(await waitOAuthTokens("fixture-state", new AbortController().signal), loginTokens);
});

test("SSE error payloads and mismatched state cannot become tokens or leak credentials", async () => {
	for (const payload of [{ ...loginTokens, state: "wrong-state" }, { ...loginTokens, error: "secret-server-detail" }]) {
		globalThis.fetch = async () => sseResponse(`data: ${JSON.stringify(payload)}\n\n`);
		await assert.rejects(waitOAuthTokens("fixture-state", new AbortController().signal), error => !error.message.includes("secret-server-detail") && !error.message.includes(validJwt));
	}
	globalThis.fetch = async () => response({ not: "sse" });
	await assert.rejects(waitOAuthTokens("fixture-state", new AbortController().signal), /不是 SSE/);
});

test("SSE cancellation cancels reader and prevents late result", async () => {
	let cancelled = false;
	globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
	const controller = new AbortController();
	const pending = waitOAuthTokens("fixture-state", controller.signal);
	await new Promise(resolve => setImmediate(resolve));
	controller.abort();
	await assert.rejects(pending, error => error.name === "AbortError");
	assert.equal(cancelled, true);
});

test("SSE login wins and dismisses manual input without displaying tokens", async () => {
	const notices = [];
	let dismissed = false;
	globalThis.fetch = async url => url.includes("/oauth/authorize")
		? response({ authorizeUrl: "https://auth.example/authorize", state: "fixture-state" })
		: sseResponse(`data: ${JSON.stringify(loginTokens)}\n\n`);
	const result = await runOAuthLogin({ notify: text => notices.push(text), input: (...args) => {
		args[2].signal.addEventListener("abort", () => { dismissed = true; }, { once: true });
		return pendingInput(...args);
	} }, async () => true, new AbortController().signal);
	assert.deepEqual(result, loginTokens);
	assert.equal(dismissed, true);
	assert.ok(notices.every(text => !text.includes(validJwt) && !text.includes("fixture-oauth-refresh")));
});

test("manual login wins, cancels SSE and supports connection failure fallback", async () => {
	let cancelled = false;
	globalThis.fetch = async url => url.includes("/oauth/authorize")
		? response({ authorizeUrl: "https://auth.example/authorize", state: "fixture-state" })
		: new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
	assert.deepEqual(await runOAuthLogin({ notify() {}, input: async () => callback }, async () => true, new AbortController().signal), loginTokens);
	assert.equal(cancelled, true);
	const notices = [];
	globalThis.fetch = async url => url.includes("/oauth/authorize")
		? response({ authorizeUrl: "https://auth.example/authorize", state: "fixture-state" })
		: response({}, 503);
	const result = await runOAuthLogin({ notify: text => notices.push(text), input: async () => {
		await new Promise(resolve => setTimeout(resolve, 10)); return callback;
	} }, async () => true, new AbortController().signal);
	assert.deepEqual(result, loginTokens);
	assert.ok(notices.some(text => text.includes("自动接收未取得 token")));
});

test("OAuth validates authorization URL and callback protocol", async () => {
	for (const authorizeUrl of ["file:///private/file", "https://user:pass@auth.example", "https://auth.example?token=secret"]) {
		globalThis.fetch = async () => response({ authorizeUrl, state: "fixture-state" });
		await assert.rejects(requestOAuthAuthorization(new AbortController().signal), /授权地址格式异常/);
	}
	assert.deepEqual(callbackTokens(callback), loginTokens);
	assert.equal(callbackTokens("https://other.example?token=secret"), undefined);
	assert.equal(callbackTokens("file:///tmp?token=secret"), undefined);
});

test("token writes preserve session fields, reject expired tokens and honor cancellation", async () => {
	await fixtures();
	await saveOAuthTokens(loginTokens);
	const saved = JSON.parse(await readFile(sessionPath, "utf8"));
	assert.equal(saved.sessionId, "fixture-session");
	assert.equal(saved.refreshToken, "fixture-oauth-refresh");
	assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
	const before = await readFile(sessionPath, "utf8");
	await assert.rejects(saveOAuthTokens({ ...loginTokens, accessToken: jwt(1) }), /已过期/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(saveOAuthTokens(loginTokens, controller.signal));
	assert.equal(await saveCallbackUrl("vscode://callback?token=bad-token"), false);
	assert.equal(await readFile(sessionPath, "utf8"), before);
});

test("manual command is cancelled on session shutdown and status never contains tokens", async () => {
	await fixtures();
	const before = await readFile(sessionPath, "utf8");
	const registered = new Map(), events = new Map(), notices = [];
	register({ registerProvider() {}, on(name, handler) { events.set(name, handler); }, registerCommand(name, command) { registered.set(name, command); } });
	const ctx = { hasUI: true, ui: { input: pendingInput, notify: text => notices.push(text) } };
	const pending = registered.get("cannbot-login").handler("manual", ctx);
	await new Promise(resolve => setImmediate(resolve));
	await registered.get("cannbot-login").handler("status", ctx);
	assert.ok(notices.some(text => text.includes("进行中")));
	events.get("session_shutdown")();
	await pending;
	assert.equal(await readFile(sessionPath, "utf8"), before);
	assert.ok(notices.some(text => text.includes("已取消授权")));
	assert.ok(notices.every(text => !text.includes(validJwt) && !text.includes("fixture-refresh")));
});

test("in-flight refresh cannot overwrite a newer completed login", async () => {
	await fixtures({ expired: true });
	let finishRefresh;
	globalThis.fetch = async url => {
		assert.match(url, /oauth\/refresh$/);
		return new Promise(resolve => { finishRefresh = resolve; });
	};
	const pending = loadCredentials();
	while (!finishRefresh) await new Promise(resolve => setImmediate(resolve));
	await saveOAuthTokens(loginTokens);
	finishRefresh(response({ accessToken: jwt(Math.floor(Date.now() / 1000) + 7200), refreshToken: "fixture-stale-refresh" }));
	assert.equal((await pending).jwt, validJwt);
	assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).refreshToken, "fixture-oauth-refresh");
});

test("real Pi registry loads synced models, resolves auth and reselects updated current model", { skip: !process.env.PI_TEST_PACKAGE_DIR }, async () => {
	await fixtures();
	const base = pathToFileURL(`${process.env.PI_TEST_PACKAGE_DIR}/dist/`);
	const { ModelRuntime } = await import(new URL("core/model-runtime.js", base).href);
	const { ModelRegistry } = await import(new URL("core/model-registry.js", base).href);
	const { AuthStorage } = await import(new URL("core/auth-storage.js", base).href);
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: configPath,
		modelsStorePath: join(home, "integration-models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
	const registry = new ModelRegistry(runtime);
	const registered = new Map(), events = new Map(), notices = [];
	let selected;
	register({
		registerProvider: (...args) => registry.registerProvider(...args),
		on(name, handler) { events.set(name, handler); },
		registerCommand(name, command) { registered.set(name, command); },
		setModel: async model => { selected = model; return true; },
	});
	await registry.refresh({ allowNetwork: false, providers: ["cannbot"] });
	const current = registry.find("cannbot", "test-model");
	assert.ok(current);
	globalThis.fetch = async url => { assert.match(url, /models\/list/); return response(catalog([{ ...nativeModel, contextLength: 2000 }])); };
	const ctx = { hasUI: true, model: current, modelRegistry: registry, waitForIdle: async () => {},
		ui: { confirm: async () => true, notify: (message, type) => notices.push({ message, type }) } };
	await registered.get("cannbot-models").handler("sync", ctx);
	assert.ok(notices.every(n => n.type !== "error"));
	assert.ok(notices.some(n => n.message.includes("Pi 模型列表已刷新")));
	const updated = registry.find("cannbot", "test-model");
	assert.equal(updated.contextWindow, 2000);
	assert.equal(selected.contextWindow, 2000);
	assert.equal(updated.compat.maxTokensField, "max_tokens");
	assert.equal((await registry.getApiKeyAndHeaders(updated)).ok, true);
	assert.ok(registry.getAvailable().some(model => model.provider === "cannbot"));
	const event = { headers: { Authorization: "Bearer dummy", authorization: "old", "X-Custom": "keep" } };
	await events.get("before_provider_headers")(event, { ...ctx, model: updated });
	assert.equal(event.headers.Authorization, `Bearer ${validJwt}`);
	assert.equal(event.headers.authorization, null);
	assert.equal(event.headers["x-api-vkey"], "fixture-vk");
	assert.equal(event.headers["X-Custom"], "keep");
});

async function independentFixtures() {
	await fixtures();
	await savePiVk("fixture-independent-vk");
	const snapshot = await readConfigSnapshot();
	await applySyncPlan(snapshot, buildSyncPlan(snapshot.config, [{ id: "test-model", contextWindow: 1000, maxTokens: 100 }], UPSTREAM_GATEWAY));
}
function menuHarness(choices, { confirms = [], input, serviceOverrides = {}, model = { provider: "cannbot", id: "test-model" } } = {}) {
	const screens = [], notices = [], counts = { auth: 0, vk: 0, commit: 0 };
	const services = {
		gateway: UPSTREAM_GATEWAY,
		inspect: inspectCredentials,
		canRenew: async () => !!(JSON.parse(await readFile(sessionPath, "utf8"))).refreshToken,
		hasLegacyVk: async () => !!(JSON.parse(await readFile(authPath, "utf8"))).cannbot?.key,
		renew: signal => loadCredentials(signal, true),
		authorize: async () => { counts.auth++; await saveOAuthTokens(loginTokens); return true; },
		storeVk: async (ctx, importLegacy) => {
			if (!await ctx.ui.confirm("保存独立密钥？", "仅测试确认")) return false;
			counts.vk++;
			const value = importLegacy ? JSON.parse(await readFile(authPath, "utf8")).cannbot.key : await ctx.ui.input("连接密钥");
			if (!value) return false;
			await savePiVk(value); return true;
		},
		catalog: fetchCannbotModels,
		probe: probeCannbotModel,
		commit: async (snapshot, plan, _ctx, signal) => { counts.commit++; await applySyncPlan(snapshot, plan, signal); },
		explain: error => error instanceof Error && error.constructor.name === "CannbotError" ? error.message : "网络或本地操作失败（详情已脱敏）",
		...serviceOverrides,
	};
	const ctx = { hasUI: true, model, waitForIdle: async () => {}, ui: {
		notify: (message, type) => notices.push({ message, type }),
		input: input ?? (async () => "fixture-new-vk"),
		confirm: async (title, message, opts) => {
			screens.push({ title, message, confirm: true });
			const answer = confirms.shift();
			return typeof answer === "function" ? answer(title, message, opts) : answer ?? false;
		},
		select: async (title, options, opts) => {
			screens.push({ title, options });
			if (title.startsWith("正在")) return pendingInput(title, undefined, opts);
			const wanted = choices.shift();
			if (typeof wanted === "function") return wanted(title, options, opts);
			if (wanted === undefined) return undefined;
			const selected = options.find(option => option.startsWith(wanted));
			assert.ok(selected, `Menu option ${wanted} not present in ${options.join(" | ")}`);
			return selected;
		},
	} };
	const menu = createCannbotMenu(services);
	return { menu, ctx, screens, notices, counts, choices, confirms, services };
}

test("menu entry is read-only and highlights migration without exposing credentials", async () => {
	await fixtures();
	const before = await Promise.all([readFile(configPath, "utf8"), readFile(sessionPath, "utf8"), readFile(piVkPath, "utf8")]);
	globalThis.fetch = () => { throw new Error("Entry must not use network"); };
	const h = menuHarness([(_title, options) => { assert.ok(options[0].startsWith("完成独立设置")); return "退出"; }]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.deepEqual(await Promise.all([readFile(configPath, "utf8"), readFile(sessionPath, "utf8"), readFile(piVkPath, "utf8")]), before);
	assert.ok(h.screens[0].title.includes("尚未完成独立设置"));
	assert.ok(h.screens.every(s => !JSON.stringify(s).includes(validJwt) && !JSON.stringify(s).includes("fixture-vk")));
});

test("ready homepage removes setup recommendation and does not pretend inference is verified", async () => {
	await independentFixtures();
	globalThis.fetch = () => { throw new Error("No network on entry"); };
	const h = menuHarness([(_title, options) => { assert.ok(!options.some(s => s.includes("完成独立设置"))); return "退出"; }]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.ok(h.screens[0].title.includes("不等于推理已验证"));
});

test("missing credentials are guided once and model-update task resumes automatically", async () => {
	await fixtures(); await jsonFile(sessionPath, {}); await jsonFile(authPath, {});
	const before = await readFile(configPath, "utf8");
	let gets = 0;
	globalThis.fetch = async url => { assert.match(url, /models\/list/); gets++; return response(catalog()); };
	const h = menuHarness(["检查模型更新", "准备账号后继续检查模型更新", "返回首页", "退出"]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.auth, 1); assert.equal(gets, 1); assert.equal(h.counts.commit, 0);
	assert.equal(await readFile(configPath, "utf8"), before);
	assert.ok(h.screens.some(s => s.title.includes("发现")));
	assert.equal(h.choices.length, 0);
});

test("cancelling prerequisite preparation never authorizes or starts catalog requests", async () => {
	await fixtures(); await jsonFile(sessionPath, {}); await jsonFile(authPath, {});
	let gets = 0; globalThis.fetch = async () => { gets++; return response(catalog()); };
	const h = menuHarness(["检查模型更新", "返回首页", "退出"]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.auth, 0); assert.equal(gets, 0);
});

test("no-update result offers no meaningless apply button", async () => {
	await independentFixtures();
	globalThis.fetch = async () => response(catalog());
	const h = menuHarness(["检查模型更新", (title, options) => {
		assert.ok(title.includes("没有可写入更新")); assert.ok(!options.some(s => s.includes("应用"))); return "返回首页";
	}, "退出"]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.commit, 0);
});

test("model update requires explicit confirmation and preserves pending preview on cancel", async () => {
	await independentFixtures();
	const before = await readFile(configPath, "utf8");
	globalThis.fetch = async () => response(catalog([{ ...nativeModel, contextLength: 2000 }]));
	const h = menuHarness(["检查模型更新", "备份并应用", "返回首页", "退出"], { confirms: [false] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.commit, 0); assert.equal(await readFile(configPath, "utf8"), before);
	assert.ok(h.notices.some(n => n.message.includes("已取消配置更新")));
	assert.equal(h.choices.length, 0);
});

test("confirmed update saves configuration and backs it up", async () => {
	await independentFixtures();
	const before = await readFile(configPath, "utf8");
	globalThis.fetch = async () => response(catalog([{ ...nativeModel, contextLength: 2000 }]));
	const h = menuHarness(["检查模型更新", "备份并应用", "退出"], { confirms: [true] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.commit, 1);
	assert.equal(JSON.parse(await readFile(configPath, "utf8")).providers.cannbot.models[0].contextWindow, 2000);
	const backups = (await readdir(join(home, "agent"))).filter(name => name.endsWith(".bak"));
	assert.ok((await Promise.all(backups.map(name => readFile(join(home, "agent", name), "utf8")))).includes(before));
});

test("setup keeps successful steps after failure and retries only the remaining config step", async () => {
	await fixtures(); await jsonFile(sessionPath, {});
	globalThis.fetch = async () => response({}, 503);
	const h = menuHarness(["完成独立设置", "开始完成剩余 3", "退出"], { confirms: [true, true] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.auth, 1); assert.equal(h.counts.vk, 1); assert.equal(h.counts.commit, 0);
	assert.equal(await readPiVk(), "fixture-vk");
	assert.ok(h.notices.some(n => n.message.includes("已完成并保留")));
	globalThis.fetch = async () => response(catalog());
	h.choices.push("完成独立设置", "开始完成剩余 1", "退出");
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.auth, 1); assert.equal(h.counts.vk, 1); assert.equal(h.counts.commit, 1);
	assert.ok(h.screens.some(s => s.title.includes("已有准备会跳过") && s.options?.[0].includes("剩余 1")));
});

test("first setup reuses an existing authorization and cancels before importing keys", async () => {
	await fixtures();
	globalThis.fetch = () => { throw new Error("No network before key import consent"); };
	const before = await readFile(piVkPath, "utf8");
	const h = menuHarness(["完成独立设置", "开始完成剩余 2", "退出"], { confirms: [false] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.auth, 0); assert.equal(h.counts.vk, 0); assert.equal(h.counts.commit, 0);
	assert.equal(await readFile(piVkPath, "utf8"), before);
});

test("non-auth HTTP failures never encourage repeated authorization", async () => {
	for (const status of [403, 429, 503]) {
		await independentFixtures();
		globalThis.fetch = async () => response({ secret: "must-not-show" }, status);
		const h = menuHarness(["检查连接", (title, options) => {
			assert.ok(!options.some(s => s.includes("恢复授权"))); return "查看详情";
		}, "返回首页", "退出"]);
		await h.menu(h.ctx, new AbortController().signal);
		assert.equal(h.counts.auth, 0);
		assert.ok(h.notices.every(n => !n.message.includes("must-not-show")));
	}
});

test("401 recovery resumes list check, but never silently retries paid inference", async () => {
	await independentFixtures();
	let posts = 0, gets = 0;
	globalThis.fetch = async (url, options) => {
		if (options.method === "POST") { posts++; return response({}, 401); }
		gets++; assert.match(url, /models\/list/); return response(catalog());
	};
	const h = menuHarness(["检查连接", "测试当前模型", "恢复授权并重新检查连接", "返回首页", "退出"], { confirms: [true] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(posts, 1); assert.equal(gets, 2); assert.equal(h.counts.auth, 1);
});

test("probe confirmation cancellation and viewing details do not trigger inference or extra GETs", async () => {
	await independentFixtures(); let gets = 0;
	globalThis.fetch = async (url, options) => { assert.equal(options.method, undefined); gets++; return response(catalog()); };
	const h = menuHarness(["检查连接", "查看详情", "测试当前模型", "返回首页", "退出"], { confirms: [false] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(gets, 1);
	assert.equal(h.screens.filter(s => s.confirm).length, 1);
});

test("successful short probe remains accurately labeled on the homepage", async () => {
	await independentFixtures(); let posts = 0;
	globalThis.fetch = async (_url, options) => {
		if (options.method === "POST") { posts++; return response({ choices: [{ message: { role: "assistant", content: "OK" } }] }); }
		return response(catalog());
	};
	const h = menuHarness(["检查连接", "测试当前模型", "返回首页", (title) => { assert.ok(title.includes("已通过独立短文本测试")); return "退出"; }], { confirms: [true] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(posts, 1);
});

test("expired credentials can renew after consent without requiring browser authorization", async () => {
	await independentFixtures(); await jsonFile(sessionPath, { accessToken: jwt(1), refreshToken: "fixture-refresh" }); await jsonFile(piVkPath, {}); await jsonFile(authPath, {});
	let refreshes = 0;
	globalThis.fetch = async url => {
		if (url.endsWith("oauth/refresh")) { refreshes++; return response(loginTokens); }
		return response(catalog());
	};
	const h = menuHarness(["检查模型更新", "返回首页", "退出"]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(refreshes, 1); assert.equal(h.counts.auth, 0);
});

test("progress cancellation prevents late catalog results from offering config writes", async () => {
	await independentFixtures();
	let finish;
	globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
	const h = menuHarness(["检查模型更新", "退出"]);
	const originalSelect = h.ctx.ui.select;
	h.ctx.ui.select = async (title, options, opts) => {
		if (title.startsWith("正在")) {
			while (!finish) await new Promise(resolve => setImmediate(resolve));
			return "取消本次操作";
		}
		return originalSelect(title, options, opts);
	};
	const before = await readFile(configPath, "utf8");
	await h.menu(h.ctx, new AbortController().signal);
	finish(response(catalog([{ ...nativeModel, contextLength: 2000 }])));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.counts.commit, 0); assert.equal(await readFile(configPath, "utf8"), before);
	assert.ok(!h.screens.some(s => s.options?.some(o => o.startsWith("备份并应用"))));
});

test("shutdown after confirmation cancels before backup/write", async () => {
	await independentFixtures();
	const controller = new AbortController(), before = await readFile(configPath, "utf8");
	const files = await readdir(join(home, "agent"));
	globalThis.fetch = async () => response(catalog([{ ...nativeModel, contextLength: 2000 }]));
	const h = menuHarness(["检查模型更新", "备份并应用"], { confirms: [() => { controller.abort(); return true; }] });
	await h.menu(h.ctx, controller.signal);
	assert.equal(h.counts.commit, 0); assert.equal(await readFile(configPath, "utf8"), before);
	assert.deepEqual(await readdir(join(home, "agent")), files);
});

test("plugin menu reuses manual authorization and handles headless/argument guard", async () => {
	await fixtures({ expired: true });
	const h = menuHarness(["账号与设置", "粘贴已有授权回调", "返回首页", "退出"], { input: async () => callback });
	await commands().get("cannbot-proxy").handler("", h.ctx);
	assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).refreshToken, "fixture-oauth-refresh");
	assert.ok(h.notices.every(n => !n.message.includes(validJwt)));
	assert.ok((await run("cannbot-proxy", "bad-args")).some(n => n.message.includes("无需参数")));
	assert.ok((await run("cannbot-proxy", "", { hasUI: false })).some(n => n.message.includes("交互式")));
});

test("fresh setup creates independent config with only confirmed missing steps", async () => {
	await fixtures(); await jsonFile(sessionPath, {}); await jsonFile(authPath, {}); await jsonFile(configPath, {});
	globalThis.fetch = async () => response(catalog());
	const h = menuHarness(["完成首次设置", "开始完成剩余 3", "退出"], { confirms: [true, true] });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.auth, 1); assert.equal(h.counts.vk, 1); assert.equal(h.counts.commit, 1);
	assert.equal(await readPiVk(), "fixture-new-vk");
	const config = JSON.parse(await readFile(configPath, "utf8"));
	assert.equal(config.providers.cannbot.apiKey, "cannbot-extension");
	assert.deepEqual(config.providers.cannbot.models, [{ id: "test-model", contextWindow: 1000, maxTokens: 100 }]);
});

test("recent check is invalidated after local configuration changes", async () => {
	await independentFixtures(); let gets = 0;
	globalThis.fetch = async () => { gets++; return response(catalog()); };
	const h = menuHarness(["检查连接", "返回首页", "退出"]);
	await h.menu(h.ctx, new AbortController().signal);
	const config = JSON.parse(await readFile(configPath, "utf8"));
	config.providers.cannbot.models[0].cost = { input: 1 };
	await jsonFile(configPath, config);
	h.choices.push(title => { assert.ok(title.includes("尚未在本菜单中验证")); assert.ok(!title.includes("最近检查")); return "退出"; });
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(gets, 1);
});

test("cancelled renewal cannot write a late token or launch browser authorization", async () => {
	await independentFixtures(); await jsonFile(sessionPath, { accessToken: jwt(1), refreshToken: "fixture-refresh" }); await jsonFile(piVkPath, {}); await jsonFile(authPath, {});
	let finish;
	globalThis.fetch = async url => { assert.match(url, /oauth\/refresh$/); return new Promise(resolve => { finish = resolve; }); };
	const h = menuHarness(["检查模型更新", "退出"]);
	const select = h.ctx.ui.select;
	h.ctx.ui.select = async (title, options, opts) => {
		if (title.startsWith("正在更新已有授权")) {
			while (!finish) await new Promise(resolve => setImmediate(resolve));
			return "取消本次操作";
		}
		return select(title, options, opts);
	};
	const before = await readFile(sessionPath, "utf8");
	await h.menu(h.ctx, new AbortController().signal);
	finish(response(loginTokens));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(await readFile(sessionPath, "utf8"), before);
	assert.equal(h.counts.auth, 0);
});

test("plugin rejects concurrent menus and closes dialogs on shutdown", async () => {
	await independentFixtures();
	const registered = new Map(), events = new Map(), notices = [];
	register({ registerProvider() {}, on(name, handler) { events.set(name, handler); }, registerCommand(name, command) { registered.set(name, command); } });
	let entered;
	const ready = new Promise(resolve => { entered = resolve; });
	const ctx = { hasUI: true, ui: {
		notify: message => notices.push(message),
		select: (title, options, opts) => { entered(); return pendingInput(title, undefined, opts); },
	} };
	const handler = registered.get("cannbot-proxy").handler;
	const pending = handler("", ctx);
	await ready;
	await handler("", ctx);
	assert.ok(notices.some(message => message.includes("菜单已打开")));
	events.get("session_shutdown")();
	await pending;
	await handler("", { ...ctx, ui: { ...ctx.ui, select: async () => "退出" } });
});

test("renewal service failures are reported without launching browser authorization", async () => {
	for (const status of [429, 503]) {
		await independentFixtures(); await jsonFile(sessionPath, { accessToken: jwt(1), refreshToken: "fixture-refresh" }); await jsonFile(piVkPath, {}); await jsonFile(authPath, {});
		const before = await readFile(sessionPath, "utf8");
		globalThis.fetch = async url => { assert.match(url, /oauth\/refresh$/); return response({ secret: "must-not-show" }, status); };
		const h = menuHarness(["检查模型更新", (title, options) => {
			assert.ok(!options.some(s => s.includes("恢复授权"))); return "返回首页";
		}, "退出"]);
		await h.menu(h.ctx, new AbortController().signal);
		assert.equal(h.counts.auth, 0);
		assert.equal(await readFile(sessionPath, "utf8"), before);
		assert.ok(h.notices.every(n => !n.message.includes("must-not-show")));
	}
});

test("rejected refresh token falls back to browser authorization", async () => {
	await independentFixtures(); await jsonFile(sessionPath, { accessToken: jwt(1), refreshToken: "fixture-refresh" }); await jsonFile(piVkPath, {}); await jsonFile(authPath, {});
	let gets = 0;
	globalThis.fetch = async url => url.endsWith("oauth/refresh") ? response({}, 401) : (gets++, response(catalog()));
	const h = menuHarness(["检查模型更新", "准备账号后继续检查模型更新", "返回首页", "退出"]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(h.counts.auth, 1); assert.equal(gets, 1);
	assert.ok(h.notices.some(n => n.message.includes("未能续期")));
});

test("plugin VK save honors menu cancellation before writing", async () => {
	await fixtures(); await jsonFile(sessionPath, { accessToken: validJwt }); await jsonFile(piVkPath, {});
	const registered = new Map(), events = new Map();
	register({ registerProvider() {}, on(name, handler) { events.set(name, handler); }, registerCommand(name, command) { registered.set(name, command); } });
	const before = await readFile(piVkPath, "utf8");
	let confirms = 0;
	const ctx = { hasUI: true, model: undefined, waitForIdle: async () => {}, ui: {
		notify() {},
		select: async (title, options) => title.startsWith("CANNBot Proxy") ? options.find(o => o.startsWith("完成独立设置")) : options.find(o => o.startsWith("开始完成")),
		confirm: async () => { confirms++; events.get("session_shutdown")(); return true; },
		input: async () => "fixture-late-vk",
	} };
	await registered.get("cannbot-proxy").handler("", ctx);
	assert.equal(confirms, 1);
	assert.equal(await readFile(piVkPath, "utf8"), before);
});

test("expired JWT renews before VK fallback, and VK-only 403 offers authorization recovery", async () => {
	await independentFixtures(); await jsonFile(sessionPath, { accessToken: jwt(1), refreshToken: "fixture-refresh" });
	let refreshes = 0, gets = 0, sawJwt = false;
	globalThis.fetch = async (url, options) => {
		if (url.endsWith("oauth/refresh")) { refreshes++; return response({}, 401); }
		gets++; sawJwt ||= !!options.headers.Authorization;
		return gets === 1 ? response({}, 403) : response(catalog());
	};
	const h = menuHarness(["检查连接", (title, options) => {
		assert.ok(title.includes("仅凭连接密钥")); return options.find(o => o.startsWith("恢复授权"));
	}, "返回首页", "退出"]);
	await h.menu(h.ctx, new AbortController().signal);
	assert.equal(refreshes, 1); assert.equal(h.counts.auth, 1); assert.equal(gets, 2); assert.ok(sawJwt);
});

test("actual Pi jiti loader discovers unified entry and retained commands", { skip: !process.env.PI_TEST_PACKAGE_DIR }, async () => {
	await fixtures();
	const { loadExtensions } = await import(pathToFileURL(`${process.env.PI_TEST_PACKAGE_DIR}/dist/core/extensions/loader.js`).href);
	const extensionPath = process.env.CANNBOT_EXTENSION ?? fileURLToPath(new URL("../sync/extensions/cannbot-proxy.ts", import.meta.url));
	const result = await loadExtensions([extensionPath], home);
	assert.equal(result.errors.length, 0);
	assert.equal(result.extensions.length, 1);
	const registered = result.extensions[0].commands;
	for (const name of ["cannbot-proxy", "cannbot-check", "cannbot-models", "cannbot-login", "cannbot-vk"]) assert.ok(registered.has(name));
	await registered.get("cannbot-proxy").handler("", { hasUI: true, ui: { notify() {}, select: async () => "退出" } });
});
