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
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
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

test("committed reasoning is independent across turns and survives final output and insertion", async () => {
	const e = await start();
	e.poll(); let p = latest(e, "poll"); assert.equal(p.payload.fromReasoningSeq, 0);
	p.resolve({ text: "draft", lastSeq: 1, reasoning: "think ", reasoningLastSeq: 1 }); await tick();
	e.poll(); p = latest(e, "poll"); assert.equal(p.payload.fromReasoningSeq, 1);
	p.resolve({ text: "", lastSeq: 1, reasoning: "more", reasoningLastSeq: 2 }); await tick();
	latest(e, "send").resolve({ output: "answer" }); await tick();
	p = latest(e, "poll"); assert.equal(p.payload.fromReasoningSeq, 2);
	p.resolve({ text: "", lastSeq: 1, reasoning: " final", reasoningLastSeq: 3 }); await tick();
	let messages = e.controller.store.state.messages;
	assert.equal(messages[1].text, "answer"); assert.equal(messages[1].reasoning, "think more final");
	e.controller.toggleMessage(1); e.controller.insertSelected();
	assert.match(e.inserted(), /助手：answer/); assert.doesNotMatch(e.inserted(), /think|final/);
	e.controller.sendTemp("second"); e.poll(); p = latest(e, "poll");
	assert.equal(p.payload.fromSeq, 1); assert.equal(p.payload.fromReasoningSeq, 3);
	p.resolve({ text: "two", lastSeq: 2, reasoning: "second thought", reasoningLastSeq: 4 }); await tick();
	latest(e, "send").resolve({ output: "two" }); await tick();
	latest(e, "poll").resolve({ text: "", lastSeq: 2, reasoning: "", reasoningLastSeq: 4 }); await tick();
	messages = e.controller.store.state.messages;
	assert.equal(messages[1].reasoning, "think more final"); assert.equal(messages[3].reasoning, "second thought");
	assert.equal(messages[2].reasoning, undefined);
});

test("retry previews stay visible and separate from live and committed reasoning", async () => {
	const e = await start(); e.poll();
	let poll = latest(e, "poll"); assert.equal(poll.payload.includeLiveReasoning, true);
	poll.resolve({ text: "", lastSeq: 0, liveReasoning: { attemptId: "one", revision: 1, text: "first live", running: true } }); await tick();
	assert.equal(e.controller.store.state.messages[1].liveReasoning, "first live");
	e.poll(); poll = latest(e, "poll");
	poll.resolve({ text: "", lastSeq: 0, liveReasoning: null, retryReasoning: [{ attemptId: "one", text: "first live" }] }); await tick();
	const gap = e.controller.store.state.messages[1];
	assert.equal(gap.liveReasoning, "");
	assert.equal(gap.reasoningPreview.text, "first live", "an empty live snapshot keeps the last displayable thought");
	assert.deepEqual(JSON.parse(JSON.stringify(gap.reasoningAttempts)), [{ attemptId: "one", text: "first live" }], "an abandoned attempt stays visible instead of vanishing");
	e.poll(); poll = latest(e, "poll");
	poll.resolve({ text: "", lastSeq: 0, liveReasoning: { attemptId: "two", revision: 2, text: "replacement", running: true },
		retryReasoning: [{ attemptId: "one", text: "first live" }] }); await tick();
	const retrying = e.controller.store.state.messages[1];
	assert.equal(retrying.liveReasoning, "replacement", "attempt snapshots do not concatenate");
	assert.equal(retrying.reasoningAttempts.length, 1, "redelivered previews dedupe by attempt");
	latest(e, "send").resolve({ output: "final answer" }); await tick();
	latest(e, "poll").resolve({ text: "", lastSeq: 0, reasoning: "committed thought", reasoningLastSeq: 1, liveReasoning: null,
		retryReasoning: [{ attemptId: "one", text: "first live" }] }); await tick();
	const message = e.controller.store.state.messages[1];
	assert.equal(message.reasoning, "committed thought"); assert.equal(message.liveReasoning, "");
	assert.deepEqual(JSON.parse(JSON.stringify(message.reasoningAttempts)), [{ attemptId: "one", text: "first live" }], "the prior attempt survives completion outside the committed fields");
	assert.equal(message.streaming, false); assert.equal(message.text, "final answer");
	assert.doesNotMatch(message.reasoning + message.text, /first live|replacement/);
});

test("old host and empty reasoning never create invented content", async () => {
	const e = await start(); e.poll();
	latest(e, "poll").resolve({ text: "old", lastSeq: 1 }); await tick();
	latest(e, "send").resolve({ output: "old" }); await tick();
	assert.equal(latest(e, "poll").payload.fromReasoningSeq, 0);
	latest(e, "poll").resolve({ text: "", lastSeq: 1, reasoning: "", reasoningLastSeq: 1 }); await tick();
	assert.equal(e.controller.store.state.messages[1].reasoning, "");
});

test("serial final cut fences late intermediate replies and close/unload", async () => {
	for (const ending of ["settle", "close", "unload"]) {
		const e = await start(); e.poll(); const pending = latest(e, "poll");
		e.poll(); assert.equal(e.calls.filter(c => c.method === "poll").length, 1);
		if (ending === "settle") latest(e, "send").resolve({ output: "answer" });
		if (ending === "close") await e.controller.closeTemp();
		if (ending === "unload") e.unload();
		await tick(); pending.resolve({ text: "stale", lastSeq: 1, reasoning: "stale thought", reasoningLastSeq: 1 }); await tick();
		if (ending === "settle") {
			const final = latest(e, "poll"); assert.notEqual(final, pending); assert.equal(final.payload.fromReasoningSeq, 0);
			final.resolve({ text: "fresh", lastSeq: 1, reasoning: "fresh thought", reasoningLastSeq: 1 }); await tick();
			assert.equal(e.controller.store.state.messages[1].reasoning, "fresh thought");
		} else assert.doesNotMatch(JSON.stringify(e.controller.store.state.messages), /stale/);
	}
});

test("factory sees only eligible reasoning and supplies safe missing-factory fallback", () => {
	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	function MarkdownText() {}
	for (const markdown of [MarkdownText, null]) {
		const render = createMessageRenderer({ h, MarkdownText: markdown });
		let calls = 0;
		const factory = (name, input, options) => {
			calls++; assert.equal(name, "conversation.chat.reasoning.content");
			assert.equal(input.text, "<script>child</script>"); assert.equal(input.running, true);
			assert.deepEqual(Object.keys(input).sort(), ["labels", "running", "text"]);
			return options.fallback;
		};
		const tree = render({ role: "agent", text: "answer", reasoning: "<script>child</script>", streaming: true }, "x", null, factory);
		const details = tree.children.find(n => n?.type === "details"), content = details.children[1];
		assert.equal(markdown ? content.props.text : content.children[0], "<script>child</script>");
		assert.equal(content.props.dangerouslySetInnerHTML, undefined);
		for (const message of [{ role: "agent", text: "a" }, { role: "agent", text: "a", reasoning: "" }, { role: "user", text: "a", reasoning: "secret" }, { role: "agent", error: true, text: "a", reasoning: "secret" }]) render(message, "x", null, factory);
		assert.equal(calls, 1);
	}
});

test("reasoning uses the public native disclosure and thinking icon when available", () => {
	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	let expanded, calls = 0;
	const React = { useState: initial => { if (expanded === undefined) expanded = initial; return [expanded, update => { expanded = update; }]; } };
	function DisclosureRow() {} function ThinkIcon() {} function TextShimmer() {}
	const render = createMessageRenderer({ h, React, DisclosureRow, ThinkIcon, TextShimmer });
	const factory = (name, input) => { calls++; assert.equal(name, "conversation.chat.reasoning.content"); assert.equal(input.text, "**First thought**\nmore"); return "native-body"; };
	const message = render({ role: "agent", text: "answer", reasoning: "**First thought**\nmore", streaming: true }, "x", null, factory);
	const block = message.children.find(node => typeof node?.type === "function");
	let row = block.type(block.props).children[0];
	assert.equal(row.type, DisclosureRow); assert.equal(row.props.title, "思考"); assert.equal(row.props.icon.type, ThinkIcon);
	assert.equal(row.props.open, true); assert.equal(row.props.running, true); assert.equal(calls, 1);
	assert.equal(row.children[0].children[0], "native-body");
	const paused = () => block.type({ ...block.props, running: false }).children[0];
	assert.equal(paused().props.open, true, "a pause in thought does not fold the active turn");
	row.props.onToggle(); row = block.type(block.props).children[0];
	assert.equal(row.props.collapsedContent[0].props["data-shimmer-decoration"], true);
	assert.equal(row.props.collapsedContent[1].children[0].type, TextShimmer);
	assert.equal(paused().props.open, false, "manual collapse survives pauses");
	assert.equal(block.type(block.props).children[0].props.open, false, "new deltas respect manual collapse");
	row.props.onToggle();
	assert.equal(paused().props.open, true);
	const finished = () => block.type({ ...block.props, running: false, autoOpen: false }).children[0];
	assert.equal(finished().props.open, true, "manual expansion survives completion");
	expanded = null;
	assert.equal(finished().props.open, false, "untouched disclosures fold when the whole turn completes");
});

test("the display-only fallback keeps the current row through empty steps and avoids duplicate archived thoughts", () => {
	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	const render = createMessageRenderer({ h });
	const state = { role: "agent", text: "", streaming: true, liveReasoning: "", reasoningPreview: { attemptId: "old", text: "previous thought" } };
	const row = message => render(message, "turn").children.find(node => node?.props?.key === "current-reasoning");
	assert.equal(row(state).children[1].children[0], "previous thought");
	const waiting = { ...state, liveReasoning: "<signature>masked", reasoningAttempts: [{ attemptId: "old", text: "previous thought" }] };
	const tree = render(waiting, "turn");
	assert.equal(tree.children[1], null, "the waiting preview is only rendered once");
	assert.equal(row(waiting).children[1].children[0], "previous thought");
	assert.equal(row(waiting).props.open, true);
	const retry = { ...waiting, liveReasoning: "next thought", liveReasoningRunning: true };
	assert.equal(row(retry).children[1].children[0], "next thought");
	assert.equal(render(retry, "turn").children[1][0].children[1].children[0], "previous thought");
	assert.equal(row({ ...state, streaming: false }), undefined, "a preview is never treated as committed");
});

test("reasoning hides signature metadata and incomplete signature prefixes", () => {
	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	const render = createMessageRenderer({ h });
	for (const reasoning of ["<sig", "<signature>secret"]) {
		assert.equal(render({ role: "agent", text: "a", reasoning, streaming: true }, "x").children.some(n => n?.type === "details"), false);
	}
	const row = render({ role: "agent", text: "a", reasoning: "<signature>secret</signature>\nvisible" }, "x");
	const details = row.children.find(n => n?.type === "details");
	assert.equal(details.children[1].children[0], "visible");
});

test("renderer isolates real reasoning in collapsed details with native markdown or plain fallback", () => {
	const { createMessageRenderer } = load("client.messages.js");
	const h = (type, props, ...children) => ({ type, props: props || {}, children });
	function MarkdownText() {}
	for (const markdown of [MarkdownText, null]) {
		const render = createMessageRenderer({ h, MarkdownText: markdown });
		const tree = render({ role: "agent", text: "answer", reasoning: "thought", streaming: false }, "x");
		const details = tree.children.find(n => n?.type === "details");
		assert.ok(details); assert.equal(details.props.open, undefined); assert.equal(details.children[0].children[0], "思考过程");
		assert.equal(markdown ? details.children[1].props.text : details.children[1].children[0], "thought");
		const answer = tree.children.find(n => n?.props.className?.startsWith("dsh-btw-prose"));
		assert.equal(answer.children[0]?.props?.text ?? answer.children[0], "answer");
		for (const message of [{ role: "agent", text: "a" }, { role: "agent", text: "a", reasoning: "" }, { role: "user", text: "a", reasoning: "secret" }, { role: "agent", error: true, text: "a", reasoning: "secret" }]) {
			assert.equal(render(message, "x").children.some(n => n?.type === "details"), false);
		}
	}
});
