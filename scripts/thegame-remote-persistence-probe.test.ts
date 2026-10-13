import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArguments, validRecall, guardContinuation, credentialStatus, readOnlyCredentialStore, RECALL_QUERY } from "./thegame-remote-persistence-probe.mjs";

const output = fileURLToPath(new URL("../../../thegame/bin/qa/harness/", import.meta.url));
const host = fileURLToPath(new URL("../../../thegame-pi-web/lib/toolkit-context-projector.ts", import.meta.url));
const sdk = fileURLToPath(new URL("../../../thegame-pi-web/node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
const args = () => ["--sdk", sdk, "--auth", resolve(output, "synthetic-never-read.json"), "--host-adapter", host,
	"--output-root", output, "--model", "gpt-6.1-sol", "--thinking", "high", "--live", "subscription"];
const expected = { fact: "synthetic-fact-marker", receipt: "synthetic-receipt-marker" };
const reply = (text = JSON.stringify(expected), stopReason = "stop") => ({ role: "assistant", stopReason,
	content: [{ type: "text", text }] });
const signal = () => new AbortController().signal;
const payload = () => ({ model: "gpt-6.1-sol", input: [
	{ type: "compaction", encrypted_content: "synthetic-ciphertext" },
	{ role: "user", content: [{ type: "input_text", text: RECALL_QUERY }] },
] });

test("persisted probe requires exact subscription opt-in, supported model, effort and approved roots", () => {
	expect(parseArguments(args()).model).toBe("gpt-6.1-sol");
	for (const [key, value] of [["--live", "api-key"], ["--model", "unverified-model"], ["--thinking", "guess"],
		["--sdk", "relative/sdk"], ["--auth", "relative/auth"], ["--output-root", resolve(output, "borrowed")],
		["--host-adapter", resolve(output, "wrong.ts")]]) {
		const invalid = args(); invalid[invalid.indexOf(key) + 1] = value;
		expect(() => parseArguments(invalid)).toThrow();
	}
	expect(() => parseArguments(args().slice(0, -2))).toThrow();
	expect(() => parseArguments([...args(), "--live", "subscription"])).toThrow();
});

test("exact two-field recall rejects partial, aborted, fenced, extra-field and tool-call responses", () => {
	expect(validRecall(reply(), expected, signal())).toBe(true);
	for (const text of ["partial", "```json\n" + JSON.stringify(expected) + "\n```", JSON.stringify({ ...expected, extra: true }),
		JSON.stringify({ ...expected, receipt: "wrong" }), JSON.stringify([expected])]) {
		expect(validRecall(reply(text), expected, signal())).toBe(false);
	}
	for (const stop of ["length", "aborted", "error", "toolUse"]) expect(validRecall(reply(undefined, stop), expected, signal())).toBe(false);
	const controller = new AbortController(); controller.abort();
	expect(validRecall(reply(), expected, controller.signal)).toBe(false);
	expect(validRecall({ ...reply(), content: [...reply().content, { type: "toolCall", name: "lookup" }] }, expected, signal())).toBe(false);
	expect(validRecall(undefined, expected, signal())).toBe(false);
});

test("continuation requires one real-shaped checkpoint and no plaintext answer leakage", () => {
	const check = (value: unknown) => guardContinuation(value, "gpt-6.1-sol", Object.values(expected));
	expect(() => check(payload())).not.toThrow();
	expect(() => check({ ...payload(), model: "gpt-6-astra" })).toThrow();
	expect(() => check({ ...payload(), input: [] })).toThrow();
	expect(() => check({ ...payload(), input: [payload().input[0], ...payload().input] })).toThrow();
	expect(() => check({ ...payload(), input: [{ type: "compaction", encrypted_content: " " }] })).toThrow();
	expect(() => check({ ...payload(), input: [...payload().input, { type: "compaction_trigger" }] })).toThrow();
	for (const marker of Object.values(expected)) {
		expect(() => check({ ...payload(), input: [...payload().input, { role: "user", content: marker }] })).toThrow();
		expect(() => check({ ...payload(), input: [...payload().input, { type: "input_text", encrypted_content: marker }] })).toThrow();
		expect(() => check({ ...payload(), input: [{ type: "compaction", encrypted_content: marker }] })).not.toThrow();
		expect(RECALL_QUERY.includes(marker)).toBe(false);
	}
});

test("actual SDK mock workflow exercises compact, persisted reopen and pre-recall fork without network", {
	skip: !process.env.THEGAME_PROBE_SDK,
}, async () => {
	const root = await mkdtemp(join(output, "W-074-S5-probe-sdk-mock-"));
	const auth = join(root, "synthetic-auth.json");
	const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "W074_synthetic_account" } })).toString("base64url");
	await writeFile(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: `e30.${claim}.synthetic-signature`,
		refresh: "synthetic-refresh", expires: Date.now() + 60 * 60_000 } }));
	const before = await readFile(auth);
	// The probe intentionally loads SDK/config modules under its isolated HOME. Run it
	// in a fresh child so import-time constants cannot leak into other Bun test files.
	const mockFlow = async function (moduleUrl, command, outputRoot) {
		const { runProbe } = await import(moduleUrl);
		const { zstdDecompressSync } = await import("node:zlib");
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		let calls = 0, captured;
		const checkpoint = { type: "compaction", id: "W074_mock_checkpoint", encrypted_content: "W074_mock_not_real_ciphertext" };
		const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
		globalThis.fetch = async (_url, init) => {
			calls++;
			const body = JSON.parse(new Headers(init.headers).get("content-encoding") === "zstd"
				? zstdDecompressSync(init.body).toString("utf8") : init.body);
			let stream;
			if (body.input.some((item) => item.type === "compaction_trigger")) {
				const input = JSON.stringify(body.input);
				captured = { fact: input.match(/W074_FACT_[a-f0-9]{32}/)[0], receipt: input.match(/W074_RECEIPT_[a-f0-9]{32}/)[0] };
				stream = event({ type: "response.completed", response: { id: "W074_mock_response", status: "completed", output: [checkpoint] } });
			} else {
				const text = JSON.stringify(captured);
				const message = { id: "W074_mock_message", type: "message", role: "assistant", status: "completed",
					content: [{ type: "output_text", text, annotations: [] }] };
				stream = event({ type: "response.created", response: { id: "W074_mock_reply", status: "in_progress", output: [] } }) +
					event({ type: "response.output_item.added", output_index: 0, item: { ...message, content: [], status: "in_progress" } }) +
					event({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) +
					event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }) +
					event({ type: "response.output_item.done", output_index: 0, item: message }) +
					event({ type: "response.completed", response: { id: "W074_mock_reply", status: "completed", output: [message],
						usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
			}
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const result = await runProbe(command);
		await writeFile(join(outputRoot, result.root, "test-network.json"), JSON.stringify({ mockBackend: true, operatorGrant: false }));
		console.log(JSON.stringify({ mockResult: result, calls }));
		if (result.cleanup === "fixture-and-environment-retained-until-exit") process.exit(1);
	};
	try {
		const command = args(); command[command.indexOf("--auth") + 1] = auth;
		command[command.indexOf("--sdk") + 1] = process.env.THEGAME_PROBE_SDK!;
		const moduleUrl = new URL("./thegame-remote-persistence-probe.mjs", import.meta.url).href;
		const code = `(${mockFlow.toString()})(${JSON.stringify(moduleUrl)},${JSON.stringify(command)},${JSON.stringify(output)}).catch(()=>{process.exitCode=1;});`;
		const { stdout } = await promisify(execFile)(process.execPath, ["--eval", code], { timeout: 60_000, killSignal: "SIGKILL" });
		const { mockResult: result, calls } = JSON.parse(stdout.trim().split("\n").find((line) => line.includes('"mockResult"'))!);
		expect(result.status).toBe("pass");
		expect(result.httpCount).toBe(3);
		expect(calls).toBe(3);
		expect(result.cleanup).toBe("fixture-deleted");
		expect((await readFile(auth)).equals(before)).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: false });
	}
});

test("persisted trial reuses OAuth freshness and blocks mutation before refresh callback", async () => {
	expect(credentialStatus({ type: "api_key", key: "synthetic" })).toBe("not-subscription-oauth");
	expect(credentialStatus({ type: "oauth", expires: Date.now() + 1_000 })).toBe("refresh-required");
	const store = readOnlyCredentialStore(new Map([["openai-codex", { type: "oauth", access: "synthetic" }]]));
	let callback = false;
	await expect(store.modify("openai-codex", async () => { callback = true; return undefined; })).rejects.toThrow();
	expect(callback).toBe(false);
	expect(await store.read("openai")).toBeUndefined();
});
