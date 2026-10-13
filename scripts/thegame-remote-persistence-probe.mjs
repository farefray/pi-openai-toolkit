// W-074 R3. Explicit opt-in; run ONLY in a disposable process, never inside pi-web.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as zlib from "node:zlib";
import { boundedFetch, completedReply, credentialStatus, DEADLINE_MS, normalizeThinking, readOnlyCredentialStore } from "./thegame-capability-probe.mjs";

export { credentialStatus, readOnlyCredentialStore } from "./thegame-capability-probe.mjs";
export const MODEL_IDS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna"];
export const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const RECALL_QUERY = 'Recall the exact fact from the earlier user message and the exact receipt from the earlier lookup result. Reply ONLY with a JSON object containing exactly the two string fields "fact" and "receipt". No markdown, explanation, or tool calls.';
const TOOL_NAME = "w074_synthetic_lookup";
const TOOL_SCHEMA = { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false };
const APPROVED_ROOT = fileURLToPath(new URL("../../../thegame/bin/qa/harness/", import.meta.url));
const TOOLKIT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_NAMES = ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "PI_CODING_AGENT_DIR", "JITI_FS_CACHE"];
const SETTLE_MS = 5_000; // Local abort/disposal grace, never an extra network workflow budget.
class ProbeFailure extends Error {
	constructor(code, blocked = false) { super(code); this.code = code; this.blocked = blocked; }
}
function requireCondition(ok, code, blocked = false) { if (!ok) throw new ProbeFailure(code, blocked); }
function pathKey(path) { const value = normalize(resolve(path)); return process.platform === "win32" ? value.toLowerCase() : value; }

export function parseArguments(argv) {
	const required = ["sdk", "auth", "host-adapter", "output-root", "model", "thinking", "live"];
	const args = {};
	requireCondition(argv.length === required.length * 2, "arguments-rejected", true);
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.slice(2);
		requireCondition(argv[i]?.startsWith("--") && required.includes(key) && !(key in args) && typeof argv[i + 1] === "string" && !argv[i + 1].startsWith("--"), "arguments-rejected", true);
		args[key] = argv[i + 1];
	}
	requireCondition(required.every((key) => args[key]), "arguments-rejected", true);
	requireCondition(args.live === "subscription" && MODEL_IDS.includes(args.model), "subscription-model-rejected", true);
	try { args.thinking = normalizeThinking(args.thinking); } catch { throw new ProbeFailure("thinking-rejected", true); }
	for (const key of ["sdk", "auth", "host-adapter", "output-root"]) requireCondition(isAbsolute(args[key]), "absolute-path-required", true);
	requireCondition(pathKey(args["output-root"]) === pathKey(APPROVED_ROOT), "output-root-rejected", true);
	requireCondition(basename(args["host-adapter"]) === "toolkit-context-projector.ts" && basename(dirname(args["host-adapter"])) === "lib", "source-adapter-required", true);
	return args;
}

export function validRecall(message, expected, signal) {
	if (!message || !completedReply(message, signal) || message.role !== "assistant" || !Array.isArray(message.content)) return false;
	if (message.content.some((block) => !["text", "thinking"].includes(block.type))) return false;
	try {
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
		const value = JSON.parse(text);
		return value !== null && !Array.isArray(value) && Object.keys(value).length === 2 &&
			Object.hasOwn(value, "fact") && Object.hasOwn(value, "receipt") && value.fact === expected.fact && value.receipt === expected.receipt;
	} catch { return false; }
}

function containsPlaintext(value, markers) {
	if (typeof value === "string") return markers.some((marker) => value.includes(marker));
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, child]) => {
		// Only actual encrypted wire fields are exempt, not signatures or arbitrary opaque-looking fields.
		const encrypted = key === "encrypted_content" && ["compaction", "reasoning"].includes(value.type);
		return markers.some((marker) => key.includes(marker)) || (!encrypted && containsPlaintext(child, markers));
	});
}
export function guardContinuation(payload, modelId, markers) {
	requireCondition(payload?.model === modelId && Array.isArray(payload.input), "continuation-model-or-input");
	const checkpoints = payload.input.filter((item) => item?.type === "compaction");
	requireCondition(checkpoints.length === 1 && typeof checkpoints[0].encrypted_content === "string" && checkpoints[0].encrypted_content.trim().length > 0, "continuation-checkpoint-count");
	requireCondition(!payload.input.some((item) => item?.type === "compaction_trigger"), "continuation-compaction-trigger");
	requireCondition(!containsPlaintext(payload.input, markers), "continuation-plaintext-leak");
}

export function isolateEnvironment(fixture) {
	const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
	const values = { HOME: join(fixture, "home"), USERPROFILE: join(fixture, "home"),
		TEMP: join(fixture, "temp"), TMP: join(fixture, "temp"), TMPDIR: join(fixture, "temp"),
		PI_CODING_AGENT_DIR: join(fixture, "agent"), JITI_FS_CACHE: "0" };
	for (const name of ENV_NAMES) process.env[name] = values[name];
	return () => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}

// Track underlying promises, not merely the timeout race. Late session construction is captured too.
function lifecycle(signal) {
	const pending = new Set();
	const sessions = new Set();
	function track(promise) {
		const p = Promise.resolve(promise);
		pending.add(p);
		void p.then(() => pending.delete(p), () => pending.delete(p));
		return p;
	}
	async function operation(fn) {
		signal.throwIfAborted();
		let onAbort;
		const aborted = new Promise((_, reject) => { onAbort = () => reject(new ProbeFailure("workflow-aborted", true)); signal.addEventListener("abort", onAbort, { once: true }); });
		try { return await Promise.race([track(Promise.resolve().then(fn)), aborted]); }
		finally { signal.removeEventListener("abort", onAbort); }
	}
	async function close(session) {
		await session.abort();
		await session.waitForIdle();
		await session.extensionRunner.emit({ type: "session_shutdown" });
		session.dispose();
		sessions.delete(session);
	}
	async function cleanup() {
		let timer;
		const settled = (async () => {
			// Abort every captured session before waiting for possibly stalled operations.
			for (const session of sessions) track(session.abort());
			while (pending.size) await Promise.allSettled([...pending]);
			for (const session of [...sessions]) await close(session);
			return true;
		})();
		try { return await Promise.race([settled, new Promise((resolve) => { timer = setTimeout(() => resolve(false), SETTLE_MS); })]); }
		catch { return false; }
		finally { clearTimeout(timer); }
	}
	return { operation, track, sessions, close, cleanup };
}

function sharedSnapshot(sdk, compat) {
	return { prototype: Object.getOwnPropertyDescriptors(sdk.ExtensionRunner.prototype),
		apis: compat.getApiProviders().map((provider) => [provider.api, Object.getOwnPropertyDescriptors(provider)]) };
}
function networkPayload(init) {
	let body = init?.body;
	const encoding = new Headers(init?.headers).get("content-encoding");
	if (encoding === "zstd") {
		requireCondition(typeof zlib.zstdDecompressSync === "function" && ArrayBuffer.isView(body), "sdk-body-seam", true);
		body = zlib.zstdDecompressSync(body).toString("utf8");
	} else requireCondition(!encoding, "sdk-body-seam", true);
	requireCondition(typeof body === "string", "sdk-body-seam", true);
	try { return JSON.parse(body); } catch { throw new ProbeFailure("sdk-body-seam", true); }
}

export async function runProbe(argv) {
	const args = parseArguments(argv); // Reject opt-out/borrowed paths before imports, credentials, or writes.
	requireCondition(pathKey(await realpath(args["output-root"])) === pathKey(APPROVED_ROOT), "output-root-alias-rejected", true);
	const output = await mkdtemp(join(args["output-root"], "W-074-S5-live-persistence-"));
	let fixture;
	let restoreEnvironment = () => {};
	const report = { status: "blocked", stages: { setup: false, compact: false, persisted: false, reopenRecall: false, forkRecall: false, sharedAudit: false },
		httpStatuses: [], httpCount: 0, elapsedMs: 0, credentialUnchanged: false, root: basename(output), cleanup: "not-started", code: "not-started" };
	await writeFile(join(output, "plan.json"), JSON.stringify({ maximumDispatches: 3, deadlineMs: DEADLINE_MS,
		allowedRoutes: [RESPONSES_URL], provider: "openai-codex", model: args.model, thinking: args.thinking,
		features: ["manual-compact", "persist", "reopen-exact-recall", "fork-pre-recall-exact-recall"],
		live: "subscription", credentialReadOnly: true, refresh: false, login: false, apiKeyFallback: false,
		transport: "sse", retries: 0, cacheWarming: false, automaticCompaction: false,
		search: false, images: false, websocket: false, diagnosticCapture: false }, null, 2), { flag: "wx" });
	const controller = new AbortController();
	const tracker = lifecycle(controller.signal);
	const originalFetch = globalThis.fetch;
	const consoleMethods = ["log", "info", "warn", "error", "debug"];
	const originalConsole = new Map(consoleMethods.map((name) => [name, console[name]]));
	const rows = [];
	let authBefore;
	let runtime, sdk, compat, beforeShared;
	let restoreStream;
	let phase = "setup";
	let failedCode;
	let toolExecutions = 0;
	let streamCalls = 0;
	const stageDispatches = new Set();
	const expected = { fact: `W074_FACT_${randomUUID().replaceAll("-", "")}`, receipt: `W074_RECEIPT_${randomUUID().replaceAll("-", "")}` };
	const markers = Object.values(expected);
	let checkpoint;
	let declaredTools;
	const started = Date.now();
	const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
	const abortProcess = () => controller.abort();
	process.on("SIGINT", abortProcess);
	process.on("SIGTERM", abortProcess);
	function reject(code, blocked = false) { failedCode ??= { code, blocked }; controller.abort(); throw new ProbeFailure(code, blocked); }
	function checkPayload(payload) {
		requireCondition(payload?.model === args.model && payload.stream === true && Array.isArray(payload.input), "request-model-or-stream");
		const triggers = payload.input.filter((item) => item?.type === "compaction_trigger");
		if (phase === "compact") {
			requireCondition(Array.isArray(payload.tools) && payload.tools.length === 1 && payload.tools[0].type === "function" && payload.tools[0].name === TOOL_NAME && isDeepStrictEqual(payload.tools[0].parameters, TOOL_SCHEMA), "compact-tool-schema");
			requireCondition(triggers.length === 1 && payload.input.at(-1)?.type === "compaction_trigger" && !payload.input.some((item) => item?.type === "compaction"), "compact-phase-input");
			requireCondition(isDeepStrictEqual(payload.tools, declaredTools), "compact-tool-cache");
			requireCondition(markers.every((marker) => JSON.stringify(payload.input).includes(marker)), "compact-markers-missing");
		} else {
			requireCondition(["reopenRecall", "forkRecall"].includes(phase), "dispatch-outside-stage");
			guardContinuation(payload, args.model, markers);
			// SDK may carry tool declarations in transcript updates, not body.tools.
			// Any live tool execution is forbidden independently of declaration placement.
			if (payload.tools !== undefined) requireCondition(Array.isArray(payload.tools) && payload.tools.every((tool) =>
				tool.type === "function" && tool.name === TOOL_NAME && isDeepStrictEqual(tool.parameters, TOOL_SCHEMA)), "continuation-tool-schema");
			requireCondition(isDeepStrictEqual(payload.input.find((item) => item?.type === "compaction"), checkpoint), "continuation-checkpoint-mismatch");
			// Also forbid accidental marker leakage in prompt/schema outside the input array.
			requireCondition(!containsPlaintext({ ...payload, input: undefined }, markers), "continuation-prompt-leak");
		}
	}
	const fetchBounded = boundedFetch(originalFetch, new Set([RESPONSES_URL]), 3, rows);
	const guardedFetch = (input, init) => tracker.track((async () => {
		try {
			controller.signal.throwIfAborted();
			requireCondition(init?.method === "POST" && !stageDispatches.has(phase), "extra-dispatch");
			checkPayload(networkPayload(init));
			stageDispatches.add(phase);
			const signals = [controller.signal, init?.signal, input instanceof Request ? input.signal : undefined].filter(Boolean);
			return await fetchBounded(input, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
		} catch (error) { reject(error instanceof ProbeFailure ? error.code : "network-guard-or-provider-failure", error instanceof ProbeFailure && error.blocked); }
	})());
	try {
		fixture = await mkdtemp(join(output, "fixture-")); // Captured same-process child is the ONLY recursive deletion target.
		await Promise.all(["home", "temp", "agent", "project/.pi", "sessions"].map((part) => mkdir(join(fixture, part), { recursive: true })));
		restoreEnvironment = isolateEnvironment(fixture);
		// SDK/import diagnostics can contain backend bodies. Never forward them, even on startup failure.
		for (const name of consoleMethods) console[name] = () => {};
		globalThis.fetch = guardedFetch;
		authBefore = await readFile(args.auth);
		const sdkEntry = join(args.sdk, "dist", "index.js");
		const manifest = JSON.parse(await readFile(join(args.sdk, "package.json"), "utf8"));
		requireCondition(manifest.version === "1.1.0", "current-sdk-required", true);
		sdk = await tracker.operation(() => import(pathToFileURL(sdkEntry).href));
		const aiRoot = resolve(args.sdk, "../pi-ai/dist");
		const ai = await tracker.operation(() => import(pathToFileURL(join(aiRoot, "index.js")).href));
		compat = await tracker.operation(() => import(pathToFileURL(join(aiRoot, "compat.js")).href));
		requireCondition(typeof compat.getApiProviders === "function" && sdk.ExtensionRunner?.prototype, "sdk-audit-seam", true);
		beforeShared = sharedSnapshot(sdk, compat);
		const requireSdk = createRequire(pathToFileURL(sdkEntry));
		const { createJiti } = await tracker.operation(() => import(pathToFileURL(requireSdk.resolve("jiti")).href));
		const jiti = createJiti(sdkEntry, { interopDefault: true, fsCache: false });
		const adapter = await tracker.operation(() => jiti.import(args["host-adapter"]));
		requireCondition(typeof adapter.installToolkitContextProjector === "function", "host-adapter-seam", true);
		const credential = sdk.readStoredCredential("openai-codex", args.auth);
		requireCondition(authBefore.equals(await readFile(args.auth)), "credential-changed-during-read", true);
		requireCondition(credentialStatus(credential) === "ready", "subscription-grant-not-ready", true);
		runtime = await tracker.operation(() => sdk.ModelRuntime.create({ credentials: readOnlyCredentialStore(new Map([["openai-codex", credential]])),
			modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }));
		const model = runtime.getModel("openai-codex", args.model);
		requireCondition(model?.id === args.model && model.provider === "openai-codex" && model.api === "openai-codex-responses", "exact-sdk-model-missing", true);
		const originalStream = runtime.streamSimple;
		runtime.streamSimple = function (selected, context, options = {}) {
			if (!["reopenRecall", "forkRecall"].includes(phase) || selected.provider !== "openai-codex" || selected.id !== args.model || ++streamCalls > 2) reject("unexpected-sdk-stream");
			const onPayload = options.onPayload;
			return originalStream.call(this, selected, context, { ...options, transport: "sse", maxRetries: 0,
				timeoutMs: Math.max(1, DEADLINE_MS - (Date.now() - started)), reasoning: args.thinking,
				signal: AbortSignal.any([controller.signal, options.signal].filter(Boolean)), fetch: guardedFetch,
				onPayload: async (...values) => {
					try { const payload = (await onPayload?.(...values)) ?? values[0]; checkPayload(payload); return payload; }
					catch (error) { reject(error instanceof ProbeFailure ? error.code : "payload-hook-failure"); }
				} });
		};
		restoreStream = () => { delete runtime.streamSimple; };
		const cwd = join(fixture, "project");
		const agentDir = join(fixture, "agent");
		new sdk.ProjectTrustStore(agentDir).set(cwd, true);
		await writeFile(join(cwd, ".pi", "pi-openai-toolkit.json"), JSON.stringify({ schemaVersion: 2,
			defaults: { context: { mode: "remote-compaction", remoteCompaction: { inputSource: "pi-context-hook" }, nativeFallback: { enabled: false } },
				webSearch: { route: "unmanaged" }, imageGeneration: { enabled: false }, responsesWebSocket: { enabled: false } }, models: {},
			diagnostics: { level: "error", notifyOnLoad: false, captureRequests: false, captureResponses: false, redactSensitiveData: true } }));
		const tool = { name: TOOL_NAME, label: "Synthetic lookup", description: "Synthetic historical lookup schema. Do not call during recall.", parameters: TOOL_SCHEMA,
			execute: async () => { toolExecutions++; throw new ProbeFailure("live-tool-execution-forbidden"); } };
		async function open(manager) {
			const settingsManager = sdk.SettingsManager.inMemory({ packages: [{ source: join(TOOLKIT_ROOT, "thegame"), skills: [], prompts: [], themes: [] }],
				defaultTools: [], transport: "sse", retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: DEADLINE_MS } },
				cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 0 }, enableInstallTelemetry: false });
			const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await tracker.operation(() => loader.reload({ resolveProjectTrust: async () => true }));
			const extensions = loader.getExtensions();
			requireCondition(extensions.errors.length === 0 && extensions.extensions.length === 1 && pathKey(extensions.extensions[0].path) === pathKey(join(TOOLKIT_ROOT, "src", "thegame-extension.ts")), "safe-resource-selection", true);
			const created = await tracker.operation(async () => {
				const result = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: args.thinking,
					settingsManager, resourceLoader: loader, sessionManager: manager, tools: [TOOL_NAME], customTools: [tool] });
				tracker.sessions.add(result.session); // Capture even a late startup after cancellation.
				return result;
			});
			const session = created.session;
			requireCondition(!created.modelFallbackMessage && session.model?.id === args.model && session.model?.provider === "openai-codex" && session.thinkingLevel === args.thinking, "session-selection-mismatch", true);
			requireCondition(adapter.installToolkitContextProjector(session.extensionRunner) === true, "host-shim-install", true);
			await tracker.operation(() => session.bindExtensions({ mode: "print", onError: () => { failedCode ??= { code: "extension-handler-failure", blocked: false }; controller.abort(); } }));
			requireCondition(isDeepStrictEqual(session.getActiveToolNames(), [TOOL_NAME]), "session-tool-selection", true);
			session.subscribe((event) => {
				if (event.type === "tool_execution_start" || (event.type === "message_end" && event.message?.role === "assistant" && event.message.content.some((block) => block.type === "toolCall"))) {
					failedCode ??= { code: "live-tool-call-forbidden", blocked: false }; controller.abort(); tracker.track(session.abort());
				}
			});
			return session;
		}
		const manager = sdk.SessionManager.create(cwd, join(fixture, "sessions"));
		manager.appendModelChange(model.provider, model.id);
		manager.appendThinkingLevelChange(args.thinking);
		manager.appendMessage({ role: "user", content: `The exact fact is ${expected.fact}. Preserve it for later recall.`, timestamp: 1 });
		const call = ai.fauxToolCall(TOOL_NAME, { key: "receipt" }, { id: "W074_synthetic_call" });
		const assistant = (content) => ({ ...ai.fauxAssistantMessage(content), provider: model.provider, api: model.api, model: model.id });
		manager.appendMessage(assistant(call));
		manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: TOOL_NAME, isError: false, content: [{ type: "text", text: `The exact receipt is ${expected.receipt}.` }], timestamp: 2 });
		manager.appendMessage(assistant("Acknowledged. Both exact values will be preserved."));
		const first = await open(manager);
		declaredTools = first.agent.state.tools.map((item) => ({ type: "function", name: item.name, description: item.description, parameters: item.parameters, strict: null }));
		requireCondition(declaredTools.length === 1, "tool-schema-seam", true);
		await tracker.operation(() => first.extensionRunner.emitBeforeProviderRequest({ model: model.id, input: [], tools: declaredTools, stream: true }));
		requireCondition(rows.length === 0, "schema-cache-dispatched");
		report.stages.setup = true;
		const file = manager.getSessionFile();
		const originalBytes = await readFile(file);
		phase = "compact";
		const compact = await tracker.operation(() => first.compact("Preserve both the exact user fact and the exact lookup receipt for later exact JSON recall."));
		controller.signal.throwIfAborted();
		requireCondition(compact.details?.strategy === "openai-remote-compaction-v2" && compact.details.inputProvenance === "pi-context-hook-v1", "native-checkpoint-provenance");
		const window = compact.details.compactedWindow;
		requireCondition(Array.isArray(window) && window.length === 1 && window[0]?.type === "compaction" && typeof window[0].encrypted_content === "string" && window[0].encrypted_content.length > 0, "native-checkpoint-missing");
		checkpoint = structuredClone(window[0]);
		requireCondition(rows.length === 1 && rows[0].status === 200, "compact-dispatch-failed");
		report.stages.compact = true;
		const persistedBytes = await readFile(file);
		requireCondition(persistedBytes.length > originalBytes.length && persistedBytes.subarray(0, originalBytes.length).equals(originalBytes), "checkpoint-not-append-only");
		const persistedManager = sdk.SessionManager.open(file);
		const entry = persistedManager.getBranch().findLast((item) => item.type === "compaction");
		const checkpointLeaf = manager.getLeafId(); // NEVER replace this with the later recall response leaf.
		requireCondition(entry?.id === checkpointLeaf && entry.fromHook === true && isDeepStrictEqual(entry.details, JSON.parse(JSON.stringify(compact.details))), "persisted-checkpoint-mismatch");
		report.stages.persisted = true;
		await tracker.operation(() => tracker.close(first));
		async function recall(session, stage) {
			phase = stage;
			await tracker.operation(() => session.prompt(RECALL_QUERY));
			controller.signal.throwIfAborted();
			const reply = session.messages.findLast((message) => message.role === "assistant");
			requireCondition(validRecall(reply, expected, controller.signal) && toolExecutions === 0 && rows.length === (stage === "reopenRecall" ? 2 : 3) && rows.at(-1).status === 200, "exact-recall-failed");
			report.stages[stage] = true;
			await tracker.operation(() => tracker.close(session));
		}
		const reopened = await open(sdk.SessionManager.open(file));
		requireCondition(reopened.sessionManager.getLeafId() === checkpointLeaf, "reopen-checkpoint-leaf");
		await recall(reopened, "reopenRecall");
		const sourceBeforeFork = await readFile(file);
		const forkFile = sdk.SessionManager.open(file).createBranchedSession(checkpointLeaf);
		requireCondition(typeof forkFile === "string", "fork-file-missing", true);
		const forkManager = sdk.SessionManager.open(forkFile);
		requireCondition(forkManager.getLeafId() === checkpointLeaf && !forkManager.getBranch().some((item) => item.type === "message" && item.message?.role === "user" && item.message.content === RECALL_QUERY), "fork-after-recall-forbidden");
		await recall(await open(forkManager), "forkRecall");
		requireCondition(sourceBeforeFork.equals(await readFile(file)), "fork-rewrote-source");
		phase = "finished";
		requireCondition(!failedCode && toolExecutions === 0 && rows.length === 3 && streamCalls === 2, "workflow-counts-failed");
		report.code = "exact-persisted-and-pre-recall-fork";
		report.status = "pass";
	} catch (error) {
		const failure = failedCode ?? (error instanceof ProbeFailure ? error : { code: controller.signal.aborted ? "workflow-aborted" : "controlled-probe-failure", blocked: controller.signal.aborted });
		report.status = failure.blocked ? "blocked" : "fail";
		report.code = failure.code;
	} finally {
		phase = "cleanup";
		const safe = await tracker.cleanup();
		clearTimeout(timer);
		if (controller.signal.aborted) { report.status = failedCode && !failedCode.blocked ? "fail" : "blocked"; if (report.code === "exact-persisted-and-pre-recall-fork") report.code = "workflow-aborted"; }
		if (safe && beforeShared) {
			report.stages.sharedAudit = isDeepStrictEqual(sharedSnapshot(sdk, compat), beforeShared);
			if (!report.stages.sharedAudit) { report.status = "fail"; report.code = "shared-state-mutated"; }
		}
		try { report.credentialUnchanged = Boolean(authBefore?.equals(await readFile(args.auth))); } catch { report.credentialUnchanged = false; }
		if (!report.credentialUnchanged) { report.status = "fail"; report.code = "credential-read-or-change"; }
		if (safe) {
			restoreStream?.();
			globalThis.fetch = originalFetch;
			try { if (fixture) await rm(fixture, { recursive: true, force: false }); report.cleanup = "fixture-deleted"; }
			catch { report.cleanup = "fixture-retained"; report.status = "blocked"; report.code = "fixture-cleanup-failed"; }
			restoreEnvironment();
			for (const [name, method] of originalConsole) console[name] = method;
			process.off("SIGINT", abortProcess); process.off("SIGTERM", abortProcess);
		} else {
			// Keep isolation, guarded fetch, suppressed diagnostics and captured fixture until process exit.
			controller.abort(); report.status = "blocked"; report.code = "abort-or-disposal-unsettled"; report.cleanup = "fixture-and-environment-retained-until-exit";
		}
		report.httpCount = rows.length; report.httpStatuses = rows.map((row) => row.status); report.elapsedMs = Date.now() - started;
		if (report.status === "pass" && !Object.values(report.stages).every(Boolean)) { report.status = "fail"; report.code = "incomplete-stages"; }
		await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
		originalConsole.get("log")(JSON.stringify(report));
	}
	return report;
}

const invoked = process.argv[1] && pathKey(process.argv[1]) === pathKey(fileURLToPath(import.meta.url));
if (invoked) {
	try {
		const report = await runProbe(process.argv.slice(2));
		if (report.cleanup === "fixture-and-environment-retained-until-exit") process.exit(1);
		if (report.status !== "pass") process.exitCode = 1;
	} catch { console.error("Persistence probe blocked before completion; no raw diagnostics emitted."); process.exitCode = 1; }
}
