// W-074: explicit subscription-only probes. Run in a disposable process, never in pi-web.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FEATURES = ["inventory", "basic", "compact", "hosted-search", "alpha-search", "windows-read"];
export const PROVIDERS = ["openai", "openai-codex"];
export const DEADLINE_MS = 45_000;

export function normalizeThinking(value = "off") {
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) throw new Error("Unknown thinking level");
	return value;
}

export function credentialStatus(credential, now = Date.now()) {
	if (!credential) return "missing-grant";
	if (credential.type !== "oauth") return "not-subscription-oauth";
	if (!Number.isFinite(credential.expires) || credential.expires <= now + 6 * 60_000) return "refresh-required";
	return "ready";
}

/** Reject before calling the mutation callback: even remote refresh is forbidden. */
export function readOnlyCredentialStore(snapshots) {
	return {
		async read(provider) { return snapshots.has(provider) ? structuredClone(snapshots.get(provider)) : undefined; },
		async list() { return [...snapshots].map(([providerId, c]) => ({ providerId, type: c.type })); },
		async modify() { throw new Error("probe-credential-mutation-blocked"); },
		async delete() { throw new Error("probe-credential-mutation-blocked"); },
	};
}

export function allowedUrls(provider, feature) {
	const responses = provider === "openai" ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses";
	if (["basic", "compact", "hosted-search"].includes(feature)) return new Set([responses]);
	if (feature === "alpha-search") return new Set([provider === "openai" ? "https://api.openai.com/v1/alpha/search" : "https://chatgpt.com/backend-api/alpha/search"]);
	if (feature === "windows-read" && provider === "openai-codex") return new Set(["https://chatgpt.com/backend-api/codex/alpha/history/v2/list_windows"]);
	return new Set();
}

export function boundedFetch(original, urls, maximum, records) {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!urls.has(url)) throw new Error("probe-endpoint-blocked");
		if (records.length >= maximum) throw new Error("probe-dispatch-budget-exhausted");
		const entry = { endpoint: url, status: null };
		records.push(entry);
		const response = await original(input, { ...init, redirect: "error" });
		entry.status = response.status;
		return response;
	};
}

export function completedReply(message, signal) {
	return !signal.aborted && message.stopReason === "stop";
}

export function acceptedHistoryRead(result, signal, validateResponse) {
	return !signal.aborted && result.ok === true && validateResponse(result.value);
}

function textOf(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}
function citations(value, found = new Set()) {
	if (!value || typeof value !== "object") return found;
	if (value.type === "url_citation" && typeof value.url === "string" && /^https?:\/\//.test(value.url)) found.add(value.url);
	for (const [key, child] of Object.entries(value)) {
		if (["encrypted_content", "encrypted_output", "headers", "apiKey"].includes(key)) continue;
		if (child && typeof child === "object") citations(child, found);
	}
	return found;
}
async function fileHash(path) {
	try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
	catch (error) { if (error.code === "ENOENT") return null; throw new Error("probe-auth-read-failed"); }
}
function parseArguments(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || !argv[i + 1]) throw new Error("Expected named arguments with values");
		args[argv[i].slice(2)] = argv[i + 1];
	}
	for (const key of ["sdk", "auth", "output-root"]) if (!args[key]) throw new Error(`Missing --${key}`);
	args.feature ??= "inventory";
	args.model ??= "gpt-5.6-luna";
	args.thinking = normalizeThinking(args.thinking);
	if (!FEATURES.includes(args.feature)) throw new Error("Unknown feature");
	if (args.feature !== "inventory" && args.live !== "subscription") throw new Error("Live requests require --live subscription");
	if (args.provider && !PROVIDERS.includes(args.provider)) throw new Error("Unknown provider");
	return args;
}

export async function runProbe(argv) {
	const args = parseArguments(argv);
	const sdkRoot = resolve(args.sdk);
	const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(sdkRoot, "../pi-ai/dist/index.js")).href);
	const sdkVersion = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")).version;
	const authPath = resolve(args.auth);
	const authHashBefore = await fileHash(authPath);
	await mkdir(resolve(args["output-root"]), { recursive: true });
	const output = await mkdtemp(join(resolve(args["output-root"]), `W-074-S2-${args.feature}-`));
	const providers = args.provider ? [args.provider] : PROVIDERS;
	const snapshots = new Map();
	const result = { sdkVersion, feature: args.feature, model: args.model, thinking: args.thinking, deadlineMs: DEADLINE_MS,
		maximumDispatchesPerProvider: args.feature === "compact" ? 2 : args.feature === "inventory" ? 0 : 1,
		authFileUnchanged: null, records: [] };
	for (const provider of providers) {
		const credential = sdk.readStoredCredential(provider, authPath);
		const readiness = credentialStatus(credential);
		result.records.push({ provider, authKind: credential?.type ?? "missing", readiness, status: "not-run", reason: readiness, dispatches: [] });
		if (readiness === "ready") snapshots.set(provider, credential);
	}
	// Write the exact budget and intended routes before any live dispatch.
	await writeFile(join(output, "plan.json"), JSON.stringify({ ...result, allowedEndpoints: providers.map((provider) => ({ provider, endpoints: [...allowedUrls(provider, args.feature)] })) }, null, 2), { flag: "wx" });
	const runtime = await sdk.ModelRuntime.create({ credentials: readOnlyCredentialStore(snapshots),
		modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const registry = new sdk.ModelRegistry(runtime);
	const originalFetch = globalThis.fetch;
	try {
		for (const row of result.records) {
			const model = runtime.getModel(row.provider, args.model);
			row.api = model?.api;
			row.providerLabel = runtime.getProvider(row.provider)?.name;
			if (!model) { row.status = "blocked"; row.reason = "model-not-in-pinned-sdk"; continue; }
			if (row.readiness !== "ready") { row.status = "blocked"; continue; }
			if (args.feature === "inventory") { row.status = "pass"; row.reason = "metadata-only-no-endpoint-test"; continue; }
			if (args.feature === "windows-read" && row.provider !== "openai-codex") {
				row.status = "not-run"; row.reason = "toolkit-native-windows-require-codex-route"; continue;
			}
			const started = Date.now();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
			const guarded = boundedFetch(originalFetch, allowedUrls(row.provider, args.feature), result.maximumDispatchesPerProvider, row.dispatches);
			globalThis.fetch = guarded;
			const options = { signal: controller.signal, transport: "sse", maxRetries: 0, maxTokens: 128,
				reasoning: args.thinking, timeoutMs: DEADLINE_MS, fetch: guarded };
			const marker = `W074_${randomUUID().replaceAll("-", "")}`;
			const sessionManager = sdk.SessionManager.inMemory(output);
			const ctx = { cwd: output, model, modelRegistry: registry, sessionManager, hasUI: false,
				getThinkingLevel: () => args.thinking, ui: { notify() {} }, abort: () => controller.abort() };
			try {
				if (args.feature === "basic") {
					const message = await runtime.completeSimple(model, { systemPrompt: "Follow the synthetic test exactly.", messages: [
						{ role: "user", content: `Reply with exactly ${marker}`, timestamp: Date.now() },
					] }, options);
					row.status = completedReply(message, controller.signal) && textOf(message) === marker ? "pass" : "fail";
					row.reason = row.status === "pass" ? "exact-synthetic-reply" : "reply-or-provider-failure";
					row.stopReason = message.stopReason;
					row.usage = message.usage;
				} else if (args.feature === "compact") {
					const { resolveNativeCompactionEnvironment } = await import("../src/runtime.ts");
					const { executeRemoteV2Compaction } = await import("../src/remote-v2-client.ts");
					const resolved = await resolveNativeCompactionEnvironment(ctx);
					if (!resolved.ok) { row.status = "blocked"; row.reason = resolved.reason; continue; }
					const compact = await executeRemoteV2Compaction({ runtime: resolved.runtime, signal: controller.signal,
						request: { model: model.id, instructions: "Preserve the exact synthetic project marker for later recall.", input: [
							{ role: "user", content: [{ type: "input_text", text: `The project marker is ${marker}. Remember it exactly.` }] },
							{ role: "assistant", content: [{ type: "output_text", text: "I will remember the project marker." }] },
						] } });
					if (!compact.ok) {
						row.status = "fail"; row.reason = compact.reason;
						row.protocolDiagnostic = { code: compact.errorCode, type: compact.errorType, parameter: compact.errorParam, category: compact.errorCategory };
						continue;
					}
					row.checkpointReceived = true;
					const message = await runtime.completeSimple(model, { systemPrompt: "Recall the preserved synthetic marker.", messages: [
						{ role: "user", content: "What is the exact project marker? Reply with only the marker.", timestamp: Date.now() },
					] }, { ...options, sessionId: sessionManager.getSessionId(), onPayload(payload) {
						return { ...payload, input: [...compact.compactedWindow, { role: "user", content: [{ type: "input_text", text: "What is the exact project marker? Reply with only the marker." }] }] };
					} });
					row.status = completedReply(message, controller.signal) && textOf(message) === marker ? "pass" : "fail";
					row.reason = row.status === "pass" ? "opaque-checkpoint-and-exact-recall" : "checkpoint-continuation-failed";
					row.stopReason = message.stopReason;
				} else if (args.feature === "hosted-search") {
					const sources = new Set();
					let webSearchEvents = 0;
					const message = await runtime.completeSimple(model, { systemPrompt: "Use hosted web search and cite official sources.", messages: [
						{ role: "user", content: "Find the official OpenAI Responses API documentation using web search; return its URL in one sentence.", timestamp: Date.now() },
					] }, { ...options, maxTokens: 384, onPayload(payload) { return { ...payload, tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } }; },
						onProviderStreamEvent(event) { citations(event, sources); if (typeof event?.type === "string" && event.type.includes("web_search_call")) webSearchEvents++; } });
					row.status = completedReply(message, controller.signal) && sources.size > 0 && webSearchEvents > 0 ? "pass" : "fail";
					row.reason = row.status === "pass" ? "hosted-search-events-and-source-annotations" : "no-verified-search-citations";
					row.sourceUrls = [...sources]; row.webSearchEvents = webSearchEvents; row.stopReason = message.stopReason;
				} else if (args.feature === "alpha-search") {
					const { resolveResponsesEnvironment } = await import("../src/runtime.ts");
					const { requestAlphaSearch } = await import("../src/web-search/alpha-client.ts");
					const resolved = await resolveResponsesEnvironment(ctx);
					if (!resolved.ok) { row.status = "blocked"; row.reason = resolved.reason; continue; }
					const search = await requestAlphaSearch({ runtime: resolved.runtime, signal: controller.signal, fetchFn: guarded,
						timeoutMs: DEADLINE_MS, commands: { search_query: [{ q: "site:developers.openai.com Responses API documentation" }], response_length: "short" } });
					row.status = search.ok ? "pass" : "fail"; row.reason = search.ok ? "alpha-search-client-accepted-response" : search.reason;
					// Do not persist backend output: even synthetic search may return opaque fields.
				} else if (args.feature === "windows-read") {
					const { callHistoryNotesBackend, HISTORY_ENDPOINTS, isSuccessfulHistoryNotesResponse } = await import("../src/context-management/history-notes.ts");
					const history = await callHistoryNotesBackend(HISTORY_ENDPOINTS.list_windows, { limit: 1, recent_first: true }, ctx, controller.signal);
					const accepted = acceptedHistoryRead(history, controller.signal, isSuccessfulHistoryNotesResponse);
					row.status = accepted ? "pass" : "fail"; row.reason = accepted ? "history-endpoint-only-not-rollover-proof" : history.ok ? "backend-semantic-rejection" : history.reason;
				}
			} catch {
				row.status = controller.signal.aborted ? "blocked" : "fail";
				row.reason = controller.signal.aborted ? "deadline" : "controlled-probe-failure";
			} finally {
				clearTimeout(timer); globalThis.fetch = originalFetch; row.elapsedMs = Date.now() - started;
				if (controller.signal.aborted) { row.status = "blocked"; row.reason = "deadline"; }
			}
		}
	} finally {
		globalThis.fetch = originalFetch;
		result.authFileUnchanged = authHashBefore === await fileHash(authPath);
		await writeFile(join(output, "report.json"), JSON.stringify(result, null, 2), { flag: "wx" });
	}
	console.log(JSON.stringify({ evidenceDirectory: basename(output), ...result }, null, 2));
	return result;
}

if (import.meta.main) {
	try { await runProbe(process.argv.slice(2)); }
	catch { console.error("Probe stopped before completion; no raw error or credential details are printed."); process.exitCode = 1; }
}
