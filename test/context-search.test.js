import assert from "node:assert/strict";
import test from "node:test";
import { runOnDemand, CONTEXT_SEARCH_LIMITS as L } from "../lib/context-search.js";

const selection = { provider: "mock", model: "m", reasoningEffort: "low" };
const call = (id, query) => [
	{ type: "tool-call-delta", index: 0, id, name: "search_snapshot", argumentsDelta: JSON.stringify({ query }) },
	{ type: "finish", reason: { kind: "tool-calls" }, replayState: { response: { token: "opaque" } } },
];
const answer = text => [
	{ type: "text-delta", index: 0, text },
	{ type: "finish", reason: { kind: "stop" } },
];
function mock(rounds, requests = []) {
	return { async *stream(opts) { requests.push(opts); const chunks = rounds.shift(); assert.ok(chunks, "unexpected model round"); yield* chunks; } };
}
const run = (llm, extra = {}) => runOnDemand({ llm, selection, question: "What happened?", transcript: "first apple\nsecond banana\n", ...extra });

test("real wire shapes, multiple searches, replay and no initial snapshot", async () => {
	const requests = [], deltas = [];
	const result = await run(mock([call("1", "apple"), call("2", "banana"), answer("Found both")], requests), { onDelta: s => deltas.push(s) });
	assert.deepEqual(result, { text: "Found both", snapshotTruncated: false, searchCalls: 2 });
	assert.deepEqual(deltas, ["Found both"]);
	assert.equal(requests[0].messages[0].content[0].text, "What happened?");
	assert.ok(!JSON.stringify(requests[0]).includes("first apple"));
	assert.equal(requests[0].tools[0].parameters.properties.query.type, "string");
	assert.equal(requests[0].reasoningEffort, "low");
	const assistant = requests[1].messages[1], tool = requests[1].messages[2];
	assert.equal(assistant.role, "assistant");
	assert.deepEqual(assistant.source.replayState, { response: { token: "opaque" } });
	assert.equal(assistant.content[0].arguments, '{"query":"apple"}');
	assert.equal(tool.role, "tool"); assert.equal(tool.source.callId, "1"); assert.equal(tool.toolCallId, "1");
	assert.match(tool.content[0].text, /first apple/);
	assert.match(JSON.parse(tool.content[0].text).scope, /not complete/);
	assert.match(requests[2].messages[4].content[0].text, /banana/);
});

test("stop with tool call executes search and preserves pi-ai replay envelope", async () => {
	// Shape mirrors dsh-llm-pi-ai's toPiReplayState: the metadata blocks
	// correspond to content blocks in stream order, including signatures.
	const replayState = {
		response: { kind: "pi-ai", version: 2, api: "openai-completions", provider: "mock", model: "m", responseModel: "m-native", responseId: "response-1", stopReason: "stop" },
		blocks: [{ type: "reasoning", thinkingSignature: "sig-r" }, { type: "text", textSignature: "sig-t" }, { type: "tool-call", thoughtSignature: "sig-call", namespace: "ns" }],
	};
	const chunks = [
		{ type: "reasoning-delta", index: 0, text: "look up" },
		{ type: "text-delta", index: 1, text: "Searching." },
		{ type: "tool-call-delta", index: 2, id: "stop-call", name: "search_snapshot", argumentsDelta: '{"query":"apple"}' },
		{ type: "finish", reason: { kind: "stop" }, replayState },
	];
	const requests = [], deltas = [];
	const result = await run(mock([chunks, answer("Found apple")], requests), { onDelta: text => deltas.push(text) });
	assert.equal(result.searchCalls, 1);
	assert.deepEqual(deltas, ["Found apple"]);
	const [assistant, tool] = requests[1].messages.slice(1);
	assert.deepEqual(assistant.source.replayState, replayState);
	assert.deepEqual(assistant.content.map(block => block.type), replayState.blocks.map(block => block.type));
	assert.equal(tool.toolCallId, "stop-call");
	assert.match(tool.content[0].text, /first apple/);
	await assert.rejects(run(mock([[{ type: "tool-call-delta", index: 0, id: "bad", name: "other", argumentsDelta: "{}" }, { type: "finish", reason: { kind: "stop" } }]])), /unsupported tool/);
});

test("truncation, result bounds and empty results", async () => {
	const requests = [];
	const transcript = "old-secret" + "x".repeat(L.transcript) + ("needle " + "z".repeat(900)).repeat(12);
	const result = await run(mock([call("a", "old-secret"), call("b", "needle"), answer("ok")], requests), { transcript });
	assert.equal(result.snapshotTruncated, true);
	assert.deepEqual(JSON.parse(requests[1].messages[2].content[0].text).results, []);
	const hits = JSON.parse(requests[2].messages[4].content[0].text).results;
	assert.ok(hits.length <= L.results && hits.length > 0);
	assert.ok(hits.every(x => x.text.length <= L.excerpt && x.text.trim()));
	assert.ok(hits.reduce((n, x) => n + x.text.length, 0) <= L.returned);
});

test("refuses missing search, malformed tools and model failures", async () => {
	await assert.rejects(run(mock([answer("guess")])), /required snapshot search/);
	await assert.rejects(run(mock([[{ type: "tool-call-delta", index: 0, id: "x", name: "other", argumentsDelta: "{}" }, { type: "finish", reason: { kind: "tool-calls" } }]])), /unsupported tool/);
	await assert.rejects(run(mock([[{ type: "tool-call-delta", index: 0, id: "x", name: "search_snapshot", argumentsDelta: "{" }, { type: "finish", reason: { kind: "tool-calls" } }]])), /arguments/);
	await assert.rejects(run(mock([[{ type: "finish", reason: { kind: "error", failure: {} } }]])), /error/);
	await assert.rejects(run(mock([[]])), /missing finish/);
});

test("block-end wire, search round cap and duplicate IDs", async () => {
	const block = { type: "tool-call", id: "x", name: "search_snapshot", arguments: '{"query":"apple"}' };
	const end = [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "block-end", index: 0, block }, { type: "finish", reason: { kind: "tool-calls" } }];
	assert.equal((await run(mock([end, answer("ok")]))).text, "ok");
	await assert.rejects(run(mock([end, end])), /unsupported tool/);
	await assert.rejects(run(mock(Array.from({ length: L.rounds }, (_, i) => call(String(i), "apple")))), /round limit/);
});

test("abort before and during a stalled stream", async () => {
	const ac = new AbortController(); ac.abort();
	await assert.rejects(run(mock([]), { signal: ac.signal }), { name: "AbortError" });
	const ac2 = new AbortController();
	const llm = { stream() { return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => Promise.resolve({ done: true }) }; } }; } };
	const pending = run(llm, { signal: ac2.signal }); ac2.abort();
	await assert.rejects(pending, { name: "AbortError" });
});
