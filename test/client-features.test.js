import test from "node:test";
import assert from "node:assert/strict";
import { clientLoader } from "./client-loader.js";

async function setup(config = {}, options = {}) {
	const registrations = new Map(), calls = [], writes = [], required = [], styles = [], events = new Map();
	const hooks = new Map(), childInstances = new Map(), viewControllers = new Map();
	let plugin, active, index = 0, listener, cleanup, pendingEffects = [], revision = 0;
	const snapshot = { status: "ready", writable: true, value: config };
	const scope = {
		getSnapshot: () => snapshot,
		subscribe: (fn) => { listener = fn; return () => {}; },
		set: (key, value) => { writes.push([key, value]); if (options.settingResult === false) return Promise.resolve(false); snapshot.value[key] = value; listener(); return Promise.resolve(true); },
		mutate: (ops) => { writes.push(ops); if (options.settingResult === false) return Promise.resolve(false); for (const op of ops) snapshot.value[op.path[0]] = op.value; listener(); return Promise.resolve(true); },
	};
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
		useState: (initial) => { const i = index++; const state = hooks.get(active); if (!(i in state)) state[i] = initial; return [state[i], (value) => { state[i] = typeof value === "function" ? value(state[i]) : value; revision++; }]; },
		useReducer: () => { index++; return [0, () => { revision++; }]; },
		useEffect: (fn, deps) => { if (options.effects === false) return; const state = hooks.get(active), i = index++, old = state[i]; if (!old || !deps || deps.some((v, n) => v !== old.deps[n])) pendingEffects.push(() => { old?.cleanup?.(); state[i] = { deps, cleanup: fn() }; }); },
		useLayoutEffect: () => {}, useRef: (value) => { const state = hooks.get(active), i = index++; if (!(i in state)) state[i] = { current: value }; return state[i]; },
	};
	const render = (component, props = {}, instance = component, depth = 0) => { assert.ok(depth < 10, "effects settle"); const before = revision; active = instance; index = 0; pendingEffects = []; if (!hooks.has(instance)) hooks.set(instance, []); const result = component(props);
		const commit = node => { if (Array.isArray(node)) return node.forEach(commit); if (!node || typeof node !== "object") return; if (node.props?.ref && !node.props.ref.current && options.commitRef) node.props.ref.current = options.commitRef(node); node.children?.forEach(commit); }; commit(result);
		for (const effect of pendingEffects) effect(); if (revision !== before) return render(component, props, instance, depth + 1);
		const oldChildren = childInstances.get(instance) || new Set(); childInstances.set(instance, new Set());
		const expand = (node) => {
			if (Array.isArray(node)) return node.map(expand);
			if (!node || typeof node !== "object") return node;
			if (["BtwTempView", "BtwDockView", "BtwSettings"].includes(node.type?.name)) {
				if (node.props.controller) viewControllers.set(node.props.controller.id, node.props.controller);
				const child = node.type.name === "BtwTempView" ? "view:" + (node.props.dock ? "dock:" : node.props.inline ? "sidebar:" : node.props.standalone ? "global:" : "overlay:") + node.props.controller.id : node.type.name === "BtwDockView" ? "dock:" + node.props.controller.id : node.type;
				if (!childInstances.has(instance)) childInstances.set(instance, new Set());
				childInstances.get(instance).add(child);
				return render(node.type, node.props, child);
			}
			return { ...node, children: node.children?.map(expand) };
		};
		const tree = expand(result); for (const child of oldChildren) if (!childInstances.get(instance).has(child)) unmount(child); return tree; };
	const sandbox = {
		window: { innerWidth: options.width || 1440, innerHeight: options.height || 900, localStorage: options.storage, addEventListener: (type, fn) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); }, removeEventListener: (type, fn) => events.get(type)?.delete(fn) },
		document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild: (tag) => styles.push(tag.textContent) },
			addEventListener: (type, fn) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
			removeEventListener: (type, fn) => events.get(type)?.delete(fn) },
		setInterval: options.setInterval || setInterval, clearInterval: options.clearInterval || clearInterval, setTimeout, clearTimeout, AbortController, TextEncoder, ResizeObserver: options.ResizeObserver, Date: options.Date || Date, requestAnimationFrame() {},
	};
	const loader = clientLoader(sandbox, (id) => {
		required.push(id);
		if (id === "react") return React;
		if (id === "@deepseek-ai/dsh-client-ui-primitives" && options.primitives) return options.primitives;
		throw new Error("shared module unavailable: " + id);
	}, { beforeChunk: options.beforeChunk });
	plugin = loader.entry;
	const connection = { rpc: { call: (...args) => { calls.push(args); return Promise.resolve(options.rpc ? options.rpc(args[1], args[2]) : args[1] === "models" ? { ok: true, value: { providers: [{ id: "p", models: [{ id: "m", name: "Model" }] }] } } : { ok: true, value: args[1] === "open" ? { sessionId: "fixture-child", cwd: null } : args[1] === "send" ? { output: "answer" } : args[1] === "poll" ? { text: "", lastSeq: 0 } : {} }); } }, ...options.connection };
	let currentConnection = connection;
	const ctx = {
		configForms: { get: (key) => { assert.equal(key, "btw"); return scope; } },
		slots: { inject: (_name, fn) => fn(), register: (meta, component) => { registrations.set(meta.id || meta.key || meta.name, component); return () => {}; } },
		get: (key) => key === "connection" ? currentConnection : undefined,
		effect: (fn) => { cleanup = fn(); },
	};
	if (options.noSettings) delete ctx.configForms;
	if (options.badSidebar) ctx.inject = () => { throw new Error("unavailable"); };
	if (options.sidebar || options.layout || options.remote || options.workspace) ctx.inject = (deps, fn) => {
		if (deps[0] === "uiWorkspace") return options.workspace ? fn(options.workspace) : () => {};
		if (deps[0] === "workspaces") {
			const service = Object.hasOwn(options, "workspaces") ? options.workspaces : options.workspace?.workspaces;
			return service ? fn({ workspaces: service }) : () => {};
		}
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
	const unmount = (component) => { for (const child of childInstances.get(component) || []) unmount(child); childInstances.delete(component); for (const hook of hooks.get(component) || []) hook?.cleanup?.(); hooks.delete(component); };
	const env = { registrations, calls, writes, required, styles, viewControllers, requests: loader.requests, setActiveElement: element => { sandbox.document.activeElement = element; }, setViewport: (width, height) => { sandbox.window.innerWidth = width; sandbox.window.innerHeight = height; for (const fn of events.get("resize") || []) fn(); }, dispatch: (type, event) => { for (const fn of events.get(type) || []) fn(event); }, render, connection, replaceConnection: (next = { ...connection }) => { currentConnection = next; }, unmount, cleanup: () => cleanup?.() };
	// Feature/geometry tests explicitly visit settings first. Lazy tests opt out.
	if (!options.lazy) { const settings = registrations.get("dsh-btw#btw")({}); render(settings.type, settings.props); await tick(); render(settings.type, settings.props); await tick(); }
	return env;
}
test("source-free entry uses native RPC and closes only its owned session", async () => {
	const listeners = new Set(), byId = {}, calls = [];
	const notify = () => { for (const fn of listeners) fn(); };
	const sessions = { list: { getSnapshot: () => ({ byId }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } }, retainInfo: id => ({ getSnapshot: () => byId[id] || { retainedBy: {} }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } }) };
	const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} }, beginNavigation: () => new AbortController().signal, selectPanel() {} };
	const uiWorkspace = { openSession(id) { byId[id] = { retainedBy: { mainView: 1 } }; notify(); }, async archiveSession(id) { calls.push(id); delete byId[id]; notify(); } };
	const env = await setup({}, { lazy: true, layout, workspace: { uiWorkspace, sessions, layout }, workspaces: defaultWorkspace(byId), rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : method === "nativeClose" ? { burned: true } : { providers: [] } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen"]);
	assert.ok(env.styles.some(css => css.includes('[data-conversation-session="owned"] [data-composer-card]') && css.includes('[data-conversation-session="owned"] [data-message-bubble]') && css.includes('dashed')));
	assert.equal(env.render(env.registrations.get("btw")), null, "native session has no fake composer or controls");
	const button = env.render(env.registrations.get("btw-temp"), { sessionId: "owned" });
	assert.equal(button.props["aria-label"], "结束临时聊天");
	const heroClose = env.render(env.registrations.get("conversation.header.leading"));
	assert.equal(heroClose.props["aria-label"], "结束临时聊天", "blank native page must remain closable");
	assert.equal(heroClose.props["aria-pressed"], true, "native page exposes its active temporary-chat state");
	assert.ok(heroClose.children.includes("临时聊天"));
	assert.equal(heroClose.children[0].props.active, true, "active badge shows a check mark");
	heroClose.props.onClick(); await tick();
	assert.deepEqual(calls, ["owned"], "only the owned native view is archived; no previous window is touched");
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]);
	env.cleanup();
});

function defaultWorkspace(byId) {
	return { list: { getSnapshot: () => ({ phase: "ready", items: [{ workspaceId: "workspace-one", path: "/native/project", createdAt: "2026-01-01T00:00:00Z", sessionIds: Object.keys(byId) }] }) } };
}

function nativeFixture() {
	const listeners = new Set(), byId = {}, navigation = [], panelListeners = new Set();
	let panel = null;
	const notify = () => { for (const fn of [...listeners]) fn(); };
	const select = id => { for (const row of Object.values(byId)) row.retainedBy.mainView = 0; if (id) (byId[id] ||= { retainedBy: {} }).retainedBy.mainView = 1; notify(); };
	const sessions = { list: { getSnapshot: () => ({ byId }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } }, retainInfo: id => ({ getSnapshot: () => byId[id] || { retainedBy: {} }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } }), retain: () => ({ release() {} }) };
	const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: panel }), subscribe: fn => { panelListeners.add(fn); return () => panelListeners.delete(fn); } }, beginNavigation: () => new AbortController().signal, selectPanel(id) { panel = id; for (const fn of [...panelListeners]) fn(); } };
	const uiWorkspace = { openSession(id) { navigation.push(["open", id]); select(id); }, async archiveSession(id) { navigation.push(["archive", id]); if (byId[id]?.retainedBy.mainView) select(null); } };
	return { sessions, layout, uiWorkspace, byId, select, navigation, workspaces: defaultWorkspace(byId) };
}

test("native opening on a desktop blank view inherits its existing default workspace without creating one", async () => {
	const f = nativeFixture(); let creates = 0;
	f.workspaces.create = () => { creates++; throw Error("must not create/adopt a workspace"); };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned", workspaceId: "workspace-one", cwd: "/native/project" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick(); await tick();
	assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0]?.[2])), { workspaceId: "workspace-one" });
	assert.equal(creates, 0); assert.deepEqual(f.navigation, [["open", "owned"]]); env.cleanup();
});

test("web without a selected or default workspace does not create a btw workspace or Session", async () => {
	const f = nativeFixture();
	const workspaces = { list: { getSnapshot: () => ({ phase: "ready", items: [] }) }, create() { assert.fail("do not create a fallback workspace"); } };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, workspaces });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.equal(env.calls.length, 0); assert.deepEqual(f.navigation, []);
	assert.match(JSON.stringify(env.render(env.registrations.get("btw"))), /选择工作区/); env.cleanup();
});

test("desktop blank workspace selection follows the native recent-workspace rule and stable ties", async () => {
	const f = nativeFixture();
	f.byId.older = { updatedAt: 100, retainedBy: {} }; f.byId.recent = { updatedAt: 500, retainedBy: {} };
	const workspaces = { list: { getSnapshot: () => ({ phase: "ready", items: [
		{ workspaceId: "old", sessionIds: ["older"], createdAt: "2026-01-01T00:00:00Z" },
		{ workspaceId: "recent", sessionIds: ["recent"], createdAt: "2026-01-01T00:00:00Z" },
		{ workspaceId: "tie", sessionIds: ["recent"], createdAt: "2026-01-01T00:00:00Z" },
	] }) } };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, workspaces, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0]?.[2])), { workspaceId: "recent" }); env.cleanup();
});

test("native open inherits the selected Session's workspace without sending its history", async () => {
	const f = nativeFixture(); f.select("source");
	const workspaces = { list: { getSnapshot: () => ({ phase: "ready", items: [{ workspaceId: "workspace-one", sessionIds: ["source"] }] }) } };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, workspaces, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0][2])), { workspaceId: "workspace-one" });
	assert.deepEqual(f.navigation, [["open", "owned"]]);
	env.render(env.registrations.get("btw-temp"), { sessionId: "owned" }).props.onClick(); await tick();
	assert.deepEqual(f.navigation, [["open", "owned"], ["archive", "owned"]], "ending clears only the owned native view without restoring the source"); env.cleanup();
});

test("native open is single-flight and a late result cannot override user navigation", async () => {
	const f = nativeFixture(), pending = deferred();
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? pending.promise : { ok: true, value: { burned: true } } });
	const entry = env.registrations.get("conversation.header.leading");
	env.render(entry).props.onClick(); env.render(entry).props.onClick();
	f.select("other"); pending.resolve({ ok: true, value: { sessionId: "owned" } }); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]);
	assert.deepEqual(f.navigation, []); assert.equal(f.byId.other.retainedBy.mainView, 1); env.cleanup();
});

test("a second click while opening cancels and the late id burns exactly once", async () => {
	const f = nativeFixture(), pending = deferred();
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? pending.promise : { ok: true, value: { burned: true } } });
	const entry = env.registrations.get("conversation.header.leading");
	env.render(entry).props.onClick(); await tick();
	const opening = env.render(entry);
	assert.ok(opening.children.includes("开启中…"), "opening gives immediate feedback");
	assert.equal(opening.props.disabled, undefined, "the entry stays clickable to cancel");
	opening.props.onClick(); await tick();
	assert.match(env.render(entry).props.title, /已请求取消/);
	pending.resolve({ ok: true, value: { sessionId: "owned" } }); await tick(); await tick(); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"], "the cancelled late id is burned exactly once");
	assert.deepEqual(f.navigation, []);
	assert.equal(env.render(env.registrations.get("btw")), null, "a cancelled open leaves no error surface");
	env.render(entry).props.onClick(); await tick(); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose", "nativeOpen"], "opening works again after a cancelled open");
	assert.equal(env.render(entry).props["aria-label"], "结束临时聊天");
	env.cleanup();
});

test("closing shows feedback immediately and overlapping close signals burn once", async () => {
	const f = nativeFixture(), burn = deferred(); let closes = 0;
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? { ok: true, value: { sessionId: "owned" } } : (++closes, burn.promise) });
	const entry = env.registrations.get("conversation.header.leading");
	env.render(entry).props.onClick(); await tick(); await tick();
	env.render(entry).props.onClick(); await tick();
	const closing = env.render(entry);
	assert.equal(closing.props["aria-label"], "清理后开启临时聊天");
	assert.equal(closing.props.disabled, undefined, "a new opening intent remains actionable while cleanup is pending");
	assert.match(closing.props.title, /正在结束/);
	f.select("other"); await tick();
	env.cleanup();
	burn.resolve({ ok: true, value: { burned: true } }); await tick(); await tick();
	assert.equal(closes, 1, "navigation, retry and unload closes dedupe to one burn");
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]);
	assert.equal(f.byId.other.retainedBy.mainView, 1);
});

test("an opening requested during close runs once after confirmed cleanup and preserves native workspace selection", async () => {
	const f = nativeFixture(), burn = deferred(); let opens = 0, closes = 0;
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? { ok: true, value: { sessionId: "owned-" + ++opens } } : (++closes, burn.promise) });
	const entry = env.registrations.get("conversation.header.leading");
	env.render(entry).props.onClick(); await tick(); await tick();
	env.render(entry).props.onClick(); await tick();
	assert.deepEqual(f.navigation, [["open", "owned-1"], ["archive", "owned-1"]], "the public host UI closes only the owned native view before disk cleanup completes");
	env.render(entry).props.onClick(); await tick();
	assert.match(env.render(entry).props.title, /清理完成后将开启/);
	assert.equal(opens, 1, "do not overlap native sessions while the old burn is pending");
	burn.resolve({ ok: true, value: { burned: true } }); await tick(); await tick(); await tick();
	assert.equal(opens, 2); assert.equal(closes, 1);
	assert.deepEqual(f.navigation, [["open", "owned-1"], ["archive", "owned-1"], ["open", "owned-2"]]);
	assert.equal(env.render(entry).props["aria-label"], "结束临时聊天"); env.cleanup();
});

test("a queued reopening can be canceled and never overrides newer native navigation", async () => {
	for (const next of ["cancel", "session", "panel"]) {
		const f = nativeFixture(), burn = deferred(); let opens = 0;
		const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? (++opens, { ok: true, value: { sessionId: "owned" } }) : burn.promise });
		const entry = env.registrations.get("conversation.header.leading");
		env.render(entry).props.onClick(); await tick();
		env.render(entry).props.onClick(); await tick();
		env.render(entry).props.onClick();
		if (next === "cancel") env.render(entry).props.onClick();
		else if (next === "session") f.select("other");
		else f.layout.selectPanel("settings");
		burn.resolve({ ok: true, value: { burned: true } }); await tick(); await tick();
		assert.equal(opens, 1, next + " supersedes the queued opening");
		if (next === "session") assert.equal(f.byId.other.retainedBy.mainView, 1);
		if (next === "panel") assert.equal(f.layout.panelInfo.getSnapshot().activePanelId, "settings");
		env.cleanup();
	}
});

test("failure to dismiss a native view does not skip the owned burn or falsely claim UI success", async () => {
	const f = nativeFixture();
	f.uiWorkspace.archiveSession = () => Promise.reject(new Error("native navigation failed"));
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	const entry = env.registrations.get("conversation.header.leading");
	env.render(entry).props.onClick(); await tick();
	env.render(entry).props.onClick(); await tick(); await tick();
	assert.deepEqual(env.calls.map(call => call[1]), ["nativeOpen", "nativeClose"]);
	assert.match(JSON.stringify(env.render(env.registrations.get("btw"))), /临时记录已清理.*退出失败/);
	assert.equal(env.render(entry).props["aria-label"], "开启全局临时聊天"); env.cleanup();
});

test("a third click during opening restores the latest intent without another host creation", async () => {
	const f = nativeFixture(), pending = deferred();
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? pending.promise : { ok: true, value: { burned: true } } });
	const entry = env.registrations.get("conversation.header.leading");
	env.render(entry).props.onClick(); env.render(entry).props.onClick(); env.render(entry).props.onClick();
	pending.resolve({ ok: true, value: { sessionId: "owned" } }); await tick(); await tick();
	assert.deepEqual(env.calls.map(call => call[1]), ["nativeOpen"]);
	assert.deepEqual(f.navigation, [["open", "owned"]]); env.cleanup();
});

test("a rejected burn keeps the session endable and retryable from the entry", async () => {
	const f = nativeFixture(); let burns = 0;
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? { ok: true, value: { sessionId: "owned" } } : ++burns === 1 ? { ok: true, value: {} } : { ok: true, value: { burned: true } } });
	const entry = env.registrations.get("conversation.header.leading");
	env.render(entry).props.onClick(); await tick(); await tick();
	env.render(entry).props.onClick(); await tick(); await tick();
	const endable = env.render(entry);
	assert.equal(endable.props["aria-label"], "结束临时聊天", "the still-alive session stays endable");
	assert.match(JSON.stringify(env.render(env.registrations.get("btw"))), /未确认安全清理/, "the failure stays visible");
	endable.props.onClick(); await tick(); await tick();
	assert.equal(burns, 2);
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose", "nativeClose"]);
	assert.equal(env.render(entry).props["aria-label"], "开启全局临时聊天", "idle again only after burned:true");
	env.cleanup();
});

test("native navigation away closes without restoring and failed close can retry", async () => {
	const f = nativeFixture(); let attempts = 0;
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? { ok: true, value: { sessionId: "owned" } } : (++attempts === 1 ? { ok: false, error: { message: "burn failed" } } : { ok: true, value: { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	f.select("other"); await tick();
	let status = env.render(env.registrations.get("btw")); assert.match(JSON.stringify(status), /burn failed/);
	all(status, n => n.type === "button")[0].props.onClick(); await tick();
	assert.deepEqual(f.navigation, [["open", "owned"]]); assert.equal(f.byId.other.retainedBy.mainView, 1); assert.equal(attempts, 2); env.cleanup();
});

test("native unsupported backend reports error instead of presenting a fake conversation", async () => {
	const f = nativeFixture();
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: () => ({ ok: false, error: { message: "unknown method: nativeOpen" } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.match(JSON.stringify(env.render(env.registrations.get("btw"))), /unknown method: nativeOpen/);
	assert.deepEqual(f.navigation, []); env.cleanup();
});

test("native selection survives catalog lag and remains usable until explicit close", async () => {
	const f = nativeFixture(), snapshot = f.sessions.list.getSnapshot;
	f.sessions.list.getSnapshot = () => { const { byId } = snapshot(); const visible = { ...byId }; delete visible.owned; return { byId: visible }; };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen"]);
	const button = env.render(env.registrations.get("btw-temp"), { sessionId: "owned" });
	assert.equal(button.props["aria-label"], "结束临时聊天");
	button.props.onClick(); await tick();
	assert.deepEqual(f.navigation, [["open", "owned"], ["archive", "owned"]], "the native view exits even while the catalog lags; the source is not restored");
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]); env.cleanup();
});

test("native catalog refresh cannot open after user navigates or unloads", async () => {
	for (const unload of [false, true]) {
		const f = nativeFixture(), refresh = deferred(); f.sessions.refresh = () => refresh.promise;
		const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
		env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
		if (unload) env.cleanup(); else f.select("other");
		refresh.resolve(); await tick(); await tick();
		assert.deepEqual(f.navigation, []); assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]);
		if (!unload) { assert.equal(f.byId.other.retainedBy.mainView, 1); env.cleanup(); }
	}
});

test("ending the native chat releases the prior reference without navigating back", async () => {
	const f = nativeFixture(); f.select("old"); let released = 0;
	f.sessions.retain = (id, options) => { assert.equal(id, "old"); assert.equal(options.source, "controllerOperation"); return { release: () => released++ }; };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	const button = env.render(env.registrations.get("btw-temp"), { sessionId: "owned" }); button.props.onClick(); button.props.onClick(); await tick();
	assert.deepEqual(f.navigation, [["open", "owned"], ["archive", "owned"]], "the previous window is not reopened or archived");
	assert.equal(released, 1);
	const rpc = env.calls.map(([channel, method, payload]) => [channel, method, JSON.stringify(payload)]);
	assert.deepEqual(rpc, [["/btw", "nativeOpen", '{"workspaceId":"workspace-one"}'], ["/btw", "nativeClose", '{"sessionId":"owned"}']]); env.cleanup();
});

test("native pending open after unload closes on its pinned connection without navigation", async () => {
	const f = nativeFixture(), pending = deferred(), wrong = [];
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => method === "nativeOpen" ? pending.promise : { ok: true, value: { burned: true } } });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick();
	env.replaceConnection({ rpc: { call: (...args) => { wrong.push(args); return Promise.resolve({ ok: true, value: { burned: true } }); } } });
	env.cleanup(); pending.resolve({ ok: true, value: { sessionId: "owned" } }); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]); assert.deepEqual(wrong, []); assert.deepEqual(f.navigation, []);
});

test("native panel navigation burns without restoring a session", async () => {
	const f = nativeFixture(), env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	f.layout.selectPanel("other-panel"); await tick();
	assert.deepEqual(f.navigation, [["open", "owned"]]); assert.equal(f.layout.panelInfo.getSnapshot().activePanelId, "other-panel");
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]); env.cleanup();
});

test("native close rejects missing burn confirmation and retries without affecting another session", async () => {
	const f = nativeFixture(); let close = 0;
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : ++close === 1 ? {} : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	env.render(env.registrations.get("btw-temp"), { sessionId: "owned" }).props.onClick(); await tick();
	f.select("other"); const status = env.render(env.registrations.get("btw")); assert.match(JSON.stringify(status), /未确认安全清理/);
	all(status, n => n.type === "button")[0].props.onClick(); await tick();
	assert.equal(close, 2); assert.equal(f.byId.other.retainedBy.mainView, 1); env.cleanup();
});

function adoptFixture() {
	const f = nativeFixture(); f.select("source");
	return { f, workspaces: create => ({ ...f.workspaces, create }) };
}

test("active desktop workspace wins over a more recently updated unrelated project", async () => {
	const f = nativeFixture(); f.select("source");
	f.byId.source.updatedAt = 100; f.byId.recent = { updatedAt: 1000, retainedBy: {} };
	const workspaces = { list: { getSnapshot: () => ({ phase: "ready", items: [
		{ workspaceId: "recent", sessionIds: ["recent"], createdAt: "2026-01-01T00:00:00Z" },
		{ workspaceId: "current", sessionIds: ["source"], createdAt: "2026-01-01T00:00:00Z" },
	] }) }, create() { assert.fail("existing workspace needs no create"); } };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, workspaces, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0][2])), { workspaceId: "current" }); env.cleanup();
});

test("pending workspace discovery never opens a temporary Session against stale cached choices", async () => {
	const f = nativeFixture(), snapshot = { ...f.workspaces.list.getSnapshot(), phase: "pending" };
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, workspaces: { list: { getSnapshot: () => snapshot } } });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	assert.deepEqual(env.calls, []); assert.match(JSON.stringify(env.render(env.registrations.get("btw"))), /工作区尚未就绪/); env.cleanup();
});

test("catalog refresh failure keeps ownership and a burned-confirmed retry instead of swallowing cleanup", async () => {
	const f = nativeFixture(); let burns = 0;
	f.sessions.refresh = () => Promise.reject(new Error("目录刷新失败"));
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : ++burns === 1 ? {} : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick(); await tick();
	const status = env.render(env.registrations.get("btw"));
	assert.equal(burns, 1); assert.match(JSON.stringify(status), /目录刷新失败/);
	assert.match(JSON.stringify(status), /重试结束/);
	all(status, n => n.type === "button")[0].props.onClick(); await tick(); await tick();
	assert.equal(burns, 2); assert.deepEqual(f.navigation, []);
	assert.equal(env.render(env.registrations.get("btw")), null); env.cleanup();
});

test("unload during catalog refresh closes the live Session immediately and fences its late result", async () => {
	const f = nativeFixture(), refresh = deferred(); let released = 0;
	f.select("source");
	f.sessions.refresh = () => refresh.promise;
	f.sessions.retain = () => ({ release: () => released++ });
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, rpc: method => ({ ok: true, value: method === "nativeOpen" ? { sessionId: "owned" } : { burned: true } }) });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick(); await tick();
	env.cleanup(); await tick(); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]); assert.equal(released, 1);
	refresh.resolve(); await tick(); await tick();
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]); assert.deepEqual(f.navigation, []);
});

test("late native open skips workspace adoption after the user switches sessions", async () => {
	const { f, workspaces } = adoptFixture(), pending = deferred(); let adoptions = 0;
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, workspaces: workspaces(() => { adoptions++; }), rpc: method => method === "nativeOpen" ? pending.promise : { ok: true, value: { burned: true } } });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick();
	f.select("other"); pending.resolve({ ok: true, value: { sessionId: "owned", cwd: "/w/owned" } }); await tick(); await tick();
	assert.equal(adoptions, 0, "cancelled navigation must not wait on or mutate workspace discovery");
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]);
	assert.deepEqual(f.navigation, []); assert.equal(f.byId.other.retainedBy.mainView, 1); env.cleanup();
});

test("late native open cannot adopt or navigate through a replacement connection", async () => {
	const { f, workspaces } = adoptFixture(), pending = deferred(); let adoptions = 0;
	const env = await setup({}, { lazy: true, layout: f.layout, workspace: f, workspaces: workspaces(() => { adoptions++; }), rpc: method => method === "nativeOpen" ? pending.promise : { ok: true, value: { burned: true } } });
	env.render(env.registrations.get("conversation.header.leading")).props.onClick();
	env.replaceConnection({ rpc: { call() { assert.fail("cleanup must use the creating connection"); } } });
	pending.resolve({ ok: true, value: { sessionId: "owned", cwd: "/w/owned" } }); await tick(); await tick();
	assert.equal(adoptions, 0);
	assert.deepEqual(f.navigation, []); assert.equal(f.byId.source.retainedBy.mainView, 1);
	assert.deepEqual(env.calls.map(c => c[1]), ["nativeOpen", "nativeClose"]); env.cleanup();
});

function all(node, predicate, out = []) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) { for (const item of node) all(item, predicate, out); return out; }
	if (predicate(node)) out.push(node);
	for (const child of node.children || []) all(child, predicate, out);
	return out;
}
const isMessageContent = (node) => node.props.className === "dsh-btw-bubble" || node.props.className?.split(" ").includes("dsh-btw-prose");
function escapeTarget(tree, id) {
	const scope = id ? all(tree, n => n.props["data-chat-id"] === id)[0] : tree;
	const node = all(scope, n => n.props.className === "dsh-btw-modal")[0];
	const target = { closest: () => null };
	node.props.ref.current = { ...node.props.ref.current, contains: candidate => candidate === target };
	return target;
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

// Adapter tests stop at the native Menu boundary: keyboard traversal, IME guards,
// outside dismissal and focus return belong to dsh's Menu, not a plugin clone.
function NativeMenu() { throw new Error("Menu is rendered by the host"); }
const sharedPrimitives = { Menu: NativeMenu };
function modelTree(env, tree, instance = "model") {
	const node = all(tree, (n) => n.type?.name === "ModelSelect")[0];
	return env.render(node.type, node.props, instance);
}
function nativeMenu(env, tree, label, instance = label) {
	const node = all(tree, (n) => n.type?.name === "ChoiceMenu" && n.props.label === label)[0];
	assert.ok(node, "shared picker for " + label);
	const menu = env.render(node.type, node.props, instance);
	assert.equal(menu.type, NativeMenu);
	return menu;
}

test("missing or incomplete shared modules preserve editable native model and context selects", async () => {
	for (const primitives of [undefined, {}, { MenuSurface() {}, MenuItemButton() {} }, { Menu: {} }]) {
		const env = await setup({}, { primitives }); await tick();
		const component = env.registrations.get("dsh-btw#btw")({}).type;
		env.render(component); await tick(); // First settings visit lazy-loads the settings sibling chunk.
		const tree = env.render(component);
		const context = all(tree, (n) => n.type === "select" && n.props["aria-label"] === "侧问默认上下文")[0];
		context.props.onChange({ target: { value: "all" } }); await tick();
		assert.deepEqual(env.writes[0], ["askContextMode", "all"]);
		const model = modelTree(env, tree);
		const select = all(model, (n) => n.type === "select")[0];
		select.props.onChange({ target: { value: '["p","m"]' } }); await tick();
		assert.equal(env.writes[1].at(-1).value, "custom");
		assert.ok(env.required.includes("@deepseek-ai/dsh-client-ui-primitives"));
		assert.equal(env.calls.some((c) => /selectModel/.test(c[1])), false);
		env.cleanup();
	}
});

test("shared Menu uses native portal, focus and navigation contract; settings save through form scope", async () => {
	const env = await setup({}, { primitives: sharedPrimitives, effects: true }); await tick();
	const settings = env.registrations.get("dsh-btw#btw")({}).type;
	env.render(settings); await tick();
	let tree = env.render(settings), model = modelTree(env, tree);
	let menu = nativeMenu(env, model, "模型");
	assert.equal(all(model, (n) => n.type === "select").length, 0);
	assert.equal(menu.props.open, false);
	assert.equal(menu.props.portal, true); assert.equal(menu.props.autoFocus, true);
	assert.equal(menu.props.side, "top"); assert.equal(menu.props.align, "end");
	assert.equal(menu.props.selectedId, "default");
	assert.deepEqual(Array.from(menu.props.items, (item) => item.id), ["default", '["p","m"]']);
	assert.match(JSON.stringify(menu.props.items[0].label), /已选择/);
	assert.equal(menu.props.anchor.props.type, "button");
	assert.equal(menu.props.anchor.props["aria-haspopup"], "menu");
	assert.match(menu.props.anchor.props["aria-label"], /模型：默认/);
	let prevented = 0, stopped = 0;
	for (const guard of [{ isComposing: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }, { ctrlKey: true }]) {
		menu.props.anchor.props.onKeyDown({ key: "ArrowDown", ...guard });
		assert.equal(nativeMenu(env, model, "模型").props.open, false);
	}
	menu.props.anchor.props.onKeyDown({ key: "ArrowDown", preventDefault: () => prevented++, stopPropagation: () => stopped++ });
	menu = nativeMenu(env, model, "模型");
	assert.equal(menu.props.open, true); assert.equal(prevented, 1); assert.equal(stopped, 1);
	assert.equal(menu.props.anchor.props["aria-expanded"], true);
	menu.props.onClose(); // Native Escape / outside-pointer dismissal.
	assert.equal(nativeMenu(env, model, "模型").props.open, false);
	menu.props.anchor.props.onClick();
	menu = nativeMenu(env, model, "模型");
	menu.props.onSelect('["p","m"]'); await tick();
	assert.equal(nativeMenu(env, model, "模型").props.open, false, "selection explicitly closes native Menu");
	assert.deepEqual(JSON.parse(JSON.stringify(env.writes[0])), [
		{ op: "set", path: ["askProvider"], value: "p" }, { op: "set", path: ["askModel"], value: "m" }, { op: "set", path: ["askModelMode"], value: "custom" },
	]);
	tree = env.render(settings); model = modelTree(env, tree);
	assert.match(nativeMenu(env, model, "模型").props.anchor.props["aria-label"], /p \/ Model/);
	menu = nativeMenu(env, tree, "侧问默认上下文");
	menu.props.onSelect("on-demand"); await tick();
	assert.deepEqual(env.writes.at(-1), ["askContextMode", "on-demand"]);
	const css = env.styles.join("");
	assert.match(css, /dsh-btw-picker-menu\[data-menu-material\]\{z-index:9010;max-width:min\(360px,calc\(100vw - 24px\)/);
	assert.match(css, /var\(--dsw-alias-label-secondary/); // Theme tokens, not a light-only popup.
	assert.match(css, /picker-trigger:focus-visible/);
	assert.deepEqual(env.required, ["react", "@deepseek-ai/dsh-client-ui-primitives"]);
	assert.deepEqual(env.calls.map((c) => c[1]), ["models"]); env.cleanup();
});

test("shared model picker retains catalog error/retry and unavailable saved model", async () => {
	let failed = true;
	const env = await setup({ askModelMode: "custom", askProvider: "p", askModel: "gone" }, { primitives: sharedPrimitives, rpc: () => failed
		? { ok: false, error: { message: "unknown method: models" } }
		: { ok: true, value: { providers: [{ id: "p", models: [{ id: "m", name: "Model" }] }] } } });
	await tick(); const settings = env.registrations.get("dsh-btw#btw")({}).type;
	env.render(settings); await tick();
	let model = modelTree(env, env.render(settings));
	let menu = nativeMenu(env, model, "模型");
	assert.match(menu.props.anchor.props["aria-label"], /已保存模型不可用/);
	assert.ok(menu.props.items.some((item) => item.id === '["p","gone"]'));
	assert.match(JSON.stringify(model), /宿主仍运行旧版 btw/);
	assert.ok(all(model, (n) => n.props.role === "status").length);
	failed = false; all(model, (n) => n.type === "button" && n.children.includes("重试"))[0].props.onClick();
	await tick(); model = modelTree(env, env.render(settings)); menu = nativeMenu(env, model, "模型");
	assert.ok(menu.props.items.some((item) => item.id === '["p","m"]'));
	assert.equal(all(model, (n) => n.props.className === "dsh-btw-err").length, 0); env.cleanup();
});

test("shared temporary selectors send only btw choices, lock on first send, and respect consumed Escape", async () => {
	const opened = deferred();
	const env = await setup({}, { primitives: sharedPrimitives, effects: true, rpc: (method) => method === "open" ? opened.promise : ({ ok: true, value: method === "models" ? { providers: [{ id: "p", models: [{ id: "m" }] }] } : {} }) });
	await tick(); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	let model = modelTree(env, tree), menu = nativeMenu(env, model, "模型");
	assert.equal(menu.props.portal, true, "native menu must escape the clipped modal");
	assert.equal(menu.props.listClassName, "dsh-btw-picker-menu");
	const css = env.styles.join("");
	const menuLayer = Number(css.match(/\.dsh-btw-picker-menu\[data-menu-material\]\{z-index:(\d+)/)[1]);
	const modalLayer = Number(css.match(/\.dsh-btw-desktop\{[^}]*z-index:(\d+)/)[1]);
	assert.ok(menuLayer > modalLayer, "the portaled menu layer must sit above the modal veil");
	menu.props.anchor.props.onClick(); menu = nativeMenu(env, model, "模型");
	assert.equal(menu.props.open, true);
	menu.props.onSelect('["p","m"]'); // Native portaled row click forwards to this callback.
	assert.equal(nativeMenu(env, model, "模型").props.open, false);
	let context = nativeMenu(env, tree, "临时聊天上下文"); context.props.onSelect("recent");
	tree = env.render(overlay);
	context = nativeMenu(env, tree, "临时聊天上下文");
	context.props.anchor.props.onClick(); context = nativeMenu(env, tree, "临时聊天上下文");
	assert.equal(context.props.open, true);
	context.props.onClose(); // dsh Menu consumes Escape in document's capture phase.
	env.dispatch("keydown", { key: "Escape", defaultPrevented: true });
	assert.equal(nativeMenu(env, tree, "临时聊天上下文").props.open, false);
	assert.ok(env.render(overlay), "first Escape closes only the menu, keeping the chat visible");
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hello" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick();
	assert.equal(env.calls.find((c) => c[1] === "open")[2].contextMode, "recent");
	assert.deepEqual(JSON.parse(JSON.stringify(env.calls.find((c) => c[1] === "open")[2].model)), { provider: "p", model: "m" });
	// Callbacks retained from the unlocked render must not change a pending child.
	menu.props.onSelect("host"); context.props.onSelect("all");
	tree = env.render(overlay); model = modelTree(env, tree);
	menu = nativeMenu(env, model, "模型"); context = nativeMenu(env, tree, "临时聊天上下文");
	for (const picker of [menu, context]) {
		assert.equal(picker.props.anchor.props.disabled, true); assert.equal(picker.props.open, false);
		picker.props.anchor.props.onClick(); picker.props.onSelect("host");
	}
	assert.equal(menu.props.selectedId, '["p","m"]'); assert.equal(context.props.selectedId, "recent");
	assert.equal(env.writes.length, 0);
	assert.ok(env.calls.every((c) => c[0] === "/btw" && ["models", "open"].includes(c[1])));
	opened.resolve({ ok: true, value: { sessionId: "tmp", cwd: null } }); await tick(); await tick();
	tree = env.render(overlay);
	assert.equal(nativeMenu(env, modelTree(env, tree), "模型").props.anchor.props.disabled, true);
	env.dispatch("keydown", { key: "Escape", defaultPrevented: false, target: escapeTarget(env.render(overlay)) }); await tick(); assert.equal(env.render(overlay), null);
	env.cleanup();
});

test("shared ask menus preserve local model/context choices and disable while asking", async () => {
	const response = deferred();
	const env = await setup({}, { primitives: sharedPrimitives, effects: true, rpc: (method) => method === "open" ? response.promise : ({ ok: true, value: { providers: [{ id: "p", models: [{ id: "m" }] }] } }) });
	await tick(); env.render(env.registrations.get("btw-trigger")).props.onClick();
	const ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	let tree = env.render(ask, props);
	nativeMenu(env, modelTree(env, tree), "模型").props.onSelect('["p","m"]');
	nativeMenu(env, tree, "侧问上下文").props.onSelect("none");
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
	tree = env.render(ask, props); all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
	const payload = env.calls.find((c) => c[1] === "open")[2];
	assert.equal(payload.contextMode, "none"); assert.equal(payload.transcript, "");
	assert.equal(payload.parentSessionId, "origin"); assert.equal(payload.modelMode, "custom");
	assert.deepEqual(JSON.parse(JSON.stringify(payload.model)), { provider: "p", model: "m" });
	tree = env.render(ask, props);
	for (const menu of [nativeMenu(env, modelTree(env, tree), "模型"), nativeMenu(env, tree, "侧问上下文")]) {
		assert.equal(menu.props.anchor.props.disabled, true);
		assert.equal(menu.props.open, false);
	}
	assert.equal(env.writes.length, 0); env.cleanup(); response.resolve({ ok: true, value: { sessionId: "stale" } }); await tick();
});

test("shared settings selectors stay disabled when the form service is missing", async () => {
	const env = await setup({}, { primitives: sharedPrimitives, effects: true, noSettings: true }); await tick();
	const tree = env.render(env.registrations.get("dsh-btw#btw")({}).type);
	for (const menu of [nativeMenu(env, modelTree(env, tree), "模型"), nativeMenu(env, tree, "侧问默认上下文")]) {
		assert.equal(menu.props.anchor.props.disabled, true);
		menu.props.anchor.props.onClick(); menu.props.onSelect("current");
	}
	assert.equal(env.writes.length, 0); env.cleanup();
});

test("shared project temporary model menu never offers current-session resolution", async () => {
	const env = await setup({ tempModelMode: "current", tempContextMode: "all" }, { primitives: sharedPrimitives }); await tick();
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const tree = env.render(env.registrations.get("btw"));
	const menu = nativeMenu(env, modelTree(env, tree), "模型");
	assert.equal(menu.props.selectedId, "default");
	assert.equal(menu.props.items.some((item) => item.id === "current"), false);
	assert.ok(all(tree, (n) => n.props.label === "临时聊天上下文").length); env.cleanup();
});

test("settings writes toggle and selected model through form scope", async () => {
	const env = await setup(); await tick();
	const wrapper = env.registrations.get("dsh-btw#btw")({});
	const tree = env.render(wrapper.type);
	const checkbox = all(tree, (n) => n.type === "input" && n.props["aria-label"] === "显示侧问按钮")[0];
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
	const env = await setup({}, { rpc: () => outdated
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
		const env = await setup({}, { rpc: () => ({ ok: false, error: { message } }) }); await tick();
		const component = env.registrations.get("dsh-btw#btw")({}).type;
		env.render(component); await tick();
		const settings = env.render(component);
		const model = all(settings, (n) => typeof n.type === "function")[0];
		const tree = JSON.stringify(env.render(model.type, model.props));
		assert.ok(tree.includes(message)); assert.doesNotMatch(tree, /宿主仍运行旧版/);
		env.cleanup();
	}
});

test("settings reports false set/mutate receipts and clears the error after a real save", async () => {
	const options = { settingResult: false }, env = await setup({}, options); await tick();
	const component = env.registrations.get("dsh-btw#btw")({}).type;
	env.render(component); await tick();
	let tree = env.render(component);
	all(tree, (n) => n.type === "input")[0].props.onChange({ target: { checked: false } }); await tick();
	assert.ok(all(env.render(component), (n) => typeof n.props.className === "string" && n.props.className.includes("dsh-btw-set-error")).some((n) => n.children[0].includes("设置未保存")));
	const model = all(tree, (n) => typeof n.type === "function")[0]; model.props.onChange('["p","m"]'); await tick();
	assert.ok(all(env.render(component), (n) => typeof n.props.className === "string" && n.props.className.includes("dsh-btw-set-error")).some((n) => n.children[0].includes("设置未保存")));
	options.settingResult = true; tree = env.render(component);
	all(tree, (n) => n.type === "input")[0].props.onChange({ target: { checked: false } }); await tick();
	assert.equal(all(env.render(component), (n) => typeof n.props.className === "string" && n.props.className.includes("dsh-btw-set-error")).length, 0); env.cleanup();
});

test("settings sibling chunk loads only on a settings visit, dedupes, and never rides along with chat first-use", async () => {
	const env = await setup({}, { lazy: true }); await tick();
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	await tick(); await tick();
	assert.equal(env.requests.includes("client.settings.js"), false, "chat first-use never fetches the settings chunk");
	const settings = env.registrations.get("dsh-btw#btw")({}).type;
	let tree = env.render(settings);
	assert.ok(all(tree, (n) => n.props.role === "status" && n.children[0] === "正在加载 btw 设置…")[0], "first visit shows the settings loader");
	await tick();
	assert.equal(env.requests.filter((file) => file === "client.settings.js").length, 1, "one lazy request");
	tree = env.render(settings);
	assert.equal(tree.props.className, "dsh-btw-settings");
	assert.equal(all(tree, (n) => n.props["aria-label"] === "侧问默认上下文").length, 1);
	assert.ok(env.styles.some((css) => css.includes("dsh-btw-settings")), "settings CSS injected under its own id");
	env.render(settings); await tick();
	assert.equal(env.requests.filter((file) => file === "client.settings.js").length, 1, "repeated visits dedupe the load");
	env.cleanup();
});

test("failed settings chunk fetch stays retryable without touching chat state", async () => {
	let fail = true;
	const env = await setup({}, { beforeChunk: (file) => { if (file === "client.settings.js" && fail) throw new Error("chunk offline"); } });
	await tick();
	const settings = env.registrations.get("dsh-btw#btw")({}).type;
	env.render(settings); await tick(); await tick();
	let tree = env.render(settings);
	assert.ok(all(tree, (n) => n.props.role === "status" && String(n.children[0]).includes("btw 设置加载失败"))[0]);
	const retry = all(tree, (n) => n.type === "button" && n.children.includes("重试"))[0];
	assert.ok(retry, "settings load failure is retryable");
	fail = false;
	retry.props.onClick(); await tick(); await tick();
	tree = env.render(settings);
	assert.equal(tree.props.className, "dsh-btw-settings");
	env.cleanup();
});

test("unload fences a late settings sibling without CSS, RPC or UI resurrection", async () => {
	const response = deferred();
	const env = await setup({}, { lazy: true, beforeChunk: file => file === "client.settings.js" ? response.promise : undefined });
	const settings = env.registrations.get("dsh-btw#btw")({}).type;
	env.render(settings); await tick();
	env.render(settings); env.render(settings); await tick();
	assert.equal(env.requests.filter(file => file === "client.settings.js").length, 1);
	env.cleanup(); response.resolve(); await tick();
	assert.equal(env.render(settings), null);
	assert.equal(env.styles.some(css => css.includes("dsh-btw-settings")), false);
	assert.equal(env.calls.some(call => ["open", "send"].includes(call[1])), false);
});

test("recent reads the native Conversation legacy slice, never lifecycle or partial text", async () => {
	for (const hook of ["useChat", "useConversation"]) {
		const env = await setup({ askContextMode: "recent" }); await tick(); env.render(env.registrations.get("btw-trigger")).props.onClick();
		const nodes = [{ kind: "user", content: [{ type: "text", text: "recorded question" }] }, { kind: "assistant", blocks: [{ kind: "text", text: "recorded answer" }] }];
		const props = chatProps("origin", nodes);
		if (hook === "useConversation") { delete props.useChat; props.useConversation = (select) => select({ views: { get: (target) => { assert.equal(target, "chat"); return { legacy: { nodes, partial: { text: "uncommitted" } } }; } }, activeTargets: new Set(["chat"]) }); }
		const ask = env.registrations.get("btw-ask"); let tree = env.render(ask, props);
		all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "followup" } });
		tree = env.render(ask, props); all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
		assert.equal(env.calls.find((c) => c[1] === "open")[2].transcript, "User: recorded question\n\nAssistant: recorded answer"); env.cleanup();
	}
});

test("ask transmits selected model and configured context without snapshot", async () => {
	const env = await setup({ askContextMode: "none", askModelMode: "custom", askProvider: "p", askModel: "m" }); await tick();
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	const component = env.registrations.get("btw-ask");
	const props = chatProps("s1", [{ kind: "user", content: [{ type: "text", text: "secret" }] }]);
	let tree = env.render(component, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
	tree = env.render(component, props);
	all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
	const call = env.calls.find((entry) => entry[1] === "open");
	assert.deepEqual(JSON.parse(JSON.stringify(call[2])), { cwd: null, transcript: "", contextMode: "none", modelMode: "custom", model: { provider: "p", model: "m" }, parentSessionId: "s1" });
});

test("on-demand sends only the authorized recent snapshot", async () => {
	const env = await setup({ askContextMode: "on-demand" }); await tick();
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	const component = env.registrations.get("btw-ask");
	const props = chatProps("origin", Array.from({ length: 20 }, (_, i) => ({ kind: "user", content: [{ type: "text", text: `line ${i}` }] })));
	let tree = env.render(component, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
	tree = env.render(component, props);
	all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
	const payload = env.calls.find((entry) => entry[1] === "open")[2];
	assert.equal(payload.contextMode, "on-demand");
	assert.ok(payload.transcript.includes("line 19"));
	assert.ok(payload.transcript.includes("line 0"), "short loaded evidence remains authorized within the 48k budget, even beyond 14 messages");
});

test("current ask selection delegates resolution with parent session", async () => {
	const env = await setup({ askModelMode: "current" }); await tick();
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	const component = env.registrations.get("btw-ask"), props = { sessionId: "origin" };
	let tree = env.render(component, props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hello" } });
	tree = env.render(component, props);
	all(tree, (n) => n.props["aria-label"] === "提问")[0].props.onClick();
	const payload = env.calls.find((c) => c[1] === "open")[2];
	assert.equal(payload.parentSessionId, "origin");
	assert.equal(payload.model, undefined);
});

test("optional services do not prevent activation", async () => {
	const env = await setup({}, { noSettings: true, badSidebar: true });
	assert.ok(env.registrations.has("btw-ask"));
	assert.ok(env.registrations.has("btw"));
});

test("visibility switches hide both global and session entries", async () => {
	const env = await setup({ showAskChip: false, showTempEntry: false });
	assert.equal(env.render(env.registrations.get("btw-trigger")), null);
	assert.equal(env.render(env.registrations.get("conversation.header.leading")), null);
	assert.equal(env.render(env.registrations.get("btw-temp")), null);
});

test("first send opens with chosen context and model, then locks controls", async () => {
	const env = await setup({}, { rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [{ id: "p", models: [{ id: "m" }] }] } : method === "open" ? { sessionId: "tmp", cwd: "/project" } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
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


	const env = await setup({}, { rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "temp", cwd: null } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
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
	assert.equal(payload.modelMode, "current");
});

test("standalone legacy view retains shared child transport and waits for close", async () => {
	let resolveClose; const selected = [];
	const layout = { selectPanel: (id) => selected.push(id) };
	const env = await setup({ tempModelMode: "current", tempContextMode: "all", tempPresentation: "overlay" }, { effects: true, layout, rpc: (method) => method === "close" ? new Promise((resolve) => { resolveClose = resolve; }) : ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "global", cwd: null } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
	await tick();
	assert.ok(!env.registrations.has("btw-temp-global"));
	assert.ok(env.registrations.has("conversation.header.leading"));
	// Exercise the existing standalone view directly; the new header entry is native.
	assert.match(env.styles.join(""), /\.dsh-btw-standalone \[data-global=true\] \.dsh-btw-mcard\{border-style:dashed/);
	assert.match(env.styles.join(""), /\.dsh-btw-standalone \[data-global=true\] \.dsh-btw-msg\.user \.dsh-btw-bubble\{border:1px dashed/);
	const panel = env.registrations.get("dsh-btw-global");
	let view = env.render(panel); view = env.render(panel);
	const overlay = view.type, props = view.props;
	let tree = env.render(overlay, props);
	assert.ok(all(tree, (n) => n.props["data-global"] === true).length);
	assert.equal(all(tree, n => n.props["data-btw-mode"]).length, 0, "source-free page does not offer floating modes");
	assert.equal(all(tree, n => n.props["aria-label"] === "最小化 btw").length, 0);
	assert.equal(all(tree, (n) => n.props.className === "dsh-btw-msub")[0].children[0], "");
	assert.equal(all(tree, (n) => n.props.className === "dsh-btw-mtitle" && n.children.includes("btw")).length, 1, "one shared btw title");
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
	assert.deepEqual(all(tree, isMessageContent).map((n) => n.children[0]), ["hi", "ok", "second turn", "ok"]);
	assert.equal(all(tree, (n) => n.type === "button" && n.children.includes("选择消息")).length, 0);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.type === "checkbox").length, 0);
	assert.equal(all(tree, (n) => n.props.className === "dsh-btw-msub")[0].children[0], "", "settled headers do not repeat lifecycle instructions");
	all(tree, (n) => n.type === "button" && n.props["aria-label"] === "结束临时聊天")[0].props.onClick();
	// Ending leaves the panel in the same tick; the host cleanup finishes later.
	assert.deepEqual(selected, ["dsh-btw-global", null]);
	resolveClose({ ok: true, value: {} }); await tick();
	assert.deepEqual(selected, ["dsh-btw-global", null]);
	env.cleanup();
});

async function historyFixture(records, extra = {}) {
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
	const env = await setup({ askContextMode: "all", tempContextMode: "all" }, { remote, effects: true, connection: { state }, Date: class extends Date { static now() { return now; } }, ...extra });
	const component = env.registrations.get("btw-ask"), props = chatProps("origin", [{ kind: "user", content: [{ type: "text", text: "projection must not be sent" }] }]);
	const submit = () => {
		const existing = env.render(component, props);
		if (existing && all(existing, isMessageContent).length) modeControl(existing, "overlay").props.onClick();
		if (!env.render(component, props)) env.render(env.registrations.get("btw-trigger")).props.onClick();
		let tree = env.render(component, props);
		all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "question" } });
		tree = env.render(component, props); all(tree, (n) => n.props["aria-label"] === "提问")[0]?.props.onClick();
	};
	return { ...env, pages, component, props, submit, error: () => all(env.render(component, props), (n) => n.props.role === "status" && n.props.className?.includes("dsh-btw-err"))[0]?.children[0], advance: (ms) => { now += ms; }, disconnect: () => { connected = "disconnected"; for (const fn of listeners) fn(); }, reconnect: () => { connected = "connected"; for (const fn of listeners) fn(); } };
}
const record = (seq, type = "user/message", text = "text " + seq) => ({ type: "event", event: { seq, type, data: type === "user/message" ? { content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } } } });

test("all binds the guarded remote.session namespace and degrades safely when unavailable", async () => {
	for (const available of ["present", "missing-root", "missing-session"]) {
		const extra = available === "present" ? {} : { remote: available === "missing-root" ? undefined : {} };
		const env = await historyFixture([record(0, "user/message", "recorded marker")], extra);
		await tick(); env.render(env.registrations.get("btw-trigger")).props.onClick();
		const tree = env.render(env.component, env.props);
		all(tree, (n) => typeof n.type === "function")[0].props.onChange("current");
		env.submit(); await tick(); await tick();
		const payload = env.calls.find((c) => c[1] === "open")?.[2];
		if (available === "present") {
			assert.ok(payload, env.error());
			assert.ok(payload.transcript.includes("recorded marker"));
			assert.equal(payload.modelMode, "current"); assert.equal(payload.parentSessionId, "origin");
			assert.equal(env.pages.length, 1);
			env.submit(); await tick();
			assert.equal(env.calls.filter((c) => c[1] === "open").at(-1)[2].transcript, payload.transcript);
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
	const env = await historyFixture(records); await tick(); env.submit(); await tick(); await tick();
	const payload = env.calls.find((c) => c[1] === "open")[2];
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
	const env = await historyFixture(records); await tick(); env.submit(); await tick(); await tick();
	assert.equal(env.pages.length, 3);
	env.submit(); await tick(); assert.equal(env.pages.length, 4);
	records.push(record(12)); env.submit(); await tick(); assert.equal(env.pages.length, 5);
	assert.ok(env.calls.filter((c) => c[1] === "open").at(-1)[2].transcript.includes("text 12"));
	env.advance(60_001); env.submit(); await tick(); assert.equal(env.pages.length, 9);
	env.disconnect(); env.reconnect(); env.submit(); await tick(); assert.equal(env.pages.length, 13);
	env.unmount(env.component); env.submit(); await tick(); assert.equal(env.pages.length, 17);
	env.cleanup();
});

test("all shares concurrent fixed/float child reads without mutating the main session", async () => {
	const records = Array.from({ length: 12 }, (_, i) => record(i));
	const env = await historyFixture(records); await tick(); env.submit();
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw");
	button(env.render(overlay), "新建临时聊天").props.onClick();
	button(typeTemp(env, overlay, "temp"), "发送").props.onClick();
	await tick(); await tick(); assert.equal(env.pages.length, 3);
	const [fixedPayload, floatPayload] = env.calls.filter(c => c[1] === "open").map(c => c[2]);
	assert.ok(floatPayload, "two independent controllers share the authorized read, not one visual owner");
	assert.equal(fixedPayload.transcript, floatPayload.transcript); assert.equal(floatPayload.contextSnapshot.throughSeq, 11);
	assert.equal(env.writes.length, 0); env.cleanup();
});

test("all refuses oversized, empty or discontinuous pages, never truncates or falls back", async () => {
	for (const [records, error] of [
		[[record(0, "user/message", "x".repeat(1024 * 1024))], /超过/],
		[[record(0), record(3)], /不连续/],
	]) {
		const env = await historyFixture(records); await tick(); env.submit(); await tick(); await tick();
		assert.equal(env.calls.some((c) => c[1] === "open"), false); assert.match(env.error(), error); env.cleanup();
	}
	const env = await historyFixture([], { events: () => ({ ok: true, value: { cursor: 9, records: [], hasMore: true } }) });
	await tick(); env.submit(); await tick(); assert.match(env.error(), /空页|缺页/); assert.equal(env.calls.some((c) => c[1] === "open"), false); env.cleanup();
});

test("all rejects missing early pages, changed cursors, and empty source", async () => {
	for (const value of [
		{ cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i + 4)), hasMore: false },
		{ cursor: -1, records: [], hasMore: false },
	]) {
		const env = await historyFixture([], { events: () => ({ ok: true, value }) });
		await tick(); env.submit(); await tick(); assert.match(env.error(), /缺少|没有已记录/);
		assert.equal(env.calls.some((c) => c[1] === "open"), false); env.cleanup();
	}
	const env = await historyFixture([], { events: (_request, _signal, n) => ({ ok: true, value: n === 1 ? { cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i + 4)), hasMore: true } : { cursor: 8, records: Array.from({ length: 4 }, (_, i) => record(i)), hasMore: false } }) });
	await tick(); env.submit(); await tick(); assert.match(env.error(), /切点改变/); env.cleanup();
});

test("all cancels one merged consumer without cancelling the other", async () => {
	let release;
	const env = await historyFixture([], { events: () => new Promise(resolve => { release = resolve; }) });
	await tick(); env.submit();
	const closeFixed = button(env.render(env.component, env.props), "关闭侧问面板");
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw");
	button(env.render(overlay), "新建临时聊天").props.onClick();
	button(typeTemp(env, overlay, "temp"), "发送").props.onClick();
	closeFixed.props.onClick();
	release({ ok: true, value: { cursor: 0, records: [record(0)], hasMore: false } }); await tick(); await tick();
	assert.equal(env.pages.length, 1);
	assert.equal(env.calls.filter(c => c[1] === "open").length, 1, "only the remaining consumer opens a child");
	env.cleanup();
});

test("all aborts in-flight pages on source close and unload", async () => {
	for (const close of ["source", "plugin"]) {
		let release, readSignal;
		const env = await historyFixture([], { events: (_request, signal, n) => n === 1 ? { ok: true, value: { cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i + 4)), hasMore: true } } : new Promise((resolve) => { release = resolve; readSignal = signal; }) });
		await tick(); env.submit(); await tick();
		if (close === "source") env.unmount(env.component); else env.cleanup();
		assert.equal(readSignal.aborted, true);
		release({ ok: true, value: { cursor: 7, records: Array.from({ length: 4 }, (_, i) => record(i)), hasMore: false } }); await tick(); await tick();
		assert.equal(env.calls.some((c) => c[1] === "open"), false); env.cleanup();
	}
});

test("all cancels on connection replacement, disconnect and explicit close", async () => {
	for (const action of ["replaceConnection", "disconnect", "cancel"]) {
		let resolve;
		const env = await historyFixture([], { events: () => new Promise((fn) => { resolve = fn; }) });
		await tick(); env.submit();
		if (action === "cancel") all(env.render(env.component, env.props), (n) => n.props["aria-label"] === "关闭侧问面板")[0].props.onClick(); else env[action]();
		resolve({ ok: true, value: { cursor: 0, records: [record(0)], hasMore: false } }); await tick(); await tick();
		assert.equal(env.calls.some((c) => c[1] === "open"), false); env.cleanup();
	}
});

async function tempFixture() {
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
	const env = await setup({}, options);
	const actions = {
		captureInsertion: () => { captured = { start: 0, end: 8, draftRev: 4 }; return captured; },
		insertText: (text, span) => { insertions++; assert.equal(span.start, 8); assert.equal(span.end, 8); assert.equal(span.draftRev, 4); if (reject) return false; draft = draft.slice(0, span.start) + text + draft.slice(span.end); return true; },
	};
	env.render(env.registrations.get("btw-ask"), { sessionId: "origin", inputActions: actions });
	return { ...env, options, sidebarState: () => ({ expanded, collapses }), setMounted: (v) => { mounted = v; }, setReject: (v) => { reject = v; }, getDraft: () => draft, getInsertions: () => insertions };
}
// Internal transition fixture for lifecycle tests: inline UI deliberately has no mode controls.
function switchHeaderSidebarToOverlay(env) {
	const overlay = env.registrations.get("btw"), pane = env.render(overlay, { inline: true });
	if (pane) {
		assert.equal(all(pane, n => n.props["data-btw-mode"]).length, 0);
		const id = all(pane, n => n.props["data-chat-id"])[0].props["data-chat-id"];
		env.viewControllers.get(id).showOverlay();
	}
}
async function startAndSelect(env) {
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick(); await tick();
	switchHeaderSidebarToOverlay(env);
	const overlay = env.registrations.get("btw");
	let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hello" } });
	tree = env.render(overlay);
	all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick(); await tick();
	tree = env.render(overlay);
	all(tree, (n) => n.type === "button" && n.children.includes("选择消息"))[0].props.onClick();
	tree = env.render(overlay);
	all(tree, (n) => n.type === "input" && n.props.type === "checkbox")[0].props.onChange();
	return overlay;
}

test("side question docks into the same btw chat controls, preserving draft and choices", async () => {
	const env = await setup({}, { effects: true, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {} } });
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
	const env = await historyFixture([record(0)], { rpc: (method) => {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return opened.promise;
		if (method === "close") return ++closes === 1 ? { ok: false, error: { message: "EACCES" } } : { ok: true, value: {} };
		throw new Error("must not send into a closing child");
	} });
	await tick(); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "first" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick();
	tree = env.render(overlay); all(tree, (n) => n.type === "button" && n.props["aria-label"] === "结束临时聊天")[0].props.onClick();
	opened.resolve({ ok: true, value: { sessionId: "late-child", cwd: null } }); await tick(); await tick();
	tree = env.render(overlay);
	assert.ok(all(tree, (n) => n.props.role === "status")[0].children[0].includes("EACCES"));
	assert.equal(env.calls.filter((c) => c[1] === "close")[0][2].sessionId, "late-child");
	all(tree, (n) => n.type === "button" && n.props["aria-label"] === "结束临时聊天")[0].props.onClick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "close").at(-1)[2].sessionId, "late-child");
	assert.equal(env.render(overlay), null); env.cleanup();
});

test("unload owns late open cleanup and never routes its child to a replacement connection", async () => {
	const opened = deferred(), wrongCalls = [];
	const env = await setup({}, { rpc: (method) => method === "open" ? opened.promise : { ok: true, value: method === "models" ? { providers: [] } : {} } });
	await tick(); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
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
	const env = await setup({}, { ...timers, rpc: (method) => {
		if (method === "send") return sent.promise;
		if (method === "poll") return polled.promise;
		if (method === "close") return closed.promise;
		return { ok: true, value: method === "models" ? { providers: [] } : { sessionId: "temp", cwd: null } };
	} });
	await tick(); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "first" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick();
	timers.poll(); assert.equal(timers.size(), 1);
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "结束临时聊天")[0].props.onClick();
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
	const env = await setup({}, { rpc: (method) => {
		if (method === "close") return ++closes === 1 ? { ok: false, error: { message: "retry cleanup" } } : { ok: true, value: {} };
		return { ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "owned", cwd: null } : method === "send" ? { output: "answer" } : { text: "", lastSeq: 0 } };
	} });
	await tick(); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	const overlay = env.registrations.get("btw");
	const send = (text) => { let tree = env.render(overlay); all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: text } }); tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); };
	send("first"); await tick(); await tick();
	env.replaceConnection({ rpc: { call: (...args) => { wrongCalls.push(args); return Promise.resolve({ ok: true, value: {} }); } } });
	send("second"); await tick(); await tick();
	let tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "结束临时聊天")[0].props.onClick(); await tick();
	tree = env.render(overlay); assert.ok(all(tree, (n) => n.props.role === "status")[0].children[0].includes("retry cleanup"));
	env.cleanup(); await tick();
	assert.deepEqual(env.calls.filter((c) => c[1] === "close").map((c) => c[2].sessionId), ["owned", "owned"]);
	assert.equal(env.calls.filter((c) => c[1] === "send").length, 2); assert.equal(wrongCalls.length, 0);
});

test("global re-entry while old close is pending opens a fresh editable draft after cleanup", async () => {
	const disposed = deferred();
	const env = await setup({}, { effects: true, layout: { selectPanel() {} }, rpc: (method) => method === "close" ? disposed.promise : { ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "global", cwd: null } : method === "send" ? { output: "answer" } : { text: "", lastSeq: 0 } } });
	await tick(); const panel = env.registrations.get("dsh-btw-global"); let body = env.render(panel); body = env.render(panel);
	let tree = env.render(body.type, body.props);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "first" } });
	tree = env.render(body.type, body.props); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick(); await tick();
	env.unmount(panel);
	assert.equal(env.calls.filter(c => c[1] === "close").length, 1, "leaving the source-free page closes its child");
	assert.equal(env.render(env.registrations.get("btw")), null, "leaving never strands a floating chat");
	env.render(panel);
	disposed.resolve({ ok: true, value: {} }); await tick();
	body = env.render(panel); tree = env.render(body.type, body.props);
	const textarea = all(tree, (n) => n.type === "textarea")[0];
	assert.ok(textarea); assert.equal(textarea.props.disabled, false); assert.equal(textarea.props.value, ""); env.cleanup();
});

test("fixed and sidebar turns send plain new text to one retained child, never reconstructing its history", async () => {
	let sends = 0;
	const env = await setup({ askContextMode: "none" }, { sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {} }, rpc: method => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "child", cwd: null } : method === "send" ? { output: ++sends === 1 ? "earlier answer" : "continued " + sends } : { text: "", lastSeq: 0 } }) });
	env.render(env.registrations.get("btw-trigger")).props.onClick(); const ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	button(typeTemp(env, ask, "earlier question", props), "提问").props.onClick(); await tick(); await tick();
	let tree = env.render(ask, props); assert.deepEqual(all(tree, isMessageContent).map(n => n.children[0]), ["earlier question", "earlier answer"]);
	button(tree, "停靠侧边栏").props.onClick();
	const overlay = env.registrations.get("btw"), inline = { inline: true };
	button(typeTemp(env, overlay, "followup", inline), "发送").props.onClick(); await tick(); await tick();
	button(typeTemp(env, overlay, "next", inline), "发送").props.onClick(); await tick(); await tick();
	assert.equal(env.calls.filter(c => c[1] === "open").length, 1);
	assert.deepEqual(env.calls.filter(c => c[1] === "send").map(c => [c[2].sessionId, c[2].text]), [["child", "earlier question"], ["child", "followup"], ["child", "next"]]);
	assert.deepEqual(chatText(env.render(overlay, inline)), ["earlier question", "earlier answer", "followup", "continued 2", "next", "continued 3"]);
	env.cleanup();
});

test("late fixed-child poll success or failure cannot overwrite a new source session", async () => {
	for (const outcome of ["success", "failure"]) {
		const timers = manualTimers(), stale = deferred(), sent = deferred(); let children = 0;
		const env = await setup({ askContextMode: "none" }, { ...timers, rpc: (method, payload) => {
			if (method === "models") return { ok: true, value: { providers: [] } };
			if (method === "open") return { ok: true, value: { sessionId: "child" + ++children } };
			if (method === "send") return payload.sessionId === "child1" ? sent.promise : { ok: true, value: { output: "new source answer" } };
			if (method === "poll") return payload.sessionId === "child1" ? stale.promise : { ok: true, value: { text: "", lastSeq: 0 } };
			return { ok: true, value: {} };
		} });
		const ask = env.registrations.get("btw-ask");
		const submit = source => {
			env.render(ask, chatProps(source)); env.render(env.registrations.get("btw-trigger"), { sessionId: source }).props.onClick();
			button(typeTemp(env, ask, "question for " + source, chatProps(source)), "提问").props.onClick();
		};
		submit("old"); await tick(); timers.poll(); timers.poll();
		assert.equal(env.calls.filter(c => c[1] === "poll").length, 1, "old polls remain serial");
		submit("new"); await tick(); await tick();
		if (outcome === "success") stale.resolve({ ok: true, value: { text: "stale answer", lastSeq: 1 } }); else stale.reject(new Error("stale failure"));
		sent.resolve({ ok: true, value: { output: "old source answer" } }); await tick(); await tick();
		assert.deepEqual(all(env.render(ask, chatProps("new")), isMessageContent).map(n => n.children[0]), ["question for new", "new source answer"]);
		const oldText = all(env.render(ask, chatProps("old")), isMessageContent).map(n => n.children[0]);
		assert.equal(oldText[0], "question for old");
		if (outcome === "success") assert.equal(oldText[1], "old source answer");
		else assert.match(oldText[1], /stale failure/, "a failed final cursor read is actionable only in its own child");
		env.cleanup();
	}
});

test("temporary polls are serial, fence late deltas and keep a monotone cursor across turns", async () => {
	const timers = manualTimers(), firstSend = deferred(), stalePoll = deferred();
	let polls = 0, sends = 0;
	const env = await setup({}, { ...timers, rpc: (method) => {
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
	let bubbles = all(env.render(overlay), isMessageContent);
	assert.deepEqual(bubbles.map((n) => n.children[0]), ["first", "AB"]);
	send("second"); await tick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "poll").at(-1)[2].fromSeq, 2);
	bubbles = all(env.render(overlay), isMessageContent);
	assert.deepEqual(bubbles.map((n) => n.children[0]), ["first", "AB", "second", "C"]); env.cleanup();
});

test("sidebar and popup share a live conversation; popup and header restoration collapse without closing tabs", async () => {
	const env = await tempFixture(); const overlay = await startAndSelect(env);
	assert.equal(env.options.definition.kind, "btw-temp");
	assert.deepEqual(env.sidebarState(), { expanded: false, collapses: 1 }, "explicit small-window switch collapses the sidebar");
	let tree = env.render(overlay);
	modeControl(tree, "sidebar").props.onClick();
	assert.equal(env.sidebarState().expanded, true);

	assert.equal(env.render(overlay), null);

	const body = env.render(env.registrations.get("dsh-btw/temp"), { btwSessionId: "origin" });
	assert.equal(body.props.inline, true);
	const pane = env.render(body.type, body.props);
	assert.ok(all(pane, (n) => n.type === "input" && n.props.checked).length);
	switchHeaderSidebarToOverlay(env);
	assert.deepEqual(env.sidebarState(), { expanded: false, collapses: 2 });
	tree = env.render(overlay);
	assert.deepEqual(all(tree, isMessageContent).map((n) => n.children[0]), ["hello", "answer"]);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.checked).length, 1);
	modeControl(tree, "sidebar").props.onClick();

	assert.equal(env.calls.filter((c) => c[1] === "close").length, 0);
	env.options.sidebar.openTab("btw-temp");
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();

	assert.equal(env.sidebarState().expanded, true, "header reopens the sidebar");
	switchHeaderSidebarToOverlay(env);
	assert.deepEqual(env.sidebarState(), { expanded: false, collapses: 3 });

	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	assert.equal(env.sidebarState().expanded, true, "header reactivates the sidebar");
	switchHeaderSidebarToOverlay(env);
	assert.equal(env.sidebarState().collapses, 4);
	tree = env.render(overlay);
	assert.deepEqual(all(tree, isMessageContent).map((n) => n.children[0]), ["hello", "answer"]);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.checked).length, 1);
	assert.equal(env.calls.filter((c) => c[1] === "open").length, 1);
	all(tree, (n) => n.type === "button" && n.props["aria-label"] === "结束临时聊天")[0].props.onClick();
	assert.equal(env.calls.filter((c) => c[1] === "close").length, 1);
	assert.equal(env.calls.find((c) => c[1] === "close")[2].sessionId, "temp");
	await tick(); env.cleanup();
});

test("message selection starts from the header and cancellation clears it", async () => {
	const env = await tempFixture();
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick(); await tick();
	switchHeaderSidebarToOverlay(env);
	const overlay = env.registrations.get("btw");
	let tree = env.render(overlay);
	assert.equal(all(tree, (n) => n.type === "button" && n.children.includes("选择消息")).length, 0);
	all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "hello" } });
	tree = env.render(overlay); all(tree, (n) => n.props["aria-label"] === "发送")[0].props.onClick(); await tick(); await tick();
	tree = env.render(overlay);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.type === "checkbox").length, 0);
	const header = all(tree, (n) => n.props.className === "dsh-btw-mhead")[0];
	all(header, (n) => n.type === "button" && n.children.includes("选择消息"))[0].props.onClick();
	tree = env.render(overlay); all(tree, (n) => n.type === "input" && n.props.type === "checkbox")[0].props.onChange();
	tree = env.render(overlay); all(tree, (n) => n.type === "button" && n.children.includes("取消选择"))[0].props.onClick();
	tree = env.render(overlay);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.type === "checkbox").length, 0);
	assert.equal(all(tree, (n) => n.type === "button" && typeof n.children[0] === "string" && n.children[0].startsWith("送回")).length, 0);
	all(tree, (n) => n.type === "button" && n.children.includes("选择消息"))[0].props.onClick();
	assert.ok(all(env.render(overlay), (n) => n.type === "input" && n.props.type === "checkbox").every((n) => !n.props.checked));
	env.cleanup();
});

test("message selection uses small named native checkboxes and draft success is neutral", async () => {
	const env = await tempFixture(); const overlay = await startAndSelect(env);
	let tree = env.render(overlay);
	const boxes = all(tree, (n) => n.type === "input" && n.props.type === "checkbox");
	assert.deepEqual(boxes.map((n) => n.props["aria-label"]), ["选择消息 1", "选择消息 2"]);
	assert.ok(boxes.every((n) => n.props.className === "dsh-btw-pick" && !n.props.disabled && n.props.tabIndex !== -1));
	assert.equal(all(tree, (n) => n.children.includes("选择")).length, 0);
	boxes[0].props.onChange(); boxes[1].props.onChange();
	tree = env.render(overlay);
	assert.deepEqual(all(tree, (n) => n.type === "input" && n.props.type === "checkbox").map((n) => n.props.checked), [false, true]);
	all(tree, (n) => n.type === "button" && typeof n.children[0] === "string" && n.children[0].startsWith("送回"))[0].props.onClick();
	tree = env.render(overlay);
	const status = all(tree, (n) => n.props.role === "status")[0];
	assert.equal(status.children[0], "已插入草稿，未发送");
	assert.equal(status.props.className, "dsh-btw-status");
	assert.ok(env.getDraft().includes("助手：answer"));
	assert.equal(env.calls.filter((c) => c[1] === "send").length, 1);
	assert.equal(all(tree, (n) => n.type === "input" && n.props.type === "checkbox").length, 0);
	all(tree, (n) => n.type === "button" && n.children.includes("选择消息"))[0].props.onClick();
	assert.equal(all(env.render(overlay), (n) => n.props.role === "status").length, 0);
	env.cleanup();
});

test("cross-session and stale-revision insertions are refused; success preserves draft", async () => {
	const env = await tempFixture(); const overlay = await startAndSelect(env);
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

// Registry tests intentionally drive only the public view callbacks and btw RPC.
function modeControl(tree, mode) {
	const control = all(focusedTree(tree), n => n.props["data-btw-mode"] === mode)[0];
	assert.ok(control, "shared icon mode control: " + mode);
	return control;
}

const button = (tree, label) => {
	if (label === "结束对话") label = "结束临时聊天";
	const direct = all(focusedTree(tree), (n) => n.type === "button" && (n.props["aria-label"] === label || n.children.includes(label)))[0];
	if (direct) return direct;
	if (["停靠侧边栏", "弹窗", "页面"].includes(label)) return modeControl(tree, ({ "停靠侧边栏": "sidebar", "弹窗": "overlay", "页面": "global" })[label]);
};
function typeTemp(env, component, text, props = {}) {
	let tree = env.render(component, props);
	const expand = all(focusedTree(tree), n => n.props["aria-label"] === "展开输入框")[0];
	if (expand) { expand.props.onClick(); tree = env.render(component, props); }
	all(focusedTree(tree), (n) => n.type === "textarea")[0].props.onChange({ target: { value: text } });
	return env.render(component, props);
}
function focusChat(env, component, id, props = {}) {
	const tree = env.render(component, props);
	const window = all(tree, (n) => n.props["data-chat-id"] === id)[0];
	assert.ok(window, "chat is independently reachable: " + id);
	window.props.onPointerDownCapture();
	return env.render(component, props);
}
const chatWindow = (tree, id) => all(tree, (n) => n.props["data-chat-id"] === id)[0];
const focusedTree = (tree) => all(tree, (n) => n.props["data-focused"] === true)[0] || tree;
function resizeKey(tree, edge, key, shiftKey = false, count = 1) {
	const handle = all(focusedTree(tree), (n) => n.props["data-edge"] === edge)[0];
	assert.ok(handle, "keyboard resize handle: " + edge);
	for (let i = 0; i < count; i++) handle.props.onKeyDown({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
}
const chatText = (tree) => all(focusedTree(tree), isMessageContent).map((n) => n.children[0]);

test("default is the only policy item; legacy settings normalize and RPC resolves by parent", async () => {
	for (const mode of [undefined, "host", "current", "default"]) {
		for (const parent of [undefined, "source"]) {
			const config = mode ? { askModelMode: mode, tempModelMode: mode } : {};
			const env = await setup(config, { layout: { selectPanel() {} }, rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "tmp", cwd: null } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
			await tick(); const overlay = env.registrations.get("btw"), overlayProps = parent ? {} : { standalone: true };
			if (parent) env.render(env.registrations.get("btw-temp"), { sessionId: parent }).props.onClick();
			else { const panel = env.registrations.get("dsh-btw-global"); env.render(panel); env.render(panel); }
			let tree = env.render(overlay, overlayProps), model = modelTree(env, tree);

			const select = all(model, (n) => n.type === "select")[0];
			assert.equal(select.props.value, "default");
			assert.deepEqual(all(select, (n) => n.type === "option").map((n) => [n.props.value, n.children[0]]), [["default", "默认"]]);
			tree = typeTemp(env, overlay, "hello", overlayProps); button(tree, "发送").props.onClick(); await tick(); await tick();
			assert.equal(env.calls.find((c) => c[1] === "open")[2].modelMode, parent ? "current" : "host");
			env.render(env.registrations.get("btw-trigger")).props.onClick();
			const ask = env.registrations.get("btw-ask"), props = { sessionId: parent };
			tree = env.render(ask, props); all(tree, (n) => n.type === "textarea")[0].props.onChange({ target: { value: "ask" } });
			tree = env.render(ask, props); button(tree, "提问").props.onClick();
			assert.equal(env.calls.find((c) => c[1] === "open")[2].modelMode, parent ? "current" : "host");
			env.cleanup();
		}
	}
	const env = await setup({ askModelMode: "custom", askProvider: "p", askModel: "m" }); await tick();
	const settings = env.registrations.get("dsh-btw#btw")({}).type;
	const model = modelTree(env, env.render(settings)); all(model, (n) => n.type === "select")[0].props.onChange({ target: { value: "default" } }); await tick();
	assert.deepEqual(env.writes.at(-1), ["askModelMode", "host"]);
	assert.equal(all(modelTree(env, env.render(settings)), (n) => n.type === "select")[0].props.value, "default"); env.cleanup();
});

test("concurrent controllers poll independently; stale rendered close and late replies cannot affect the visible chat", async () => {
	const timers = manualTimers(), sends = new Map(), polls = new Map(); let opened = 0;
	const env = await setup({}, { ...timers, rpc: (method, payload) => {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return { ok: true, value: { sessionId: "child" + ++opened, cwd: null } };
		if (method === "send") { const request = deferred(); sends.set(payload.sessionId, request); return request.promise; }
		if (method === "poll") { if (!polls.has(payload.sessionId)) { const request = deferred(); polls.set(payload.sessionId, request); return request.promise; } return { ok: true, value: { text: "", lastSeq: 1 } }; }
		return { ok: true, value: {} };
	} });
	await tick(); const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	let tree = typeTemp(env, overlay, "first"); button(tree, "发送").props.onClick(); await tick();
	const staleClose = button(env.render(overlay), "结束对话");
	button(env.render(overlay), "新建临时聊天").props.onClick();
	tree = typeTemp(env, overlay, "second"); button(tree, "发送").props.onClick(); await tick();
	tree = typeTemp(env, overlay, "second draft"); timers.poll(); timers.poll();
	assert.equal(timers.size(), 2); assert.equal(env.calls.filter((c) => c[1] === "poll").length, 2, "one in-flight poll per controller");
	staleClose.props.onClick(); await tick();
	assert.deepEqual(env.calls.filter((c) => c[1] === "close").map((c) => c[2].sessionId), ["child1"]);
	assert.equal(timers.size(), 1);
	sends.get("child1").resolve({ ok: true, value: { output: "stale first" } });
	polls.get("child1").resolve({ ok: true, value: { text: "stale delta", lastSeq: 1 } });
	polls.get("child2").resolve({ ok: true, value: { text: "background second", lastSeq: 1 } }); await tick();
	assert.deepEqual(chatText(env.render(overlay)), ["second", "background second"]);
	assert.equal(all(focusedTree(env.render(overlay)), (n) => n.type === "textarea")[0].props.value, "second draft");
	sends.get("child2").resolve({ ok: true, value: { output: "second complete" } }); await tick(); await tick();
	assert.deepEqual(chatText(env.render(overlay)), ["second", "second complete"]);
	assert.equal(timers.size(), 0); env.cleanup(); await tick();
	assert.deepEqual(env.calls.filter((c) => c[1] === "close").map((c) => c[2].sessionId), ["child1", "child2"]);
});

test("background opening and failed-close recovery retain separate ids and owner connections", async () => {
	const firstOpen = deferred(), secondOpen = deferred(), wrong = []; let opens = 0, firstCloses = 0;
	const env = await setup({}, { rpc: (method, payload) => {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return ++opens === 1 ? firstOpen.promise : secondOpen.promise;
		if (method === "close" && payload.sessionId === "late-first" && ++firstCloses === 1) return { ok: false, error: { message: "denied" } };
		return { ok: true, value: method === "send" ? { output: "second reply" } : { text: "", lastSeq: 0 } };
	} });
	await tick(); const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), { sessionId: "first-source" }).props.onClick();
	button(typeTemp(env, overlay, "first"), "发送").props.onClick();
	const firstClose = button(env.render(overlay), "结束对话");
	button(env.render(overlay), "新建临时聊天").props.onClick();
	button(typeTemp(env, overlay, "second"), "发送").props.onClick();
	firstClose.props.onClick();
	env.replaceConnection({ rpc: { call: (...args) => { wrong.push(args); return Promise.resolve({ ok: true, value: {} }); } } });
	secondOpen.resolve({ ok: true, value: { sessionId: "second-child", cwd: null } }); await tick(); await tick();
	firstOpen.resolve({ ok: true, value: { sessionId: "late-first", cwd: null } }); await tick(); await tick();
	assert.deepEqual(chatText(env.render(overlay)), ["second", "second reply"]);
	assert.deepEqual(env.calls.filter((c) => c[1] === "send").map((c) => c[2].sessionId), ["second-child"]);
	let tree = focusChat(env, overlay, "btw-1"); assert.match(JSON.stringify(tree), /denied/);
	button(tree, "结束对话").props.onClick(); await tick();
	assert.deepEqual(chatText(env.render(overlay)), ["second", "second reply"]);
	assert.equal(firstCloses, 2); assert.equal(wrong.length, 0); env.cleanup(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "close").at(-1)[2].sessionId, "second-child"); assert.equal(wrong.length, 0);
});

test("all three presentations share draft, model, context, messages, selection and small-window geometry", async () => {
	let mounted = "origin", expanded = false; const selected = [];
	const env = await setup({}, { effects: true, layout: { selectPanel: (id) => selected.push(id) }, sidebar: { mounted: { getSnapshot: () => mounted }, openTab() { expanded = true; }, isExpanded: () => expanded, toggleExpanded() { expanded = false; } }, rpc: (method) => ({ ok: true, value: method === "models" ? { providers: [{ id: "p", models: [{ id: "m" }] }] } : method === "open" ? { sessionId: "one", cwd: null } : method === "send" ? { output: "own answer" } : { text: "", lastSeq: 0 } }) });
	await tick(); env.render(env.registrations.get("btw-ask"), chatProps("origin", [{ kind: "user", content: [{ type: "text", text: "SOURCE_SECRET_NEVER_RENDER" }] }]));
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	switchHeaderSidebarToOverlay(env);
	const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
	modelTree(env, tree).children[0].props.onChange({ target: { value: '["p","m"]' } });
	all(tree, (n) => n.props["aria-label"] === "临时聊天上下文")[0].props.onChange({ target: { value: "recent" } });
	button(typeTemp(env, overlay, "own question"), "发送").props.onClick(); await tick(); await tick();
	tree = env.render(overlay); button(tree, "选择消息").props.onClick(); tree = env.render(overlay);


	all(tree, (n) => n.props.type === "checkbox")[0].props.onChange();
	tree = typeTemp(env, overlay, "unsent draft"); resizeKey(tree, "e", "ArrowRight", true, 7); resizeKey(env.render(overlay), "e", "ArrowLeft", false, 2);
	tree = env.render(overlay); button(tree, "停靠侧边栏").props.onClick(); assert.equal(env.render(overlay), null);
	const pane = env.render(env.registrations.get("dsh-btw/temp"), { btwSessionId: "origin" });
	let sidebarTree = env.render(pane.type, pane.props);
	const verify = (view) => {
		assert.deepEqual(chatText(view), ["own question", "own answer"]);
		assert.equal(all(view, (n) => n.type === "textarea")[0].props.value, "unsent draft");
		assert.equal(all(view, (n) => n.props.type === "checkbox" && n.props.checked).length, 1);
		assert.equal(all(view, (n) => n.type?.name === "ModelSelect")[0].props.value, '["p","m"]');
		assert.equal(all(view, (n) => n.props["aria-label"] === "临时聊天上下文")[0].props.value, "recent");
		assert.equal(all(view, (n) => n.props.className === "dsh-btw-modal")[0].props.style["--btw-width"], "1000px");
		assert.doesNotMatch(JSON.stringify(view), /SOURCE_SECRET_NEVER_RENDER/);
	};
	verify(sidebarTree); switchHeaderSidebarToOverlay(env);
	button(env.render(overlay), "页面").props.onClick();
	const panel = env.registrations.get("dsh-btw-global"), page = env.render(panel);
	let pageTree = env.render(page.type, page.props); verify(pageTree);
	assert.equal(all(pageTree, (n) => n.props.className === "dsh-btw-modal")[0].props.style.borderRadius, "var(--dsw-radius-panel,24px)");
	assert.equal(all(pageTree, (n) => n.props.type === "range").length, 0);
	button(pageTree, "弹窗").props.onClick(); env.unmount(panel); verify(env.render(overlay));
	const css = env.styles.join(""); assert.match(css, /width:min\(var\(--btw-width,740px\),calc\(100vw - 32px\)\)/); assert.match(css, /corner-shape:superellipse\(1\.5\)/);
	assert.equal(env.calls.filter((c) => c[1] === "open").length, 1); assert.equal(env.calls.some((c) => c[1] === "close"), false);
	assert.deepEqual(selected, ["dsh-btw-global", null]); env.cleanup();
});

test("stale configuration callbacks remain pinned; closing a sourced sidebar cannot strand another source", async () => {
	const env = await setup({}, { effects: true, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {}, isExpanded: () => false } }); await tick();
	const entry = env.registrations.get("btw-temp"), overlay = env.registrations.get("btw");
	env.render(entry, { sessionId: "other" }).props.onClick();
	const oldModel = all(env.render(overlay), (n) => n.type?.name === "ModelSelect")[0];
	env.render(entry, { sessionId: "origin" }).props.onClick();
	switchHeaderSidebarToOverlay(env);
	oldModel.props.onChange('["p","m"]');
	let tree = env.render(overlay);
	assert.equal(all(chatWindow(tree, "btw-2"), (n) => n.type?.name === "ModelSelect")[0].props.value, "default");
	assert.equal(all(chatWindow(tree, "btw-1"), (n) => n.type?.name === "ModelSelect")[0].props.value, '["p","m"]');
	button(tree, "停靠侧边栏").props.onClick();
	const pane = env.render(env.registrations.get("dsh-btw/temp"), { btwSessionId: "origin" });
	tree = focusChat(env, overlay, "btw-1");
	assert.equal(modeControl(tree, "sidebar").props.disabled, true);
	const currentPane = env.render(pane.type, pane.props);
	button(currentPane, "结束对话").props.onClick(); await tick();
	tree = env.render(overlay);
	assert.ok(chatWindow(tree, "btw-1")); assert.equal(chatWindow(tree, "btw-2"), undefined);
	assert.equal(all(tree, (n) => n.type?.name === "ModelSelect")[0].props.value, '["p","m"]');
	env.cleanup();
});

test("unload closes every pending child on its own creating connection, including background opens", async () => {
	const first = deferred(), second = deferred(), secondCalls = [];
	const env = await setup({}, { rpc: (method) => method === "open" ? first.promise : { ok: true, value: method === "models" ? { providers: [] } : {} } });
	await tick(); const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	button(typeTemp(env, overlay, "first"), "发送").props.onClick();
	env.replaceConnection({ rpc: { call: (...args) => { secondCalls.push(args); return args[1] === "open" ? second.promise : Promise.resolve({ ok: true, value: {} }); } } });
	button(env.render(overlay), "新建临时聊天").props.onClick();
	button(typeTemp(env, overlay, "second"), "发送").props.onClick();
	env.cleanup(); assert.equal(env.render(overlay), null);
	second.resolve({ ok: true, value: { sessionId: "second-owner", cwd: null } });
	first.resolve({ ok: true, value: { sessionId: "first-owner", cwd: null } }); await tick(); await tick();
	assert.deepEqual(env.calls.filter((c) => c[1] === "close").map((c) => c[2].sessionId), ["first-owner"]);
	assert.deepEqual(secondCalls.filter((c) => c[1] === "close").map((c) => c[2].sessionId), ["second-owner"]);
	assert.equal([...env.calls, ...secondCalls].some((c) => c[1] === "send"), false);
});

test("host child capacity counts pending openings but does not silently cap independent drafts", async () => {
	const openings = [];
	const env = await setup({}, { rpc: (method) => {
		if (method === "open") { const request = deferred(); openings.push(request); return request.promise; }
		return { ok: true, value: method === "models" ? { providers: [] } : {} };
	} });
	await tick(); const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	for (let i = 0; i < 17; i++) {
		if (i) button(env.render(overlay), "新建临时聊天").props.onClick();
		button(typeTemp(env, overlay, "question " + i), "发送").props.onClick();
	}
	assert.equal(openings.length, 16);
	assert.match(JSON.stringify(env.render(overlay)), /最多同时开启 16/);
	button(env.render(overlay), "新建临时聊天").props.onClick();
	let tree = env.render(overlay);
	assert.equal(all(focusedTree(tree), (n) => n.type === "textarea")[0].props.disabled, false);
	assert.equal(all(tree, (n) => n.props["data-chat-id"]).length, 18);
	assert.equal(all(tree, (n) => n.props["aria-label"] === "切换临时聊天").length, 0);
	env.cleanup(); openings.forEach((request, i) => request.resolve({ ok: true, value: { sessionId: "late-" + i, cwd: null } })); await tick(); await tick();
	assert.equal(env.calls.filter((c) => c[1] === "close").length, 16);
	assert.equal(new Set(env.calls.filter((c) => c[1] === "close").map((c) => c[2].sessionId)).size, 16);
	assert.equal(env.calls.some((c) => c[1] === "send"), false);
});

function geometryStorage() {
	const values = new Map(), writes = [];
	return { values, writes, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes.push([key, value]); } };
}
const projectProps = (cwd = "/project", sessionId = "origin") => ({ sessionId, useSessions: (fn) => fn({ byId: { [sessionId]: { cwd } } }) });
const modal = (tree) => all(focusedTree(tree), (n) => n.props.className === "dsh-btw-modal")[0];

test("small window is pinned by default; pointer dragging and resize clamp numeric project-local geometry", async () => {
	const storage = geometryStorage(), env = await setup({}, { storage, width: 1000, height: 700 }); await tick();
	const overlay = env.registrations.get("btw"); env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	let tree = typeTemp(env, overlay, "PRIVATE DRAFT NEVER PERSIST");
	let head = all(tree, (n) => n.props.className === "dsh-btw-mhead")[0];
	assert.equal(button(tree, "固定小窗").props["aria-pressed"], true);
	modal(tree).props.ref.current = { getBoundingClientRect: () => ({ left: 100, top: 30 }) };
	const event = { button: 0, pointerId: 1, clientX: 100, clientY: 50, target: {}, currentTarget: { setPointerCapture() {} }, preventDefault() {} };
	head.props.onPointerDown(event); head.props.onPointerMove({ pointerId: 1, clientX: 9000, clientY: 9000 });
	assert.equal(modal(env.render(overlay)).props.style.left, 130); assert.equal(storage.writes.length, 0);
	button(tree, "固定小窗").props.onClick(); tree = env.render(overlay); head = all(tree, (n) => n.props.className === "dsh-btw-mhead")[0];
	assert.equal(head.props["data-draggable"], true);
	head.props.onPointerDown(event); head.props.onPointerMove({ pointerId: 1, clientX: 9000, clientY: 9000 }); head.props.onPointerUp();
	tree = env.render(overlay); assert.equal(modal(tree).props.style.left, 260); assert.equal(modal(tree).props.style.top, 60);
	assert.equal(storage.values.size, 1);
	for (const [key, json] of storage.writes) {
		assert.equal(key, "dsh-btw/geometry/v1/%2Fproject");
		assert.ok(Object.values(JSON.parse(json)).every(Number.isFinite)); assert.doesNotMatch(json, /PRIVATE|origin|session|model|draft/);
	}
	env.setViewport(600, 500); tree = env.render(overlay);
	assert.equal(modal(tree).props.style["--btw-width"], "568px"); assert.equal(modal(tree).props.style.left, 32); assert.equal(modal(tree).props.style.top, 48);
	env.cleanup();
	const restored = await setup({}, { storage, width: 600, height: 500 }); await tick();
	restored.render(restored.registrations.get("btw-temp"), projectProps()).props.onClick();
	tree = restored.render(restored.registrations.get("btw")); assert.equal(modal(tree).props.style.left, 32); assert.equal(modal(tree).props.style["--btw-width"], "568px");
	assert.equal(all(tree, (n) => n.type === "textarea")[0].props.value, "");
	restored.render(restored.registrations.get("btw-temp"), projectProps("/another", "other")).props.onClick();
	tree = restored.render(restored.registrations.get("btw")); assert.equal(modal(tree).props.style.left, 16); restored.cleanup();
});

test("remember-position opt-out ignores stored geometry and writes nothing; bad storage degrades safely", async () => {
	for (const broken of [false, true]) {
		const storage = geometryStorage(); storage.values.set("dsh-btw/geometry/v1/%2Fproject", '{"width":400,"x":50000,"y":50000}');
		if (broken) { storage.getItem = () => { throw new Error("privacy"); }; storage.setItem = () => { throw new Error("quota"); }; }
		const env = await setup({ tempRememberPosition: false, tempWindowPinned: false }, { storage }); await tick();
		env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		const overlay = env.registrations.get("btw"); let tree = env.render(overlay);
		assert.equal(modal(tree).props.style["--btw-width"], "740px"); assert.equal(modal(tree).props.style.left, 350);
		assert.equal(button(tree, "固定小窗").props["aria-pressed"], false);
		resizeKey(tree, "e", "ArrowRight", true, 4);
		assert.equal(modal(env.render(overlay)).props.style["--btw-width"], "900px"); assert.equal(storage.writes.length, 0); env.cleanup();
	}
});

test("default presentation settings use exactly three modes and project sidebar switches safely", async () => {
	for (const mode of ["overlay", "sidebar", "global"]) {
		for (const sourced of [true]) {
			const selected = [], env = await setup({ tempPresentation: mode }, { effects: true, layout: { selectPanel: (id) => selected.push(id) }, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {}, isExpanded: () => false } }); await tick();
			env.render(env.registrations.get("btw-temp"), sourced ? projectProps() : {}).props.onClick();
			const overlay = env.registrations.get("btw"), effective = sourced ? "sidebar" : "overlay";
			let tree = effective === "global" ? env.render(overlay, { standalone: true }) : effective === "sidebar" ? env.render(overlay, { inline: true }) : env.render(overlay);
			assert.ok(tree); if (effective === "sidebar") assert.equal(all(tree, n => n.props["data-btw-mode"]).length, 0); else assert.equal(modeControl(tree, effective).props["aria-pressed"], true);
			assert.equal(all(tree, (n) => n.props["aria-label"] === "收起临时聊天").length, 0);
			if (sourced) {
				switchHeaderSidebarToOverlay(env); tree = env.render(overlay);
				modeControl(tree, "global").props.onClick(); tree = env.render(overlay, { standalone: true });
				modeControl(tree, "sidebar").props.onClick(); tree = env.render(overlay, { inline: true });
				switchHeaderSidebarToOverlay(env); assert.ok(env.render(overlay));
				assert.equal(env.calls.some((c) => c[1] === "close"), false, "presentation switching never releases a child");
			}
			env.cleanup();
		}
	}
	const env = await setup(); await tick(); const settings = env.registrations.get("dsh-btw#btw")({}).type;
	env.render(settings); await tick();
	let tree = env.render(settings), select = all(tree, (n) => n.props["aria-label"] === "默认显示模式")[0];
	assert.deepEqual(all(select, (n) => n.type === "option").map((n) => n.children[0]), ["小窗", "侧边栏", "全屏"]);
	select.props.onChange({ target: { value: "sidebar" } });
	for (const label of ["小窗默认固定", "记忆项目内的小窗位置和大小（仅数值）"])
		all(tree, (n) => n.type === "input" && n.props.role === "switch" && n.props["aria-label"] === label)[0].props.onChange({ target: { checked: false } });
	await tick();
	assert.deepEqual(env.writes, [["tempPresentation", "sidebar"], ["tempWindowPinned", false], ["tempRememberPosition", false]]); env.cleanup();
});

test("native sidebar close ignores foreign tabs and closes only the current child", async () => {
	let nativeClose, unregistered = 0, next = 0;
	const env = await setup({ tempPresentation: "sidebar" }, {
		sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {}, isExpanded: () => false,
			registerCloseHandler(kind, handler) { assert.equal(kind, "btw-temp"); nativeClose = handler; return () => unregistered++; } },
		rpc: method => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "child-" + ++next } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }),
	});
	await tick(); const overlay = env.registrations.get("btw"), inline = { inline: true };
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	button(typeTemp(env, overlay, "first", inline), "发送").props.onClick(); await tick(); await tick();
	const first = env.viewControllers.get(all(env.render(overlay, inline), n => n.props["data-chat-id"])[0].props["data-chat-id"]);
	nativeClose("another-source"); assert.equal(env.calls.some(c => c[1] === "close"), false);
	// The sidebar exposes no 新建 control any more, so it holds exactly one chat.
	assert.equal(all(env.render(overlay, inline), n => n.props["aria-label"] === "新建临时聊天").length, 0);
	assert.equal(env.render(overlay), null, "the sidebar chat never leaks into a floating window");
	assert.deepEqual(Array.from(first.store.state.messages, m => m.text), ["first", "ok"]);
	nativeClose("origin"); await tick();
	assert.deepEqual(env.calls.filter(c => c[1] === "close").map(c => c[2].sessionId), ["child-1"]);
	env.cleanup(); await tick(); assert.equal(unregistered, 1);
});

const geometry = (tree) => {
	const { left: x, top: y, width, height } = modal(tree).props.style;
	return { x, y, width, height };
};
function pointerResize(tree, edge, dx, dy) {
	const handle = all(focusedTree(tree), n => n.props["data-edge"] === edge)[0];
	const captures = [], releases = [];
	const currentTarget = { setPointerCapture: id => captures.push(id), releasePointerCapture: id => releases.push(id) };
	handle.props.onPointerDown({ button: 0, pointerId: 7, clientX: 100, clientY: 100, currentTarget, preventDefault() {}, stopPropagation() {} });
	handle.props.onPointerMove({ pointerId: 8, clientX: 9999, clientY: 9999 });
	handle.props.onPointerMove({ pointerId: 7, clientX: 100 + dx, clientY: 100 + dy });
	handle.props.onPointerUp({ pointerId: 7, currentTarget });
	handle.props.onPointerMove({ pointerId: 7, clientX: 9999, clientY: 9999 });
	assert.deepEqual(captures, [7]); assert.deepEqual(releases, [7]);
	return handle;
}

test("all eight desktop resize handles capture pointers, preserve opposite edges and work while pinned", async () => {
	for (const edge of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
		const storage = geometryStorage();
		storage.values.set("dsh-btw/geometry/v1/%2Fproject", JSON.stringify({ x: 300, y: 200, width: 600, height: 450 }));
		const env = await setup({}, { storage, width: 1400, height: 1000 }); await tick();
		const overlay = env.registrations.get("btw"); env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		let tree = typeTemp(env, overlay, "KEEP DRAFT"); const from = geometry(tree);
		assert.equal(button(tree, "固定小窗").props["aria-pressed"], true);
		assert.equal(all(tree, n => n.props["data-edge"]).length, 8);
		assert.equal(all(tree, n => n.props.type === "range").length, 0);
		const handle = pointerResize(tree, edge, 50, 60);

		tree = env.render(overlay); const next = geometry(tree);
		assert.deepEqual(next, {

			x: from.x + (edge.includes("w") ? 50 : 0), y: from.y + (edge.includes("n") ? 60 : 0),
			width: from.width + (edge.includes("w") ? -50 : edge.includes("e") ? 50 : 0),
			height: from.height + (edge.includes("n") ? -60 : edge.includes("s") ? 60 : 0),
		});
		// Capture loss/cancel fences a real in-progress gesture.
		for (const end of ["onPointerCancel", "onLostPointerCapture"]) {
			handle.props.onPointerDown({ button: 0, pointerId: 9, clientX: 0, clientY: 0, currentTarget: {}, preventDefault() {}, stopPropagation() {} });
			handle.props[end](); handle.props.onPointerMove({ pointerId: 9, clientX: 4000, clientY: 4000 });
			assert.deepEqual(geometry(env.render(overlay)), next);
		}
		assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "KEEP DRAFT");

		for (const [, json] of storage.writes) assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ["height", "width", "x", "y"]);
		assert.equal(env.calls.some(c => c[1] !== "models"), false); env.cleanup();
	}
});


test("north/west resizing clamps at minimum and viewport with fixed south/east anchors; keyboard has the same constraints", async () => {

	const storage = geometryStorage(); storage.values.set("dsh-btw/geometry/v1/%2Fproject", '{"x":200,"y":100,"width":600,"height":500,"sessionId":"DO NOT RESTORE","draft":"SECRET"}');
	const env = await setup({}, { storage, width: 1200, height: 900 }); await tick();

	const overlay = env.registrations.get("btw"); env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	pointerResize(env.render(overlay), "nw", 9999, 9999);
	assert.deepEqual(geometry(env.render(overlay)), { x: 440, y: 280, width: 360, height: 320 });
	pointerResize(env.render(overlay), "nw", -9999, -9999);
	assert.deepEqual(geometry(env.render(overlay)), { x: 0, y: 0, width: 800, height: 600 });
	resizeKey(env.render(overlay), "nw", "ArrowRight", true); resizeKey(env.render(overlay), "nw", "ArrowDown");
	assert.deepEqual(geometry(env.render(overlay)), { x: 40, y: 10, width: 760, height: 590 });
	resizeKey(env.render(overlay), "se", "ArrowRight", true, 100); resizeKey(env.render(overlay), "se", "ArrowDown", true, 100);
	assert.deepEqual(geometry(env.render(overlay)), { x: 40, y: 10, width: 1160, height: 852 });
	env.setViewport(250, 200);
	assert.deepEqual(geometry(env.render(overlay)), { x: 32, y: 10, width: 218, height: 152 });
	assert.equal(all(env.render(overlay), n => n.type === "textarea")[0].props.value, "");
	assert.doesNotMatch(storage.writes.at(-1)[1], /SECRET|sessionId|draft/);
	const css = env.styles.join(""); for (const cursor of ["ns-resize", "ew-resize", "nesw-resize", "nwse-resize"]) assert.ok(css.includes(cursor));
	assert.match(css, /resize:focus-visible/); env.cleanup();
});

test("focus only raises independent windows; Escape closes only the focused controller and native menu Escape is isolated", async () => {
	const firstOpen = deferred(), firstSend = deferred(); let opens = 0;
	const timers = manualTimers();
	const env = await setup({}, { effects: true, ...timers, rpc: method => {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return ++opens === 1 ? firstOpen.promise : { ok: true, value: { sessionId: "two" } };
		if (method === "send") return firstSend.promise;
		return { ok: true, value: { text: "", lastSeq: 0 } };
	} }); await tick();
	const overlay = env.registrations.get("btw"), entry = env.registrations.get("btw-temp");
	env.render(entry, projectProps()).props.onClick(); button(typeTemp(env, overlay, "first"), "发送").props.onClick();
	button(env.render(overlay), "新建临时聊天").props.onClick();
	let tree = typeTemp(env, overlay, "second draft");
	const order = all(tree, n => n.props["data-chat-id"]).map(n => n.props["data-chat-id"]);
	assert.deepEqual(order, ["btw-1", "btw-2"]);
	assert.notDeepEqual(geometry(chatWindow(tree, "btw-1")), geometry(chatWindow(tree, "btw-2")), "new windows cascade, leaving an older window reachable");
	let focusCalls = 0;
	for (const textarea of all(tree, n => n.type === "textarea")) textarea.props.ref.current = { focus() { focusCalls++; } };
	firstOpen.resolve({ ok: true, value: { sessionId: "one" } }); await tick(); tree = env.render(overlay);
	assert.equal(focusCalls, 0, "background opening does not focus an editor");
	firstSend.resolve({ ok: true, value: { output: "first answer" } }); await tick(); await tick(); tree = env.render(overlay);
	assert.equal(focusCalls, 0, "background reply does not focus an editor");
	assert.equal(all(focusedTree(tree), n => n.type === "textarea")[0].props.value, "second draft");
	tree = focusChat(env, overlay, "btw-1");
	assert.deepEqual(all(tree, n => n.props["data-chat-id"]).map(n => n.props["data-chat-id"]), order, "raising never reorders editor DOM");
	assert.ok(chatWindow(tree, "btw-1").props.style.zIndex > chatWindow(tree, "btw-2").props.style.zIndex);
	assert.deepEqual(chatText(tree), ["first", "first answer"]);
	pointerResize(tree, "se", 20, 30);
	assert.equal(all(chatWindow(env.render(overlay), "btw-2"), n => n.type === "textarea")[0].props.value, "second draft");
	const inside = escapeTarget(env.render(overlay), "btw-1");
	for (const event of [{ defaultPrevented: true }, { isComposing: true }, { target: { closest: () => ({}) } }]) env.dispatch("keydown", { key: "Escape", target: inside, ...event });
	assert.equal(env.calls.filter(c => c[1] === "close").length, 0);
	env.dispatch("keydown", { key: "Escape", target: inside }); await tick();
	// Esc ends the focused btw at once and cleans it up in the background.
	assert.deepEqual(env.calls.filter(c => c[1] === "close").map(c => c[2].sessionId), ["one"]);
	tree = env.render(overlay); assert.ok(chatWindow(tree, "btw-2")); assert.equal(chatWindow(tree, "btw-1"), undefined);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "second draft");
	env.render(entry, projectProps()).props.onClick(); tree = env.render(overlay);
	assert.equal(all(tree, n => n.props["data-chat-id"]).length, 1, "the ended chat is gone, so nothing resumes");
	assert.equal(all(chatWindow(tree, "btw-2"), n => n.type === "textarea")[0].props.value, "second draft");
	assert.equal(all(tree, n => n.props["aria-label"] === "切换临时聊天").length, 0);
	const css = env.styles.join(""); assert.match(css, /\.dsh-btw-desktop\{[^}]*z-index:9000/); assert.match(css, /picker-menu\[data-menu-material\]\{z-index:9010/);
	assert.equal(all(tree, n => n.props.className === "dsh-btw-desktop").length, 1); env.cleanup();
});

test("new chat never replaces fullscreen; moving another chat there returns its occupant to a visible window", async () => {
	const selected = [], env = await setup({}, { effects: true, layout: { selectPanel: id => selected.push(id) } }); await tick();
	const overlay = env.registrations.get("btw"); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	let tree = typeTemp(env, overlay, "first draft"); modeControl(tree, "global").props.onClick();
	tree = env.render(overlay, { standalone: true }); button(tree, "新建临时聊天").props.onClick();
	assert.equal(all(env.render(overlay, { standalone: true }), n => n.type === "textarea")[0].props.value, "first draft");
	tree = typeTemp(env, overlay, "second draft"); modeControl(tree, "global").props.onClick();
	tree = env.render(overlay); assert.ok(chatWindow(tree, "btw-1")); assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "first draft");
	const page = env.render(overlay, { standalone: true }); assert.ok(chatWindow(page, "btw-2")); assert.equal(all(page, n => n.type === "textarea")[0].props.value, "second draft");
	assert.equal(modal(page).props.style.width, "100%"); assert.equal(modal(page).props.style.height, "100%");
	assert.equal(all(page, n => n.props["data-edge"] || n.props.type === "range").length, 0);
	assert.equal(env.calls.some(c => c[1] !== "models"), false); env.cleanup();
});

test("fullscreen to sidebar restores the selected source before checking mounted, including deferred mounts and wrong-source fallback", async () => {
	for (const deferredMount of [false, true]) for (const source of ["origin", "another"]) {
		let mounted = "origin", opened = 0; const listeners = new Set(), selected = [];
		const env = await setup({}, { effects: true, layout: { selectPanel(id) { selected.push(id); mounted = id ? undefined : deferredMount ? undefined : source; } },
			sidebar: { mounted: { getSnapshot: () => mounted, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }, openTab() { assert.equal(mounted, "origin"); opened++; }, isExpanded: () => false } }); await tick();
		const overlay = env.registrations.get("btw"); env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		switchHeaderSidebarToOverlay(env);
		opened = 0;
		modeControl(typeTemp(env, overlay, "preserved"), "global").props.onClick(); assert.equal(mounted, undefined);
		let tree = env.render(overlay, { standalone: true });
		modeControl(tree, "sidebar").props.onClick(); assert.equal(selected.at(-1), null);
		if (deferredMount) { assert.ok(env.render(overlay), "pending mount remains a reachable small window"); mounted = source; for (const fn of [...listeners]) fn(); }
		assert.equal(opened, source === "origin" ? 1 : 0); assert.equal(listeners.size, 1, "only the lifetime sidebar retirement watcher remains");
		tree = env.render(overlay, source === "origin" ? { inline: true } : {});
		assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "preserved");
		assert.equal(env.calls.some(c => c[1] !== "models"), false); env.cleanup();
	}
});

test("reasoning factory follows each real seat with child-only input and old-host fallback", async () => {
	const calls = [], factory = (name, input, options) => { calls.push({ name, input, options }); return { type: "native-reasoning", props: { input }, children: [] }; };
	const missingFactory = (_name, _input, options) => options.fallback;
	const env = await sideQuestionFixture({ effects: true, layout: { selectPanel() {} }, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {}, isExpanded: () => false } });
	let tree = await env.submit();
	const controller = [...env.viewControllers.values()][0];
	controller.store.state.messages[1].reasoning = "child committed thought";
	const verify = (view, native) => {
		const details = all(view, n => n.type === "details" && n.props.className === "dsh-btw-reasoning");
		assert.equal(details.length, 1); assert.equal(details[0].props.open, undefined);
		assert.equal(all(view, n => n.type === "native-reasoning").length, native ? 1 : 0);
		if (!native) assert.equal(details[0].children[1].children[0], "child committed thought");
	};
	verify(env.render(env.ask, env.props), false);
	verify(env.render(env.ask, { ...env.props, renderFactorySlot: missingFactory }), false);
	verify(env.render(env.ask, { ...env.props, renderFactorySlot: factory }), true);
	button(env.render(env.ask, env.props), "浮动小窗").props.onClick();
	const overlay = env.registrations.get("btw");
	verify(env.render(overlay), false); verify(env.render(overlay, { renderFactorySlot: missingFactory }), false); verify(env.render(overlay, { renderFactorySlot: factory }), true);
	button(env.render(overlay), "停靠侧边栏").props.onClick();
	const sidebar = env.registrations.get("dsh-btw/temp");
	let seat = env.render(sidebar, { btwSessionId: "origin" }); verify(env.render(seat.type, seat.props), false);
	seat = env.render(sidebar, { btwSessionId: "origin", renderFactorySlot: missingFactory }); verify(env.render(seat.type, seat.props), false);
	seat = env.render(sidebar, { btwSessionId: "origin", renderFactorySlot: factory }); verify(env.render(seat.type, seat.props), true);
	switchHeaderSidebarToOverlay(env);
	button(env.render(overlay), "页面").props.onClick();
	const panel = env.registrations.get("dsh-btw-global");
	seat = env.render(panel); verify(env.render(seat.type, seat.props), false);
	seat = env.render(panel, { renderFactorySlot: missingFactory }); verify(env.render(seat.type, seat.props), false);
	seat = env.render(panel, { renderFactorySlot: factory }); verify(env.render(seat.type, seat.props), true);
	assert.equal(calls.length, 4);
	for (const call of calls) {
		assert.equal(call.name, "conversation.chat.reasoning.content");
		assert.deepEqual(Object.keys(call.input).sort(), ["labels", "running", "text"]);
		assert.equal(call.input.text, "child committed thought"); assert.equal(call.input.running, false);
		assert.ok(call.input.labels.code && call.input.labels.footnotes); assert.ok(call.options.fallback);
		assert.doesNotMatch(JSON.stringify(call.input), /origin|side-child|assistant answer/);
	}
	env.cleanup();
});

const dockPanel = tree => all(tree, n => n.props.className === "dsh-btw-card dsh-btw-dock-panel")[0];
async function sideQuestionFixture(options = {}) {
	const timers = manualTimers();
	const env = await setup({ askContextMode: "none", ...options.config }, { effects: true, ...timers, ...options,
		rpc: options.rpc || (method => ({ ok: true, value: method === "models" ? { providers: [{ id: "p", models: [{ id: "m" }] }] } : method === "open" ? { sessionId: "side-child", cwd: "/project" } : method === "send" ? { output: options.answer || "assistant answer" } : method === "poll" ? { text: "", lastSeq: 0 } : {} })) });
	const ask = env.registrations.get("btw-ask"), props = { ...projectProps(), ...options.props };
	const submit = async (question = "user question") => {
		await tick(); // The optional model catalog must settle before a custom-model send.
		env.render(env.registrations.get("btw-trigger")).props.onClick();
		let tree = env.render(ask, props); all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: question } });
		tree = env.render(ask, props); button(tree, "提问").props.onClick(); await tick(); timers.poll(); await tick();
		return env.render(ask, props);
	};
	return { ...env, ask, props, timers, submit };
}

test("fixed composer-top panel scrolls its shared transcript internally and resizes within column/viewport without touching the main draft", async () => {
	const storage = geometryStorage(), mainWrites = [], answer = "assistant paragraph\n".repeat(4000);
	const env = await sideQuestionFixture({ storage, width: 1200, height: 1000, answer,
		props: { inputActions: { setDraft: text => mainWrites.push(text), captureInsertion() {}, insertText() { assert.fail("resizing cannot insert into the main draft"); } } } });
	let tree = await env.submit();
	assert.deepEqual(all(tree, isMessageContent).map(n => n.children[0]), ["user question", answer]);
	const stage = all(tree, n => n.props.className === "dsh-btw-dock-stage")[0];
	stage.props.ref.current = { clientWidth: 600, getBoundingClientRect: () => ({ width: 600, bottom: 600 }) };
	env.setViewport(1200, 1000); tree = env.render(env.ask, env.props);
	assert.equal(dockPanel(tree).props.style.width, "100%"); assert.equal(dockPanel(tree).props.style.height, 200);
	assert.deepEqual(all(tree, n => n.props["data-edge"]).map(n => n.props["data-edge"]), ["n"], "only the north edge can resize the fixed panel");
	const transcript = all(tree, n => n.props["aria-label"] === "侧问消息")[0];
	assert.equal(transcript.props.tabIndex, 0, "scrollable answer is keyboard reachable");
	const card = dockPanel(tree), transcriptIndex = card.children.indexOf(transcript);
	assert.ok(card.children.slice(transcriptIndex + 1).some(n => n?.props?.["aria-label"] === "展开输入框"), "collapsed editor toggle stays below the scrolling body");
	pointerResize(tree, "n", 100, -80); tree = env.render(env.ask, env.props);
	assert.equal(dockPanel(tree).props.style.width, "100%"); assert.equal(dockPanel(tree).props.style.marginLeft, undefined); assert.equal(dockPanel(tree).props.style.height, 280);
	resizeKey(tree, "n", "ArrowDown", true); tree = env.render(env.ask, env.props); assert.equal(dockPanel(tree).props.style.height, 240);
	resizeKey(tree, "n", "ArrowUp", true, 100); tree = env.render(env.ask, env.props); assert.equal(dockPanel(tree).props.style.height, 500);
	env.setViewport(400, 360); tree = env.render(env.ask, env.props);
	assert.equal(dockPanel(tree).props.style.width, "100%"); assert.equal(dockPanel(tree).props.style.marginLeft, undefined); assert.equal(dockPanel(tree).props.style.height, 180);
	assert.deepEqual(all(tree, isMessageContent).map(n => n.children[0]), ["user question", answer]);
	assert.deepEqual(mainWrites, []); assert.equal(env.render(env.registrations.get("btw")), null);
	assert.equal(all(tree, n => n.props.type === "range").length, 0);
	for (const [key, json] of storage.writes) {
		assert.equal(key, "dsh-btw/geometry/v1/%2Fproject/dock-v3");
		assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ["height"]);
		assert.ok(Object.values(JSON.parse(json)).every(Number.isFinite)); assert.doesNotMatch(json, /paragraph|question|origin|job/);
	}
	const css = env.styles.join("");
	assert.match(css, /dock-panel>\.dsh-btw-answer\{flex:1;min-height:0;margin-right:8px;overscroll-behavior:contain/);
	assert.match(css, /dock-panel>\.dsh-btw-head,\.dsh-btw-dock-panel>\.dsh-btw-row\{flex:none/);
	assert.match(css, /\.dsh-btw-answer\{[^}]*overflow-y:auto;scrollbar-width:thin/);
	assert.match(css, /\.dsh-btw-q\{display:block;box-sizing:border-box;width:100%/);
	assert.doesNotMatch(css, /\.dsh-btw-dock-panel>\.dsh-btw-row\{[^}]*overflow-y:auto/, "the editor container must not introduce a second scrollbar");
	assert.match(css, /\.dsh-btw-mbody\{[^}]*overflow-y:auto;scrollbar-width:thin/);
	assert.match(css, /\.dsh-btw-veil \.dsh-btw-mbody\{margin-right:8px/); env.cleanup();
});

test("fixed-panel geometry restores numeric size only, observes host column changes and honors memory opt-out", async () => {
	for (const remember of [true, false]) {
		const storage = geometryStorage(); storage.values.set("dsh-btw/geometry/v1/%2Fproject/dock-v3", '{"width":420,"height":270,"x":30,"y":0,"draft":"SECRET","sessionId":"source"}');
		let observe, disconnected = 0, column = 720;
		const env = await sideQuestionFixture({ storage, commitRef: node => node.props.className === "dsh-btw-dock-stage" ? { get clientWidth() { return column; }, getBoundingClientRect: () => ({ width: column, bottom: 700 }) } : null, config: { tempRememberPosition: remember }, ResizeObserver: class {
			constructor(callback) { observe = callback; } observe() {} disconnect() { disconnected++; }
		} });
		env.render(env.registrations.get("btw-trigger")).props.onClick();
		let tree = env.render(env.ask, env.props), stage = all(tree, n => n.props.className === "dsh-btw-dock-stage")[0];
		assert.equal(dockPanel(tree).props.style.width, "100%"); assert.equal(dockPanel(tree).props.style.height, remember ? 270 : 200);
		assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "");
		column = 500; stage.props.ref.current = { get clientWidth() { return column; }, getBoundingClientRect: () => ({ width: column, bottom: 700 }) };
		button(tree, "最小化 btw").props.onClick(); env.render(env.ask, env.props);
		env.render(env.registrations.get("btw-trigger")).props.onClick(); tree = env.render(env.ask, env.props);
		assert.equal(typeof observe, "function"); column = 300; observe(); tree = env.render(env.ask, env.props);
		assert.equal(dockPanel(tree).props.style.width, "100%"); assert.equal(dockPanel(tree).props.style.marginLeft, undefined);
		assert.deepEqual(all(tree, n => n.props["data-edge"]).map(n => n.props["data-edge"]), ["n"]);
		resizeKey(tree, "n", "ArrowUp"); tree = env.render(env.ask, env.props); assert.equal(dockPanel(tree).props.style.width, "100%");
		assert.equal(storage.writes.length > 0, remember);
		if (remember) assert.doesNotMatch(storage.writes.at(-1)[1], /SECRET|draft|sessionId/);
		env.unmount(env.ask); assert.ok(disconnected > 0); env.cleanup();
	}
});

function PublicMarkdown() { throw new Error("the host renders MarkdownText"); }
test("public MarkdownText function and memo use the native safe text contract on fixed, float, sidebar and fullscreen views", async () => {
	for (const MarkdownText of [PublicMarkdown, { $$typeof: Symbol.for("react.memo"), type: PublicMarkdown }]) {
		const answer = "# Heading\n\n- **bold**\n\n```js\nconst x = 1;\n```";
		const env = await sideQuestionFixture({ answer, done: false, primitives: { MarkdownText },
			layout: { selectPanel() {} }, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {}, isExpanded: () => false } });
		let tree = await env.submit("<img onerror=alert(1)>");
		const verify = (view, streaming) => {
			const native = all(view, n => n.type === MarkdownText);
			assert.equal(native.length, 1); assert.equal(native[0].props.text, answer); assert.equal(native[0].props.streaming, streaming);
			assert.deepEqual(Object.keys(native[0].props).sort(), ["labels", "streaming", "text"]);
			assert.deepEqual(JSON.parse(JSON.stringify(native[0].props.labels)), { code: { copyLabel: "复制", copiedLabel: "已复制", toolbarLabels: { codeLabel: "代码", wrapLabel: "自动换行", unwrapLabel: "不换行" } }, footnotes: "脚注" });
			assert.equal(all(view, n => n.props.className === "dsh-btw-bubble")[0].children[0], "<img onerror=alert(1)>");
			assert.equal(all(view, n => n.props.dangerouslySetInnerHTML || n.type === "img").length, 0);
			assert.equal(all(view, n => n.props.className === "dsh-btw-prose").length, 1);
		};
		verify(tree, false);
		button(tree, "展开输入框").props.onClick(); tree = env.render(env.ask, env.props);
		all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "unsent followup" } });
		tree = env.render(env.ask, env.props); button(tree, "浮动小窗").props.onClick(); assert.equal(env.render(env.ask, env.props), null);
		const overlay = env.registrations.get("btw"); tree = env.render(overlay); verify(tree, false);
		assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "unsent followup");
		modeControl(tree, "sidebar").props.onClick(); tree = env.render(overlay, { inline: true }); verify(tree, false);
		switchHeaderSidebarToOverlay(env); tree = env.render(overlay); verify(tree, false);
		modeControl(tree, "global").props.onClick(); tree = env.render(overlay, { standalone: true }); verify(tree, false);
		assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "unsent followup");
		assert.equal(env.calls.filter(c => c[1] === "open").length, 1); assert.equal(env.calls.filter(c => c[1] === "send").length, 1);
		const css = env.styles.join(""); assert.match(css, /\.dsh-btw-prose\{[^}]*font-size:14px;line-height:24px/); assert.doesNotMatch(css, /\.dsh-btw-msg\.agent \.dsh-btw-bubble/);
		assert.deepEqual(env.required, ["react", "@deepseek-ai/dsh-client-ui-primitives"]); env.cleanup();
	}
});

test("missing/invalid MarkdownText safely falls back to the same unboxed plain assistant text", async () => {
	for (const primitives of [undefined, {}, { MarkdownText: {} }, { MarkdownText: { $$typeof: "not-react" } }]) {
		const answer = "**literal** <script>alert(1)</script>\nraw & text";
		const env = await sideQuestionFixture({ primitives, answer }); let tree = await env.submit();
		const prose = all(tree, n => n.props.className === "dsh-btw-prose dsh-btw-plain")[0];
		assert.equal(prose.children[0], answer); assert.equal(all(tree, n => n.props.dangerouslySetInnerHTML || n.type === "script").length, 0);
		assert.deepEqual(all(tree, isMessageContent).map(n => n.children[0]), ["user question", answer]);
		button(tree, "浮动小窗").props.onClick(); tree = env.render(env.registrations.get("btw"));
		assert.deepEqual(chatText(tree), ["user question", answer]); assert.equal(all(tree, n => n.props.className === "dsh-btw-prose dsh-btw-plain").length, 1); env.cleanup();
	}
});

test("fixed to sidebar carries completed question, answer, model/context and unsent draft without an automatic send", async () => {
	const env = await sideQuestionFixture({ config: { askModelMode: "custom", askProvider: "p", askModel: "m", askContextMode: "recent" },
		sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {}, isExpanded: () => false } });
	let tree = await env.submit(); button(tree, "展开输入框").props.onClick(); tree = env.render(env.ask, env.props);
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "next unsent question" } });
	tree = env.render(env.ask, env.props); button(tree, "停靠侧边栏").props.onClick(); assert.equal(env.render(env.ask, env.props), null);
	const overlay = env.registrations.get("btw"); tree = env.render(overlay, { inline: true });
	assert.deepEqual(chatText(tree), ["user question", "assistant answer"]);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "next unsent question");
	assert.equal(all(tree, n => n.type?.name === "ModelSelect")[0].props.value, '["p","m"]');
	assert.equal(all(tree, n => n.props["aria-label"] === "临时聊天上下文")[0].props.value, "recent");
	assert.equal(env.calls.filter(c => c[1] === "open").length, 1); assert.equal(env.calls.filter(c => c[1] === "send").length, 1); env.cleanup();
});

test("Escape closes the btw last used even when focus sits in the host composer", async () => {
	const env = await setup({}, { effects: true }); await tick();
	const overlay = env.registrations.get("btw"); env.render(env.registrations.get("btw-temp"), { sessionId: "origin" }).props.onClick();
	button(typeTemp(env, overlay, "first draft"), "新建临时聊天").props.onClick(); typeTemp(env, overlay, "second draft");
	let tree = focusChat(env, overlay, "btw-1");
	const second = escapeTarget(tree, "btw-2"), outside = { closest: () => null };
	// Focus stays in the host composer; Esc still dismisses the btw used last.
	env.setActiveElement(outside);
	env.dispatch("keydown", { key: "Escape", target: outside, composedPath: () => [] }); await tick();
	tree = env.render(overlay);
	assert.equal(all(tree, n => n.props["data-chat-id"]).length, 1, "exactly one btw leaves");
	assert.ok(chatWindow(tree, "btw-2"), "the other chat survives");
	assert.deepEqual(env.calls.filter(c => c[1] === "close"), [], "a draft-only chat has no host record to clean");
	// A native menu consuming Escape keeps it for itself.
	env.setActiveElement(second);
	env.dispatch("keydown", { key: "Escape", target: { closest: sel => sel.includes("role=menu") ? {} : null }, composedPath: () => [] });
	assert.ok(chatWindow(env.render(overlay), "btw-2"), "menu Escape never ends the chat");
	env.dispatch("keydown", { key: "Escape", target: second, composedPath: () => [second] }); await tick();
	assert.equal(env.render(overlay), null, "the last chat leaves on its own Escape");
	env.cleanup();
});

test("warm source btw opens the existing dock directly without a loading paint or another child", async () => {
	const env = await setup({}, { effects: false }), ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	env.render(ask, props);
	env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick();
	let tree = env.render(ask, props);
	assert.equal(all(tree, n => n.props.className?.includes("dsh-btw-dock-panel")).length, 1, "ready UI opens in the event, not a later source effect");
	assert.equal(all(tree, n => n.props.className === "dsh-btw-status").length, 0);
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "keep this chat draft" } });
	button(env.render(ask, props), "最小化 btw").props.onClick();
	env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick();
	tree = env.render(ask, props);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "keep this chat draft");
	assert.equal(all(tree, n => n.props.className === "dsh-btw-status").length, 0);
	assert.equal(env.calls.some(c => ["open", "send"].includes(c[1])), false);
	env.cleanup();
});

test("warm opening never uses a stale source snapshot or leaves its older intent armed", async () => {
	const env = await setup({}, { effects: false }), ask = env.registrations.get("btw-ask");
	const a = chatProps("source-a"), b = chatProps("source-b");
	env.render(ask, b);
	env.render(env.registrations.get("btw-trigger"), { sessionId: "source-a" }).props.onClick();
	assert.equal(env.render(ask, b), null, "a stale source click must not open the current source");
	env.render(env.registrations.get("btw-trigger"), { sessionId: "source-b" }).props.onClick();
	assert.equal(all(env.render(ask, b), n => n.props.className?.includes("dsh-btw-dock-panel")).length, 1);
	assert.equal(env.render(ask, a), null, "a superseded intent must not revive when returning to that source");
	assert.equal(env.calls.some(c => ["open", "send"].includes(c[1])), false); env.cleanup();
});

test("pending fixed dock reserves the real frame before feature CSS and remains cancelable", async () => {
	const gate = deferred(), env = await setup({}, { lazy: true, beforeChunk: () => gate.promise });
	const ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	env.render(ask, props); env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick();
	const tree = env.render(ask, props);
	assert.equal(tree.props.className, "dsh-btw-dock");
	assert.equal(all(tree, n => n.props.className === "dsh-btw-card dsh-btw-dock-loading").length, 1);
	assert.match(env.styles[0], /\.dsh-btw-dock-loading\{height:min\(200px,50dvh\)/);
	assert.match(env.styles[0], /\.dsh-btw-dock\{[^}]*--dsh-composer-side-clearance/);
	assert.match(env.styles[0], /\.dsh-btw-card\{[^}]*--dsw-specific-input-major/);
	all(tree, n => n.props["aria-label"] === "取消加载 btw")[0].props.onClick();
	assert.equal(env.render(ask, props), null);
	gate.resolve(); await tick();
	assert.equal(env.render(ask, props), null);
	assert.equal(env.calls.some(c => ["open", "send"].includes(c[1])), false); env.cleanup();
});

test("canceling a cold dock keeps a different source's queued slash draft", async () => {
	const gate = deferred(), env = await setup({}, { lazy: true, beforeChunk: () => gate.promise });
	const ask = env.registrations.get("btw-ask");
	const source = (id, text) => {
		const input = { draft: "/btw " + text };
		return { ...chatProps(id), useInput: select => select(input), inputActions: { setDraft(value) { input.draft = value; } } };
	};
	const a = source("source-a", "question A"), b = source("source-b", "question B");
	env.render(ask, a, "source-a"); env.render(ask, a, "source-a");
	env.render(ask, b, "source-b"); const loadingB = env.render(ask, b, "source-b");
	all(loadingB, n => n.props["aria-label"] === "取消加载 btw")[0].props.onClick();
	gate.resolve(); await tick();
	const treeA = env.render(ask, a, "source-a");
	assert.equal(all(treeA, n => n.type === "textarea")[0].props.value, "question A");
	assert.equal(env.render(ask, b, "source-b"), null);
	assert.equal(env.calls.some(c => ["open", "send"].includes(c[1])), false); env.cleanup();
});

test("cold dock placeholder respects explicitly remembered project dimensions", async () => {
	for (const remember of [true, false]) {
		const gate = deferred(), storage = geometryStorage();
		storage.values.set("dsh-btw/geometry/v1/%2Fproject/dock-v3", '{"width":420,"height":270,"x":30,"y":0}');
		const env = await setup({ tempRememberPosition: remember }, { lazy: true, storage, beforeChunk: () => gate.promise });
		const ask = env.registrations.get("btw-ask"), props = { ...chatProps("origin"), ...projectProps() };
		env.render(ask, props); env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick();
		const loading = all(env.render(ask, props), n => n.props.className === "dsh-btw-card dsh-btw-dock-loading")[0];
		if (remember) {
			assert.ok(loading.props.style.width === undefined || loading.props.style.width === "100%");
			assert.equal(loading.props.style.height, "min(270px, 50dvh)");
			assert.equal(loading.props.style.marginLeft, undefined);
		} else assert.equal(loading.props.style, undefined);
		gate.resolve(); await tick(); env.cleanup();
	}
});

test("cold dock ignores old v2 dimensions and reserves the default frame", async () => {
	const gate = deferred(), storage = geometryStorage();
	storage.values.set("dsh-btw/geometry/v1/%2Fproject/dock-v2", '{"width":420,"height":370,"x":30}');
	const env = await setup({ tempRememberPosition: true }, { lazy: true, storage, beforeChunk: () => gate.promise });
	const ask = env.registrations.get("btw-ask"), props = projectProps();
	env.render(ask, props); env.render(env.registrations.get("btw-trigger"), props).props.onClick();
	const loading = all(env.render(ask, props), n => n.props.className === "dsh-btw-card dsh-btw-dock-loading")[0];
	assert.equal(loading.props.style, undefined);
	assert.match(env.styles[0], /\.dsh-btw-dock-loading\{height:min\(200px,50dvh\)/);
	gate.resolve(); await tick(); env.cleanup();
});

test("a dock-only cold load never renders a duplicate global overlay loader", async () => {
	const gate = deferred(), env = await setup({}, { lazy: true, beforeChunk: () => gate.promise });
	const ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	env.render(ask, props); env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick();
	env.render(ask, props);
	assert.equal(env.render(env.registrations.get("btw")), null, "dock loading belongs to the composer seat, not shell.overlay");
	gate.resolve(); await tick(); env.cleanup();
});

test("canceling a concurrently loading float leaves the pending dock request intact", async () => {
	const gate = deferred(), env = await setup({}, { lazy: true, beforeChunk: () => gate.promise });
	const ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	env.render(ask, props); env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick();
	env.render(ask, props);
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	const overlay = env.render(env.registrations.get("btw"));
	all(overlay, n => n.props["aria-label"] === "取消加载 btw")[0].props.onClick();
	assert.ok(all(env.render(ask, props), n => n.props.className === "dsh-btw-card dsh-btw-dock-loading").length);
	gate.resolve(); await tick();
	assert.equal(all(env.render(ask, props), n => n.props.className?.includes("dsh-btw-dock-panel")).length, 1);
	assert.equal(env.render(env.registrations.get("btw")), null); env.cleanup();
});

test("activation and hidden source bridge fetch no chunks or catalog; concurrent first-use shares shipped modules", async () => {
	const gate = deferred(), env = await setup({}, { lazy: true, beforeChunk: () => gate.promise });
	env.render(env.registrations.get("btw-ask"), chatProps("origin"));
	assert.deepEqual(env.requests, []); assert.deepEqual(env.calls, []); assert.deepEqual(env.required, ["react"]);
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	const settings = env.registrations.get("dsh-btw#btw")({}); env.render(settings.type);
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	await tick();
	assert.equal(env.requests.length, 4); assert.equal(new Set(env.requests).size, 4);
	assert.deepEqual(env.calls, [], "imports must not open/send or fetch models before ready");
	gate.resolve(); await tick();
	const tree = env.render(env.registrations.get("btw"));
	assert.equal(all(tree, n => n.props["data-chat-id"]).length, 1, "repeated entry clicks retain one local intent");
	assert.deepEqual(env.calls.map(c => c[1]), ["models"]); env.cleanup();
});

test("first slash question survives a failed sibling fetch, safe retry and concurrent temporary entry", async () => {
	let fail = true;
	const env = await setup({}, { lazy: true, effects: true, beforeChunk: file => { if (fail && file === "client.views.js") throw new Error("chunk offline"); } });
	const input = { draft: "/btw carried question" }, writes = [];
	const props = { ...chatProps("origin"), useInput: select => select(input), inputActions: { setDraft(value) { writes.push(value); input.draft = value; } } };
	const ask = env.registrations.get("btw-ask");
	env.render(ask, props); env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	await tick();
	let tree = env.render(ask, props);
	assert.match(JSON.stringify(tree), /chunk offline/); assert.deepEqual(writes, [""]); assert.deepEqual(env.calls, []);
	fail = false;
	all(tree, n => n.type === "button" && n.children.includes("重试"))[0].props.onClick();
	await tick(); tree = env.render(ask, props);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "carried question");
	assert.equal(all(env.render(env.registrations.get("btw")), n => n.props["data-chat-id"]).length, 1);
	assert.deepEqual(env.calls.map(c => c[1]), ["models"], "retry does not submit a question or create an agent");
	env.cleanup();
});

test("cancel and unload fence late first-use completion without resurrecting UI or issuing RPC", async () => {
	for (const action of ["cancel", "unload"]) {
		const gate = deferred(), env = await setup({}, { lazy: true, beforeChunk: () => gate.promise });
		const overlay = env.registrations.get("btw");
		env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick(); await tick();
		if (action === "cancel") all(env.render(overlay), n => n.props["aria-label"] === "取消加载 btw")[0].props.onClick();
		else env.cleanup();
		gate.resolve(); await tick();
		assert.equal(env.render(overlay), null);
		assert.equal(env.calls.some(c => ["open", "send", "ask"].includes(c[1])), false);
		if (action === "unload") { assert.deepEqual(env.calls, []); assert.equal(env.styles.length, 1); }
		env.cleanup();
	}
});

test("unload also fences a pending optional catalog reply", async () => {
	const models = deferred(), env = await setup({}, { rpc: () => models.promise });
	env.cleanup();
	models.resolve({ ok: true, value: { providers: [{ id: "late", models: [{ id: "m" }] }] } }); await tick();
	assert.equal(env.render(env.registrations.get("btw")), null);
	assert.equal(env.calls.length, 1);
});

test("recent snapshot retains completed message tails, tool-only text and a final 48k suffix without private state", async () => {
	const text = (value) => ({ type: "text", text: value });
	for (const nodes of [
		[{ kind: "user", content: [text("x".repeat(1601) + "needle-user")] }, { kind: "assistant", blocks: [{ kind: "text", text: "x".repeat(1601) + "needle-assistant" }] }],
		[{ kind: "tool-result", content: [text("needle-tool"), { type: "image", data: "BINARY_SECRET" }], subCalls: [{ kind: "tool-result", content: [text("needle-subtool")] }, { kind: "tool-running", content: [text("RUNNING_SECRET")] }] }],
		[{ kind: "user", content: [text("x".repeat(60_000) + "needle-tail")] }],
		Array.from({ length: 25 }, (_, i) => ({ kind: "user", content: [text(i === 0 ? "needle-older-short-message" : "short message " + i)] })),
	]) {
		const env = await setup({ askContextMode: "on-demand", tempContextMode: "on-demand" }, { rpc: method => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "probe-child" } : method === "send" ? { output: "ok" } : method === "poll" ? { text: "", lastSeq: 0 } : {} }) });
		env.render(env.registrations.get("btw-trigger")).props.onClick();
		const component = env.registrations.get("btw-ask"), props = { ...chatProps("origin", nodes), useSession: select => select({ removed: false, text: "LIFECYCLE_SECRET" }), useChat: select => select({ legacy: { nodes, partial: { text: "PARTIAL_SECRET" }, runningCalls: [{ text: "RUNNING_SECRET" }] } }) };
		let tree = env.render(component, props); all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "search" } });
		tree = env.render(component, props); button(tree, "提问").props.onClick(); await tick();
		const snapshot = env.calls.find(c => c[1] === "open")[2].transcript;
		assert.ok(snapshot.length <= 48_000); assert.match(snapshot, /needle-/); assert.doesNotMatch(snapshot, /BINARY_SECRET|RUNNING_SECRET|PARTIAL_SECRET|LIFECYCLE_SECRET/);
		if (nodes[0].kind === "tool-result") assert.equal(snapshot, "Tool: needle-tool\n\nTool: needle-subtool");
		else if (nodes[0].content[0].text.length > 48_000) assert.equal(snapshot, ("User: " + nodes[0].content[0].text).slice(-48_000));
		else if (nodes.length > 14) assert.match(snapshot, /needle-older-short-message/);
		else { assert.match(snapshot, /needle-user/); assert.match(snapshot, /needle-assistant/); }
		env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		const overlay = env.registrations.get("btw"); button(typeTemp(env, overlay, "search from child"), "发送").props.onClick(); await tick(); await tick();
		assert.equal(env.calls.find(c => c[1] === "open")[2].transcript, snapshot);
		assert.ok(env.calls.every(c => ["models", "ask", "open", "send", "poll"].includes(c[1])), "recent search never fetches full history");
		env.cleanup();
	}
});

test("optional catalog retries deduplicate concurrent clicks and retain retry after failure", async () => {
	let count = 0; const response = deferred();
	const env = await setup({}, { rpc: () => ++count === 1 ? { ok: false, error: { message: "catalog offline" } } : response.promise });
	const settings = env.registrations.get("dsh-btw#btw")({}).type;
	const model = modelTree(env, env.render(settings)), retry = all(model, n => n.type === "button" && n.children.includes("重试"))[0];
	retry.props.onClick(); retry.props.onClick(); assert.equal(count, 2);
	response.resolve({ ok: true, value: { providers: [] } }); await tick(); env.cleanup();
});

function publicSidebar() {
	let mounted = "origin", activeId = null, expanded = false, closeHandler, failClose = false;
	const tabs = new Map(), mountedListeners = new Set(), tabListeners = new Set(), closed = [];
	const rows = () => [...tabs.values()];
	const notify = () => { for (const fn of tabListeners) fn(); };
	const right = {
		mounted: { getSnapshot: () => mounted, subscribe: fn => { mountedListeners.add(fn); return () => mountedListeners.delete(fn); } },
		openTabs: { getSnapshot: rows, subscribe: fn => { tabListeners.add(fn); return () => tabListeners.delete(fn); } },
		active: () => { const tab = tabs.get(activeId); return tab?.sessionId === mounted ? { id: tab.tabId, kind: tab.kind } : undefined; },
		openTab() {
			let tab = rows().find(tab => tab.sessionId === mounted && tab.kind === "btw-temp");
			if (!tab) { tab = { sessionId: mounted, tabId: "tab-" + nextId++, kind: "btw-temp" }; tabs.set(tab.tabId, tab); }
			activeId = tab.tabId; expanded = true; notify();
		},
		close(id) {
			const tab = tabs.get(id); assert.equal(tab?.sessionId, mounted, "public close must not target another source");
			if (failClose) throw new Error("sidebar close offline");
			closeHandler?.(mounted, { id, kind: tab.kind });
			tabs.delete(id); closed.push({ ...tab });
			expanded = rows().some(tab => tab.sessionId === mounted);
			if (activeId === id) activeId = rows().find(tab => tab.sessionId === mounted)?.tabId || null;
			notify();
		},
		registerCloseHandler(_kind, handler) { closeHandler = handler; return () => { closeHandler = null; }; },
		isExpanded: () => expanded, toggleExpanded: () => { expanded = !expanded; },
	};
	let nextId = 1;
	return { right, rows, closed, expanded: () => expanded,
		switchSource(source) { mounted = source; activeId = rows().find(tab => tab.sessionId === source)?.tabId || null; for (const fn of mountedListeners) fn(); },
		seed(source, id, kind = "btw-temp") { tabs.set(id, { sessionId: source, tabId: id, kind }); activeId = id; expanded = true; },
		fail(value) { failClose = value; },
	};
}

test("header sidebar waits once for its source and respects a small-window switch", async () => {
	for (const cancel of [false, true]) {
		let mounted, opened = 0; const listeners = new Set();
		const env = await setup({}, { sidebar: { mounted: { getSnapshot: () => mounted, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }, openTab() { opened++; } } });
		await tick(); const overlay = env.registrations.get("btw");
		env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		let tree = env.render(overlay); assert.ok(tree, "pending mount has a safe small window");
		if (cancel) modeControl(tree, "overlay").props.onClick();
		mounted = "origin"; for (const fn of [...listeners]) fn();
		assert.equal(opened, cancel ? 0 : 1);
		assert.ok(env.render(overlay, cancel ? {} : { inline: true }));
		env.cleanup();
	}
});

test("sidebar corrects a default active tab when the new btw tab is only in inventory, unless the user acts", async () => {
	for (const userSwitch of [false, true]) {
		const surface = publicSidebar(), originalOpen = surface.right.openTab;
		let active = { id: "guide", kind: "guide" }, focused = 0;
		surface.right.openTab = (...args) => { originalOpen(...args); active = { id: "guide", kind: "guide" }; };
		surface.right.active = () => active;
		surface.right.focus = id => { focused++; active = { id, kind: "btw-temp" }; };
		const env = await setup({}, { sidebar: surface.right }); await tick();
		env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		assert.equal(surface.rows().filter(tab => tab.kind === "btw-temp").length, 1);
		if (userSwitch) env.dispatch("pointerdown", {});
		await new Promise(resolve => setTimeout(resolve, 120));
		assert.equal(focused, userSwitch ? 0 : 1);
		assert.equal(surface.closed.length, 0, "must not close the default tab");
		env.cleanup();
	}
});

test("sidebar leaves fullscreen to the host, omits minimize, and X ends the child", async () => {
	const surface = publicSidebar();
	const env = await setup({}, { sidebar: surface.right, layout: { selectPanel() {} } });
	const overlay = env.registrations.get("btw"), inline = { inline: true };
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	button(typeTemp(env, overlay, "owned question", inline), "发送").props.onClick(); await tick(); await tick();
	const tree = env.render(overlay, inline);
	assert.equal(all(tree, n => n.props["data-btw-mode"]).length, 0);
	assert.equal(all(tree, n => n.props["aria-label"] === "最小化 btw").length, 0);
	button(tree, "结束临时聊天").props.onClick(); await tick();
	assert.deepEqual(env.calls.filter(c => c[1] === "close").map(c => c[2].sessionId), ["fixture-child"]);
	assert.equal(surface.rows().length, 0);
	env.cleanup();
});

test("ending an active sidebar chat hides its column without removing another tab", async () => {
	for (const activeOwn of [true, false]) {
		const surface = publicSidebar(), hidden = [];
		surface.right.hide = id => hidden.push(id);
		const env = await setup({}, { sidebar: surface.right });
		env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		const tree = env.render(env.registrations.get("btw"), { inline: true });
		if (!activeOwn) surface.right.active = () => ({ id: "guide", kind: "guide" });
		button(tree, "结束临时聊天").props.onClick(); await tick();
		assert.equal(hidden.length, activeOwn ? 1 : 0);
		if (activeOwn) assert.equal(hidden[0], "tab-1");
		env.cleanup();
	}
});

test("mode changes retire only owned sidebar pages, keep the child, and explicit end retires its tab without recursive close", async () => {
	const surface = publicSidebar(), end = deferred();
	const env = await setup({ tempPresentation: "sidebar" }, { effects: true, sidebar: surface.right, layout: { selectPanel() {} }, rpc: method => method === "close" ? end.promise : ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "owned-child" } : method === "send" ? { output: "answer" } : { text: "", lastSeq: 0 } }) });
	const overlay = env.registrations.get("btw"), inline = { inline: true };
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	button(typeTemp(env, overlay, "first question", inline), "发送").props.onClick(); await tick(); await tick();
	assert.equal(surface.rows().length, 1);
	switchHeaderSidebarToOverlay(env);
	assert.equal(surface.rows().length, 0); assert.equal(surface.expanded(), false);
	assert.deepEqual(chatText(env.render(overlay)), ["first question", "answer"]);
	assert.equal(env.calls.some(c => c[1] === "close"), false, "programmatic tab retirement cannot close the continuing child");
	modeControl(env.render(overlay), "sidebar").props.onClick();
	button(env.render(overlay, inline), "结束临时聊天").props.onClick();
	assert.equal(surface.rows().length, 0, "the tab leaves immediately; cleanup continues in the background");
	assert.equal(surface.expanded(), false, "the emptied column collapses right away");
	end.resolve({ ok: true, value: {} }); await tick();
	assert.equal(surface.rows().length, 0); assert.equal(surface.expanded(), false);
	assert.equal(env.render(env.registrations.get("dsh-btw/temp"), { btwSessionId: "origin" }), null, "no restore component or hidden resurrection");
	assert.equal(env.calls.filter(c => c[1] === "open").length, 1);
	assert.equal(env.calls.filter(c => c[1] === "close").length, 1);
	env.cleanup();
});

test("failed internal sidebar close remains retryable; another source/tab never closes by stale callback", async () => {
	const surface = publicSidebar();
	const env = await setup({ tempPresentation: "sidebar" }, { effects: true, sidebar: surface.right });
	const overlay = env.registrations.get("btw"), inline = { inline: true };
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	surface.fail(true); button(env.render(overlay, inline), "结束临时聊天").props.onClick(); await tick();
	assert.match(JSON.stringify(env.render(overlay, inline)), /sidebar close offline/);
	assert.equal(surface.rows().length, 1);
	surface.fail(false); button(env.render(overlay, inline), "结束临时聊天").props.onClick(); await tick();
	assert.equal(surface.rows().length, 0);
	env.cleanup();

	const moved = publicSidebar(), gate = deferred();
	const next = await setup({ tempPresentation: "sidebar" }, { effects: true, sidebar: moved.right, rpc: method => method === "close" ? gate.promise : ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "late-close" } : method === "send" ? { output: "answer" } : { text: "", lastSeq: 0 } }) });
	const view = next.registrations.get("btw");
	next.render(next.registrations.get("btw-temp"), projectProps()).props.onClick();
	button(typeTemp(next, view, "hello", inline), "发送").props.onClick(); await tick(); await tick();
	button(next.render(view, inline), "结束临时聊天").props.onClick();
	moved.seed("other", "other-editor", "editor"); moved.switchSource("other");
	gate.resolve({ ok: true, value: {} }); await tick();
	assert.ok(moved.rows().some(tab => tab.tabId === "other-editor"));
	assert.deepEqual(moved.closed.map(tab => tab.kind), ["btw-temp"], "ending closes only its own tab, in the same tick");
	moved.switchSource("origin");
	assert.deepEqual(moved.closed.map(tab => tab.kind), ["btw-temp"]);
	assert.ok(moved.rows().some(tab => tab.tabId === "other-editor"));
	next.cleanup();
});

test("restored empty sidebar records disappear; ordinary body unmount/collapse/session switch preserves a live child", async () => {
	const surface = publicSidebar(); surface.seed("origin", "stale-btw");
	const env = await setup({ tempPresentation: "sidebar" }, { effects: true, sidebar: surface.right });
	assert.equal(surface.rows().length, 0, "layout persistence must not restore hidden chat state");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	const body = env.registrations.get("dsh-btw/temp"), overlay = env.registrations.get("btw");
	env.render(body, { btwSessionId: "origin" }); env.unmount(body);
	surface.right.toggleExpanded(); surface.switchSource("other"); surface.switchSource("origin");
	assert.equal(surface.rows().length, 1);

	assert.equal(env.calls.some(c => ["open", "close"].includes(c[1])), false);
	assert.ok(env.render(overlay, { inline: true }));
	env.cleanup();
});

test("public Button/Tooltip/window icons share guidance across fixed and shared views, with a distinct small-window fallback", async () => {
	function Button() {} function Tooltip() {} function Fullscreen() {} function PanelLeft() {} function PinFill() {} function PinOutline() {}
	const primitives = { Button, Tooltip, IconFullscreenOutlineRegular: Fullscreen, IconPanelLeftOutlineRegular: PanelLeft, IconPinFillRegular: PinFill, IconPinOutlineRegular: PinOutline };
	const env = await setup({}, { primitives, layout: { selectPanel() {} } });
	env.render(env.registrations.get("btw-trigger")).props.onClick();
	const askTree = env.render(env.registrations.get("btw-ask"), chatProps("origin"));
	assert.equal(all(askTree, n => n.type === Button && n.props["data-btw-mode"]).length, 3);
	assert.equal(all(askTree, n => n.type === "select" && n.props["aria-label"] === "显示模式").length, 0);
	const mode = name => all(askTree, n => n.props["data-btw-mode"] === name)[0];
	assert.equal(mode("overlay").props["aria-pressed"], true);
	assert.equal(mode("sidebar").props.disabled, true); assert.match(mode("sidebar").props.title, /侧边栏不可用/);
	assert.equal(mode("global").props.size, "sm"); assert.equal(all(mode("global"), n => n.type === Fullscreen).length, 1);
	assert.equal(all(mode("overlay"), n => n.type === "svg").length, 1); assert.equal(all(mode("overlay"), n => n.type === PinFill).length, 0);
	for (const tooltip of all(askTree, n => n.type === Tooltip)) { assert.equal(tooltip.props.side, "bottom"); assert.equal(tooltip.props.delayMs, 500); assert.equal(typeof tooltip.props.label, "string"); }
	mode("overlay").props.onClick();
	const tree = env.render(env.registrations.get("btw"));
	assert.equal(all(tree, n => n.type === PinFill).length, 1);
	assert.match(all(tree, n => n.props["data-btw-mode"] === "sidebar")[0].props.title, /侧边栏不可用/);
	env.cleanup();
});

test("dock editor toggle uses the shared DSH chevron and a circular accessible button", async () => {
	function Chevron() {}
	const env = await sideQuestionFixture({ primitives: { IconChevronDownOutlineRegular: Chevron } });
	const tree = await env.submit();
	const toggle = button(tree, "展开输入框");
	assert.equal(toggle.props["aria-expanded"], false);
	assert.equal(all(toggle, n => n.type === Chevron).length, 1);
	const css = env.styles.join("");
	assert.match(css, /\.dsh-btw-editor-toggle\{[^}]*border-radius:50%/);
	assert.match(css, /\.dsh-btw-editor-toggle\[aria-expanded=false\] svg\{transform:rotate\(180deg\)/);
	env.cleanup();
});

test("collapsed dock editor leaves the transcript the full panel height and the expand control floats", async () => {
	const env = await sideQuestionFixture();
	const tree = await env.submit();
	const card = dockPanel(tree);
	assert.equal(card.props["data-editor"], "collapsed");
	assert.equal(all(tree, n => n.props.className === "dsh-btw-row").length, 0, "no editor row consumes panel height while collapsed");
	const toggle = button(tree, "展开输入框");
	assert.equal(toggle.props["aria-expanded"], false);
	assert.ok(card.children.indexOf(toggle) > card.children.indexOf(all(tree, n => n.props["aria-label"] === "侧问消息")[0]), "floating toggle anchors after the scrolling body");
	const css = env.styles.join("");
	assert.match(css, /\.dsh-btw-editor-toggle\{[^}]*position:absolute/);
	assert.match(css, /\.dsh-btw-row>\.dsh-btw-editor-toggle\{bottom:auto;top:-12px;/);
	assert.match(css, /\.dsh-btw-dock-panel\[data-editor=collapsed\]>\.dsh-btw-answer\{padding-bottom:34px;/);
	env.cleanup();
});

test("expanded dock composer overlays the transcript, stays operable and keeps the draft", async () => {
	const env = await sideQuestionFixture();
	let tree = await env.submit();
	button(tree, "展开输入框").props.onClick(); tree = env.render(env.ask, env.props);
	assert.equal(dockPanel(tree).props["data-editor"], "expanded");
	const row = all(tree, n => n.props.className === "dsh-btw-row")[0];
	assert.ok(row, "overlay composer row renders");
	assert.ok(row.children.includes(all(tree, n => n.props["aria-label"] === "收起输入框")[0]), "the fold control rides the overlay edge instead of owning a row");
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "overlay draft" } });
	tree = env.render(env.ask, env.props);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "overlay draft");
	assert.equal(button(tree, "提问").props.disabled, false, "send stays operable above the overlay");
	button(tree, "收起输入框").props.onClick(); tree = env.render(env.ask, env.props);
	assert.equal(dockPanel(tree).props["data-editor"], "collapsed");
	assert.equal(all(tree, n => n.props.className === "dsh-btw-row").length, 0);
	button(tree, "展开输入框").props.onClick(); tree = env.render(env.ask, env.props);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "overlay draft", "collapsing preserves the draft");
	const css = env.styles.join("");
	assert.match(css, /\.dsh-btw-dock-panel\[data-editor=expanded\]>\.dsh-btw-row\{position:absolute;left:0;right:0;bottom:0/);
	assert.match(css, /\.dsh-btw-dock-panel\[data-editor=expanded\]>\.dsh-btw-answer\{padding-bottom:calc\(var\(--btw-editor-h,88px\) \+ 14px\);/);
	env.cleanup();
});

test("narrow dock head stays one row: icons never wrap over or clip the title", async () => {
	const env = await sideQuestionFixture({ width: 360, height: 640 });
	const tree = await env.submit();
	const head = all(tree, n => n.props.className === "dsh-btw-head")[0];
	const kids = head.children.filter(Boolean);
	assert.equal(kids[0].props.className, "dsh-btw-mtitles", "shrinking title block stays first");
	assert.ok(kids.some(n => n.type === "button" && n.children.includes("选择消息")), "text button remains present and shrinkable");
	assert.equal(kids.at(-1).props.className, "dsh-btw-x", "close stays last and reachable");
	const css = env.styles.join("");
	assert.match(css, /\.dsh-btw-head\{display:flex;flex-wrap:nowrap;align-items:center;gap:4px;padding:6px 8px 0;min-width:0;/);
	assert.match(css, /\.dsh-btw-head \.dsh-btw-mtitle\{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;/);
	assert.match(css, /\.dsh-btw-head>button\.dsh-btw-control\{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;/);
	assert.match(css, /\.dsh-btw-dock-panel\{[^}]*container-type:inline-size;/);
	assert.match(css, /@container \(max-width:320px\)\{[^@]*min-width:22px/, "icon controls shrink before anything can overflow");
	assert.match(css, /@container \(max-width:250px\)\{[^@]*\.dsh-btw-mtitles\{display:none\}/, "the title drops out before icons collide with text");
	env.cleanup();
});

test("dock textarea keeps its plain hint while a reply is streaming and stays send-locked", async () => {
	const streaming = deferred();
	const env = await sideQuestionFixture({ rpc: method => ({ ok: true, value: method === "models" ? { providers: [{ id: "p", models: [{ id: "m", name: "Model" }] }] } : method === "open" ? { sessionId: "side-child", cwd: "/project" } : method === "send" ? streaming.promise : method === "poll" ? { text: "", lastSeq: 0 } : {} }) });
	env.render(env.registrations.get("btw-trigger"), env.props).props.onClick();
	let tree = env.render(env.ask, env.props);
	const hint = "问点什么… Enter 发送，Shift+Enter 换行";
	assert.equal(all(tree, n => n.type === "textarea")[0].props.placeholder, hint);
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "during" } });
	tree = env.render(env.ask, env.props); button(tree, "提问").props.onClick(); await tick(); env.timers.poll(); await tick();
	tree = env.render(env.ask, env.props);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.placeholder, hint, "streaming keeps the ordinary hint");
	assert.doesNotMatch(JSON.stringify(tree), /回复中/);
	assert.equal(button(tree, "提问").props.disabled, true, "send remains locked while busy");
	streaming.resolve({ ok: true, value: { output: "late answer" } }); await tick(); await tick();
	env.cleanup();
});

test("the overlay composer measures itself so the transcript scrolls clear of it", async () => {
	const writes = [], observed = []; let disconnected = 0;
	const panelStyle = { setProperty: (k, v) => writes.push([k, v]), removeProperty: (k) => writes.push(["remove", k]) };
	const ResizeObserver = class { constructor(apply) { this.apply = apply; } observe(el) { observed.push(el); } disconnect() { disconnected++; } };
	const env = await sideQuestionFixture({ ResizeObserver, commitRef: node => node.props.className === "dsh-btw-card dsh-btw-dock-panel" ? { style: panelStyle } : node.props.className === "dsh-btw-row" ? { offsetHeight: 96 } : null });
	let tree = await env.submit();
	writes.length = 0; // the reply's transient expand→fold pass leaves no live clearance
	button(tree, "展开输入框").props.onClick(); tree = env.render(env.ask, env.props);
	assert.deepEqual(writes.filter(([k]) => k === "--btw-editor-h"), [["--btw-editor-h", "96px"]], "overlay height feeds the scroll clearance");
	assert.ok(observed.length, "row size changes re-measure the clearance");
	button(tree, "收起输入框").props.onClick(); tree = env.render(env.ask, env.props);
	assert.ok(writes.some(([k]) => k === "remove"), "folding removes the clearance variable");
	assert.ok(disconnected > 0);
	env.cleanup();
});

test("source bridge reuses snapshots for stable source/nodes and never rescans on partial-only changes", async () => {
	let reads = 0;
	const nodes = new Proxy([{ kind: "assistant", blocks: [{ kind: "text", text: "completed evidence" }] }], { get(target, key) { if (key === "0") reads++; return Reflect.get(target, key); } });
	const env = await setup({}, { lazy: true });
	const component = env.registrations.get("btw-ask");
	let partial = "one";
	const props = { sessionId: "origin", useChat: select => select({ legacy: { nodes, partial: { text: partial } } }) };
	env.render(component, props); const firstReads = reads; assert.ok(firstReads > 0);
	partial = "two"; env.render(component, props); assert.equal(reads, firstReads);
	env.render(component, { ...props, sessionId: "other" }); assert.ok(reads > firstReads);
	assert.deepEqual(env.requests, []); env.cleanup();
});

test("fixed two-turn recall uses one real transport owner and child history, then preserves it across all three UI modes", async () => {
	const children = new Map(), selected = []; let nextId = 0;
	const env = await setup({ askContextMode: "none", tempContextMode: "all" }, {
		layout: { selectPanel: id => selected.push(id) }, sidebar: { mounted: { getSnapshot: () => "origin" }, openTab() {}, isExpanded: () => false },
		rpc(method, payload) {
			if (method === "models") return { ok: true, value: { providers: [] } };
			if (method === "open") { const id = "actual-child-" + ++nextId; children.set(id, []); return { ok: true, value: { sessionId: id, cwd: "/project" } }; }
			if (method === "send") {
				const history = children.get(payload.sessionId); assert.ok(history, "send must reach its retained child");
				const remembered = history.find(text => text.includes("private-token-918"));
				history.push(payload.text);
				return { ok: true, value: { output: payload.text === "recall" ? remembered ? "private-token-918" : "NO_HISTORY" : "reply " + history.length } };
			}
			return { ok: true, value: method === "poll" ? { text: "", lastSeq: 0 } : {} };
		},
	});
	const dock = env.registrations.get("btw-ask"), props = projectProps(), overlay = env.registrations.get("btw");
	env.render(dock, props); env.render(env.registrations.get("btw-trigger"), props).props.onClick();
	button(typeTemp(env, dock, "remember private-token-918", props), "提问").props.onClick(); await tick(); await tick();
	button(typeTemp(env, dock, "recall", props), "提问").props.onClick(); await tick(); await tick();
	let tree = env.render(dock, props);
	assert.deepEqual(all(tree, isMessageContent).map(n => n.children[0]), ["remember private-token-918", "reply 1", "recall", "private-token-918"]);
	const ownId = all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"];
	assert.equal(env.calls.filter(c => c[1] === "open").length, 1);
	assert.equal(env.calls.find(c => c[1] === "open")[2].contextMode, "none", "fixed entry keeps ask defaults, not temp defaults");
	assert.deepEqual(JSON.parse(JSON.stringify(env.calls.filter(c => c[1] === "send").map(c => c[2]))), [
		{ sessionId: "actual-child-1", text: "remember private-token-918" }, { sessionId: "actual-child-1", text: "recall" },
	]);
	button(tree, "展开输入框").props.onClick(); tree = env.render(dock, props);
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "unsent between modes" } });
	tree = env.render(dock, props); modeControl(tree, "overlay").props.onClick();
	let previousMode = "overlay";
	for (const [mode, viewProps] of [["sidebar", { inline: true }], ["overlay", {}], ["global", { standalone: true }], ["overlay", {}]]) {
		const previousProps = previousMode === "sidebar" ? { inline: true } : previousMode === "global" ? { standalone: true } : {};
		if (previousMode === "sidebar") switchHeaderSidebarToOverlay(env); else modeControl(env.render(overlay, previousProps), mode).props.onClick();
		previousMode = mode;
		const view = env.render(overlay, viewProps);
		assert.equal(all(view, n => n.props["data-chat-id"])[0].props["data-chat-id"], ownId);
		assert.equal(all(view, n => n.type === "textarea")[0].props.value, "unsent between modes");
		assert.deepEqual(chatText(view), ["remember private-token-918", "reply 1", "recall", "private-token-918"]);
	}
	assert.equal(env.calls.filter(c => c[1] === "open").length, 1); assert.equal(env.calls.filter(c => c[1] === "send").length, 2);
	assert.equal(env.calls.some(c => ["ask", "askPoll", "askCancel"].includes(c[1])), false);
	env.cleanup();
});

test("fixed minimize is not end: reply/draft/child survive chip reopening, but X cleanup makes the next chat fresh", async () => {
	const reply = deferred(), closed = deferred(), storage = geometryStorage(); let opened = 0;
	const env = await setup({ askContextMode: "none" }, { storage, rpc(method) {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return { ok: true, value: { sessionId: "min-child-" + ++opened, cwd: "/project" } };
		if (method === "send") return reply.promise;
		if (method === "close") return closed.promise;
		return { ok: true, value: { text: "", lastSeq: 0 } };
	} });
	const dock = env.registrations.get("btw-ask"), props = projectProps();
	env.render(dock, props); env.render(env.registrations.get("btw-trigger"), props).props.onClick();
	button(typeTemp(env, dock, "keep running while minimized", props), "提问").props.onClick(); await tick();
	let tree = env.render(dock, props), id = all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"];
	assert.ok(modeControl(tree, "global"), "dock retains its fullscreen control");
	button(tree, "最小化 btw").props.onClick(); assert.equal(env.render(dock, props), null);
	assert.equal(env.calls.some(c => c[1] === "close"), false);
	reply.resolve({ ok: true, value: { output: "background answer" } }); await tick(); await tick();
	env.render(env.registrations.get("btw-trigger"), props).props.onClick(); tree = env.render(dock, props);
	assert.equal(all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"], id);
	assert.deepEqual(all(tree, isMessageContent).map(n => n.children[0]), ["keep running while minimized", "background answer"]);
	button(tree, "展开输入框").props.onClick(); tree = env.render(dock, props);
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "private unsent draft" } });
	button(env.render(dock, props), "最小化 btw").props.onClick();
	env.render(env.registrations.get("btw-trigger"), props).props.onClick(); tree = env.render(dock, props);
	const reopenEditor = all(tree, n => n.props["aria-label"] === "展开输入框")[0];
	if (reopenEditor) { reopenEditor.props.onClick(); tree = env.render(dock, props); }
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "private unsent draft");
	assert.equal(opened, 1); assert.equal(env.calls.filter(c => c[1] === "send").length, 1);
	assert.equal(storage.writes.length, 0, "minimize never persists hidden chat state or a default geometry");
	button(tree, "关闭侧问面板").props.onClick();
	assert.equal(env.calls.filter(c => c[1] === "close").length, 1);
	closed.resolve({ ok: true, value: {} }); await tick();
	assert.equal(env.render(dock, props), null);
	env.render(env.registrations.get("btw-trigger"), props).props.onClick(); tree = env.render(dock, props);
	assert.notEqual(all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"], id);
	assert.deepEqual(all(tree, isMessageContent), []); assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "");
	assert.equal(opened, 1, "a fresh blank controller still waits for first send before creating a child");
	button(typeTemp(env, dock, "fresh question", props), "提问").props.onClick(); await tick(); await tick();
	assert.equal(opened, 2); assert.equal(env.calls.filter(c => c[1] === "send").at(-1)[2].sessionId, "min-child-2");
	assert.deepEqual(all(env.render(dock, props), isMessageContent).map(n => n.children[0]), ["fresh question", "background answer"]);
	env.cleanup();
});

test("small-window/fullscreen minimize retains and reopens the same child through its chip", async () => {
	for (const mode of ["overlay", "global"]) {
		const surface = publicSidebar(), selected = [];
		const env = await setup({ askContextMode: "none" }, { sidebar: surface.right, layout: { selectPanel: id => selected.push(id) } });
		const dock = env.registrations.get("btw-ask"), props = projectProps(), overlay = env.registrations.get("btw");
		env.render(dock, props); env.render(env.registrations.get("btw-trigger"), props).props.onClick();
		button(typeTemp(env, dock, "one retained child", props), "提问").props.onClick(); await tick(); await tick();
		modeControl(env.render(dock, props), mode).props.onClick();
		const viewProps = mode === "global" ? { standalone: true } : {};
		let view = env.render(overlay, viewProps), id = all(view, n => n.props["data-chat-id"])[0].props["data-chat-id"];
		assert.equal(modeControl(view, "global").props.disabled, false, "small window and global view retain fullscreen control");
		button(view, "最小化 btw").props.onClick();
		assert.equal(env.render(overlay, viewProps), null); assert.equal(surface.rows().length, 0);
		assert.equal(env.calls.some(c => c[1] === "close"), false);
		env.render(env.registrations.get("btw-trigger"), props).props.onClick(); env.render(dock, props); view = env.render(overlay, viewProps);
		assert.equal(all(view, n => n.props["data-chat-id"])[0].props["data-chat-id"], id);
		assert.deepEqual(chatText(view), ["one retained child", "answer"]);
		assert.equal(env.calls.filter(c => c[1] === "open").length, 1);
		env.cleanup();
	}
});

test("ending a fixed pending open retains its barrier across source switches and unload; a late child never sends", async () => {
	const opened = deferred(), callsOnWrongConnection = [];
	const env = await setup({ askContextMode: "none" }, { rpc: method => method === "open" ? opened.promise : { ok: true, value: method === "models" ? { providers: [] } : {} } });
	const dock = env.registrations.get("btw-ask"), props = projectProps();
	env.render(dock, props); env.render(env.registrations.get("btw-trigger"), props).props.onClick();
	button(typeTemp(env, dock, "opening fixed", props), "提问").props.onClick();
	const closing = button(env.render(dock, props), "关闭侧问面板"); closing.props.onClick();
	env.render(dock, projectProps("/other", "other"));
	env.replaceConnection({ rpc: { call: (...args) => { callsOnWrongConnection.push(args); return Promise.resolve({ ok: true, value: {} }); } } });
	env.cleanup(); opened.resolve({ ok: true, value: { sessionId: "late-fixed-child" } }); await tick(); await tick();
	assert.deepEqual(env.calls.filter(c => c[1] === "close").map(c => c[2].sessionId), ["late-fixed-child"]);
	assert.equal(env.calls.some(c => c[1] === "send"), false); assert.deepEqual(callsOnWrongConnection, []);
});

test("fixed geometry ignores old v2 dimensions, preserves new manual v3 heights and never alters floating storage", async () => {
	const oldKey = "dsh-btw/geometry/v1/%2Fproject/dock-v2", nextKey = "dsh-btw/geometry/v1/%2Fproject/dock-v3", floatKey = "dsh-btw/geometry/v1/%2Fproject";
	const old = '{"width":680,"height":320,"x":0,"y":0}', float = '{"width":510,"height":390,"x":17,"y":24}';
	for (const manual of [false, true]) {
		const storage = geometryStorage(); storage.values.set(oldKey, old); storage.values.set(floatKey, float);
		if (manual) storage.values.set(nextKey, '{"width":420,"height":270,"x":30,"y":0}');
		const env = await sideQuestionFixture({ storage });
		env.render(env.registrations.get("btw-trigger"), env.props).props.onClick();
		let tree = env.render(env.ask, env.props);
		assert.equal(dockPanel(tree).props.style.width, "100%");
		assert.equal(dockPanel(tree).props.style.height, manual ? 270 : 200);
		env.setViewport(1300, 850); tree = env.render(env.ask, env.props);
		assert.deepEqual(storage.writes, [], "measurement must not promote a generated default into v3 storage");
		resizeKey(tree, "n", "ArrowUp"); tree = env.render(env.ask, env.props);
		assert.ok(storage.writes.length); assert.ok(storage.writes.every(([key, json]) => key === nextKey && Object.keys(JSON.parse(json)).join() === "height"));
		assert.equal(storage.values.get(oldKey), old); assert.equal(storage.values.get(floatKey), float);
		env.cleanup();
	}
});


test("fixed editor folds on reply, preserves drafts through toggles and folds again on follow-up", async () => {
	const env = await sideQuestionFixture();
	let tree = await env.submit("first");
	assert.equal(all(tree, n => n.type === "textarea").length, 0);
	button(tree, "展开输入框").props.onClick(); tree = env.render(env.ask, env.props);
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "second draft" } });
	tree = env.render(env.ask, env.props); button(tree, "收起输入框").props.onClick();
	tree = env.render(env.ask, env.props); button(tree, "展开输入框").props.onClick();
	tree = env.render(env.ask, env.props); assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "second draft");
	button(tree, "提问").props.onClick(); tree = env.render(env.ask, env.props);
	assert.equal(all(tree, n => n.type === "textarea").length, 0);
	await tick(); await tick(); tree = env.render(env.ask, env.props);
	assert.deepEqual(env.calls.filter(c => c[1] === "send").map(c => [c[2].sessionId, c[2].text]), [["side-child", "first"], ["side-child", "second draft"]]);
	assert.deepEqual(all(tree, isMessageContent).map(n => n.children[0]), ["first", "assistant answer", "second draft", "assistant answer"]);
	env.cleanup();
});

test("fixed editor stays open without assistant text and on send errors", async () => {
	for (const result of [{ ok: true, value: { output: "" } }, { ok: false, error: { message: "send failed" } }]) {
		const env = await sideQuestionFixture({ rpc: method => method === "models" ? { ok: true, value: { providers: [] } } : method === "open" ? { ok: true, value: { sessionId: "child" } } : method === "send" ? result : { ok: true, value: { text: "", lastSeq: 0 } } });
		const tree = await env.submit();
		assert.equal(all(tree, n => n.type === "textarea").length, 1);
		assert.equal(all(tree, n => n.props["aria-label"] === "展开输入框").length, 0);
		if (!result.ok) assert.match(JSON.stringify(tree), /send failed/);
		env.cleanup();
	}
});

test("streaming reply folds once; manually expanded draft survives later chunks", async () => {
	const sent = deferred(); let seq = 0;
	const env = await sideQuestionFixture({ rpc: method => method === "models" ? { ok: true, value: { providers: [] } } : method === "open" ? { ok: true, value: { sessionId: "child" } } : method === "send" ? sent.promise : method === "poll" ? { ok: true, value: { text: ++seq === 1 ? "first chunk" : "second chunk", lastSeq: seq } } : { ok: true, value: {} } });
	let tree = await env.submit(); assert.equal(all(tree, n => n.type === "textarea").length, 0);
	button(tree, "展开输入框").props.onClick(); tree = env.render(env.ask, env.props);
	all(tree, n => n.type === "textarea")[0].props.onChange({ target: { value: "in progress" } });
	env.timers.poll(); await tick(); tree = env.render(env.ask, env.props);
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "in progress");
	sent.resolve({ ok: true, value: { output: "first chunksecond chunk" } }); await tick(); await tick();
	tree = env.render(env.ask, env.props); assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "in progress"); env.cleanup();
});

test("fixed editor expansion belongs to each chat, not another source", async () => {
	const env = await sideQuestionFixture(); let a = await env.submit("first source");
	button(a, "展开输入框").props.onClick(); a = env.render(env.ask, env.props);
	all(a, n => n.type === "textarea")[0].props.onChange({ target: { value: "source A draft" } });
	const bProps = projectProps("/other", "other"); env.render(env.ask, bProps);
	env.render(env.registrations.get("btw-trigger"), bProps).props.onClick();
	let b = env.render(env.ask, bProps); assert.equal(all(b, n => n.type === "textarea")[0].props.value, "");
	button(typeTemp(env, env.ask, "source B", bProps), "提问").props.onClick(); await tick(); await tick();
	b = env.render(env.ask, bProps); assert.equal(all(b, n => n.type === "textarea").length, 0);
	a = env.render(env.ask, env.props); const expand = all(a, n => n.props["aria-label"] === "展开输入框")[0];
	if (expand) { expand.props.onClick(); a = env.render(env.ask, env.props); }
	assert.equal(all(a, n => n.type === "textarea")[0].props.value, "source A draft"); env.cleanup();
});


test("sidebar hides the retired 新建 and 最小化 controls and keeps the chat intact", async () => {
	for (const withMessages of [false, true]) {
		const surface = publicSidebar(); let children = 0;
		const env = await setup({}, { sidebar: surface.right, layout: { selectPanel() {} }, rpc: method => ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "sidebar-child-" + ++children } : method === "send" ? { output: "reply" } : { text: "", lastSeq: 0 } }) });
		const overlay = env.registrations.get("btw"), inline = { inline: true };
		env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
		if (withMessages) { button(typeTemp(env, overlay, "old question", inline), "发送").props.onClick(); await tick(); await tick(); }
		let tree = typeTemp(env, overlay, "old private draft", inline);
		const id = all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"], controller = env.viewControllers.get(id);
		assert.equal(all(tree, n => n.props["aria-label"] === "新建临时聊天").length, 0, "sidebar must not offer 新建");
		assert.equal(all(tree, n => n.props["aria-label"] === "最小化 btw").length, 0, "sidebar must not offer 最小化");
		tree = env.render(overlay, inline);
		assert.equal(all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"], id, "the same chat stays in the sidebar");
		assert.ok(controller, "the chat controller is untouched by the missing controls");
		assert.equal(env.render(overlay), null, "no unwanted floating window");
		assert.equal(surface.rows().length, 1, "exactly one native sidebar tab remains");
		assert.equal(surface.rows()[0].sessionId, "origin");
		assert.equal(surface.right.active().kind, "btw-temp");
		button(tree, "结束临时聊天").props.onClick(); await tick();
		if (withMessages) assert.ok(env.calls.some(c => c[1] === "close"), "ending the sidebar chat still closes its child");
		env.cleanup();
	}
});

test("floating window retains all mode controls while sidebar has none", async () => {
	const surface = publicSidebar(), env = await setup({}, { sidebar: surface.right, layout: { selectPanel() {} } });
	const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	const sidebar = env.render(overlay, { inline: true }); assert.equal(all(sidebar, n => n.props["data-btw-mode"]).length, 0);
	// A different source opens a floating window when its sidebar is not mounted.
	env.render(env.registrations.get("btw-temp"), projectProps("/other", "other")).props.onClick();
	const floating = env.render(overlay);
	assert.deepEqual(all(floating, n => n.props["data-btw-mode"]).map(n => n.props["data-btw-mode"]), ["overlay", "sidebar", "global"]);
	env.cleanup();
});

test("Esc ends the btw at once instead of parking a window to return to", async () => {
	const env = await setup({}, { effects: true });
	const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	let tree = typeTemp(env, overlay, "esc clears this");
	const id = all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"];
	button(tree, "发送").props.onClick(); await tick(); await tick();
	tree = env.render(overlay);
	env.dispatch("keydown", { key: "Escape", target: escapeTarget(tree, id) }); await tick();
	assert.equal(env.render(overlay), null, "Esc removes the window in the same tick");
	assert.deepEqual(env.calls.filter(c => c[1] === "close").map(c => c[2].sessionId), ["fixture-child"], "Esc cleans the chat up");
	assert.doesNotMatch(JSON.stringify(env.render(overlay) ?? {}), /正在清理/, "no cleanup placeholder is rendered");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	tree = env.render(overlay);
	assert.notEqual(all(tree, n => n.props["data-chat-id"])[0].props["data-chat-id"], id, "a new btw starts empty; the ended one never returns");
	assert.equal(all(tree, n => n.type === "textarea")[0].props.value, "", "no draft is restored");
	env.cleanup();
});

test("Esc in the fixed panel ends the btw like the small window", async () => {
	const env = await setup({}, { effects: true });
	const ask = env.registrations.get("btw-ask"), props = chatProps("origin");
	env.render(ask, props); // warm the panel like the dock test does
	env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick(); await tick();
	let tree = env.render(ask, props);
	if (!all(tree, n => n.type === "textarea").length) { all(tree, n => n.props["aria-label"] === "展开输入框")[0]?.props.onClick(); tree = env.render(ask, props); }
	const node = all(tree, n => typeof n.props.className === "string" && n.props.className.includes("dsh-btw-dock-panel"))[0];
	const target = { closest: () => null };
	node.props.ref.current = { ...node.props.ref.current, contains: candidate => candidate === target };
	env.setActiveElement(target);
	env.dispatch("keydown", { key: "Escape", target });
	await tick();
	assert.equal(env.render(ask, props), null, "the fixed panel leaves at once");
	assert.equal(env.calls.some(c => c[1] === "close"), false, "a chat that never opened needs no cleanup RPC");
	env.render(env.registrations.get("btw-trigger"), { sessionId: "origin" }).props.onClick();
	tree = env.render(ask, props);
	assert.equal(all(tree, n => n.type === "textarea")[0]?.props.value ?? "", "", "the ended btw does not come back with its draft");
	env.cleanup();
});

test("Esc never closes the native temporary chat", async () => {
	const selected = [], env = await setup({}, { effects: true, layout: { selectPanel: id => selected.push(id) } });
	const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	modeControl(typeTemp(env, overlay, "native surface draft"), "global").props.onClick();
	const tree = env.render(overlay, { standalone: true });
	assert.ok(tree, "the chat is presented fullscreen");
	selected.length = 0;
	env.dispatch("keydown", { key: "Escape", target: escapeTarget(tree, "btw-1") }); await tick();
	assert.equal(env.calls.some(c => c[1] === "close"), false, "Esc cannot end a temporary chat");
	assert.deepEqual(selected, [], "Esc cannot navigate away from the temporary chat");
	assert.ok(env.render(overlay, { standalone: true }), "the temporary chat stays on screen");
	env.cleanup();
});

test("closing the only fullscreen btw panel returns to the conversation", async () => {
	const selected = [], env = await setup({}, { effects: true, layout: { selectPanel: id => selected.push(id) } });
	const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	modeControl(typeTemp(env, overlay, "sole panel draft"), "global").props.onClick();
	const tree = env.render(overlay, { standalone: true });
	assert.ok(tree, "sole btw panel is presented");
	selected.length = 0;
	button(tree, "结束临时聊天").props.onClick(); await tick();
	assert.deepEqual(selected, [null], "the emptied panel closes instead of showing a blank shell");
	env.cleanup();
});

test("ending leaves the surface at once and cleans up in the background", async () => {
	const end = deferred();
	const env = await setup({}, { effects: true, rpc: method => method === "close" ? end.promise : ({ ok: true, value: method === "models" ? { providers: [] } : method === "open" ? { sessionId: "bg-child" } : method === "send" ? { output: "ok" } : { text: "", lastSeq: 0 } }) });
	const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	button(typeTemp(env, overlay, "background close"), "发送").props.onClick(); await tick(); await tick();
	const tree = env.render(overlay);
	button(tree, "结束临时聊天").props.onClick();
	assert.equal(env.render(overlay), null, "the window disappears in the same tick");
	assert.doesNotMatch(JSON.stringify(env.render(overlay) ?? {}), /正在清理/, "no cleanup placeholder is rendered");
	assert.equal(env.calls.filter(c => c[1] === "close").length, 1, "cleanup is still requested");
	end.resolve({ ok: true, value: {} }); await tick();
	assert.equal(env.render(overlay), null);
	env.cleanup();
});

test("a failed background cleanup comes back with the real reason and can be retried", async () => {
	let attempts = 0;
	const env = await setup({}, { effects: true, rpc: method => {
		if (method === "models") return { ok: true, value: { providers: [] } };
		if (method === "open") return { ok: true, value: { sessionId: "retry-child" } };
		if (method === "send") return { ok: true, value: { output: "ok" } };
		if (method === "close") return ++attempts === 1 ? { ok: false, error: { message: "EBUSY" } } : { ok: true, value: {} };
		return { ok: true, value: { text: "", lastSeq: 0 } };
	} });
	const overlay = env.registrations.get("btw");
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick();
	button(typeTemp(env, overlay, "retry me"), "发送").props.onClick(); await tick(); await tick();
	button(env.render(overlay), "结束临时聊天").props.onClick(); await tick(); await tick();
	const tree = env.render(overlay);
	assert.ok(tree, "a failed cleanup is reported instead of pretending success");
	assert.match(JSON.stringify(tree), /EBUSY/, "the host's real reason is visible");
	button(tree, "结束临时聊天").props.onClick(); await tick();
	assert.equal(env.render(overlay), null, "the retry ends it");
	assert.equal(attempts, 2);
	env.cleanup();
});

test("Esc ends the btw from the native sidebar as well", async () => {
	const surface = publicSidebar();
	const env = await setup({ tempPresentation: "sidebar" }, { effects: true, sidebar: surface.right, layout: { selectPanel() {} } });
	const overlay = env.registrations.get("btw"), inline = { inline: true };
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick(); await tick();
	let tree = typeTemp(env, overlay, "sidebar esc", inline);
	if (!all(tree, n => n.type === "textarea").length) { all(tree, n => n.props["aria-label"] === "展开输入框")[0]?.props.onClick(); tree = env.render(overlay, inline); }
	button(tree, "发送").props.onClick(); await tick(); await tick();
	tree = env.render(overlay, inline);
	const node = all(tree, n => n.props.className === "dsh-btw-modal")[0];
	const target = { closest: () => null };
	node.props.ref.current = { ...node.props.ref.current, contains: candidate => candidate === target };
	env.setActiveElement(target);
	env.dispatch("keydown", { key: "Escape", target }); await tick();
	assert.equal(env.render(overlay, inline), null, "the sidebar page leaves at once");
	assert.deepEqual(env.calls.filter(c => c[1] === "close").map(c => c[2].sessionId), ["fixture-child"], "its child is cleaned up");
	assert.equal(surface.rows().length, 0, "the emptied sidebar tab is retired");
	env.cleanup();
});

test("Esc from the host composer ends the open sidebar btw without focus inside it", async () => {
	const surface = publicSidebar();
	const env = await setup({ tempPresentation: "sidebar" }, { effects: true, sidebar: surface.right, layout: { selectPanel() {} } });
	const overlay = env.registrations.get("btw"), inline = { inline: true };
	env.render(env.registrations.get("btw-temp"), projectProps()).props.onClick(); await tick();
	let tree = typeTemp(env, overlay, "sidebar no focus", inline);
	if (!all(tree, n => n.type === "textarea").length) { all(tree, n => n.props["aria-label"] === "展开输入框")[0]?.props.onClick(); tree = env.render(overlay, inline); }
	button(tree, "发送").props.onClick(); await tick(); await tick();
	// Focus remains in the host composer; the btw sidebar page still answers Esc.
	const outside = { closest: () => null };
	env.setActiveElement(outside);
	env.dispatch("keydown", { key: "Escape", target: outside, composedPath: () => [] }); await tick();
	assert.equal(env.render(overlay, inline), null, "the sidebar btw leaves without owning focus");
	assert.deepEqual(env.calls.filter(c => c[1] === "close").map(c => c[2].sessionId), ["fixture-child"]);
	assert.equal(surface.rows().length, 0);
	env.cleanup();
});
