import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function setup(config = {}, options = {}) {
	const registrations = new Map(), calls = [], writes = [];
	const hooks = new Map();
	let plugin, active, index = 0, listener, cleanup, pendingEffects = [];
	const snapshot = { status: "ready", writable: true, value: config };
	const scope = {
		getSnapshot: () => snapshot,
		subscribe: (fn) => { listener = fn; return () => {}; },
		set: (key, value) => { writes.push([key, value]); if (options.settingResult === false) return Promise.resolve(false); snapshot.value[key] = value; listener(); return Promise.resolve(true); },
		mutate: (ops) => { writes.push(ops); if (options.settingResult === false) return Promise.resolve(false); for (const op of ops) snapshot.value[op.path[0]] = op.value; listener(); return Promise.resolve(true); },
	};
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
		useState: (initial) => { const i = index++; const state = hooks.get(active); if (!(i in state)) state[i] = initial; return [state[i], (value) => { state[i] = value; }]; },
		useReducer: () => { index++; return [0, () => {}]; },
		useEffect: (fn, deps) => { if (!options.effects) return; const state = hooks.get(active), i = index++, old = state[i]; if (!old || !deps || deps.some((v, n) => v !== old.deps[n])) pendingEffects.push(() => { old?.cleanup?.(); state[i] = { deps, cleanup: fn() }; }); },
		useLayoutEffect: () => {}, useRef: (value) => { const state = hooks.get(active), i = index++; if (!(i in state)) state[i] = { current: value }; return state[i]; },
	};
	const render = (component, props = {}) => { active = component; index = 0; pendingEffects = []; if (!hooks.has(component)) hooks.set(component, []); const result = component(props); for (const effect of pendingEffects) effect(); return result; };
	const sandbox = {
		window: { __ModuleLoader__: { load: (value) => { plugin = value.factory(() => React); } } },
		document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
		setInterval: options.setInterval || setInterval, clearInterval: options.clearInterval || clearInterval, setTimeout, AbortController, TextEncoder, Date: options.Date || Date, requestAnimationFrame() {},
	};
	vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), sandbox);
	const connection = { rpc: { call: (...args) => { calls.push(args); return Promise.resolve(options.rpc ? options.rpc(args[1], args[2]) : args[1] === "models" ? { ok: true, value: { providers: [{ id: "p", models: [{ id: "m", name: "Model" }] }] } } : { ok: false, error: { message: "offline" } }); } }, ...options.connection };
	let currentConnection = connection;
	const ctx = {
		configForms: { get: (key) => { assert.equal(key, "btw"); return scope; } },
		slots: { inject: (_name, fn) => fn(), register: (meta, component) => { registrations.set(meta.id || meta.key || meta.name, component); return () => {}; } },
		get: (key) => key === "connection" ? currentConnection : undefined,
		effect: (fn) => { cleanup = fn(); },
	};
	if (options.noSettings) delete ctx.configForms;
	if (options.badSidebar) ctx.inject = () => { throw new Error("unavailable"); };
	if (options.sidebar || options.layout || options.remote) ctx.inject = (deps, fn) => {
		if (deps[0] === "configForms") return fn({ configForms: ctx.configForms });
		if (deps[0] === "remote") {
			// Cordis activates only with all required services, and a root Remote
			// injection does not grant access to any namespace automatically.
			if (!options.remote || (deps.includes("remote.session") && !options.remote.session)) return () => {};
			const remote = { get session() {
				if (!deps.includes("remote.session")) throw new Error('cannot get property "remote.session" without inject');
				return options.remote.session;
			} };
			return fn({ remote, connection });
		}
		if (deps[0] === "layout") return options.layout ? fn({ layout: options.layout }) : () => {};
		return options.sidebar ? fn({ slots: ctx.slots, sidebarRight: options.sidebar, sidebarRightTabs: { register: (definition) => { options.definition = definition; return () => {}; } } }) : () => {};
	};
	plugin.apply(ctx);
	return { registrations, calls, writes, render, connection, replaceConnection: (next = { ...connection }) => { currentConnection = next; }, unmount: (component) => { for (const hook of hooks.get(component) || []) hook?.cleanup?.(); hooks.delete(component); }, cleanup: () => cleanup?.() };
}
function all(node, predicate, out = []) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) { for (const item of node) all(item, predicate, out); return out; }
	if (predicate(node)) out.push(node);
	for (const child of node.children || []) all(child, predicate, out);
	return out;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const chatProps = (sessionId, nodes = []) => ({
	sessionId,
	useSession: (select) => select({ sessionId, openState: "open", removed: false, blank: nodes.length === 0 }),
	useChat: (select) => select({ legacy: { nodes, partial: null, runningCalls: [] } }),
});
function manualTimers() {
	const timers = new Set();
	return { setInterval: (fn) => { timers.add(fn); return fn; }, clearInterval: (fn) => timers.delete(fn), size: () => timers.size, poll: () => { for (const fn of [...timers]) fn(); } };
}

test("settings writes toggle and selected model through form scope", async () => {
	const env = setup(); await tick();
	const wrapper = env.registrations.get("dsh-btw#btw")({});
	const tree = env.render(wrapper.type);
	const checkbox = all(tree, (n) => n.type === "input")[0];
	checkbox.props.onChange({ target: { checked: false } }); await tick();
	assert.deepEqual(env.writes[0], ["showAskChip", false]);
	assert.equal(env.render(env.registrations.get("btw-trigger")), null);
	const modelComponent = all(tree, (n) => typeof n.type === "function")[0];
	const model = env.render(modelComponent.type, modelComponent.props);
	const select = all(model, (n) => n.type === "select")[0];
	assert.ok(all(select, (n) => n.type === "option").some((n) => n.props.value === '["p","m"]'));
	select.props.onChange({ target: { value: '["p","m"]' } }); await tick();
	assert.deepEqual(JSON.parse(JSON.stringify(env.writes[1])), [
		{ op: "set", path: ["askProvider"], value: "p" }, { op: "set", path: ["askModel"], value: "m" }, { op: "set", path: ["askModelMode"], value: "custom" },
	]);
});

test("old host catalog explains restart and retry loads the updated host", async () => {
	let outdated = true;
	const env = setup({}, { rpc: () => outdated
		? { ok: false, error: { message: "unknown method: models" } }
		: { ok: true, value: { providers: [{ id: "p", models: [{ id: "m", name: "Model" }] }] } } });
	await tick();
	const settings = env.render(env.registrations.get("dsh-btw#btw")({}).type);
	const model = all(settings, (n) => typeof n.type === "function")[0];
	const render = () => env.render(model.type, model.props);
	let tree = render();
	assert.match(JSON.stringify(tree), /宿主仍运行旧版 btw，请重启 dsh web 并刷新页面后重试/);
	assert.doesNotMatch(JSON.stringify(tree), /unknown method/);
	outdated = false;
	all(tree, (n) => n.type === "button" && n.children.includes("重试"))[0].props.onClick();
	await tick(); tree = render();
	assert.equal(all(tree, (n) => n.props.className === "dsh-btw-err").length, 0);
	assert.ok(all(tree, (n) => n.type === "option").some((n) => n.props.value === '["p","m"]'));
	env.cleanup();
});

test("unrelated catalog failures are not misreported as an outdated host", async () => {
	for (const message of ["authentication required", "network unavailable"]) {
		const env = setup({}, { rpc: () => ({ ok: false, error: { message } }) }); await tick();
		const settings = env.render(env.registrations.get("dsh-btw#btw")({}).type);
		const model = all(settings, (n) => typeof n.type === "function")[0];
		const tree = JSON.stringify(env.render(model.type, model.props));
		assert.ok(tree.includes(message)); assert.doesNotMatch(tree, /宿主仍运行旧版/);
		env.cleanup();
	}
});

test("settings reports false set/mutate receipts and clears the error after a real save", async () => {
	const options = { settingResult: false }, env = setup({}, options); await tick();
	const component = env.registrations.get("dsh-btw#btw")({}).type;
	let tree = env.render(component);
	all(tree, (n) => n.type === "input")[0].props.onChange({ target: { checked: false } }); await tick();
	assert.ok(all(env.render(component), (n) => n.props.className === "dsh-btw-err").some((n) => n.children[0].includes("设置未保存")));
	const model = all(tree, (n) => typeof n.type === "function")[0]; model.props.onChange('["p","m"]'); await tick();
	assert.ok(all(env.render(component), (n) => n.props.className === "dsh-btw-err").some((n) => n.children[0].includes("设置未保存")));
	options.settingResult = true; tree = env.render(component);
	all(tree, (n) => n.type === "input")[0].props.onChange({ target: { checked: false } }); await tick();
	assert.equal(all(env.render(component), (n) => n.props.className === "dsh-btw-err").length, 0); env.cleanup();
});

test("recent reads the native Conversation legacy slice, never lifecycle or partial text", async () => {
	for (const hook of ["useChat", "useConversation"]) {
		const env = setup({ askContextMode: "recent" }); await tick(); env.render(env.registrations.get("btw-trigger")).props.onClick();
		const nodes = [{ kind: "user", content: [{ type: "text", text: "recorded question" }] }, { kind: "assistant", blocks: [{ kind: "text", text: "recorded answer" }] }];
		const props = chatProps("origin", nodes);
		if (hook === "useConversation") { delete props.useChat; props.useConversation = (select) => select({ views: { get: (target) => { assert.equal(target, "chat"); return { legacy: { nodes, partial: { text: "uncommitted" } } }; } }, activeTargets: new Set(["chat"]) }); }
		const ask = env.registrations.get("btw-ask"); let tree = env.render(ask, props);
		all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "followup" } });
		tree = env.render(ask, props); all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
		assert.equal(env.calls.find((c) => c[1] === "ask")[2].transcript, "User: recorded question\n\nAssistant: recorded answer"); env.cleanup();
	}
});

test("ask transmits selected model and configured context without snapshot", async () => {
	const env = setup({ askContextMode: "none", askModelMode: "custom", askProvider: "p", askModel: "m" }); await tick();
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	const component = env.registrations.get("btw-ask");
	const props = chatProps("s1", [{ kind: "user", content: [{ type: "text", text: "secret" }] }]);
	let tree = env.render(component, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
	tree = env.render(component, props);
	all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
	const call = env.calls.find((entry) => entry[1] === "ask");
	assert.deepEqual(JSON.parse(JSON.stringify(call[2])), { question: "question", transcript: "", contextMode: "none", modelMode: "custom", model: { provider: "p", model: "m" }, parentSessionId: "s1" });
});

test("on-demand sends only the authorized recent snapshot", async () => {
	const env = setup({ askContextMode: "on-demand" }); await tick();
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	const component = env.registrations.get("btw-ask");
	const props = chatProps("origin", Array.from({ length: 20 }, (_, i) => ({ kind: "user", content: [{ type: "text", text: `line ${i}` }] })));
	let tree = env.render(component, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
	tree = env.render(component, props);
	all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
	const payload = env.calls.find((entry) => entry[1] === "ask")[2];
	assert.equal(payload.contextMode, "on-demand");
	assert.ok(payload.transcript.includes("line 19"));
	assert.ok(!payload.transcript.includes("line 0"));
});

test("current ask selection delegates resolution with parent session", async () => {
	const env = setup({ askModelMode: "current" }); await tick();
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	const component = env.registrations.get("btw-ask"), props = { sessionId: "origin" };
	let tree = env.render(component, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hello" } });
	tree = env.render(component, props);
	all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
	const payload = env.calls.find((c) => c[1] === "ask")[2];
	assert.equal(payload.parentSessionId, "origin");
	assert.equal(payload.model, undefined);
});

test("optional services do not prevent activation", () => {
	const env = setup({}, { noSettings: true, badSidebar: true });
	assert.ok(env.registrations.has("btw-ask"));
	assert.ok(env.registrations.has("btw"));
});

test("visibility switches hide both global and session entries", () => {
	const env = setup({ showAskChip: false, showTempEntry: false });
	assert.equal(env.render(env.registrations.get("btw-trigger")), null);
	assert.equal(env.render(env.registrations.get("conversation.header.leading")), null);
	assert.equal(env.render(env.registrations.get("btw-temp")), null);
});

test("first send opens with chosen context and model, then locks controls", async () => {
	const env = setup({}, { rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [{ id: "p", models: [{ id: "m" }] }] } : method === "open" ? { sessionId: "tmp", cwd: "/project" } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
	await tick();
	env.render(env.registrations.get("btw-ask"), chatProps("origin", [{ kind: "user", content: [{ type: "text", text: "recent text" }] }]));
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin", useSessions: (fn) => fn({ byId: { origin: { cwd: "/project" } } }) }).props.onClick();
	assert.equal(env.calls.some((c) => c[1] === "open"), false);
	const overlay = env.registrations.get("btw");
	let tree = env.render(overlay);
	all(tree, (n) => n.props["aria-label"] === "临时聊天上下文")[0].props.onChange({ target: { value: "recent" } });
	const modelComponent = all(tree, (n) => typeof n.type === "function")[0];
	env.render(modelComponent.type, modelComponent.props).children[0].props.onChange({ target: { value: '["p","m"]' } });
	tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
	tree = env.render(overlay);
	all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick();
	await tick(); await tick();
	const open = env.calls.find((c) => c[1] === "open")[2];
	assert.deepEqual(JSON.parse(JSON.stringify(open)), { cwd: "/project", contextMode: "recent", transcript: "User: recent text", modelMode: "custom", model: { provider: "p", model: "m" }, parentSessionId: "origin" });
	assert.equal(env.calls.filter((c) => c[1] === "send").length, 1);
	assert.equal(all(env.render(overlay), (n) => n.props["aria-label"] === "临时聊天上下文")[0].props.disabled, true);
});

test("temporary on-demand sends snapshot and controls follow model-context-send order", async () => {
	const env = setup({}, { rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "temp", cwd: null } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
	await tick();
	env.render(env.registrations.get("btw-ask"), chatProps("origin", [{ kind: "user", content: [{ type: "text", text: "bounded" }] }]));
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	const tools = all(tree, (n) => n.props.className === "dsh-btw-tools")[0];
	assert.equal(typeof tools.children[0].type, "function");
	assert.equal(all(tools.children[1], (n) => n.props["aria-label"] === "临时聊天上下文").length, 1);
	assert.equal(tools.children[2].props["aria-label"], "发送");
	all(tree, (n) => n.props["aria-label"] === "临时聊天上下文")[0].props.onChange({ target: { value: "on-demand" } });
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hello" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick(); await tick();
	const payload = env.calls.find((c) => c[1] === "open")[2];
	assert.equal(payload.contextMode, "on-demand"); assert.equal(payload.transcript, "User: bounded");
	assert.equal(payload.modelMode, "host");
});

test("new conversation header opens standalone without workspace and exit waits for close", async () => {
	let resolveClose; const selected = [];
	const layout = { selectPanel: (id) => selected.push(id) };
	const env = setup({ tempModelMode: "current", tempContextMode: "all" }, { effects: true, layout, rpc: (method) => method === "close" ? new Promise((resolve) => { resolveClose = resolve; }) : ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "global", cwd: null } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
	await tick();
	assert.ok(!env.registrations.has("btw-temp-global"));
	assert.ok(env.registrations.has("conversation.header.leading"));
	env.render(env.registrations.get("conversation.header.leading")).props.onClick();
	assert.deepEqual(selected, ["dsh-btw-global"]);
	const panel = env.registrations.get("dsh-btw-global");
	let view = env.render(panel); view = env.render(panel);
	const overlay = view.type, props = view.props;
	let tree = env.render(overlay, props);
	assert.ok(all(tree, (n) => n.props["data-global"] === true).length);
	assert.equal(all(tree, (n) => n.props.className === "dsh-btw-msub")[0].children[0], "结束后删除本机临时记录");
	assert.equal(all(tree, (n) => n.children.includes("临时聊天")).length, 1, "no duplicate empty-state title");
	assert.equal(all(tree, (n) => n.props["aria-label"] === "临时聊天上下文").length, 0);
	const model = all(tree, (n) => typeof n.type === "function")[0];
	assert.equal(all(env.render(model.type, model.props), (n) => n.props.value === "current").length, 0);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hi" } });
	tree = env.render(overlay, props); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick();
	await tick(); await tick();
	const open = env.calls.find((c) => c[1] === "open")[2];
	assert.equal(open.cwd, null); assert.equal(open.parentSessionId, undefined); assert.equal(open.contextMode, "none");
	assert.equal(open.modelMode, "host"); assert.equal(open.transcript, "");
	tree = env.render(overlay, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "second turn" } });
	tree = env.render(overlay, props); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick();
	await tick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "open").length, 1);
	assert.deepEqual(env.calls.filter((c) => c[1] === "send").map((c) => [c[2].sessionId, c[2].text]), [["global", "hi"], ["global", "second turn"]]);
	tree = env.render(overlay, props);
	assert.deepEqual(all(tree, (n) => n.props.className === "dsh-btw-bubble").map((n) => n.children[0]), ["hi", "ok", "second turn", "ok"]);
	assert.equal(all(tree, (n) => n.props.className === "dsh-btw-msub")[0].children[0], "结束后删除本机临时记录");
	all(tree, (n) => n.type === "button" && n.children[0] === "退出临时聊天")[0].props.onClick();
	assert.deepEqual(selected, ["dsh-btw-global"]);
	resolveClose({ ok: true, value: {} }); await tick();
	assert.deepEqual(selected, ["dsh-btw-global", null]);
	env.cleanup();
});

function historyFixture(records, extra = {}) {
	let connected = "connected", now = 0;
	const listeners = new Set(), pages = [];
	const state = { getSnapshot: () => connected, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
	const remote = { session: new Proxy({ events: async (request, signal) => {
		pages.push(JSON.parse(JSON.stringify(request)));
		assert.equal(request.address.sessionId, "origin"); assert.equal(request.address.kind, "session");
		if (extra.events) return extra.events(request, signal, pages.length);
		const cursor = request.throughSeq ?? (records.length - 1), end = request.beforeSeq ?? cursor + 1;
		const start = Math.max(0, end - 4);
		return { ok: true, value: { cursor, records: records.slice(start, end), hasMore: start > 0 } };
	} }, { get: (target, key) => { if (!(key in target)) throw new Error("forbidden source write: " + String(key)); return target[key]; } }) };
	const env = setup({ askContextMode: "all", tempContextMode: "all" }, { remote, effects: true, connection: { state }, Date: class extends Date { static now() { return now; } }, ...extra });
	const component = env.registrations.get("btw-ask"), props = chatProps("origin", [{ kind: "user", content: [{ type: "text", text: "projection must not be sent" }] }]);
	const submit = () => {
		if (!env.render(component, props)) env.render(env.registrations.get("btw-trigger")).props.onClick();
		let tree = env.render(component, props);
		all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
		tree = env.render(component, props); all(tree, (n) => n.props["aria-label"] === "提问")[0]?.props.onClick();
	};
	return { ...env, pages, component, props, submit, error: () => all(env.render(component, props), (n) => n.props.className === "dsh-btw-answer dsh-btw-err")[0]?.children[0], advance: (ms) => { now += ms; }, disconnect: () => { connected = "disconnected"; for (const fn of listeners) fn(); }, reconnect: () => { connected = "connected"; for (const fn of listeners) fn(); } };
}
const record = (seq, type = "user/message", text = "text " + seq) => ({ type: "event", event: { seq, type, data: type === "user/message" ? { content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } } } });

test("all binds the guarded remote.session namespace and degrades safely when unavailable", async () => {
	for (const available of ["present", "missing-root", "missing-session"]) {
		const extra = available === "present" ? {} : { remote: available === "missing-root" ? undefined : {} };
		const env = historyFixture([record(0, "user/message", "recorded marker")], extra);
		await tick(); env.render(env.registrations.get("btw-trigger")).props.onClick();
		const tree = env.render(env.component, env.props);
		all(tree, (n) => typeof n.type === "function")[0].props.onChange("current");
		env.submit(); await tick(); await tick();
		const payload = env.calls.find((c) => c[1] === "ask")?.[2];
		if (available === "present") {
			assert.ok(payload, env.error());
			assert.ok(payload.transcript.includes("recorded marker"));
			assert.equal(payload.modelMode, "current"); assert.equal(payload.parentSessionId, "origin");
			assert.equal(env.pages.length, 1);
			env.submit(); await tick();
			assert.equal(env.calls.filter((c) => c[1] === "ask").at(-1)[2].transcript, payload.transcript);
			assert.equal(env.pages.length, 2, "cached transcript still confirms the head");
		} else {
			assert.equal(payload, undefined); assert.equal(env.pages.length, 0);
			assert.match(env.error(), /完整对话读取服务不可用/);
			assert.ok(env.registrations.has("btw"), "missing optional history must not disable temporary chat");
		}
		env.cleanup();
	}
});

test("all pages full recorded text, including pre-compaction and tool output, with no source writes", async () => {
	const records = Array.from({ length: 22 }, (_, i) => record(i, i % 2 ? "assistant/message" : "user/message", `${i}:` + "x".repeat(3000)));
	records[20] = record(20, "tool/result", "raw tool output");
	records[21] = { ...record(21, "assistant/message", "summary"), event: { ...record(21, "assistant/message", "summary").event, surfaceOp: { type: "replace", startSeq: 0, endSeq: 19 } } };
	const env = historyFixture(records); await tick(); env.submit(); await tick(); await tick();
	const payload = env.calls.find((c) => c[1] === "ask")[2];
	assert.equal(payload.contextMode, "all"); assert.equal(payload.parentSessionId, "origin");
	assert.deepEqual(JSON.parse(JSON.stringify(payload.contextSnapshot)), { sessionId: "origin", throughSeq: 21, complete: true, authorized: true });
	assert.ok(payload.transcript.length > 48_000); assert.ok(payload.transcript.includes("0:" + "x".repeat(3000)));
	assert.ok(payload.transcript.includes("raw tool output")); assert.ok(payload.transcript.includes("replacement="));
	assert.ok(!payload.transcript.includes("projection must not"));
	assert.equal(env.pages[0].throughSeq, undefined);
	assert.ok(env.pages.slice(1).every((p) => p.throughSeq === 21));
	assert.equal(env.writes.length, 0); env.cleanup();
});

test("all cache confirms head, reuses same cut and prefix, expires and clears on disconnect/source close", async () => {
	const records = Array.from({ length: 12 }, (_, i) => record(i));
	const env = historyFixture(records); await tick(); env.submit(); await tick(); await tick();
	assert.equal(env.pages.length, 3);
	env.submit(); await tick(); assert.equal(env.pages.length, 4);
	records.push(record(12)); env.submit(); await tick(); assert.equal(env.pages.length, 5);
	assert.ok(env.calls.filter((c) => c[1] === "ask").at(-1)[2].transcript.includes("text 12"));
	env.advance(60_001); env.submit(); await tick(); assert.equal(env.pages.length, 9);
	env.disconnect(); env.reconnect(); env.submit(); await tick(); assert.equal(env.pages.length, 13);
	env.unmount(env.component); env.submit(); await tick(); assert.equal(env.pages.length, 17);
	env.cleanup();
});

test("all shares concurrent ask/open reads without mutating the main session", async () => {
	const records = Array.from({ length: 12 }, (_, i) => record(i));
	const env = historyFixture(records); await tick(); env.submit();
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "temp" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick();
	await tick(); await tick(); assert.equal(env.pages.length, 3);
	const askPayload = env.calls.find((c) => c[1] === "ask")[2], openPayload = env.calls.find((c) => c[1] === "open")[2];
	assert.equal(askPayload.transcript, openPayload.transcript); assert.equal(openPayload.contextSnapshot.throughSeq, 11);
	assert.equal(env.writes.length, 0); env.cleanup();
});

test("all refuses oversized, empty or discontinuous pages, never truncates or falls back", async () => {
	for (const [records, error] of [
		[[record(0, "user/message", "x".repeat(1024 * 1024))], /超过/],
		[[record(0), record(3)], /不连续/],
	]) {
		const env = historyFixture(records); await tick(); env.submit(); await tick(); await tick();
		assert.equal(env.calls.some((c) => c[1] === "ask"), false); assert.match(env.error(), error); env.cleanup();
	}
	const env = historyFixture([], { events: () => ({ ok: true, value: { cursor: 9, records: [], hasMore: true } }) });
	await tick(); env.submit(); await tick(); assert.match(env.error(), /空页|缺页/); assert.equal(env.calls.some((c) => c[1] === "ask"), false); env.cleanup();
});

test("all rejects missing early pages, changed cursors, and empty source", async () => {
	for (const value of [
		{ cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i + 4)), hasMore: false },
		{ cursor: -1, records: [], hasMore: false },
	]) {
		const env = historyFixture([], { events: () => ({ ok: true, value }) });
		await tick(); env.submit(); await tick(); assert.match(env.error(), /缺少|没有已记录/);
		assert.equal(env.calls.some((c) => c[1] === "ask"), false); env.cleanup();
	}
	const env = historyFixture([], { events: (_request, _signal, n) => ({ ok: true, value: n === 1 ? { cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i + 4)), hasMore: true } : { cursor: 8, records: Array.from({ length: 4 }, (_, i) => record(i)), hasMore: false } }) });
	await tick(); env.submit(); await tick(); assert.match(env.error(), /切点改变/); env.cleanup();
});

test("all cancels one merged consumer without cancelling the other", async () => {
	let release;
	const env = historyFixture([], { events: () => new Promise((resolve) => { release = resolve; }) });
	await tick(); env.submit();
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "temp" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick();
	all(env.render(env.component, env.props), (n) => n.props["aria-label"] === "关闭侧问面板")[0].props.onClick();
	release({ ok: true, value: { cursor: 0, records: [record(0)], hasMore: false } }); await tick(); await tick();
	assert.equal(env.pages.length, 1); assert.equal(env.calls.some((c) => c[1] === "ask"), false);
	assert.ok(env.calls.some((c) => c[1] === "open")); env.cleanup();
});

test("all aborts in-flight pages on source close and unload", async () => {
	for (const close of ["source", "plugin"]) {
		let release, readSignal;
		const env = historyFixture([], { events: (_request, signal, n) => n === 1 ? { ok: true, value: { cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i + 4)), hasMore: true } } : new Promise((resolve) => { release = resolve; readSignal = signal; }) });
		await tick(); env.submit(); await tick();
		if (close === "source") env.unmount(env.component); else env.cleanup();
		assert.equal(readSignal.aborted, true);
		release({ ok: true, value: { cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i)), hasMore: false } }); await tick(); await tick();
		assert.equal(env.calls.some((c) => c[1] === "ask"), false); env.cleanup();
	}
});

test("all cancels on connection replacement, disconnect and explicit close", async () => {
	for (const action of ["replaceConnection", "disconnect", "cancel"]) {
		let resolve;
		const env = historyFixture([], { events: () => new Promise((fn) => { resolve = fn; }) });
		await tick(); env.submit();
		if (action === "cancel") all(env.render(env.component, env.props), (n) => n.props["aria-label"] === "关闭侧问面板")[0].props.onClick(); else env[action]();
		resolve({ ok: true, value: { cursor: 0, records: [record(0)], hasMore: false } }); await tick(); await tick();
		assert.equal(env.calls.some((c) => c[1] === "ask"), false); env.cleanup();
	}
});

function tempFixture() {
	let mounted = "origin", reject = false, draft = "original @reference", captured, insertions = 0;
	let expanded = true, collapses = 0;
	const sidebar = {
		mounted: { getSnapshot: () => mounted }, openTab: () => { expanded = true; },
		isExpanded: () => expanded,
		toggleExpanded: () => { assert.equal(expanded, true, "popup must never expand the sidebar"); expanded = false; collapses++; },
		close: () => assert.fail("presentation changes must not close tabs"),
		hide: () => assert.fail("hide can close floating tabs; collapse the column instead"),
	};
	const options = { effects: true, sidebar, rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "temp", cwd: "/tmp" } : method === "send" ? { output: "answer" } : method === "poll" ? { text: "", lastSeq: 0 } : {} }) };
	const env = setup({}, options);
	const actions = {
		captureInsertion: () => { captured = { start: 0, end: 8, draftRev: 4 }; return captured; },
		insertText: (text, span) => { insertions++; assert.equal(span.start, 8); assert.equal(span.end, 8); assert.equal(span.draftRev, 4); if (reject) return false; draft = draft.slice(0, span.start) + text + draft.slice(span.end); return true; },
	};
	env.render(env.registrations.get("btw-ask"), { sessionId: "origin", inputActions: actions });
	return { ...env, options, sidebarState: () => ({ expanded, collapses }), setMounted: (v) => { mounted = v; }, setReject: (v) => { reject = v; }, getDraft: () => draft, getInsertions: () => insertions };
}
async function startAndSelect(env) {
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick(); await tick();
	const overlay = env.registrations.get("btw");
	let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hello" } });
	tree = env.render(overlay);
	all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick(); await tick();
	tree = env.render(overlay);
	all(tree, (n) => n.type === "input" && n.props.type === "checkbox")[0].props.onChange();
	return overlay;
}

test("side question docks into the same btw chat controls, preserving draft and choices", async () => {
	const env = setup({}, { effects: true, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {} } });
	await tick(); env.render(env.registrations.get("btw-trigger")).props.onClick();
	const ask = env.registrations.get("btw-ask"), props = { sessionId: "origin", useSessions: (fn) => fn({ byId: { origin: { cwd: "/project" } } }) };
	let tree = env.render(ask, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "continue this" } });
	all(tree, (n) => n.props["aria-label"] === "侧问上下文")[0].props.onChange({ target: { value: "all" } });
	tree = env.render(ask, props); all(tree, (n) => n.props["aria-label"] === "停靠侧边栏")[0].props.onClick();
	assert.equal(env.render(ask, props), null);
	const body = env.render(env.registrations.get("dsh-btw/temp"), { btwSessionId: "origin" });
	const pane = env.render(body.type, body.props);
	assert.equal(all(pane, (n) => n.type === "textarea")[0].props.value, "continue this");
	assert.equal(all(pane, (n) => n.props["aria-label"] === "临时聊天上下文")[0].props.value, "all");
	assert.equal(all(pane, (n) => n.props.role === "tablist").length, 0);
	assert.ok(all(pane, (n) => n.props["aria-label"] === "发送").length); env.cleanup();
});

test("ending during all/open preserves the late child id when close fails and retries it", async () => {
	const opened = deferred(); let closes = 0;
	const env = historyFixture([record(0)], { rpc: (method) => {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return opened.promise;
		if (method === "close") return ++closes === 1 ? { ok: false, error: { message: "EACCES" } } : { ok: true, value: {} };
		throw new Error("must not send into a closing child");
	} });
	await tick(); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "first" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick();
	tree = env.render(overlay); all(tree, (n) => n.type === "button" && n.children[0] === "结束对话")[0].props.onClick();
	opened.resolve({ ok: true, value: { sessionId: "late-child", cwd: null } }); await tick(); await tick();
	tree = env.render(overlay);
	assert.ok(all(tree, (n) => n.props.role === "status")[0].children[0].includes("EACCES"));
	assert.equal(env.calls.filter((c) => c[1] === "close")[0][2].sessionId, "late-child");
	all(tree, (n) => n.type === "button" && n.children[0] === "结束对话")[0].props.onClick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "close").at(-1)[2].sessionId, "late-child");
	assert.equal(env.render(overlay), null); env.cleanup();
});

test("unload owns late open cleanup and never routes its child to a replacement connection", async () => {
	const opened = deferred(), wrongCalls = [];
	const env = setup({}, { rpc: (method) => method === "open" ? opened.promise : { ok: true, value: method === "models" ? { providers: [] } : {} } });
	await tick(); env.render(env.registrations.get("btw-temp"), {}).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "first" } });
	tree = env.render(overlay); const send = all(tree, (n) => n.props["aria-label"] === "发送")[0];
	send.props.onClick(); send.props.onClick();
	assert.equal(env.calls.filter((c) => c[1] === "open").length, 1, "a stale click cannot open another child");
	env.replaceConnection({ rpc: { call: (...args) => { wrongCalls.push(args); return Promise.resolve({ ok: true, value: {} }); } } });
	env.cleanup();
	opened.resolve({ ok: true, value: { sessionId: "late", cwd: null } }); await tick(); await tick();
	assert.deepEqual(env.calls.filter((c) => c[1] === "close").map((c) => c[2].sessionId), ["late"]);
	assert.equal(env.calls.some((c) => c[1] === "send"), false);
	assert.equal(wrongCalls.length, 0); assert.equal(env.render(overlay), null);
});

test("unload shares pending close, fences late send/poll and releases its polling timer", async () => {
	const timers = manualTimers(), sent = deferred(), polled = deferred(), closed = deferred();
	const env = setup({}, { ...timers, rpc: (method) => {
		if (method === "send") return sent.promise;
		if (method === "poll") return polled.promise;
		if (method === "close") return closed.promise;
		return { ok: true, value: method === "models" ? { providers: [] } : { sessionId: "temp", cwd: null } };
	} });
	await tick(); env.render(env.registrations.get("btw-temp"), {}).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "first" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick();
	timers.poll(); assert.equal(timers.size(), 1);
	tree = env.render(overlay); all(tree, (n) => n.children[0] === "结束对话")[0].props.onClick();
	env.cleanup(); assert.equal(timers.size(), 0);
	assert.equal(env.calls.filter((c) => c[1] === "close").length, 1);
	sent.resolve({ ok: true, value: { output: "late reply" } });
	polled.resolve({ ok: true, value: { text: "late delta", lastSeq: 1 } });
	closed.resolve({ ok: true, value: {} }); await tick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "poll").length, 1);
	assert.equal(env.render(overlay), null); assert.equal(timers.size(), 0);
});

test("active turns and failed-close unload retain the creating connection", async () => {
	let closes = 0; const wrongCalls = [];
	const env = setup({}, { rpc: (method) => {
		if (method === "close") return ++closes === 1 ? { ok: false, error: { message: "retry cleanup" } } : { ok: true, value: {} };
		return { ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "owned", cwd: null } : method === "send" ? { output: "answer" } : { text: "", lastSeq: 0 } };
	} });
	await tick(); env.render(env.registrations.get("btw-temp"), {}).props.onClick();
	const overlay = env.registrations.get("btw");
	const send = (text) => { let tree = env.render(overlay); all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: text } }); tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); };
	send("first"); await tick(); await tick();
	env.replaceConnection({ rpc: { call: (...args) => { wrongCalls.push(args); return Promise.resolve({ ok: true, value: {} }); } } });
	send("second"); await tick(); await tick();
	let tree = env.render(overlay); all(tree, (n) => n.children[0] === "结束对话")[0].props.onClick(); await tick();
	tree = env.render(overlay); assert.ok(all(tree, (n) => n.props.role === "status")[0].children[0].includes("retry cleanup"));
	env.cleanup(); await tick();
	assert.deepEqual(env.calls.filter((c) => c[1] === "close").map((c) => c[2].sessionId), ["owned", "owned"]);
	assert.equal(env.calls.filter((c) => c[1] === "send").length, 2); assert.equal(wrongCalls.length, 0);
});

test("global re-entry while old close is pending opens a fresh editable draft after cleanup", async () => {
	const disposed = deferred();
	const env = setup({}, { effects: true, layout: { selectPanel() {} }, rpc: (method) => method === "close" ? disposed.promise : { ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "global", cwd: null } : method === "send" ? { output: "answer" } : { text: "", lastSeq: 0 } } });
	await tick(); const panel = env.registrations.get("dsh-btw-global"); let body = env.render(panel); body = env.render(panel);
	let tree = env.render(body.type, body.props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "first" } });
	tree = env.render(body.type, body.props); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick(); await tick();
	env.unmount(panel); env.render(panel);
	disposed.resolve({ ok: true, value: {} }); await tick();
	body = env.render(panel); tree = env.render(body.type, body.props);
	const textarea = all(tree, (n) => n.type === "textarea")[0];
	assert.ok(textarea); assert.equal(textarea.props.disabled, false); assert.equal(textarea.props.value, ""); env.cleanup();
});

test("docked side question sends its earlier question and answer to the child exactly once", async () => {
	const timers = manualTimers(); let sends = 0;
	const env = setup({ askContextMode: "none" }, { ...timers, effects: true, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {} }, rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [] } : method === "ask" ? { jobId: "ask1" } : method === "askPoll" ? { text: "earlier answer", done: true } : method === "open" ? { sessionId: "child", cwd: null } : method === "send" ? { output: "continued " + ++sends } : { text: "", lastSeq: 0 } }) });
	await tick(); env.render(env.registrations.get("btw-trigger")).props.onClick(); const ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	let tree = env.render(ask, props); all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "earlier question" } });
	tree = env.render(ask, props); all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick(); await tick(); timers.poll(); await tick();
	tree = env.render(ask, props); all(tree, (n) => n.props["aria-label"] === "停靠侧边栏")[0].props.onClick();
	const body = env.render(env.registrations.get("dsh-btw/temp"), { btwSessionId: "origin" });
	const send = (text) => { let pane = env.render(body.type, body.props); all(pane, (n) => n.type === "textarea")[0].props.onChange({ target: { value: text } }); pane = env.render(body.type, body.props); all(pane, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); };
	send("followup"); await tick(); await tick();
	const first = env.calls.find((c) => c[1] === "send");
	assert.equal(first[2].sessionId, "child"); assert.ok(first[2].text.includes("earlier question")); assert.ok(first[2].text.includes("earlier answer")); assert.ok(first[2].text.endsWith("followup"));
	send("next"); await tick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "send").at(-1)[2].text, "next"); env.cleanup();
});

test("late ask poll success or failure cannot overwrite a new source session", async () => {
	for (const outcome of ["success", "failure"]) {
		const timers = manualTimers(), stale = deferred(); let jobs = 0;
		const env = setup({ askContextMode: "none" }, { ...timers, effects: true, rpc: (method, payload) => {
			if (method === "models") return { ok: true, value: { providers: [] } };
			if (method === "ask") return { ok: true, value: { jobId: "job" + ++jobs } };
			if (method === "askPoll") return payload.jobId === "job1" ? stale.promise : { ok: true, value: { text: "new source answer", done: true } };
			return { ok: true, value: {} };
		} });
		await tick(); const ask = env.registrations.get("btw-ask");
		const submit = (source) => {
			env.render(ask, chatProps(source)); env.render(env.registrations.get("btw-trigger")).props.onClick();
			let tree = env.render(ask, chatProps(source)); all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question for " + source } });
			tree = env.render(ask, chatProps(source)); all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
		};
		submit("old"); await tick(); timers.poll(); timers.poll();
		assert.equal(env.calls.filter((c) => c[1] === "askPoll").length, 1);
		submit("new"); await tick(); timers.poll(); await tick();
		if (outcome === "success") stale.resolve({ ok: true, value: { text: "stale answer", done: true } }); else stale.reject(new Error("stale failure"));
		await tick();
		const tree = env.render(ask, chatProps("new"));
		assert.equal(all(tree, (n) => n.props.className === "dsh-btw-answer")[0].children[0], "new source answer");
		assert.equal(all(tree, (n) => n.props.className === "dsh-btw-answer dsh-btw-err").length, 0); env.cleanup();
	}
});

test("temporary polls are serial, fence late deltas and keep a monotone cursor across turns", async () => {
	const timers = manualTimers(), firstSend = deferred(), stalePoll = deferred();
	let polls = 0, sends = 0;
	const env = setup({}, { ...timers, rpc: (method) => {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return { ok: true, value: { sessionId: "temp", cwd: null } };
		if (method === "send") return ++sends === 1 ? firstSend.promise : { ok: true, value: { output: "C" } };
		if (method === "poll") return ++polls === 1 ? stalePoll.promise : { ok: true, value: { text: polls === 2 ? "AB" : "C", lastSeq: polls } };
		return { ok: true, value: {} };
	} });
	await tick(); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw");
	const send = (text) => { let tree = env.render(overlay); all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: text } }); tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); };
	send("first"); await tick(); timers.poll(); timers.poll();
	assert.equal(polls, 1);
	firstSend.resolve({ ok: true, value: { output: "AB" } }); await tick();
	assert.equal(polls, 1, "final poll must wait for the old request");
	stalePoll.resolve({ ok: true, value: { text: "A", lastSeq: 1 } }); await tick(); await tick();
	let bubbles = all(env.render(overlay), (n) => n.props.className === "dsh-btw-bubble");
	assert.deepEqual(bubbles.map((n) => n.children[0]), ["first", "AB"]);
	send("second"); await tick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "poll").at(-1)[2].fromSeq, 2);
	bubbles = all(env.render(overlay), (n) => n.props.className === "dsh-btw-bubble");
	assert.deepEqual(bubbles.map((n) => n.children[0]), ["first", "AB", "second", "C"]); env.cleanup();
});

test("sidebar and popup share a live conversation; popup and header restoration collapse without closing tabs", async () => {
	const env = tempFixture(); const overlay = await startAndSelect(env);
	assert.equal(env.options.definition.kind, "btw-temp");
	assert.deepEqual(env.sidebarState(), { expanded: false, collapses: 1 });
	let tree = env.render(overlay);
	all(tree, (n) => n.type === "button" && n.props["aria-label"] === "停靠侧边栏")[0].props.onClick();
	assert.equal(env.sidebarState().expanded, true);
	assert.equal(env.render(overlay), null);
	const body = env.render(env.registrations.get("dsh-btw/temp"), { btwSessionId: "origin" });
	assert.equal(body.props.inline, true);
	const pane = env.render(body.type, body.props);
	assert.ok(all(pane, (n) => n.type === "input" && n.props.checked).length);
	all(pane, (n) => n.type === "button" && n.children[0] === "弹窗")[0].props.onClick();
	assert.deepEqual(env.sidebarState(), { expanded: false, collapses: 2 });
	tree = env.render(overlay);
	assert.deepEqual(all(tree, (n) => n.props.className === "dsh-btw-bubble").map((n) => n.children[0]), ["hello", "answer"]);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.checked).length, 1);
	all(tree, (n) => n.props["aria-label"] === "收起临时聊天")[0].props.onClick();
	assert.equal(env.calls.filter((c) => c[1] === "close").length, 0);
	env.options.sidebar.openTab("btw-temp");
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	assert.deepEqual(env.sidebarState(), { expanded: false, collapses: 3 });
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	assert.equal(env.sidebarState().collapses, 3, "already collapsed stays collapsed");
	tree = env.render(overlay);
	assert.deepEqual(all(tree, (n) => n.props.className === "dsh-btw-bubble").map((n) => n.children[0]), ["hello", "answer"]);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.checked).length, 1);
	assert.equal(env.calls.filter((c) => c[1] === "open").length, 1);
	all(tree, (n) => n.type === "button" && n.children[0] === "结束对话")[0].props.onClick();
	assert.equal(env.calls.filter((c) => c[1] === "close").length, 1);
	assert.equal(env.calls.find((c) => c[1] === "close")[2].sessionId, "temp");
	await tick(); env.cleanup();
});

test("message selection uses small named native checkboxes and draft success is neutral", async () => {
	const env = tempFixture(); const overlay = await startAndSelect(env);
	let tree = env.render(overlay);
	const boxes = all(tree, (n) => n.type === "input" && n.props.type === "checkbox");
	assert.deepEqual(boxes.map((n) => n.props["aria-label"]), ["选择消息 1", "选择消息 2"]);
	assert.ok(boxes.every((n) => n.props.className === "dsh-btw-pick" && !n.props.disabled && n.props.tabIndex !== -1));
	assert.equal(all(tree, (n) => n.children.includes("选择")).length, 0);
	boxes[0].props.onChange(); boxes[1].props.onChange();
	tree = env.render(overlay);
	assert.deepEqual(all(tree, (n) => n.type === "input").map((n) => n.props.checked), [false, true]);
	all(tree, (n) => n.type === "button" && typeof n.children[0] === "string" && n.children[0].startsWith("送回"))[0].props.onClick();
	tree = env.render(overlay);
	const status = all(tree, (n) => n.props.role === "status")[0];
	assert.equal(status.children[0], "已插入草稿，未发送");
	assert.equal(status.props.className, "dsh-btw-status");
	assert.ok(env.getDraft().includes("助手：answer"));
	assert.equal(env.calls.filter((c) => c[1] === "send").length, 1);
	all(tree, (n) => n.type === "input")[0].props.onChange();
	assert.equal(all(env.render(overlay), (n) => n.props.role === "status").length, 0);
	env.cleanup();
});

test("cross-session and stale-revision insertions are refused; success preserves draft", async () => {
	const env = tempFixture(); const overlay = await startAndSelect(env);
	const click = () => { const tree = env.render(overlay); all(tree, (n) => n.type === "button" && typeof n.children[0] === "string" && n.children[0].startsWith("送回"))[0].props.onClick(); };
	env.setMounted("other"); click();
	assert.equal(env.getInsertions(), 0); assert.equal(env.getDraft(), "original @reference");
	env.setMounted("origin"); env.setReject(true); click();
	assert.equal(env.getDraft(), "original @reference");
	const failure = all(env.render(overlay), (n) => n.props.role === "status")[0];
	assert.ok(failure.children[0].includes("草稿已更改"));
	assert.ok(failure.props.className.includes("dsh-btw-err"));
	env.setReject(false); click();
	assert.ok(env.getDraft().includes("original")); assert.ok(env.getDraft().includes("@reference")); assert.ok(env.getDraft().includes("用户：hello"));
	assert.equal(env.calls.filter((c) => c[1] === "send").length, 1);
});
