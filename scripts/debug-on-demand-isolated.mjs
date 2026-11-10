#!/usr/bin/env node
// Local installed public APIs + synthetic data only. No dsh launch or provider.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { runOnDemand } from "../lib/context-search.js";

if (process.argv[2] !== "--isolated-child") {
	const executable = process.env.DSH_BIN || (process.env.PATH || "").split(delimiter).map(p => join(p, "dsh")).find(existsSync);
	assert.ok(executable, "installed dsh required (or set DSH_BIN)");
	const anchor = join(dirname(dirname(realpathSync(executable))), "package.json");
	const root = mkdtempSync(join(tmpdir(), "btw-demand-debug-"));
	try {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--isolated-child"], {
			cwd: root, encoding: "utf8", timeout: 30000,
			env: { PATH: process.env.PATH, HOME: root, DSH_HOME: join(root, "dsh"), DSH_TELEMETRY_DISABLED: "1", DSH_DEBUG_ANCHOR: anchor },
		});
		process.stdout.write(result.stdout || "");
		process.stderr.write(result.stderr || "");
		assert.ifError(result.error);
		assert.equal(result.status, 0, "isolated debug failed");
	} finally { rmSync(root, { recursive: true, force: true }); }
} else {
	// Defense in depth: this test should never use any sockets, including loopback.
	const net = await import("node:net");
	net.default.Socket.prototype.connect = function () { throw new Error("debug forbids network"); };
	globalThis.fetch = () => { throw new Error("debug forbids fetch"); };
	const require = createRequire(process.env.DSH_DEBUG_ANCHOR);
	const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
	const { Context } = await load("cordis");
	const { LlmRuntime, LlmAdapter, LlmError, BlockAssembler, createToolResultMessage, createAssistantMessage } = await load("dsh-llm");
	const subagents = await load("dsh-subagent");
	for (const name of ["resolveChildDepth", "childSessionMeta", "captureDelegatedPolicyOverrides", "appendDelegatedPolicyOverrides"]) assert.equal(typeof subagents[name], "function");
	const pkg = JSON.parse(readFileSync(require.resolve("@deepseek-ai/dsh-llm/package.json"), "utf8"));
	console.log(`installed public LLM/subagent APIs: ${pkg.version}`);

	const selection = { provider: "synthetic", model: "snapshot-only" };
	const requests = [];
	let behavior = "search";
	class SyntheticAdapter extends LlmAdapter {
		async *stream(options) {
			requests.push(options);
			if (behavior === "reject-tools") throw new LlmError("Synthetic model does not support tools", "UNSUPPORTED_TOOLS");
			if (behavior === "no-tool") {
				yield { type: "text-delta", index: 0, text: "An unsupported guess" };
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			const result = options.messages.findLast(message => message.role === "tool");
			if (!result) {
				assert.ok(!JSON.stringify(options.messages).includes("needle-value"), "snapshot withheld until search");
				assert.equal(options.tools[0].name, "search_snapshot");
				yield { type: "block-start", index: 0, blockType: "tool-call" };
				yield { type: "block-end", index: 0, block: { type: "tool-call", id: "synthetic-call", name: "search_snapshot", arguments: '{"query":"needle-value"}' } };
				yield { type: "finish", reason: { kind: "tool-calls" }, replayState: { response: { synthetic: true }, blocks: [{ type: "tool-call" }] } };
			} else {
				// Public construction helpers define precisely the result/replay shapes.
				const expected = createToolResultMessage({ callId: result.toolCallId, content: result.content, isError: false });
				assert.deepEqual({ ...result, id: expected.id }, expected);
				const assistant = options.messages.find(message => message.role === "assistant");
				const assembled = new BlockAssembler();
				assembled.push({ type: "block-end", index: 0, block: assistant.content[0] });
				const canonical = createAssistantMessage({ content: assembled.blocks(), source: { provider: selection.provider, model: selection.model, replayState: assistant.source.replayState } });
				assert.deepEqual({ ...assistant, id: canonical.id }, canonical);
				const hits = JSON.parse(result.content[0].text).results;
				yield { type: "text-delta", index: 0, text: hits.length ? "Found needle-value" : "Not present in the authorized snapshot" };
				yield { type: "finish", reason: { kind: "stop" } };
			}
		}
	}
	const ctx = new Context();
	const llm = new LlmRuntime(ctx);
	const unregister = llm.registerAdapter(["synthetic"], new SyntheticAdapter());
	const run = transcript => runOnDemand({ llm, selection, transcript, question: "Find the value" });
	try {
		assert.equal((await run("recent needle-value")).text, "Found needle-value");
		console.log("ok: snapshot → public LlmRuntime/local adapter → call → result/replay → answer");

		// Extract ONLY this pure projection; never execute client startup or read sessions.
		const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
		const body = client.slice(client.indexOf("function transcriptOf(snap) {"), client.indexOf("// Complete recorded text"));
		assert.ok(body.startsWith("function transcriptOf(snap) {"), "projection pointer moved");
		const transcriptOf = vm.runInNewContext(`(${body.trim()})`);
		const projected = transcriptOf({ nodes: [{ kind: "assistant", blocks: [{ kind: "text", text: "x".repeat(1601) + "needle-value" }] }] });
		assert.ok(projected.includes("needle-value"), "message-tail evidence must reach search");
		assert.equal((await run(projected)).text, "Found needle-value");
		const tools = transcriptOf({ nodes: [{ kind: "tool-result", content: [{ type: "text", text: "needle-value" }] }] });
		assert.equal((await run(tools)).text, "Found needle-value", "completed tool evidence must reach search");
		const bounded = transcriptOf({ nodes: [{ kind: "user", content: [{ type: "text", text: "outside-window" + "x".repeat(60_000) + "needle-value" }] }] });
		assert.ok(bounded.length <= 48_000);
		assert.ok(!bounded.includes("outside-window"));
		assert.equal((await run(bounded)).text, "Found needle-value");
		console.log("ok: after-character-1600 and completed-tool evidence searchable; recent snapshot remains bounded");

		behavior = "no-tool";
		const before = requests.length;
		await assert.rejects(run("recent needle-value"), /required snapshot search/);
		assert.equal(requests.length, before + 1, "no fallback model request");
		console.log("ok: model not calling tools is NOT snapshot absence, no fallback");
		behavior = "reject-tools";
		let failure;
		try { await run("recent needle-value"); } catch (error) { failure = error; }
		assert.ok(failure);
		// This fails on the old backend: public LlmRuntime puts these facts in
		// finish.reason.failure, but runOnDemand used to discard them.
		assert.match(failure.message, /UNSUPPORTED_TOOLS.*Synthetic model does not support tools/);
		console.log("ok: public adapter failure retains code and actionable reason");
	} finally {
		unregister();
		await ctx.fiber.dispose();
	}
}
