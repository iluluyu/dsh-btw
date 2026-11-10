import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clientLoader } from "./client-loader.js";

// Never inspect or burn the developer's real temporary-session marker.
const home = mkdtempSync(join(tmpdir(), "dsh-btw-test-"));
const childPackages = ["dsh-persona", "dsh-tool-bash", "dsh-tool-fs", "dsh-tool-fs-search", "dsh-skill-filesystem", "dsh-tool-skill"];
for (const name of [...childPackages, "dsh-session-persistence-jsonl", "dsh-agent-loop", "dsh-home-paths"]) {
	const dir = join(home, "node_modules", "@deepseek-ai", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version: "0.2.2-rc.1", type: "module", main: "index.js" }));
	writeFileSync(join(dir, "index.js"), name === "dsh-home-paths"
		? `import { join } from "node:path"; export const dshHomePath = (...s) => join(${JSON.stringify(home)}, ...s);`
		: `export default { name: ${JSON.stringify(name)}, apply() {} };`);
}
writeFileSync(join(home, "package.json"), JSON.stringify({ name: "mock-dsh", version: "0.2.2-rc.1" }));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const { apply, inject } = await import("../lib/index.js");
if (previousHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousHome;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

function host(t, overrides = {}) {
	let handler;
	let disposed = false;
	const cleanups = [];
	const services = {
		llm: { async *stream() { yield { type: "text-delta", text: "answer" }; yield { type: "finish", reason: { kind: "stop" } }; } },
		agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock" }) },
		agents: {},
		webServer: {},
		profileContext: { installAnchor: join(home, "package.json") },
		connection: {
			rpc: {
				intercept() { assert.fail("must not intercept the shared /api gateway"); },
				handle(channel, callback) {
					assert.equal(channel, "/btw");
					handler = callback;
					return () => { disposed = true; };
				},
			},
		},
		...overrides,
	};
	apply({
		...services,
		get: (name) => services[name],
		extend(properties) { return { ...this, ...properties }; },
		effect: (factory) => cleanups.push(factory()),
	});
	const dispose = () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
	t.after(dispose);
	return { call: (...args) => handler(...args), dispose, isDisposed: () => disposed };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function assertError(result, message) {
	assert.equal(result.ok, false);
	assert.deepEqual(result.error, { code: "internal", message, details: {} });
}

test("host owns only /btw, validates methods and disposes the channel", async (t) => {
	assert.ok(inject.includes("profileContext"), "bootstrap requires profileContext");
	const scopes = []; apply({ plugin() {}, inject(names) { scopes.push(names); } });
	assert.ok(scopes.some(names => names.includes("webServer") && names.includes("connection")), "RPC child scope requires webServer and connection");
	const fixture = host(t);
	assertError(await fixture.call("settings/describe", {}), "unknown method: settings/describe");
	assertError(await fixture.call("btw/ask", {}), "unknown method: btw/ask");
	assertError(await fixture.call("ask", { question: "  " }), "问题为空");
	assertError(await fixture.call("askPoll", { jobId: "missing" }), "侧问任务不存在或已过期");
	fixture.dispose();
	assert.equal(fixture.isDisposed(), true);
});

test("side questions stream through bare ask/askPoll methods without a real provider", async (t) => {
	let request;
	const fixture = host(t, {
		llm: { async *stream(options) {
			request = options;
			yield { type: "text-delta", text: "hello " };
			yield { type: "text-delta", text: "world" };
			yield { type: "finish", reason: { kind: "stop" } };
		} },
	});
	const started = await fixture.call("ask", { question: " question ", transcript: "x".repeat(49_000) });
	assert.equal(started.ok, true);
	await flush();
	assert.deepEqual(await fixture.call("askPoll", started.value), {
		ok: true, value: { text: "hello world", done: true, error: null },
	});
	assert.equal(request.provider, "mock");
	assert.equal(request.messages[0].content[0].text, `<conversation scope="recent snapshot, not complete history">\n${"x".repeat(48_000)}\n</conversation>\n\n<question>\nquestion\n</question>`);
});

test("side questions abort on cancellation and plugin unload", async (t) => {
	const signals = [];
	const fixture = host(t, {
		llm: { async *stream({ signal }) {
			signals.push(signal);
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			yield { type: "aborted" };
		} },
	});
	const first = await fixture.call("ask", { question: "cancel me" });
	assert.deepEqual(await fixture.call("askCancel", first.value), { ok: true, value: { cancelled: true } });
	assert.equal(signals[0].aborted, true);
	await flush();
	assert.equal((await fixture.call("askPoll", first.value)).value.done, true);
	await fixture.call("ask", { question: "unload me" });
	fixture.dispose();
	assert.equal(signals[1].aborted, true);
	await flush();
});

test("missing default model is rejected before a polling job or provider call", async (t) => {
	const fixture = host(t, {
		agentDefaultModel: { currentSelection: () => undefined },
		llm: { stream() { assert.fail("no provider call without a selection"); } },
	});
	const started = await fixture.call("ask", { question: "question" });
	assertError(started, "模型不可用或配置无效");
	assert.equal(started.value, undefined, "a rejected selection must not create a polling job");
	assert.deepEqual(await fixture.call("askCancel", { jobId: "missing" }), { ok: true, value: { cancelled: false } });
});

test("temporary chat routes open/send/poll/close and cleans up its child", async (t) => {
	// Keep timeout branches deterministic without waiting on real clocks.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let disposed = 0;
	let creation;
	let sent;
	let child;
	const policies = [];
	const listeners = new Map();
	const mounted = [];
	class JsonlSessionPersistence {
		identity = Symbol("mock-backend");
		name = "session-persistence-jsonl";
		root = join(home, "sessions");
		config = { root: this.root };
		items = new Map();
		async flush() {}
		async stat(id) { return this.items.get(id); }
	}
	const persistence = new JsonlSessionPersistence();
	const project = `--${home.replace(/^\/+/, "").replaceAll("/", "-")}--`;
	const sibling = join(persistence.root, project, "unrelated", "session.v4.jsonl");
	mkdirSync(join(persistence.root, project, "unrelated"), { recursive: true });
	writeFileSync(sibling, "unrelated session");
	const fixture = host(t, {
		sessionPersistence: persistence,
		agents: { async create(options) {
			creation = options;
			const record = join(home, ".btw-temp-records", `${options.sessionId}.json`);
			assert.equal(existsSync(record), true, "recovery record precedes child creation");
			const dir = join(persistence.root, project, options.sessionId);
			const reservation = JSON.parse(readFileSync(record, "utf8"));
			const info = lstatSync(dir, { bigint: true });
			assert.deepEqual({ dev: String(info.dev), ino: String(info.ino) }, reservation.dirIdentity);
			assert.equal(readdirSync(dir).length, 0, "host reserves an exclusive empty directory before creation");
			assert.equal(reservation.id, options.sessionId);
			assert.equal(reservation.cwd, home);
			assert.equal(reservation.root, persistence.root);
			const path = join(dir, "session.v4.jsonl.zstd");
			writeFileSync(path, "mock session");
			persistence.items.set(options.sessionId, { header: { id: options.sessionId, cwd: options.meta.cwd }, location: { kind: "jsonl", path } });
			child = {
				model: { select(selection) { assert.deepEqual(selection, { provider: "mock", model: "mock" }); } },
				followup(message) {
					sent = message;
					const stream = listeners.get("agent/assistant-stream");
					stream({ agent: {}, frame: { type: "chunk", chunk: { type: "text-delta", text: "unrelated" } } });
					for (const text of ["re", "ply"]) stream({ agent: child, frame: { type: "chunk", chunk: { type: "text-delta", text } } });
					listeners.get("session/event")(child.session, {
						type: "assistant/message", data: { message: { content: [{ type: "text", text: "reply" }] } },
					});
				},
				whenIdle: async () => {},
				session: { append: (...args) => policies.push(args) },
			};
			await options.setup({
				get agent() { assert.fail("setup must use its explicit child argument"); },
				on: (name, handler) => { listeners.set(name, handler); return () => {}; },
				plugin: (plugin) => mounted.push(plugin.name),
			}, child);
			return { dispose: async () => { disposed++; }, agent: child };
		} },
	});
	const opened = await fixture.call("open", { cwd: home });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal(creation.meta.cwd, home);
	assert.equal(creation.meta.origin, "subagent");
	const record = join(home, ".btw-temp-records", `${opened.value.sessionId}.json`);
	const sessionPath = persistence.items.get(opened.value.sessionId).location.path;
	assert.equal(existsSync(record), true);
	assert.equal(existsSync(sessionPath), true);
	assert.deepEqual(mounted, childPackages);
	assert.deepEqual(policies, [["approval/policy", { policy: "never", source: "delegation" }]]);
	const payload = { sessionId: opened.value.sessionId };
	assert.deepEqual(await fixture.call("send", { ...payload, text: "question" }), { ok: true, value: { output: "reply" } });
	assert.equal(sent.content[0].text, "question");
	assert.deepEqual(await fixture.call("poll", { ...payload, fromSeq: 0 }), { ok: true, value: { text: "reply", lastSeq: 2 } });
	assert.deepEqual(await fixture.call("poll", { ...payload, fromSeq: 1 }), { ok: true, value: { text: "ply", lastSeq: 2 } });
	assert.deepEqual(await fixture.call("close", payload), { ok: true, value: { burned: true } });
	assert.equal(disposed, 1);
	assert.deepEqual(await fixture.call("close", payload), { ok: true, value: { burned: false } });
	assertError(await fixture.call("send", { ...payload, text: "question" }), "临时聊天不存在或已焚毁");
	assert.equal(existsSync(record), false);
	assert.equal(existsSync(sessionPath), false);
	assert.equal(readFileSync(sibling, "utf8"), "unrelated session");
});

function client({ draft = "" } = {}) {
	let entry;
	const pending = new Map();
	const components = new Map();
	const registrations = new Map();
	const slotCleanups = new Map();
	const registered = new Set();
	const disposed = [];
	const cleanups = [];
	const calls = [];
	const modelCalls = [];
	const selectedPanels = [];
	const settingsListeners = new Set();
	let settingsValue = {};
	let unsubscribed = 0;
	const scope = {
		getSnapshot: () => ({ status: "ready", writable: true, value: settingsValue }),
		subscribe(callback) { settingsListeners.add(callback); return () => { settingsListeners.delete(callback); unsubscribed++; }; },
		async set(key, value) { settingsValue = { ...settingsValue, [key]: value }; for (const callback of settingsListeners) callback(); },
		async mutate(operations) { for (const operation of operations) await this.set(operation.path[0], operation.value); },
	};
	const styles = [];
	const intervals = new Map(), componentEffects = [];
	const React = {
		createElement: (type, props, ...children) => ["BtwTempView", "BtwDockView"].includes(type?.name) ? type(props) : ({ type, props, children }),
		useEffect(fn) { componentEffects.push(fn); },
		useLayoutEffect() {},
		useRef: (current) => ({ current }),
		useState: (value) => [value === "" ? draft : value, () => {}],
		useReducer: () => [0, () => {}],
	};
	const sandbox = {
		window: {},
		document: {
			querySelector: (selector) => styles.find(tag => selector.includes(JSON.stringify(tag.dataset.pluginCss))) ?? null,
			createElement: () => ({ dataset: {} }),
			head: { appendChild: (tag) => styles.push(tag) },
		},
		setTimeout, clearTimeout,
		setInterval: (callback) => { intervals.set(callback, callback); return callback; },
		clearInterval: (id) => intervals.delete(id),
	};
	const loader = clientLoader(sandbox, (id) => { if (id === "react") return React; throw new Error("optional module unavailable"); });
	entry = loader.entry;
	const ctx = {
		layout: { selectPanel: (key) => selectedPanels.push(key) },
		inject(names, callback) {
			const cleanup = names.every((name) => ["layout", "configForms"].includes(name) && this[name]) ? callback(this) : undefined;
			return { dispose() { if (typeof cleanup === "function") cleanup(); else cleanup?.dispose?.(); } };
		},
		configForms: { get(name) { assert.equal(name, "btw"); return scope; } },
		slots: {
			inject(name, callback) {
				pending.set(name, callback);
				return { dispose() {
					disposed.push(name);
					slotCleanups.get(name)?.();
					slotCleanups.delete(name);
					registered.delete(name);
				} };
			},
			register(options, component) {
				assert.equal(registered.has(options.name), true, "slot must be declared before registration");
				registrations.set(options.name, options);
				components.set(options.name, component);
				return () => { components.delete(options.name); registrations.delete(options.name); };
			},
		},
		get connection() { assert.fail("connection property access requires injection; use ctx.get"); },
		get(name) { return name === "connection" ? this._connection : undefined; },
		_connection: { rpc: { async call(channel, method, payload) {
			if (method === "models") {
				modelCalls.push({ channel, method, payload });
				return { ok: true, value: { providers: [] } };
			}
			calls.push({ channel, method, payload });
			assert.equal(channel, "/btw");
			const values = {
				ask: { jobId: "ask-job" }, askPoll: { text: "answer", done: true, error: null },
				open: { sessionId: "temp", cwd: home }, send: { output: "reply" },
				poll: { text: "reply", lastSeq: 1 }, close: { burned: true },
			};
			assert.ok(Object.hasOwn(values, method), `unexpected RPC method: ${method}`);
			return { ok: true, value: values[method] };
		} } },
		effect: (factory) => cleanups.push(factory()),
	};
	return {
		entry, ctx, pending, components, registrations, calls, modelCalls, selectedPanels, disposed, styles, intervals, scope, settingsListeners,
		get unsubscribed() { return unsubscribed; },
		commitEffects() { for (const fn of componentEffects.splice(0)) fn(); },
		async warm() { const gate = components.get("plugins.bundle.config")({}); gate.type(gate.props); await flush(); },
		mount() { for (const [name, callback] of pending) { registered.add(name); slotCleanups.set(name, callback()); } },
		dispose() { for (const cleanup of cleanups.splice(0)) cleanup(); },
	};
}

test("client defers required capabilities including overlay and global entry, and disposes every slot", async () => {
	const fixture = client();
	assert.deepEqual(Array.from(fixture.entry.inject), ["slots"], "settings must remain optional at activation");
	fixture.entry.apply(fixture.ctx);
	const names = [...fixture.pending.keys()];
	assert.equal(fixture.components.size, 0);
	for (const name of ["plugins.bundle.config", "plugins.row.config", "conversation.input.dock", "conversation.input.right", "shell.overlay"]) {
		assert.ok(fixture.pending.has(name), `missing required capability: ${name}`);
	}
	assert.equal(fixture.modelCalls.length, 0, "catalog is first-use work");
	assert.equal(fixture.settingsListeners.size, 1);
	fixture.mount(); await fixture.warm();
	assert.deepEqual([...fixture.components.keys()], names);
	assert.equal(fixture.components.get("shell.overlay")(), null);
	assert.equal(tempEntry(fixture)({}).props["aria-label"], "临时聊天");
	const globalPanel = fixture.registrations.get("main");
	assert.equal(globalPanel?.key, "dsh-btw-global");
	assert.equal(typeof fixture.components.get("main"), "function");
	const globalName = [...fixture.components].find(([, component]) => component.name === "BtwGlobalEntry")?.[0];
	assert.ok(globalName, "a global header entry must be available without a current session");
	const globalEntry = fixture.components.get(globalName);
	const globalButton = globalEntry({});
	assert.equal(globalButton.props["aria-label"], "开启全局临时聊天");
	globalButton.props.onClick();
	assert.deepEqual(fixture.selectedPanels, [], "missing public navigation never opens a fake page");
	assert.match(JSON.stringify(fixture.components.get("shell.overlay")()), /宿主缺少安全的临时会话导航能力/);
	assert.equal(fixture.calls.length, 0, "unavailable safety capability does not create a session");
	assert.equal(fixture.components.get("plugins.row.config")({ view: "summary" }), "侧问与临时聊天设置");
	await fixture.scope.set("showTempEntry", false);
	assert.equal(tempEntry(fixture)({}), null);
	assert.equal(globalEntry({}), null);
	assert.equal(fixture.styles.length, 2);
	fixture.dispose();
	assert.deepEqual(fixture.disposed, names);
	assert.equal(fixture.components.size, 0, "disposing seats unregisters their renderers");
	assert.equal(fixture.settingsListeners.size, 0);
	assert.equal(fixture.unsubscribed, 1);
});

function tempEntry(fixture) {
	const name = [...fixture.registrations].find(([, options]) => options.id === "btw-temp")?.[0];
	assert.ok(name, "session temporary-chat entry must be registered");
	return fixture.components.get(name);
}

function findElement(element, predicate) {
	if (Array.isArray(element)) return element.map((child) => findElement(child, predicate)).find(Boolean);
	if (!element || typeof element !== "object") return undefined;
	return predicate(element) ? element : findElement(element.children, predicate);
}

test("client temporary-chat first send opens /btw, streams and closes on unload", async () => {
	const fixture = client();
	fixture.entry.apply(fixture.ctx);
	fixture.mount(); await fixture.warm();
	const component = tempEntry(fixture);
	const button = component({
		sessionId: "main",
		useSessions: (select) => select({ byId: { main: { cwd: home } } }),
	});
	button.props.onClick();
	await flush();
	assert.equal(fixture.calls.length, 0, "click configures locally without creating a child");
	const overlay = fixture.components.get("shell.overlay");
	const panel = overlay();
	assert.ok(panel, "click must show the configuration overlay");
	const textarea = findElement(panel, (el) => el.type === "textarea");
	assert.ok(textarea);
	textarea.props.onChange({ target: { value: "temporary question" } });
	const send = findElement(overlay(), (el) => el.props?.["aria-label"] === "发送");
	assert.equal(send.props.disabled, false);
	send.props.onClick();
	await flush();
	assert.equal(fixture.calls[0].channel, "/btw");
	assert.equal(fixture.calls[0].method, "open");
	assert.equal(fixture.calls[0].payload.cwd, home);
	assert.equal(fixture.calls[0].payload.parentSessionId, "main");
	assert.equal(fixture.calls[0].payload.modelMode, "current", "default follows the source model without changing it");
	assert.equal(fixture.calls[1].method, "send");
	assert.equal(fixture.calls[1].payload.sessionId, "temp");
	assert.equal(fixture.calls[1].payload.text, "temporary question");
	assert.equal(fixture.calls[2].method, "poll");
	assert.equal(fixture.calls[2].payload.sessionId, "temp");
	assert.ok(findElement(overlay(), (el) => el.children?.includes("reply")), "final response is rendered");
	assert.equal(fixture.intervals.size, 0, "send completion clears polling");
	fixture.dispose();
	assert.equal(fixture.calls[3].channel, "/btw");
	assert.equal(fixture.calls[3].method, "close");
	assert.equal(fixture.calls[3].payload.sessionId, "temp");
	assert.equal(overlay(), null);
});

test("fixed client submission uses the same native child transport with context and closes it on unload", async () => {
	const fixture = client();
	fixture.entry.apply(fixture.ctx); fixture.mount(); await fixture.warm();
	fixture.components.get("conversation.input.right")().props.onClick();
	const dock = fixture.components.get("conversation.input.dock"), props = { sessionId: "main",
		useSession: select => select({ sessionId: "main", removed: false }),
		useChat: select => select({ legacy: { nodes: [{ kind: "user", content: [{ type: "text", text: "context" }] }] } }),
	};
	dock(props); fixture.commitEffects();
	let panel = dock(props);
	findElement(panel, el => el.type === "textarea").props.onChange({ target: { value: "side question" } });
	panel = dock(props); findElement(panel, el => el.props?.["aria-label"] === "提问").props.onClick();
	await flush(); await flush();
	assert.deepEqual(fixture.calls.map(call => call.method), ["open", "send", "poll"]);
	assert.equal(fixture.calls[0].channel, "/btw"); assert.equal(fixture.calls[0].payload.transcript, "User: context");
	assert.equal(fixture.calls[1].payload.sessionId, "temp"); assert.equal(fixture.calls[1].payload.text, "side question");
	assert.equal(fixture.intervals.size, 0);
	assert.ok(findElement(dock(props), el => el.children?.includes("reply")));
	fixture.dispose(); assert.equal(fixture.calls.at(-1).method, "close"); assert.equal(fixture.calls.at(-1).payload.sessionId, "temp");
});

test("client can activate before connection is available", async () => {
	const fixture = client();
	delete fixture.ctx._connection;
	delete fixture.ctx.configForms;
	fixture.entry.apply(fixture.ctx);
	fixture.mount(); await fixture.warm();
	tempEntry(fixture)({}).props.onClick();
	await flush();
	assert.equal(fixture.calls.length, 0);
	fixture.dispose();
});
