import { expect, test } from "bun:test";
import { acceptedHistoryRead, allowedUrls, boundedFetch, completedReply, credentialStatus, normalizeThinking, readOnlyCredentialStore } from "./thegame-capability-probe.mjs";
import { isSuccessfulHistoryNotesResponse } from "../src/context-management/history-notes";

test("role thinking probe keeps off as default and rejects unknown effort", () => {
	expect(normalizeThinking()).toBe("off");
	for (const value of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) expect(normalizeThinking(value)).toBe(value);
	expect(() => normalizeThinking("unbounded")).toThrow("Unknown thinking level");
});

test("probe requires a fresh provider-specific OAuth grant, never a paid API key", () => {
	expect(credentialStatus(undefined, 0)).toBe("missing-grant");
	expect(credentialStatus({ type: "api_key", key: "synthetic" }, 0)).toBe("not-subscription-oauth");
	expect(credentialStatus({ type: "oauth", expires: 1 }, 0)).toBe("refresh-required");
	expect(credentialStatus({ type: "oauth", expires: 600_000 }, 0)).toBe("ready");
});

test("read-only probe store blocks refresh before calling mutation callback", async () => {
	const credential = { type: "oauth", access: "synthetic", expires: 600_000 };
	const store = readOnlyCredentialStore(new Map([["openai", credential]]));
	let invoked = false;
	await expect(store.modify("openai", async () => { invoked = true; return credential; })).rejects.toThrow("probe-credential-mutation-blocked");
	expect(invoked).toBe(false);
	expect(await store.read("openai-codex")).toBeUndefined();
	const copy = await store.read("openai");
	copy.access = "changed";
	expect((await store.read("openai")).access).toBe("synthetic");
	await expect(store.delete("openai")).rejects.toThrow("probe-credential-mutation-blocked");
});

test("bounded fetch rejects other routes, redirects and excess dispatches", async () => {
	const rows: unknown[] = [];
	let calls = 0;
	let redirect: string | undefined;
	const fetch = boundedFetch(async (_: unknown, init: RequestInit) => { calls++; redirect = init.redirect; return new Response("OK", { status: 200 }); }, allowedUrls("openai", "compact"), 1, rows);
	await expect(fetch("https://auth.openai.com/api/accounts/oauth/token")).rejects.toThrow("probe-endpoint-blocked");
	await fetch("https://api.openai.com/v1/responses");
	expect(redirect).toBe("error");
	await expect(fetch("https://api.openai.com/v1/responses")).rejects.toThrow("probe-dispatch-budget-exhausted");
	expect(calls).toBe(1);
	expect(rows).toEqual([{ endpoint: "https://api.openai.com/v1/responses", status: 200 }]);
});

test("partial or aborted replies can never satisfy live probe acceptance", () => {
	const live = new AbortController();
	for (const stopReason of ["aborted", "error", "length", "toolUse"]) {
		expect(completedReply({ stopReason, content: [{ type: "text", text: "exact synthetic marker" }] }, live.signal)).toBe(false);
	}
	expect(completedReply({ stopReason: "stop" }, live.signal)).toBe(true);
	live.abort();
	expect(completedReply({ stopReason: "stop" }, live.signal)).toBe(false);
});

test("HTTP200 history with semantic backend rejection cannot be PASS", () => {
	const live = new AbortController();
	for (const value of [{ ok: false, windows: [] }, { success: false, windows: [] }]) {
		expect(acceptedHistoryRead({ ok: true, value }, live.signal, isSuccessfulHistoryNotesResponse)).toBe(false);
	}
	expect(acceptedHistoryRead({ ok: true, value: { ok: true, windows: [] } }, live.signal, isSuccessfulHistoryNotesResponse)).toBe(true);
	expect(acceptedHistoryRead({ ok: false }, live.signal, isSuccessfulHistoryNotesResponse)).toBe(false);
	live.abort();
	expect(acceptedHistoryRead({ ok: true, value: { ok: true } }, live.signal, isSuccessfulHistoryNotesResponse)).toBe(false);
});

test("inventory has no network route and windows never borrow OpenAI OAuth", () => {
	expect(allowedUrls("openai", "inventory").size).toBe(0);
	expect(allowedUrls("openai", "windows-read").size).toBe(0);
	expect([...allowedUrls("openai-codex", "windows-read")]).toEqual(["https://chatgpt.com/backend-api/codex/alpha/history/v2/list_windows"]);
});
