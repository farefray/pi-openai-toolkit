import { expect, test } from "bun:test";
import { executeStandaloneWebRun } from "./extension";
import { v2Fixture } from "../config/test-helpers";

test("legacy standalone export preserves the optional-path reader's zero-argument invocation", async () => {
	const seen: unknown[] = [];
	const result = await executeStandaloneWebRun({
		params: { search_query: [{ q: "public synthetic compatibility fixture" }] },
		ctx: {
			model: { provider: "fixture", id: "fixture", api: "openai-responses", baseUrl: "https://fixture.invalid/v1" },
			hasUI: false,
			sessionManager: { getSessionId: () => "synthetic" },
		} as never,
		loadConfig: (configPath?: string) => {
			seen.push(configPath);
			expect(configPath).toBeUndefined(); // A ctx object here would break loadToolkitConfig's path contract.
			return v2Fixture({ defaults: { context: { mode: "pi" }, webSearch: { route: "standalone-alpha" } } });
		},
		resolveRuntime: (async () => ({ ok: true, runtime: {} })) as never,
		requestSearch: (async () => ({ ok: true, output: "synthetic compatibility reply", details: {} })) as never,
	});
	expect(seen).toEqual([undefined]);
	expect(result.text).toBe("synthetic compatibility reply");
});
