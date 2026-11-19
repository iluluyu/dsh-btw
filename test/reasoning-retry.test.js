import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load(file, globals = {}) {
	let registration;
	const sandbox = { window: { __ModuleLoader__: { load: r => { registration = r; } } }, ...globals };
	vm.runInNewContext(readFileSync(new URL("../lib/" + file, import.meta.url), "utf8"), sandbox);
	return registration.factory(() => {});
}
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
function setup() {
	const calls = [], timers = new Set(), controllers = new Map();
	let unloading = false, inserted = "";
	const connection = {};
	const sidebar = { mounted: { getSnapshot: () => "origin" } };
	const bridge = { sessionId: "origin", actions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: text => { inserted = text; return true; } } };
	const emptyTemp = () => ({ phase: "idle", messages: [], selected: [], seq: 0 });
	const { createControllerFactory } = load("client.controllers.js", {
		setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn), AbortController,
	});
	const create = createControllerFactory({
		createStore: state => ({ state, patch(update) { Object.assign(this.state, update); } }), emptyTemp, changedTemp: () => true, controllers,
		focusTemp() {}, surfaceTemp() {}, reserveSurface() {}, removeTemp() {},
		prefs: { state: { tempContextMode: "none", tempModelMode: "default" } }, catalog: { state: { providers: [] } },
		geometryKey: () => "", savedGeometry: () => ({}), modelValue: () => "default", parseModel: () => ({ mode: "default" }), resolveModelMode: () => "default",
		ctxRef: { current: { get: () => connection } }, rpc: (method, payload, conn) => {
			assert.equal(conn, connection);
			const d = deferred(); calls.push({ method, payload, ...d });
			if (method === "open") d.resolve({ sessionId: "child", cwd: null });
			if (method === "close") d.resolve({});
			return d.promise;
		}, msg: String, POLL_MS: 1, getSidebar: () => sidebar, getComposerBridge: () => bridge,
		getOriginSnapshot: () => ({ sessionId: "origin", text: "source" }), isUnloading: () => unloading,
		captureSidebarTab() {}, retireSidebarTab() {}, hideSoleSidebarTab() {},
	});
	const controller = create("one"); controllers.set("one", controller);
	controller.configure(null, "origin"); controller.beginTemp("question");
	return { controller, calls, poll: () => { for (const fn of [...timers]) fn(); }, unload: () => { unloading = true; }, inserted: () => inserted };
}
const latest = (env, method) => env.calls.filter(c => c.method === method).at(-1);

async function start() { const env = setup(); await tick(); return env; }

test("retry previews stay visible end to end without entering answer, reasoning or insertion", async () => {
	const e = await start(); e.poll();
	let p = latest(e, "poll");
	p.resolve({ text: "", lastSeq: 0, liveReasoning: { attemptId: "a1", revision: 1, text: "attempt one thinking", running: true } }); await tick();
	e.poll(); p = latest(e, "poll");
	p.resolve({ text: "", lastSeq: 0, liveReasoning: { attemptId: "a2", revision: 5, text: "attempt two thinking", running: true },
		retryReasoning: [{ attemptId: "a1", text: "attempt one thinking" }] }); await tick();
	let m = e.controller.store.state.messages[1];
	assert.equal(m.liveReasoning, "attempt two thinking", "the newest attempt stays the live snapshot");
	assert.deepEqual(plain(m.reasoningAttempts), [{ attemptId: "a1", text: "attempt one thinking" }], "the superseded attempt is preserved separately");
	latest(e, "send").resolve({ output: "answer two" }); await tick();
	latest(e, "poll").resolve({ text: "", lastSeq: 0, reasoning: "committed two", reasoningLastSeq: 1, liveReasoning: null,
		retryReasoning: [{ attemptId: "a1", text: "attempt one thinking" }] }); await tick();
	m = e.controller.store.state.messages[1];
	assert.equal(m.text, "answer two"); assert.equal(m.reasoning, "committed two");
	assert.deepEqual(plain(m.reasoningAttempts), [{ attemptId: "a1", text: "attempt one thinking" }], "completion keeps the prior attempt visible");
	assert.equal(m.liveReasoning, ""); assert.equal(m.streaming, false);
	e.controller.toggleMessage(1); e.controller.insertSelected();
	assert.match(e.inserted(), /助手：answer two/);
	assert.doesNotMatch(e.inserted(), /attempt one thinking|attempt two thinking|committed two/, "no thinking ever reaches the draft");
});

test("send failure keeps watched thinking visible and adds the error as its own message", async () => {
	for (const salvage of ["delivered", "unreachable"]) {
		const e = await start(); e.poll();
		latest(e, "poll").resolve({ text: "", lastSeq: 0, liveReasoning: { attemptId: "a1", revision: 1, text: "watched thinking", running: true } }); await tick();
		latest(e, "send").reject(new Error("boom")); await tick();
		const final = latest(e, "poll");
		if (salvage === "delivered") final.resolve({ text: "", lastSeq: 0, liveReasoning: null, retryReasoning: [{ attemptId: "a1", text: "watched thinking" }] });
		else final.reject(new Error("poll dead"));
		await tick(); await tick();
		const messages = e.controller.store.state.messages, m = messages[1];
		assert.equal(m.streaming, false); assert.equal(m.reasoning, ""); assert.equal(m.liveReasoning, "");
		assert.deepEqual(plain(m.reasoningAttempts), [{ attemptId: "a1", text: "watched thinking" }], "failed turns keep their real thinking");
		assert.doesNotMatch(m.text, /watched thinking/);
		assert.equal(messages[2].error, true); assert.match(messages[2].text, /发送失败/);
	}
});

test("retry preview merge dedupes by attempt and ignores malformed entries", async () => {
	const e = await start(); e.poll();
	latest(e, "poll").resolve({ text: "", lastSeq: 0, liveReasoning: { attemptId: "a2", revision: 3, text: "second", running: true },
		retryReasoning: [{ attemptId: "a1", text: "first" }, { attemptId: "a1", text: "first duplicate" }, { attemptId: 7, text: "bad" },
			{ attemptId: "a3" }, null, { attemptId: "a4", text: "" }] }); await tick();
	const m = e.controller.store.state.messages[1];
	assert.deepEqual(plain(m.reasoningAttempts), [{ attemptId: "a1", text: "first" }]);
	assert.equal(m.liveReasoning, "second");
	e.poll(); latest(e, "poll").resolve({ text: "", lastSeq: 0, liveReasoning: { attemptId: "a2", revision: 4, text: "second more", running: true },
		retryReasoning: [{ attemptId: "a1", text: "first" }] }); await tick();
	assert.equal(e.controller.store.state.messages[1].reasoningAttempts.length, 1, "redelivery never duplicates");
	assert.equal(e.controller.store.state.messages[1].liveReasoning, "second more");
});

test("renderer shows prior attempts as separate collapsed disclosures above the final thinking", () => {
	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	const React = { useState: initial => [initial, () => {}], useRef: value => ({ current: value }), useEffect: () => {} };
	function DisclosureRow() {} function ThinkIcon() {}
	const render = createMessageRenderer({ h, React, DisclosureRow, ThinkIcon });
	const message = { role: "agent", text: "answer", reasoning: "committed thought", streaming: false,
		reasoningAttempts: [{ attemptId: "a1", text: "first attempt" }, { attemptId: "a2", text: "second attempt" }] };
	const tree = render(message, "x");
	const priors = tree.children[1];
	assert.equal(Array.isArray(priors) && priors.length, 2);
	priors.forEach((block, i) => {
		const node = block.type(block.props), row = node.children[0];
		assert.equal(node.props["data-prior"], i + 1);
		assert.equal(node.props["data-state"], "ok");
		assert.equal(row.type, DisclosureRow); assert.equal(row.props.title, "第 " + (i + 1) + " 次思考");
		assert.equal(row.props.running, false); assert.equal(row.props.open, false, "prior attempts render collapsed");
		assert.equal(row.children[0], undefined, "collapsed prior attempts show no body");
	});
	const main = tree.children[2], mainRow = main.type(main.props).children[0];
	assert.equal(mainRow.props.title, "思考"); assert.equal(mainRow.props.running, false);
	assert.equal(tree.children.filter(n => n?.props?.className?.startsWith("dsh-btw-prose")).length, 1);
});

test("renderer prefers the live attempt while streaming and strips signatures from previews", () => {
	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	const render = createMessageRenderer({ h });
	const streaming = render({ role: "agent", text: "", reasoning: "partial committed", streaming: true,
		liveReasoning: "live now", liveReasoningRunning: true, reasoningAttempts: [{ attemptId: "a1", text: "first attempt" }] }, "x");
	const prior = streaming.children[1][0];
	assert.equal(prior.children[0].children[0], "第 1 次思考"); assert.equal(prior.children[1].children[0], "first attempt");
	const main = streaming.children[2];
	assert.equal(main.type, "details"); assert.equal(main.props.open, true);
	assert.equal(main.children[1].children[0], "live now", "the live snapshot wins over committed-so-far text");
	const stripped = render({ role: "agent", text: "a", reasoning: "committed", streaming: false,
		reasoningAttempts: [{ attemptId: "a1", text: "<signature>hidden</signature>\nshown" }, { attemptId: "a2", text: "<sig" }] }, "x");
	assert.equal(stripped.children[1].length, 1);
	assert.equal(stripped.children[1][0].children[1].children[0], "shown");
	for (const message of [{ role: "user", text: "a", reasoningAttempts: [{ text: "secret" }] },
		{ role: "agent", error: true, text: "a", reasoningAttempts: [{ text: "secret" }] }]) {
		assert.equal(render(message, "x").children.some(n => n?.props?.["data-prior"] || Array.isArray(n) && n.some(b => b?.props?.["data-prior"])), false);
	}
});

test("supplemental reads attach only to their own turn and render inside the context disclosure", async () => {
	const e = await start(); e.poll();
	latest(e, "poll").resolve({ text: "", lastSeq: 0 }); await tick();
	latest(e, "send").resolve({ output: "answer", contextReads: [{ seq: 3, role: "user", text: "r1" }, { seq: 8, role: "assistant", text: "r2" }, { seq: 9, role: "tool", text: "dropped" }] }); await tick();
	latest(e, "poll").resolve({ text: "", lastSeq: 0 }); await tick();
	let messages = e.controller.store.state.messages;
	assert.deepEqual(messages[0].context.reads, [{ seq: 3, role: "user", text: "r1" }, { seq: 8, role: "assistant", text: "r2" }], "unknown roles never attach");
	e.controller.sendTemp("second"); e.poll();
	latest(e, "poll").resolve({ text: "two", lastSeq: 1 }); await tick();
	latest(e, "send").resolve({ output: "two" }); await tick();
	latest(e, "poll").resolve({ text: "", lastSeq: 1 }); await tick();
	messages = e.controller.store.state.messages;
	assert.deepEqual(messages[0].context.reads, [{ seq: 3, role: "user", text: "r1" }, { seq: 8, role: "assistant", text: "r2" }], "earlier turns keep their reads");
	assert.equal(messages[2].context, undefined, "later turns gain no reads");
	assert.equal(messages[3].text, "two");

	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	const render = createMessageRenderer({ h });
	const tree = render({ role: "user", text: "q", context: { limited: false,
		excerpts: [{ seq: 5, role: "assistant", text: "seed" }],
		reads: [{ seq: 3, role: "user", text: "read one" }, { seq: 8, role: "assistant", text: "read two" }] } }, "x");
	const details = tree.children.find(n => n?.type === "details");
	assert.equal(details.children[0].children[0], "引用了 3 段");
	const rows = details.children.slice(1);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0].children.map(c => c.children[0]), ["助手", "seed"]);
	assert.deepEqual(rows[1].children.map(c => c.children[0]), ["补读 · 你", "read one"]);
	assert.deepEqual(rows[2].children.map(c => c.children[0]), ["补读 · 助手", "read two"]);
	assert.equal(render({ role: "user", text: "q", context: { limited: false, excerpts: [], reads: [{ seq: 1, role: "user", text: "only read" }] } }, "x")
		.children.find(n => n?.type === "details").children[0].children[0], "引用了 1 段");
	assert.equal(render({ role: "user", text: "q", context: { limited: false, excerpts: [{ seq: 5, role: "user", text: "seed" }] } }, "x")
		.children.find(n => n?.type === "details").children[0].children[0], "引用了 1 段");
	assert.equal(render({ role: "user", text: "q", context: { limited: false, excerpts: [], reads: [{ seq: 1, role: "user" }] } }, "x")
		.children.some(n => n?.type === "details"), false, "malformed reads do not fabricate citations");
	assert.equal(render({ role: "user", text: "q", context: { limited: true, excerpts: [] } }, "x")
		.children.find(n => n?.props?.className === "dsh-btw-context").children[0], "在搜索范围内未找到相关内容");
});
