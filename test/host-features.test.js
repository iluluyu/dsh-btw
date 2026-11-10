import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { BACKEND, DenyMarkers, NativeCacheBackend } from "../lib/native-cache.js";

// Everything, including the rc.1 install anchor, lives under an isolated home.
const root = mkdtempSync(join(tmpdir(), "btw-host-features-"));
process.env.DSH_HOME = root;
const { apply, Config } = await import("../lib/index.js");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const recordRoot = join(root, ".btw-temp-records");
const anchor = join(root, "install", "package.json");
const parentModel = { provider: "parent", model: "active", reasoningEffort: "low" };

function packageFixture(name, source = "export default {};") {
	const dir = join(dirname(anchor), "node_modules", "@deepseek-ai", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version: "0.2.2-rc.1", type: "module", main: "index.js" }));
	writeFileSync(join(dir, "index.js"), source);
	return dir;
}
for (const name of ["dsh-persona", "dsh-tool-bash", "dsh-tool-fs", "dsh-tool-fs-search", "dsh-skill-filesystem", "dsh-tool-skill", "dsh-session-persistence-jsonl", "dsh-agent-loop"]) {
	packageFixture(name, `export default { name: ${JSON.stringify(name)} };`);
}
packageFixture("dsh-agent", 'export const installModelSelection = () => {};');
packageFixture("dsh-home-paths", 'import { join } from "node:path"; export const dshHomePath = (...s) => join(process.env.DSH_HOME, ...s);');
writeFileSync(anchor, JSON.stringify({ name: "mock-dsh", version: "0.2.2-rc.1" }));

function host(config = {}, overrides = {}) {
	let call, request, cleanup, creations = 0;
	const warnings = [];
	const services = {
		llm: {
			listProviders: () => [{ id: "mock", name: "Mock" }],
			listModels: async () => [{ id: "m", name: "Model", provider: "mock" }],
			async *stream(opts) { request = opts; yield { type: "text-delta", text: "ok" }; yield { type: "finish", reason: { kind: "stop" } }; },
		},
		agentDefaultModel: { currentSelection: () => ({ provider: "default", model: "d" }) },
		agents: { create() { creations++; throw Error("must not create"); } },
		webServer: {}, profileContext: { installAnchor: anchor },
		connection: { rpc: { handle(_path, fn) { call = fn; return () => {}; } } },
		...overrides,
	};
	const injectedCleanup = [];
	apply({ ...services, logger: { warn: text => warnings.push(text) }, get: name => services[name], extend(p) { return { ...this, ...p }; }, effect(fn) { cleanup = fn(); },
		inject(names, callback) {
			if (names.every(n => services[n] !== undefined)) callback({ ...services, effect(fn) { injectedCleanup.push(fn()); } });
		},
	}, config);
	return { call: (...args) => call(...args), request: () => request, creations: () => creations, cleanup: async () => {
		await cleanup(); for (const fn of injectedCleanup) await fn?.();
	}, services, warnings };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function askResult(h, payload) {
	const result = await h.call("ask", { question: "q", ...payload });
	assert.equal(result.ok, true, JSON.stringify(result));
	for (let i = 0; i < 100; i++) {
		const poll = await h.call("askPoll", result.value);
		if (poll.value.done) return poll.value;
		await tick();
	}
	assert.fail("ask did not settle");
}
function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}
const files = () => existsSync(recordRoot) ? readdirSync(recordRoot).filter(x => x.endsWith(".json")) : [];
const recordPath = id => join(recordRoot, `${id}.json`);
const readRecord = id => JSON.parse(readFileSync(recordPath(id), "utf8"));
const dirIdentity = path => { const s = lstatSync(path, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) }; };

class JsonlSessionPersistence {
	identity = Symbol("mock-backend");
	name = "session-persistence-jsonl";
	root = join(root, "sessions");
	config = { root: this.root };
	items = new Map();
	async stat(id) { return this.items.get(id); }
}

function fixtureTemp(options = {}, config = {}) {
	const persistence = new JsonlSessionPersistence();
	const mounted = [], messages = [], selectionHooks = [], selections = [], sessionEvents = [], createOptions = [], runtimes = [];
	let disposals = 0, creations = 0, id;
	const agents = {
		get: id => id === "parent" ? {
			model: { current: () => parentModel }, options: {},
			session: { header: { id: "parent", cwd: root }, append() { assert.fail("btw must not write to the parent session"); } },
			ctx: { get: () => undefined },
		} : undefined,
		async create(opts) {
			createOptions.push(opts);
			creations++;
			id = opts.sessionId;
			const record = readRecord(id);
			const dir = join(persistence.root, record.cwd === null ? "_no-cwd" : `--${record.cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`, id);
			assert.deepEqual(dirIdentity(dir), record.dirIdentity, "exclusive directory and durable record precede creation");
			assert.equal(readdirSync(dir).length, 0, "reserved directory is empty");
			const path = join(dir, "session.v4.jsonl.zstd");
			if (!options.noLocation) writeFileSync(path, "mock-session");
			if (!options.noStat) persistence.items.set(id, {
				header: { id, ...(opts.meta.cwd ? { cwd: opts.meta.cwd } : {}) },
				...(options.noLocation ? {} : { location: { kind: options.badLocation ? "unknown" : "jsonl", path } }),
			});
			if (options.createGate) await options.createGate.promise;
			if (options.createError) throw Error("create failed after write");
			const listeners = new Map();
			let seq = 0;
			const emit = (type, data, subject = child.session) => {
				const event = { type, data, seq: seq++, time: Date.now() };
				listeners.get("session/event")?.(subject, event);
				return event;
			};
			const child = {
				session: { append: (type, data) => sessionEvents.push({ type, data }) },
				model: { select(selected) { selections.push(selected); }, current: () => selections.at(-1) },
				cancel() {},
				whenIdle: () => options.idleGate?.promise ?? Promise.resolve(),
				followup(message) {
					assert.ok(child.model.current(), "rc.1 requires model selection before assembly or agent/request");
					assert.equal(listeners.has("agent/request"), false, "do not rewrite a prepared model request");
					messages.push(message);
					for (let i = 0; i < (options.chunkCount ?? 1); i++) {
						listeners.get("agent/assistant-stream")?.({ agent: child, frame: { type: "chunk", chunk: { type: "text-delta", text: options.outputText ?? "temp reply" } } });
					}
					options.onFollowup?.({ child, emit, listeners, turn: messages.length });
					if (options.agentError) listeners.get("agent/error")?.({ agent: options.unrelatedError ? {} : child, turn: messages.length, step: 1, error: Error(options.agentError) });
				},
			};
			runtimes.push({ child, emit, listeners });
			await opts.setup({
				on(name, fn) { listeners.set(name, fn); if (name === "system-prompt/assemble") selectionHooks.push(fn); return () => {}; },
				plugin(plugin) { if (options.setupError) throw Error("setup failed"); mounted.push(plugin.name); },
			}, child);
			return { agent: child, async dispose() {
				disposals++;
				if (options.disposeGate) await options.disposeGate.promise;
				if (options.disposeError) throw Error("dispose failed");
				options.idleGate?.resolve();
			} };
		},
	};
	const h = host(config, { agents, sessionPersistence: persistence, ...options.services });
	return { h, persistence, mounted, messages, options, selectionHooks, selections, sessionEvents, createOptions, runtimes, id: () => id, disposals: () => disposals, creations: () => creations };
}
async function opened(f, payload = {}) {
	const response = await f.h.call("open", payload);
	assert.equal(response.ok, true, JSON.stringify(response));
	return response.value.sessionId;
}
async function closed(f, id) {
	assert.deepEqual(await f.h.call("close", { sessionId: id }), { ok: true, value: { burned: true } });
	assert.equal(existsSync(recordPath(id)), false);
}

const nativeDirs = new Map();
const nativeDir = id => nativeDirs.get(id);
const nativeWorkspace = id => join(root, ".btw-native-workspaces/_no-cwd", id);
const nativeRegistrations = new Map(), nativeArchived = new Set(), nativePinned = new Set();
const nativeDescriptor = { name: "session_projcache", version: 7, layout: "per-record", tables: ["sessions"], hasGlobal: false, compatibleVersions: [3, 4, 5, 6] };
async function fixtureNative(options = {}) {
	const markerDir = fs.mkdtemp(join(root, ".native-test-markers-"));
	const markers = new DenyMarkers(await markerDir);
	await markers.init();
	const records = new Map(), live = new Map(), calls = [], order = [];
	let delegateClosed = false, id;
	const delegate = { kv: { open: async () => ({
		loadAll: async () => ({ tables: { sessions: Object.fromEntries(records) }, global: null }),
		putRecord: async (table, key, value) => { calls.push(key); records.set(key, value); },
		deleteRecord: async (_table, key) => records.delete(key),
		deleteRecords: async (_table, keys) => keys.forEach(key => records.delete(key)),
		setGlobal: async () => {}, close: async () => {},
	}) }, close: async () => { delegateClosed = true; } };
	const gate = new NativeCacheBackend(delegate, markers);
	const unit = await gate.kv.open(nativeDescriptor);
	await unit.loadAll();
	const domain = { table: name => { assert.equal(name, "sessions"); return { get: id => records.get(id) }; } };
	let currentDomain = domain;
	const storageDomain = { get: name => name === "session_projcache" ? currentDomain : undefined };
	const persistence = new JsonlSessionPersistence();
	const sessions = { get: id => live.get(id)?.session };
	const registryCalls = [];
	const workspaceRegistry = {
		list: () => [...nativeRegistrations.values()], get: id => nativeRegistrations.get(id),
		async create(path, title) {
			registryCalls.push(["create", path]);
			const existing = this.list().find(w => w.path === path);
			if (existing) return existing;
			const workspace = { id: randomUUID(), path, title, createdAt: new Date().toISOString(), sessionIds: [],
				async attachSession(id) {
					this.sessionIds.push(id);
					if (options.attachError) throw Error("workspace attach failed after write");
				},
				async detachSession(id) { this.sessionIds = this.sessionIds.filter(other => other !== id); },
			};
			nativeRegistrations.set(workspace.id, workspace);
			if (options.registrationError) throw Error("workspace create failed after write");
			return workspace;
		},
		async delete(id) {
			const workspace = this.get(id);
			assert.ok(existsSync(workspace.path), "registration deleted BEFORE owned directory");
			assert.deepEqual(workspace.sessionIds, []);
			if (options.registrationDeleteError) throw Error("workspace registry delete failed");
			registryCalls.push(["delete", id]); return nativeRegistrations.delete(id);
		},
		async unarchiveSession(id) { nativeArchived.delete(id); },
		async unpinSession(id) { nativePinned.delete(id); },
	};
	const mounts = [], selections = [], createOptions = [];
	const agents = { get: id => live.get(id), async create(opts) {
		createOptions.push(opts); id = opts.sessionId;
		assert.equal(await markers.has(id), true, "durable marker precedes Session/Agent construction");
		const rec = JSON.parse(readFileSync(join(root, ".btw-native-records", `${id}.json`), "utf8"));
		assert.equal(opts.meta.cwd, options.selectedWorkspacePath ?? nativeWorkspace(id));
		assert.notEqual(opts.meta.cwd, process.cwd(), "never implicitly grant launch workspace");
		assert.notEqual(opts.meta.cwd, process.env.HOME, "never implicitly grant user home");
		const work = JSON.parse(readFileSync(join(root, ".btw-native-workspace-records", `${id}.json`), "utf8"));
		assert.deepEqual(dirIdentity(nativeWorkspace(id)), work.dirIdentity, "reservation ownership is durable before Session creation");
		if (options.selectedWorkspacePath) {
			const binding = JSON.parse(readFileSync(join(root, ".btw-native-workspace-records", `${id}.external`), "utf8"));
			assert.equal(binding.path, options.selectedWorkspacePath);
			assert.deepEqual(dirIdentity(opts.meta.cwd), binding.dirIdentity);
		} else assert.deepEqual(readdirSync(opts.meta.cwd), [], "new workspace is empty");
		const project = `--${rec.cwd.replace(/^\/+/, "").replaceAll("/", "-").slice(0, 251)}--`;
		const dir = join(root, "sessions", project, id);
		nativeDirs.set(id, dir);
		assert.deepEqual(dirIdentity(dir), rec.dirIdentity);
		const path = join(dir, "session.v4.jsonl.zstd");
		writeFileSync(path, "synthetic-native-only");
		if (options.vanishingFile) writeFileSync(join(dir, "session.v4.jsonl.zstd.synthetic.tmp"), "writer temporary");
		persistence.items.set(id, { header: { id, cwd: opts.meta.cwd }, location: { kind: "jsonl", path } });
		await assert.rejects(unit.putRecord("sessions", id, { secret: "must never reach delegate" }), { code: "BTW_TOMBSTONED" });
		if (options.createError) throw Error("native create failed");
		const agent = { session: { header: { id }, append() { assert.fail("no policy/history append"); } },
			model: { select: selection => selections.push(selection) },
			cancel() { order.push("cancel"); },
			async whenIdle() { order.push("idle"); await options.idleGate?.promise; },
		};
		await opts.setup({}, agent);
		live.set(id, agent);
		const agentId = id;
		return { agent, async dispose() {
			order.push("dispose"); await options.disposeGate?.promise;
			if (options.disposeError) throw Error("native dispose failed");
			live.delete(agentId);
		} };
	} };
	const services = { agents, sessionPersistence: persistence, sessions, workspaceRegistry,
		agentPresets: { resolve: async () => ({ id: "ordinary-default" }), mount: async (_ctx, preset) => mounts.push(preset) },
		btwNativeCache: gate, storage: { backend: { get: name => { assert.equal(name, BACKEND); return gate; } } },
		storageDomain, sessionProjectionCache: {},
	};
	if (options.unrouted) currentDomain = undefined;
	const h = host({ tempModelMode: "custom", tempProvider: "ignored", tempModel: "ignored" }, services);
	return { h, markers, gate, unit, calls, records, mounts, selections, createOptions, order, workspaceRegistry, registryCalls, id: () => id,
		unroute: () => { currentDomain = { table: domain.table }; },
		delegateClosed: () => delegateClosed,
		finish: async () => { await h.cleanup(); await gate.close(); await fs.rm(markers.root, { recursive: true, force: true }); },
	};
}

test("nativeOpen requires explicit active route; unknown/foreign IDs are never false success", async () => {
	const plain = host();
	assert.match((await plain.call("nativeOpen", {})).error.message, /gate.*未配置/);
	assert.equal(plain.creations(), 0);
	assert.equal((await plain.call("nativeClose", { sessionId: randomUUID() })).ok, false);
	await plain.cleanup();
	for (const mode of ["unrouted", "later-overwrite", "unit-close", "backend-unload"]) {
		const f = await fixtureNative({ unrouted: mode === "unrouted" });
		if (mode === "later-overwrite") f.unroute();
		if (mode === "unit-close") await f.unit.close();
		if (mode === "backend-unload") await f.gate.close();
		const result = await f.h.call("nativeOpen", {});
		assert.equal(result.ok, false, mode);
		assert.match(result.error.message, /gate/);
		assert.equal(f.createOptions.length, 0);
		await f.finish();
	}
});

test("native root uses ordinary default preset/model, rejects source payloads and retains permanent deny markers", async () => {
	const f = await fixtureNative();
	for (const payload of [{ parentSessionId: "parent" }, { transcript: "private" }, { cwd: root }, { modelMode: "current" }, null, []]) {
		assert.equal((await f.h.call("nativeOpen", payload)).ok, false);
	}
	const response = await f.h.call("nativeOpen", {});
	assert.equal(response.ok, true, JSON.stringify(response));
	const id = response.value.sessionId;
	assert.deepEqual(Object.keys(response.value), ["sessionId"]);
	assert.deepEqual(f.createOptions[0].meta, { cwd: nativeWorkspace(id), agentPreset: "ordinary-default" });
	assert.equal(f.createOptions[0].parentAgent, undefined);
	const registered = f.workspaceRegistry.list().find(w => w.path === nativeWorkspace(id));
	assert.ok(registered);
	assert.deepEqual(registered.sessionIds, [id], "native hero has a real workspace chip membership");
	nativeArchived.add(id); nativePinned.add(id);
	nativeArchived.add("foreign-archive"); nativePinned.add("foreign-pin");
	assert.deepEqual(f.mounts, ["ordinary-default"]);
	assert.deepEqual(f.selections, [{ provider: "default", model: "d" }]);
	assert.deepEqual(f.calls, []);
	assert.equal((await f.h.call("send", { sessionId: id, text: "not a legacy child" })).ok, false);
	assert.deepEqual(await f.h.call("close", { sessionId: id }), { ok: true, value: { burned: false } });
	assert.deepEqual(await f.h.call("nativeClose", { sessionId: id }), { ok: true, value: { burned: true } });
	assert.deepEqual(f.order, ["cancel", "dispose", "idle"]);
	assert.equal(existsSync(nativeDir(id)), false);
	assert.equal(existsSync(nativeWorkspace(id)), false);
	assert.equal(f.workspaceRegistry.get(registered.id), undefined);
	assert.equal(nativeArchived.has(id), false); assert.equal(nativePinned.has(id), false);
	assert.equal(nativeArchived.has("foreign-archive"), true); assert.equal(nativePinned.has("foreign-pin"), true);
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.registry`)), false);
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.intent`)), false);
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.json`)), false);
	assert.equal(existsSync(join(root, ".btw-native-records", `${id}.json`)), false);
	assert.equal(await f.markers.has(id), true);
	// No empty record/workspace shells may outlive the burn.
	assert.equal(existsSync(dirname(nativeDir(id))), false);
	assert.equal(existsSync(dirname(nativeWorkspace(id))), false);
	await assert.rejects(f.unit.putRecord("sessions", id, { afterClose: true }), { code: "BTW_TOMBSTONED" });
	await f.unit.putRecord("sessions", "normal-control", { unchanged: true });
	assert.deepEqual(f.calls, ["normal-control"]);
	assert.deepEqual(await f.h.call("nativeClose", { sessionId: id }), { ok: true, value: { burned: true } });
	await f.finish();
	assert.equal(f.delegateClosed(), false, "borrowed JSON backend remains open");
});

test("native close waits for disposal then idle, failed close retains records and is retryable", async () => {
	const disposeGate = deferred(), idleGate = deferred();
	const options = { disposeGate, idleGate, disposeError: true };
	const f = await fixtureNative(options);
	const opened = await f.h.call("nativeOpen", {});
	assert.equal(opened.ok, true, JSON.stringify(opened));
	const id = opened.value.sessionId, path = nativeDir(id);
	const first = f.h.call("nativeClose", { sessionId: id });
	const second = f.h.call("nativeClose", { sessionId: id });
	await tick(); assert.equal(existsSync(path), true);
	disposeGate.resolve();
	assert.equal((await first).ok, false); assert.equal((await second).ok, false);
	assert.equal(existsSync(join(root, ".btw-native-records", `${id}.json`)), true);
	options.disposeError = false;
	const retry = f.h.call("nativeClose", { sessionId: id });
	await tick(); assert.equal(existsSync(path), true);
	idleGate.resolve();
	assert.equal((await retry).ok, true);
	await f.finish();
});

test("native creation failure removes only its owned JSONL and registered empty workspace", async () => {
	const f = await fixtureNative({ createError: true });
	const result = await f.h.call("nativeOpen", {});
	assert.equal(result.ok, false);
	assert.match(result.error.message, /native create failed/);
	const id = f.id();
	assert.equal(existsSync(nativeDir(id)), false);
	assert.equal(existsSync(nativeWorkspace(id)), false);
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.json`)), false);
	assert.equal(await f.markers.has(id), true);
	await f.finish();
});

test("native active verification tolerates only vanished children, while post-dispose deletion stays strict", async () => {
	const original = fs.lstat;
	for (const code of ["ENOENT", "EACCES"]) {
		const f = await fixtureNative({ vanishingFile: true });
		let injected = false;
		fs.lstat = async (path, ...rest) => {
			if (!injected && String(path).endsWith("session.v4.jsonl.zstd.synthetic.tmp")) {
				injected = true;
				if (code === "ENOENT") await fs.unlink(path); // writer rename/remove after readdir
				throw Object.assign(new Error(`synthetic concurrent ${code}`), { code, path });
			}
			return original(path, ...rest);
		};
		syncBuiltinESMExports();
		let result;
		try { result = await f.h.call("nativeOpen", {}); }
		finally { fs.lstat = original; syncBuiltinESMExports(); }
		assert.equal(injected, true);
		assert.equal(result.ok, code === "ENOENT", JSON.stringify(result));
		if (result.ok) assert.equal((await f.h.call("nativeClose", result.value)).ok, true);
		else assert.match(result.error.message, /EACCES/);
		await f.finish();
	}
	const f = await fixtureNative({ vanishingFile: true });
	const opened = await f.h.call("nativeOpen", {});
	assert.equal(opened.ok, true, JSON.stringify(opened));
	let injected = false;
	fs.lstat = async (path, ...rest) => {
		if (!injected && String(path).endsWith("session.v4.jsonl.zstd.synthetic.tmp")) {
			injected = true;
			throw Object.assign(new Error("synthetic strict ENOENT"), { code: "ENOENT", path });
		}
		return original(path, ...rest);
	};
	syncBuiltinESMExports();
	try {
		const close = await f.h.call("nativeClose", opened.value);
		assert.equal(close.ok, false); assert.match(close.error.message, /strict ENOENT/);
	} finally { fs.lstat = original; syncBuiltinESMExports(); }
	assert.equal(existsSync(join(root, ".btw-native-records", `${opened.value.sessionId}.json`)), true);
	assert.equal((await f.h.call("nativeClose", opened.value)).ok, true);
	await f.finish();
});

test("nativeOpen accepts explicit existing workspace without changing its other Sessions or data", async () => {
	const cwd = await fs.mkdtemp(join(root, "selected-user-workspace-"));
	writeFileSync(join(cwd, "user-sentinel"), "do not delete");
	const f = await fixtureNative({ selectedWorkspacePath: cwd });
	const workspace = await f.workspaceRegistry.create(cwd, "user project");
	workspace.sessionIds.push("source-session");
	const first = await f.h.call("nativeOpen", { workspaceId: workspace.id });
	const second = await f.h.call("nativeOpen", { workspaceId: workspace.id });
	assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(second.ok, true, JSON.stringify(second));
	assert.notEqual(first.value.sessionId, second.value.sessionId);
	assert.deepEqual(workspace.sessionIds, ["source-session", first.value.sessionId, second.value.sessionId]);
	for (const option of f.createOptions) {
		assert.deepEqual(option.meta, { cwd, agentPreset: "ordinary-default" });
		assert.equal(option.parentAgent, undefined); assert.equal(option.seed, undefined);
	}
	workspace.title = "renamed user project"; // title changes don't transfer identity
	assert.equal((await f.h.call("nativeClose", first.value)).ok, true);
	assert.deepEqual(workspace.sessionIds, ["source-session", second.value.sessionId]);
	assert.equal((await f.h.call("nativeClose", second.value)).ok, true);
	assert.deepEqual(workspace.sessionIds, ["source-session"]);
	assert.equal(f.workspaceRegistry.get(workspace.id), workspace);
	assert.equal(readFileSync(join(cwd, "user-sentinel"), "utf8"), "do not delete");
	assert.equal(f.registryCalls.some(row => row[0] === "delete"), false);
	assert.equal((await f.h.call("nativeOpen", { workspaceId: randomUUID() })).ok, false);
	assert.equal((await f.h.call("nativeOpen", { workspaceId: "bad" })).ok, false);
	nativeRegistrations.delete(workspace.id); await f.finish(); await fs.rm(cwd, { recursive: true });
});

test("selected workspace partial attach failure removes only the owned membership", async () => {
	const cwd = await fs.mkdtemp(join(root, "selected-attach-failure-"));
	writeFileSync(join(cwd, "user-sentinel"), "keep");
	const f = await fixtureNative({ selectedWorkspacePath: cwd, attachError: true });
	const workspace = await f.workspaceRegistry.create(cwd, "user");
	workspace.sessionIds.push("other");
	const result = await f.h.call("nativeOpen", { workspaceId: workspace.id });
	assert.equal(result.ok, false); assert.match(result.error.message, /attach failed/);
	assert.deepEqual(workspace.sessionIds, ["other"]);
	assert.equal(f.workspaceRegistry.get(workspace.id), workspace);
	assert.equal(readFileSync(join(cwd, "user-sentinel"), "utf8"), "keep");
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${f.id()}.json`)), false);
	nativeRegistrations.delete(workspace.id); await f.finish(); await fs.rm(cwd, { recursive: true });
});

test("selected workspace replacement or removal fails closed and preserves user directory and recovery records", async () => {
	for (const mode of ["deleted", "inode-changed", "replaced"]) {
		const cwd = await fs.mkdtemp(join(root, "selected-fault-"));
		writeFileSync(join(cwd, "user-sentinel"), "keep");
		const f = await fixtureNative({ selectedWorkspacePath: cwd });
		const workspace = await f.workspaceRegistry.create(cwd, "user");
		workspace.sessionIds.push("other");
		const opened = await f.h.call("nativeOpen", { workspaceId: workspace.id });
		assert.equal(opened.ok, true, JSON.stringify(opened));
		const id = opened.value.sessionId;
		let replacement;
		if (mode === "deleted") nativeRegistrations.delete(workspace.id);
		if (mode === "replaced") {
			replacement = { ...workspace, createdAt: "2000-01-01T00:00:00.000Z" };
			nativeRegistrations.set(workspace.id, replacement);
		}
		if (mode === "inode-changed") { renameSync(cwd, `${cwd}.old`); mkdirSync(cwd); writeFileSync(join(cwd, "foreign"), "keep"); }
		const close = await f.h.call("nativeClose", { sessionId: id });
		assert.equal(close.ok, false, mode);
		assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.json`)), true);
		assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.external`)), true);
		assert.ok(workspace.sessionIds.includes("other"));
		if (mode === "inode-changed") { assert.equal(readFileSync(join(cwd, "foreign"), "utf8"), "keep"); rmSync(cwd, { recursive: true }); renameSync(`${cwd}.old`, cwd); }
		nativeRegistrations.set(workspace.id, workspace);
		assert.equal((await f.h.call("nativeClose", { sessionId: id })).ok, true);
		assert.deepEqual(workspace.sessionIds, ["other"]);
		assert.equal(readFileSync(join(cwd, "user-sentinel"), "utf8"), "keep");
		nativeRegistrations.delete(workspace.id); await f.finish(); await fs.rm(cwd, { recursive: true });
	}
});

test("selected workspace crash recovery detaches only the owned id", async () => {
	const cwd = await fs.mkdtemp(join(root, "selected-recovery-"));
	writeFileSync(join(cwd, "user-sentinel"), "keep");
	const options = { selectedWorkspacePath: cwd, disposeError: true };
	const f = await fixtureNative(options), workspace = await f.workspaceRegistry.create(cwd, "user");
	workspace.sessionIds.push("other");
	const opened = await f.h.call("nativeOpen", { workspaceId: workspace.id });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	const id = opened.value.sessionId;
	await f.h.cleanup();
	for (const dir of [".btw-native-records", ".btw-native-workspace-records"]) {
		const path = join(root, dir, `${id}.json`), record = JSON.parse(readFileSync(path, "utf8"));
		record.owner.bootId = "00000000-0000-0000-0000-000000000000";
		writeFileSync(path, JSON.stringify(record));
	}
	const recovered = await fixtureNative();
	const fresh = await recovered.h.call("nativeOpen", {});
	assert.equal(fresh.ok, true, JSON.stringify(fresh));
	assert.deepEqual(workspace.sessionIds, ["other"]);
	assert.equal(recovered.workspaceRegistry.get(workspace.id), workspace);
	assert.equal(readFileSync(join(cwd, "user-sentinel"), "utf8"), "keep");
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.external`)), false);
	await recovered.finish(); options.disposeError = false; await f.finish();
	nativeRegistrations.delete(workspace.id); await fs.rm(cwd, { recursive: true });
});

test("native registration create/attach failures clean their durable partial writes without a fake success", async () => {
	for (const option of ["registrationError", "attachError"]) {
		const f = await fixtureNative({ [option]: true });
		const result = await f.h.call("nativeOpen", {});
		assert.equal(result.ok, false, option);
		assert.match(result.error.message, /workspace .*failed/);
		const path = f.registryCalls.find(row => row[0] === "create")[1], id = path.split("/").at(-1);
		assert.equal(existsSync(path), false);
		assert.equal(f.workspaceRegistry.list().some(w => w.path === path), false);
		assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.json`)), false);
		assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.intent`)), false);
		assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.registry`)), false);
		await f.finish();
	}
});

test("native registry deletion refuses foreign references/replaced IDs and remains retryable after errors", async () => {
	for (const fault of ["foreign-reference", "replaced-id", "delete-error"]) {
		const options = {}, f = await fixtureNative(options);
		const opened = await f.h.call("nativeOpen", {});
		assert.equal(opened.ok, true, JSON.stringify(opened));
		const id = opened.value.sessionId, path = nativeWorkspace(id);
		const w = f.workspaceRegistry.list().find(w => w.path === path);
		let replacement;
		if (fault === "foreign-reference") w.sessionIds.push("foreign-session");
		if (fault === "replaced-id") {
			nativeRegistrations.delete(w.id); replacement = { ...w, id: randomUUID() };
			nativeRegistrations.set(replacement.id, replacement);
		}
		if (fault === "delete-error") options.registrationDeleteError = true;
		const close = await f.h.call("nativeClose", { sessionId: id });
		assert.equal(close.ok, false, fault);
		assert.equal(existsSync(path), true);
		assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.json`)), true);
		assert.ok(f.workspaceRegistry.get(replacement?.id ?? w.id));
		if (fault === "foreign-reference") { assert.ok(w.sessionIds.includes("foreign-session")); w.sessionIds = [id]; }
		if (fault === "replaced-id") { nativeRegistrations.delete(replacement.id); nativeRegistrations.set(w.id, w); }
		options.registrationDeleteError = false;
		assert.equal((await f.h.call("nativeClose", { sessionId: id })).ok, true);
		await f.finish();
	}
});

test("native workspace substitution fails closed and retry never removes a foreign directory", async () => {
	const f = await fixtureNative();
	const result = await f.h.call("nativeOpen", {});
	assert.equal(result.ok, true, JSON.stringify(result));
	const id = result.value.sessionId, work = nativeWorkspace(id), saved = `${work}.owned`;
	renameSync(work, saved); mkdirSync(work); writeFileSync(join(work, "foreign-sentinel"), "keep");
	const close = await f.h.call("nativeClose", { sessionId: id });
	assert.equal(close.ok, false);
	assert.match(close.error.message, /身份已改变/);
	assert.equal(readFileSync(join(work, "foreign-sentinel"), "utf8"), "keep");
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.json`)), true);
	assert.ok(f.workspaceRegistry.list().some(w => w.path === work), "inode failure must not remove the registration");
	rmSync(work, { recursive: true }); renameSync(saved, work);
	assert.equal((await f.h.call("nativeClose", { sessionId: id })).ok, true);
	await f.finish();
});

test("native orphan recovery checks owner/inodes, cleans JSONL before workspace, and retains deny markers", async () => {
	const options = { disposeError: true };
	const abandoned = await fixtureNative(options);
	const result = await abandoned.h.call("nativeOpen", {});
	assert.equal(result.ok, true, JSON.stringify(result));
	const id = result.value.sessionId;
	await abandoned.h.cleanup(); // simulate a teardown failure; both durable records survive
	// Model the create-return/ID-publication crash window: durable intent and
	// owned inode remain, but the final registry-ID binding never published.
	rmSync(join(root, ".btw-native-workspace-records", `${id}.registry`));
	nativeArchived.add(id); nativePinned.add(id);
	for (const dir of [".btw-native-records", ".btw-native-workspace-records"]) {
		const path = join(root, dir, `${id}.json`), record = JSON.parse(readFileSync(path, "utf8"));
		record.owner.bootId = "00000000-0000-0000-0000-000000000000"; // prior boot, as in existing recovery tests
		writeFileSync(path, JSON.stringify(record));
	}
	const recovered = await fixtureNative();
	const fresh = await recovered.h.call("nativeOpen", {});
	assert.equal(fresh.ok, true, JSON.stringify(fresh));
	assert.equal(existsSync(nativeDir(id)), false);
	assert.equal(existsSync(nativeWorkspace(id)), false);
	assert.equal(existsSync(join(root, ".btw-native-workspace-records", `${id}.json`)), false);
	assert.equal(await abandoned.markers.has(id), true);
	assert.equal(recovered.workspaceRegistry.list().some(w => w.path === nativeWorkspace(id)), false);
	assert.equal(nativeArchived.has(id), false); assert.equal(nativePinned.has(id), false);
	assert.equal(nativeArchived.has("foreign-archive"), true); assert.equal(nativePinned.has("foreign-pin"), true);
	await recovered.finish();
	options.disposeError = false;
	await abandoned.finish();
});

test("native gate rejects descriptor drift, corrupt markers and symlinks before delegating; other domains pass", async () => {
	const f = await fixtureNative();
	for (const patch of [{ version: 8 }, { layout: "single" }, { tables: ["sessions", "other"] }, { hasGlobal: true }, { compatibleVersions: [] }]) {
		await assert.rejects(f.gate.kv.open({ ...nativeDescriptor, ...patch }), /未知.*格式/);
	}
	const id = randomUUID();
	writeFileSync(f.markers.path(id), "{", { mode: 0o600 });
	await assert.rejects(f.unit.putRecord("sessions", id, {}));
	assert.deepEqual(f.calls, []);
	const symlinkId = randomUUID();
	symlinkSync(f.markers.path(id), f.markers.path(symlinkId));
	await assert.rejects(f.unit.putRecord("sessions", symlinkId, {}));
	const another = await f.gate.kv.open({ name: "unrelated" });
	await another.putRecord("sessions", id, {});
	assert.deepEqual(f.calls, [id]);
	await f.finish();
});

// No fixture ever opens a real model or real user session.
test("catalog projection and volatile host schema", async () => {
	assert.ok(Config);
	const h = host();
	assert.deepEqual(await h.call("models", {}), { ok: true, value: { providers: [{ id: "mock", models: [{ id: "m", name: "Model" }] }] } });
	await h.cleanup();
});

test("request modelMode overrides config; explicit model is custom; current never falls back", async () => {
	const h = host({ askModelMode: { get: () => "current" } }, { agents: { get: id => id === "parent" ? { model: { current: () => parentModel } } : undefined } });
	for (const payload of [{}, { parentSessionId: "missing" }, { modelMode: "custom" }, { modelMode: "invalid" }, { model: {} }]) {
		assert.equal((await h.call("ask", { question: "q", ...payload })).ok, false);
	}
	assert.equal((await askResult(h, { parentSessionId: "parent" })).error, null);
	assert.equal(h.request().provider, "parent");
	assert.equal(h.request().reasoningEffort, "low");
	await askResult(h, { modelMode: "host" });
	assert.equal(h.request().provider, "default");
	await askResult(h, { modelMode: "current", model: { provider: "p", model: "m", reasoningEffort: "high" }, contextMode: "none", transcript: "private" });
	assert.equal(h.request().provider, "p");
	assert.equal(h.request().reasoningEffort, "high");
	assert.equal(h.request().messages[0].content[0].text, "q");
	await h.cleanup();

	const f = fixtureTemp({}, { tempModelMode: "custom" });
	assert.equal((await f.h.call("open", {})).ok, false);
	assert.equal((await f.h.call("open", { modelMode: "current", parentSessionId: "missing" })).ok, false);
	for (const [payload, provider] of [[{ modelMode: "host" }, "default"], [{ modelMode: "current", parentSessionId: "parent" }, "parent"], [{ modelMode: "host", model: { provider: "custom", model: "x" } }, "custom"]]) {
		const id = await opened(f, payload);
		const assembly = await f.selectionHooks.at(-1)({}, {}, async () => ({ variables: {} }));
		assert.equal(assembly.variables.provider, provider);
		assert.equal(f.selections.at(-1).provider, provider);
		await closed(f, id);
	}
	await f.h.cleanup();
});

test("provider errors, aborted streams and empty answers never become success", async () => {
	for (const chunks of [
		[{ type: "error", error: { message: "provider rejected" } }],
		[{ type: "text-delta", text: "partial" }, { type: "error", message: "stream failed" }],
		[{ type: "aborted" }],
		[{ type: "finish", reason: { kind: "error" } }],
		[{ type: "finish", reason: { kind: "stop" } }],
		[{ type: "text-delta", text: "truncated, no finish" }],
		[{ type: "text-delta", text: "truncated" }, { type: "finish" }],
		[],
	]) {
		const h = host({}, { llm: { async *stream() { yield* chunks; } } });
		const result = await askResult(h);
		assert.ok(result.error);
		await h.cleanup();
	}
	const gate = deferred();
	const h = host({}, { llm: { async *stream() { await gate.promise; yield { type: "text-delta", text: "late answer" }; } } });
	const start = await h.call("ask", { question: "q" });
	await h.call("askCancel", start.value);
	let poll = await h.call("askPoll", start.value);
	assert.equal(poll.value.done, true);
	assert.match(poll.value.error, /取消/);
	gate.resolve(); await tick();
	poll = await h.call("askPoll", start.value);
	assert.equal(poll.value.text, "");
	assert.match(poll.value.error, /取消/);
	await h.cleanup();
});

function searchLlm(requests, query = "needle", options = {}) {
	let round = 0;
	return { async *stream(opts) {
		requests.push(opts);
		if (options.stall) { await new Promise(resolve => opts.signal.addEventListener("abort", resolve, { once: true })); return; }
		if (options.bad) { yield { type: "finish", reason: { kind: "error" } }; return; }
		if (round++ % 2 === 0) {
			yield { type: "tool-call-delta", index: 0, id: randomUUID(), name: "search_snapshot", argumentsDelta: JSON.stringify({ query }) };
			yield { type: "finish", reason: { kind: "tool-calls" } };
		} else {
			yield { type: "text-delta", index: 0, text: "snapshot evidence" };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	} };
}

test("ask on-demand uses tools over only the last 48k snapshot, and fails closed", async () => {
	const requests = [];
	const h = host({}, { llm: searchLlm(requests, "old-secret") });
	const result = await askResult(h, { contextMode: "on-demand", transcript: "old-secret" + "x".repeat(48000) });
	assert.equal(result.error, null);
	assert.equal(result.text, "snapshot evidence");
	assert.equal(requests[0].tools[0].name, "search_snapshot");
	assert.equal(requests[0].messages[0].content[0].text, "q");
	assert.deepEqual(JSON.parse(requests[1].messages[2].content[0].text).results, []);
	assert.match(requests[0].system, /not the full history/);
	assert.equal((await h.call("ask", { question: "q", contextMode: "on-demand" })).ok, false);
	await h.cleanup();
	const badRequests = [];
	const bad = host({}, { llm: searchLlm(badRequests, "x", { bad: true }) });
	assert.match((await askResult(bad, { contextMode: "on-demand", transcript: "x" })).error, /error/);
	assert.equal(badRequests.length, 1, "no fallback request");
	await bad.cleanup();
});

test("on-demand distinguishes missing snapshots, model no-tool responses and public adapter failures", async () => {
	for (const [chunks, expected] of [
		[[{ type: "text-delta", index: 0, text: "guess" }, { type: "finish", reason: { kind: "stop" } }], /required snapshot search.*support tool calls/],
		[[{ type: "finish", reason: { kind: "error", failure: { code: "UNSUPPORTED_TOOLS", message: "Synthetic model does not support tools" } } }], /UNSUPPORTED_TOOLS.*Synthetic model does not support tools/],
	]) {
		const requests = [];
		const h = host({}, { llm: { async *stream(opts) { requests.push(opts); yield* chunks; } } });
		try {
			const absent = await h.call("ask", { question: "q", contextMode: "on-demand", transcript: " " });
			assert.equal(absent.ok, false);
			assert.match(absent.error.message, /近期快照/);
			assert.equal(requests.length, 0, "absent snapshot never reaches the model");
			const result = await askResult(h, { contextMode: "on-demand", transcript: "synthetic evidence", modelMode: "custom", model: { provider: "chosen", model: "chosen-model", reasoningEffort: "low" } });
			assert.match(result.error, expected);
			assert.equal(result.text, "");
			assert.equal(requests.length, 1, "model failure never changes context scope or falls back");
			assert.equal(requests[0].provider, "chosen");
			assert.equal(requests[0].model, "chosen-model");
			assert.equal(requests[0].reasoningEffort, "low");
		} finally { await h.cleanup(); }
	}
});

test("on-demand cancellation aborts the model and prevents later output", async () => {
	const requests = [];
	const h = host({}, { llm: searchLlm(requests, "x", { stall: true }) });
	const response = await h.call("ask", { question: "q", contextMode: "on-demand", transcript: "x" });
	await h.call("askCancel", response.value);
	await tick();
	assert.equal(requests[0].signal.aborted, true);
	const poll = await h.call("askPoll", response.value);
	assert.ok(poll.value.done && poll.value.error);
	assert.equal(poll.value.text, "");
	await h.cleanup();
});

test("default backend reserves exclusively; close preserves project and normal-session sentinels", async () => {
	for (const cwd of [root, undefined]) {
		const f = fixtureTemp();
		const id = await opened(f, cwd ? { cwd } : {});
		assert.equal(f.mounted.includes("dsh-tool-bash"), Boolean(cwd));
		assert.equal(f.mounted.includes("dsh-tool-fs"), Boolean(cwd));
		const path = f.persistence.items.get(id).location.path;
		const project = dirname(dirname(path));
		const normal = join(project, "normal-session", "sentinel");
		mkdirSync(dirname(normal), { recursive: true }); writeFileSync(normal, "keep");
		const projectSentinel = join(root, "project-sentinel"); writeFileSync(projectSentinel, "keep");
		await closed(f, id);
		assert.equal(existsSync(path), false);
		assert.equal(readFileSync(normal, "utf8"), "keep");
		assert.equal(readFileSync(projectSentinel, "utf8"), "keep");
		assert.deepEqual(await f.h.call("close", { sessionId: id }), { ok: true, value: { burned: false } });
		await f.h.cleanup();
	}
});

test("pending sessions without stat/location still clean up by reservation identity", async () => {
	for (const options of [{ noLocation: true }, { noLocation: true, noStat: true }]) {
		const f = fixtureTemp(options);
		const id = await opened(f);
		await closed(f, id);
		await f.h.cleanup();
	}
});

test("create/setup failures clean up; disposal and location failures retain recovery evidence", async () => {
	for (const options of [{ createError: true }, { setupError: true }]) {
		const f = fixtureTemp(options);
		const response = await f.h.call("open", {});
		assert.equal(response.ok, false);
		assert.match(response.error.message, /已清理/);
		assert.equal(existsSync(recordPath(f.id())), false);
		assert.equal(existsSync(join(root, "sessions", "_no-cwd", f.id())), false);
		await f.h.cleanup();
	}
	for (const options of [{ disposeError: true }, { badLocation: true }]) {
		const f = fixtureTemp(options);
		const response = await f.h.call("open", {});
		if (response.ok) assert.equal((await f.h.call("close", response.value)).ok, false);
		else assert.match(response.error.message, /保留恢复记录/);
		assert.equal(existsSync(recordPath(f.id())), true);
		assert.equal(existsSync(join(root, "sessions", "_no-cwd", f.id())), true);
		options.disposeError = false;
		const item = f.persistence.items.get(f.id()); if (item?.location) item.location.kind = "jsonl";
		if (response.ok) await closed(f, f.id());
		else { rmSync(join(root, "sessions", "_no-cwd", f.id()), { recursive: true }); rmSync(recordPath(f.id())); }
		await f.h.cleanup();
	}
});

test("concurrent close shares disposal, fences sends and waits for in-flight sends", async () => {
	const disposeGate = deferred(), idleGate = deferred();
	const f = fixtureTemp({ disposeGate, idleGate });
	const id = await opened(f);
	const send = f.h.call("send", { sessionId: id, text: "hello" });
	assert.equal((await f.h.call("send", { sessionId: id, text: "again" })).ok, false);
	let settled = false;
	const c1 = f.h.call("close", { sessionId: id }).then(result => { settled = true; return result; });
	const c2 = f.h.call("close", { sessionId: id });
	assert.equal((await f.h.call("send", { sessionId: id, text: "too late" })).ok, false);
	await tick(); assert.equal(settled, false);
	assert.equal(existsSync(recordPath(id)), true);
	disposeGate.resolve();
	assert.equal((await send).ok, false);
	assert.deepEqual(await c1, { ok: true, value: { burned: true } });
	assert.deepEqual(await c2, { ok: true, value: { burned: true } });
	assert.equal(f.disposals(), 1);
	await f.h.cleanup();
});

test("delete validation failure is retryable; no new send after a failed close", async () => {
	const f = fixtureTemp();
	const id = await opened(f), dir = dirname(f.persistence.items.get(id).location.path);
	const outside = join(root, "outside-sentinel"); writeFileSync(outside, "keep");
	symlinkSync(outside, join(dir, "unsafe"));
	assert.equal((await f.h.call("close", { sessionId: id })).ok, false);
	assert.equal(existsSync(recordPath(id)), true);
	assert.equal((await f.h.call("send", { sessionId: id, text: "no" })).ok, false);
	assert.equal(readFileSync(outside, "utf8"), "keep");
	rmSync(join(dir, "unsafe"));
	await closed(f, id);
	assert.equal(f.disposals(), 1);
	await f.h.cleanup();
});

test("directory substitution, provider replacement and custom roots fail closed", async () => {
	const f = fixtureTemp();
	const id = await opened(f), dir = dirname(f.persistence.items.get(id).location.path), saved = `${dir}.saved`;
	renameSync(dir, saved); mkdirSync(dir); writeFileSync(join(dir, "sentinel"), "keep");
	assert.equal((await f.h.call("close", { sessionId: id })).ok, false);
	assert.equal(readFileSync(join(dir, "sentinel"), "utf8"), "keep");
	rmSync(dir, { recursive: true }); renameSync(saved, dir);
	const old = f.h.services.sessionPersistence;
	f.h.services.sessionPersistence = new JsonlSessionPersistence();
	assert.equal((await f.h.call("close", { sessionId: id })).ok, false);
	assert.equal(existsSync(recordPath(id)), true);
	f.h.services.sessionPersistence = old;
	await closed(f, id);
	await f.h.cleanup();
	const custom = new JsonlSessionPersistence(); custom.root = join(root, "custom"); custom.config.root = custom.root;
	const h = host({}, { sessionPersistence: custom });
	assert.equal((await h.call("open", {})).ok, false);
	assert.equal(h.creations(), 0);
	assert.equal(existsSync(custom.root), false);
	await h.cleanup();
});

test("record-directory symlinks and unverified backends refuse creation", async () => {
	const missing = host();
	assert.equal((await missing.call("open", {})).ok, false);
	assert.equal(missing.creations(), 0);
	await missing.cleanup();
	const saved = `${recordRoot}.saved`, target = join(root, "record-sentinel");
	mkdirSync(target); writeFileSync(join(target, "keep"), "keep");
	renameSync(recordRoot, saved); symlinkSync(target, recordRoot);
	try {
		const f = fixtureTemp();
		assert.equal((await f.h.call("open", {})).ok, false);
		assert.equal(f.creations(), 0);
		assert.equal(readFileSync(join(target, "keep"), "utf8"), "keep");
		await f.h.cleanup();
	} finally { rmSync(recordRoot); renameSync(saved, recordRoot); }
});

test("temporary on-demand prepares bounded evidence, fails without fallback, and closes during search", async () => {
	const requests = [];
	const f = fixtureTemp({ services: { llm: searchLlm(requests) } });
	const id = await opened(f, { contextMode: "on-demand", transcript: "needle in snapshot" });
	assert.equal((await f.h.call("send", { sessionId: id, text: "where?" })).ok, true);
	assert.equal(requests[0].tools[0].name, "search_snapshot");
	assert.match(f.messages[0].content[0].text, /snapshot evidence/);
	assert.doesNotMatch(f.messages[0].content[0].text, /needle in snapshot/);
	await closed(f, id); await f.h.cleanup();
	for (const options of [{ bad: true }, { stall: true }]) {
		const requests = [], f = fixtureTemp({ services: { llm: searchLlm(requests, "x", options) } });
		const id = await opened(f, { contextMode: "on-demand", transcript: "x" });
		const send = f.h.call("send", { sessionId: id, text: "q" });
		if (options.stall) { await tick(); await closed(f, id); }
		assert.equal((await send).ok, false);
		assert.equal(f.messages.length, 0, "no raw-snapshot fallback");
		if (!options.stall) await closed(f, id);
		await f.h.cleanup();
	}
});

async function makeOrphan(owner, extra = {}) {
	const id = randomUUID(), project = join(root, "sessions", "_no-cwd"), dir = join(project, id);
	mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "session.v4.jsonl.zstd"), "orphan");
	const record = { version: 2, kind: "btw-default-jsonl-temp", backend: "jsonl", runtime: "0.2.2-rc.1", id, cwd: null,
		root: join(root, "sessions"), rootIdentity: dirIdentity(join(root, "sessions")), projectIdentity: dirIdentity(project), dirIdentity: dirIdentity(dir), owner, ...extra };
	writeFileSync(recordPath(id), JSON.stringify(record));
	return { id, dir, record };
}
function ownerFor(pid) {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return { pid, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), startTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] };
}
async function triggerRecovery() {
	const f = fixtureTemp(), id = await opened(f);
	await closed(f, id); await f.h.cleanup();
}

test("startup recovery preserves live owners and legacy/malformed records; reclaims killed owners", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	try {
		const orphan = await makeOrphan(ownerFor(child.pid));
		await triggerRecovery();
		assert.equal(existsSync(orphan.dir), true, "live process is never swept");
		const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
		await Promise.all([triggerRecovery(), triggerRecovery()]);
		assert.equal(existsSync(orphan.dir), false);
		assert.equal(existsSync(recordPath(orphan.id)), false);
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); }
	const legacy = join(root, ".btw-temps.json"); writeFileSync(legacy, '[{"id":"not-owned"}]');
	const malformed = join(recordRoot, "malformed.json"); writeFileSync(malformed, "{");
	await triggerRecovery();
	assert.equal(readFileSync(legacy, "utf8"), '[{"id":"not-owned"}]');
	assert.equal(readFileSync(malformed, "utf8"), "{");
});

test("recovery validates inode and record schema; PID reuse does not suppress orphan recovery", async () => {
	const owner = ownerFor(process.pid);
	const reused = await makeOrphan({ ...owner, startTicks: String(BigInt(owner.startTicks) + 1n) });
	const changed = await makeOrphan({ ...owner, bootId: "00000000-0000-0000-0000-000000000000" });
	const saved = `${changed.dir}.saved`; renameSync(changed.dir, saved); mkdirSync(changed.dir); writeFileSync(join(changed.dir, "sentinel"), "keep");
	const invalid = await makeOrphan({ ...owner, bootId: "00000000-0000-0000-0000-000000000000" }, { version: 1 });
	await triggerRecovery();
	assert.equal(existsSync(reused.dir), false);
	assert.equal(readFileSync(join(changed.dir, "sentinel"), "utf8"), "keep");
	assert.equal(existsSync(recordPath(changed.id)), true);
	assert.equal(existsSync(invalid.dir), true);
	rmSync(changed.dir, { recursive: true }); renameSync(saved, changed.dir);
	await triggerRecovery();
	assert.equal(existsSync(changed.dir), false);
});

test("UUID collisions never reuse or remove an existing session directory", async () => {
	const id = randomUUID(), dir = join(root, "sessions", "_no-cwd", id);
	mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "sentinel"), "keep");
	const original = crypto.randomUUID;
	let calls = 0;
	crypto.randomUUID = () => calls++ === 0 ? id : original();
	syncBuiltinESMExports();
	try {
		const f = fixtureTemp(), fresh = await opened(f);
		assert.notEqual(fresh, id);
		await closed(f, fresh); await f.h.cleanup();
		assert.equal(readFileSync(join(dir, "sentinel"), "utf8"), "keep");
	} finally { crypto.randomUUID = original; syncBuiltinESMExports(); }
});

test("record publication and filesystem deletion faults fail safely and remain retryable", async () => {
	const originalOpen = fs.open;
	fs.open = async (path, ...args) => {
		if (String(path).endsWith(".pending")) throw Object.assign(Error("record write denied"), { code: "EACCES" });
		return originalOpen(path, ...args);
	};
	syncBuiltinESMExports();
	try {
		const before = readdirSync(join(root, "sessions", "_no-cwd")).sort();
		const f = fixtureTemp();
		const result = await f.h.call("open", {});
		assert.equal(result.ok, false);
		assert.equal(f.creations(), 0);
		assert.deepEqual(readdirSync(join(root, "sessions", "_no-cwd")).sort(), before, "failed registration leaves no owned content");
		await f.h.cleanup();
	} finally { fs.open = originalOpen; syncBuiltinESMExports(); }

	const f = fixtureTemp(), id = await opened(f), dir = dirname(f.persistence.items.get(id).location.path);
	const originalRm = fs.rm;
	fs.rm = async (path, ...args) => {
		if (path === dir) throw Object.assign(Error("delete denied"), { code: "EACCES" });
		return originalRm(path, ...args);
	};
	syncBuiltinESMExports();
	try {
		assert.equal((await f.h.call("close", { sessionId: id })).ok, false);
		assert.equal(existsSync(recordPath(id)), true);
		assert.equal(existsSync(dir), true);
	} finally { fs.rm = originalRm; syncBuiltinESMExports(); }
	await closed(f, id); assert.equal(f.disposals(), 1); await f.h.cleanup();

	const retry = fixtureTemp(), retryId = await opened(retry);
	const originalUnlink = fs.unlink;
	fs.unlink = async path => {
		if (path === recordPath(retryId)) throw Object.assign(Error("record unlink denied"), { code: "EACCES" });
		return originalUnlink(path);
	};
	syncBuiltinESMExports();
	try {
		assert.equal((await retry.h.call("close", { sessionId: retryId })).ok, false);
		assert.equal(existsSync(recordPath(retryId)), true);
		assert.equal(existsSync(dirname(retry.persistence.items.get(retryId).location.path)), false);
	} finally { fs.unlink = originalUnlink; syncBuiltinESMExports(); }
	await closed(retry, retryId); assert.equal(retry.disposals(), 1); await retry.h.cleanup();
});

test("non-rc.1 installation is rejected before agent creation", async () => {
	const path = join(dirname(anchor), "node_modules", "@deepseek-ai", "dsh-agent-loop", "package.json");
	const original = readFileSync(path, "utf8");
	writeFileSync(path, original.replace("0.2.2-rc.1", "0.2.2-rc.2"));
	try {
		const f = fixtureTemp();
		assert.equal((await f.h.call("open", {})).ok, false);
		assert.equal(f.creations(), 0);
		await f.h.cleanup();
	} finally { writeFileSync(path, original); }
});

const allPayload = transcript => ({ contextMode: "all", transcript, parentSessionId: "parent",
	contextSnapshot: { sessionId: "parent", throughSeq: 42, complete: true, authorized: true } });
const allTranscript = "User: first message " + "a".repeat(3000) + "\nAssistant: earlier decision\nTool: exact full tool text\n" + "b".repeat(57000) + "\nUser: final recorded message";
const largeModelInfo = async (provider, id) => {
	assert.equal(provider, "default"); assert.equal(id, "d");
	return { provider, id, context: { contextWindow: 2_000_000 } };
};

test("all preserves the first long message and >48k of recorded user/assistant/tool text", async () => {
	const h = host(); h.services.llm.resolveModelInfo = largeModelInfo;
	assert.equal((await askResult(h, allPayload(allTranscript))).error, null);
	const first = h.request(), body = first.messages[0].content[0].text;
	assert.ok(allTranscript.length > 48000);
	assert.ok(body.includes(allTranscript), "all bypasses both 1600-character and 48k recent limits");
	assert.match(body, /complete recorded source text/);
	assert.ok(body.endsWith("<question>\nq\n</question>"));
	assert.equal(first.maxTokens, 8192);
	assert.doesNotMatch(first.system, /provider.*hit|cache.*hit/i);
	await askResult(h, { ...allPayload(allTranscript), question: "second question" });
	const second = h.request();
	assert.equal(second.system, first.system);
	assert.equal(second.messages[0].content[0].text.split("<question>")[0], body.split("<question>")[0], "fixed system/history prefix; only the final question changes");
	await h.cleanup();
});

test("all requires explicit matching source, completeness, authorization and valid text", async () => {
	const h = host(); h.services.llm.resolveModelInfo = largeModelInfo;
	const valid = allPayload("User: authorized recorded text");
	for (const override of [
		{ parentSessionId: undefined }, { parentSessionId: "" }, { parentSessionId: "other" },
		{ contextSnapshot: undefined },
		{ contextSnapshot: { ...valid.contextSnapshot, complete: false } },
		{ contextSnapshot: { ...valid.contextSnapshot, authorized: undefined } },
		{ contextSnapshot: { ...valid.contextSnapshot, sessionId: "other" } },
		{ contextSnapshot: { ...valid.contextSnapshot, throughSeq: -1 } },
		{ contextSnapshot: { ...valid.contextSnapshot, throughSeq: 1.5 } },
		{ contextSnapshot: { ...valid.contextSnapshot, throughSeq: Number.MAX_SAFE_INTEGER + 1 } },
		{ transcript: undefined }, { transcript: " " }, { transcript: {} },
		{ transcript: "bad\ud800text" }, { transcript: "x".repeat(1024 * 1024 + 1) },
	]) {
		const result = await h.call("ask", { question: "q", ...valid, ...override });
		assert.equal(result.ok, false, JSON.stringify(override));
	}
	assert.equal(h.request(), undefined, "validation failure never calls a model");
	await h.cleanup();
	const f = fixtureTemp(); f.h.services.llm.resolveModelInfo = largeModelInfo;
	assert.equal((await f.h.call("open", { ...valid, parentSessionId: undefined })).ok, false);
	assert.equal((await f.h.call("open", { ...valid, contextSnapshot: { ...valid.contextSnapshot, authorized: false } })).ok, false);
	assert.equal(f.creations(), 0);
	await f.h.cleanup();
});

test("all refuses unknown or insufficient selected-model contextWindow, without truncation or fallback", async () => {
	for (const info of [
		undefined,
		{ provider: "other", id: "d", context: { contextWindow: 2_000_000 } },
		{ provider: "default", id: "other", context: { contextWindow: 2_000_000 } },
		{ provider: "default", id: "d" },
		{ provider: "default", id: "d", context: { contextWindow: 32768 } },
	]) {
		const h = host(); h.services.llm.resolveModelInfo = async () => info;
		const result = await askResult(h, allPayload(allTranscript));
		assert.match(result.error, /contextWindow/);
		assert.equal(h.request(), undefined);
		await h.cleanup();
		const f = fixtureTemp(); f.h.services.llm.resolveModelInfo = async () => info;
		const before = files().length;
		const response = await f.h.call("open", allPayload(allTranscript));
		assert.equal(response.ok, false); assert.match(response.error.message, /contextWindow/);
		assert.equal(f.creations(), 0); assert.equal(files().length, before);
		await f.h.cleanup();
	}
});

test("temporary all injects exactly once and retains its own conversation for later turns", async () => {
	const f = fixtureTemp(); f.h.services.llm.resolveModelInfo = largeModelInfo;
	const id = await opened(f, allPayload(allTranscript));
	assert.equal((await f.h.call("send", { sessionId: id, text: "first question" })).ok, true);
	const first = f.messages[0].content[0].text;
	assert.ok(first.includes(allTranscript));
	assert.ok(first.endsWith("<question>\nfirst question\n</question>"));
	assert.equal((await f.h.call("send", { sessionId: id, text: "remember the first answer" })).ok, true);
	assert.equal(f.messages[1].content[0].text, "remember the first answer", "do not inject the source twice or clear the child conversation");
	await closed(f, id); await f.h.cleanup();
});

test("temporary all rechecks first-question capacity before consuming the full snapshot", async () => {
	const f = fixtureTemp(); f.h.services.llm.resolveModelInfo = async () => ({ provider: "default", id: "d", context: { contextWindow: 160000 } });
	const id = await opened(f, allPayload("a".repeat(50000)));
	const rejected = await f.h.call("send", { sessionId: id, text: "q".repeat(30000) });
	assert.equal(rejected.ok, false); assert.match(rejected.error.message, /contextWindow/);
	assert.equal(f.messages.length, 0);
	assert.equal((await f.h.call("send", { sessionId: id, text: "short question" })).ok, true);
	assert.ok(f.messages[0].content[0].text.includes("a".repeat(50000)), "a refused question does not consume the snapshot");
	await closed(f, id); await f.h.cleanup();
});

test("child error after partial output is not success; unrelated and previous-turn errors are ignored", async () => {
	const options = { agentError: "synthetic child failure" }, f = fixtureTemp(options);
	const id = await opened(f);
	let response = await f.h.call("send", { sessionId: id, text: "first" });
	assert.equal(response.ok, false);
	assert.match(response.error.message, /synthetic child failure/);
	assert.match((await f.h.call("poll", { sessionId: id })).value.text, /temp reply/, "partial output remains available but is not a successful answer");
	options.unrelatedError = true;
	response = await f.h.call("send", { sessionId: id, text: "next" });
	assert.equal(response.ok, true, JSON.stringify(response));
	await closed(f, id); await f.h.cleanup();
});

test("the whole-send deadline aborts even an uncooperative snapshot stream", async t => {
	const requests = [];
	const llm = { stream(opts) {
		requests.push(opts);
		return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } };
	} };
	const f = fixtureTemp({ services: { llm } });
	const id = await opened(f, { contextMode: "on-demand", transcript: "synthetic snapshot" });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const pending = f.h.call("send", { sessionId: id, text: "q" });
		t.mock.timers.tick(120000);
		const response = await pending;
		assert.equal(response.ok, false);
		assert.match(response.error.message, /超时/);
		assert.equal(requests[0].signal.aborted, true);
		assert.equal(f.messages.length, 0);
		assert.equal((await f.h.call("send", { sessionId: id, text: "no" })).ok, false);
		await closed(f, id); await f.h.cleanup();
	} finally { t.mock.timers.reset(); }
});

test("ask output, job count and expiry are bounded without another ask", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let signal;
		const h = host({}, { llm: { async *stream(opts) {
			signal = opts.signal;
			yield { type: "text-delta", text: "x".repeat(64001) };
			yield { type: "finish", reason: { kind: "stop" } };
		} } });
		const result = await askResult(h);
		assert.match(result.error, /上限/); assert.equal(signal.aborted, true);
		assert.ok(result.text.length <= 64000);
		await h.cleanup();
		const jobs = host();
		const starts = [];
		for (let i = 0; i < 32; i++) {
			const response = await jobs.call("ask", { question: "q" });
			assert.equal(response.ok, true); starts.push(response.value);
		}
		await tick();
		assert.equal((await jobs.call("ask", { question: "over capacity" })).ok, false);
		t.mock.timers.tick(600000);
		assert.equal((await jobs.call("askPoll", starts.at(-1))).ok, false, "last job expires without another ask");
		assert.equal((await jobs.call("ask", { question: "capacity released" })).ok, true);
		await jobs.cleanup();
	} finally { t.mock.timers.reset(); }
});

test("send settlement and plugin unload leave no deadline or expiry timers", async t => {
	const active = new Set(), set = globalThis.setTimeout, clear = globalThis.clearTimeout;
	t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
		const handle = set(() => { active.delete(handle); fn(...args); }, ms);
		active.add(handle); return handle;
	});
	t.mock.method(globalThis, "clearTimeout", handle => { active.delete(handle); return clear(handle); });
	const f = fixtureTemp(), id = await opened(f);
	assert.equal((await f.h.call("send", { sessionId: id, text: "q" })).ok, true);
	assert.equal(active.size, 0, "send deadline was cleared");
	await closed(f, id); await f.h.cleanup();
	const completed = host(); await askResult(completed);
	assert.equal(active.size, 1, "only result expiry remains");
	await completed.cleanup(); assert.equal(active.size, 0);
	const stalled = host({}, { llm: { stream() { return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } }; } } });
	await stalled.call("ask", { question: "q" });
	await stalled.cleanup(); await tick();
	assert.equal(active.size, 0, "abort completion did not create an expiry after unload");
});

test("temp per-turn output, lifetime text and chunk count are bounded without evicting cursors", async () => {
	for (const options of [{ outputText: "x".repeat(64001) }, { outputText: "x", chunkCount: 4097 }]) {
		const f = fixtureTemp(options), id = await opened(f);
		const response = await f.h.call("send", { sessionId: id, text: "q" });
		assert.equal(response.ok, false); assert.match(response.error.message, /上限/);
		const poll = await f.h.call("poll", { sessionId: id });
		assert.ok(poll.value.text.length <= 256000 && poll.value.lastSeq <= 4096);
		await closed(f, id); await f.h.cleanup();
	}
	const f = fixtureTemp({ outputText: "x".repeat(64000) }), id = await opened(f);
	for (let i = 0; i < 4; i++) assert.equal((await f.h.call("send", { sessionId: id, text: "q" })).ok, true);
	const cursor = (await f.h.call("poll", { sessionId: id })).value.lastSeq;
	assert.equal((await f.h.call("send", { sessionId: id, text: "over lifetime buffer" })).ok, false);
	const poll = await f.h.call("poll", { sessionId: id, fromSeq: cursor });
	assert.equal(poll.value.text, ""); assert.equal(poll.value.lastSeq, cursor);
	await closed(f, id); await f.h.cleanup();
});

test("two hosts create independent records; unload waits for an in-progress open", async () => {
	const a = fixtureTemp(), b = fixtureTemp();
	const [x, y] = await Promise.all([opened(a), opened(b)]);
	assert.notEqual(x, y);
	assert.ok(files().includes(`${x}.json`) && files().includes(`${y}.json`));
	await a.h.cleanup();
	assert.equal(existsSync(recordPath(x)), false);
	assert.equal(existsSync(recordPath(y)), true);
	await b.h.cleanup();
	assert.equal(existsSync(recordPath(y)), false);
	const gate = deferred(), f = fixtureTemp({ createGate: gate });
	const pending = f.h.call("open", {});
	while (!f.id()) await tick();
	let done = false;
	const cleanup = f.h.cleanup().then(() => { done = true; });
	await tick(); assert.equal(done, false); assert.equal(existsSync(recordPath(f.id())), true);
	gate.resolve();
	assert.equal((await pending).ok, false);
	await cleanup;
	assert.equal(existsSync(recordPath(f.id())), false);
});

test("temporary delegation uses the host policy helper when available and preserves the fallback", async () => {
	const expected = [{ type: "approval/policy", data: { policy: "never", source: "delegation" } }];
	const fallback = fixtureTemp();
	const first = await opened(fallback);
	assert.deepEqual(fallback.sessionEvents, expected);
	await closed(fallback, first); await fallback.h.cleanup();

	globalThis.__btwDelegationHelperCalls = 0;
	packageFixture("dsh-subagent", `
		export function resolveChildDepth(parent) { return (parent.session.header.delegationDepth ?? 0) + 1; }
		export function childSessionMeta(parent, depth, isSeeded) {
			return { parentSession: parent.session.header.id, delegationDepth: depth, isSeeded, cwd: parent.session.header.cwd, agentPreset: "must-not-inherit-composition" };
		}
		export function captureDelegatedPolicyOverrides() { return { approvalPolicy: "never", sandboxMode: "workspace-write", permissionPreset: "auto" }; }
		export function appendDelegatedPolicyOverrides(session, overrides) {
			globalThis.__btwDelegationHelperCalls++;
			if (overrides.sandboxMode !== undefined) session.append("sandbox/mode", { mode: overrides.sandboxMode, source: "delegation" });
			if (overrides.approvalPolicy !== undefined) session.append("approval/policy", { policy: overrides.approvalPolicy, source: "delegation" });
			if (overrides.permissionPreset !== undefined) session.append("permission/preset", { preset: overrides.permissionPreset });
		}
	`);
	const native = fixtureTemp();
	try {
		const id = await opened(native);
		assert.equal(globalThis.__btwDelegationHelperCalls, 1);
		assert.deepEqual(native.sessionEvents, expected);
		assert.equal(native.createOptions[0].meta.parentSession, undefined, "global chat has no invented parent");
		await closed(native, id);
		const child = await opened(native, { parentSessionId: "parent", modelMode: "current" });
		assert.equal(globalThis.__btwDelegationHelperCalls, 2);
		assert.deepEqual(native.createOptions[1].meta, { origin: "subagent", parentSession: "parent", delegationDepth: 1, isSeeded: false });
		assert.deepEqual(native.createOptions[1].agentOptions, { subagentDepth: 1 });
		assert.equal(native.createOptions[1].meta.agentPreset, undefined, "btw keeps its own composition");
		assert.equal(native.createOptions[1].meta.cwd, undefined, "lineage must not grant workspace tools");
		assert.deepEqual(native.sessionEvents.slice(1), [
			{ type: "sandbox/mode", data: { mode: "workspace-write", source: "delegation" } },
			...expected,
			{ type: "permission/preset", data: { preset: "auto" } },
		]);
		await closed(native, child);
	} finally { await native.h.cleanup(); delete globalThis.__btwDelegationHelperCalls; }
});

test("live reasoning is an explicit current-attempt snapshot, replaced on retry and distinct from committed cursor", async () => {
	const idleGate = deferred();
	const f = fixtureTemp({ idleGate, onFollowup({ emit, turn }) { emit("turn/start", { turn }); } });
	const id = await opened(f), send = f.h.call("send", { sessionId: id, text: "question" });
	const { child, listeners, emit } = f.runtimes[0];
	const stream = frame => listeners.get("agent/assistant-stream")({ agent: child, frame });
	const start = (n, revision) => stream({ type: "start", attemptId: `${id}:${n}`, revision, turn: 1, step: 1 });
	const chunk = (n, revision, index, part) => stream({ type: "chunk", attemptId: `${id}:${n}`, revision, index, time: 1, chunk: part });
	const poll = () => f.h.call("poll", { sessionId: id, fromReasoningSeq: 0, includeLiveReasoning: true });
	try {
		assert.equal((await poll()).value.liveReasoning, null);
		start(1, 1);
		chunk(1, 2, 0, { type: "reasoning-delta", index: 0, text: "actual ", signature: "SECRET" });
		chunk(1, 3, 1, { type: "tool-call-delta", argumentsDelta: "SECRET" });
		chunk(1, 4, 2, { type: "reasoning-delta", index: 0, text: "thinking" });
		assert.deepEqual((await poll()).value.liveReasoning, { attemptId: `${id}:1`, revision: 4, text: "actual thinking", running: true });
		assert.equal((await poll()).value.reasoning, "");
		assert.equal((await poll()).value.reasoningLastSeq, 0);
		assert.equal(Object.hasOwn((await f.h.call("poll", { sessionId: id })).value, "liveReasoning"), false);
		listeners.get("agent/assistant-stream")({ agent: {}, frame: { type: "chunk", attemptId: `${id}:1`, revision: 5, index: 3, chunk: { type: "reasoning-delta", text: "foreign" } } });
		chunk(1, 4, 3, { type: "reasoning-delta", text: "stale revision" });
		chunk(1, 5, 9, { type: "reasoning-delta", text: "invalid index" });
		assert.equal((await poll()).value.liveReasoning.text, "actual thinking");
		stream({ type: "end", attemptId: `${id}:1`, revision: 5, index: 3, outcome: { kind: "abandoned" } });
		assert.equal((await poll()).value.liveReasoning, null);
		start(1, 6); // duplicate/replayed attempt cannot be resurrected
		assert.equal((await poll()).value.liveReasoning, null);
		start(2, 7);
		chunk(1, 8, 3, { type: "reasoning-delta", text: "late" });
		chunk(2, 8, 0, { type: "reasoning-delta", index: 0, text: "retry actual" });
		assert.deepEqual((await poll()).value.liveReasoning, { attemptId: `${id}:2`, revision: 8, text: "retry actual", running: true });
		emit("assistant/attempt", reasoningMessage(1, [{ type: "reasoning", text: "not committed" }]));
		emit("assistant/message", reasoningMessage(1, [{ type: "reasoning", text: "committed actual" }, { type: "text", text: "answer" }]));
		stream({ type: "end", attemptId: `${id}:2`, revision: 9, index: 1, outcome: { kind: "committed", eventType: "assistant/message", seq: 3 } });
		assert.deepEqual((await poll()).value.liveReasoning, { attemptId: `${id}:2`, revision: 9, text: "retry actual", running: false });
		assert.equal((await poll()).value.reasoning, "");
		emit("turn/end", { turn: 1, reason: { kind: "completed" } });
		idleGate.resolve(); assert.deepEqual(await send, { ok: true, value: { output: "answer" } });
		const final = (await poll()).value;
		assert.equal(final.liveReasoning, null); assert.equal(final.reasoning, "committed actual");
		assert.equal(final.reasoningLastSeq, 1);
	} finally { idleGate.resolve(); await closed(f, id); await f.h.cleanup(); }
});

test("live reasoning folds at matching block end or first answer, reopens only for a later reasoning delta", async () => {
	const idleGate = deferred(), f = fixtureTemp({ idleGate, onFollowup({ emit, turn }) { emit("turn/start", { turn }); } });
	const id = await opened(f), send = f.h.call("send", { sessionId: id, text: "q" });
	const { child, listeners, emit } = f.runtimes[0], attemptId = `${id}:1`;
	const stream = frame => listeners.get("agent/assistant-stream")({ agent: child, frame });
	const poll = async () => (await f.h.call("poll", { sessionId: id, includeLiveReasoning: true })).value.liveReasoning;
	stream({ type: "start", attemptId, revision: 1, turn: 1, step: 1 });
	stream({ type: "chunk", attemptId, revision: 2, index: 0, chunk: { type: "reasoning-delta", index: 3, text: "thinking" } });
	stream({ type: "chunk", attemptId, revision: 3, index: 1, chunk: { type: "block-end", index: 9, block: { secret: "never read" } } });
	assert.equal((await poll()).running, true);
	stream({ type: "chunk", attemptId, revision: 4, index: 2, chunk: { type: "block-end", index: 3, block: { secret: "never read" } } });
	assert.deepEqual(await poll(), { attemptId, revision: 4, text: "thinking", running: false });
	stream({ type: "chunk", attemptId, revision: 5, index: 3, chunk: { type: "reasoning-delta", index: 4, text: " again" } });
	assert.deepEqual(await poll(), { attemptId, revision: 5, text: "thinking again", running: true });
	stream({ type: "chunk", attemptId, revision: 6, index: 4, chunk: { type: "text-delta", index: 5, text: "answer" } });
	assert.deepEqual(await poll(), { attemptId, revision: 6, text: "thinking again", running: false });
	emit("assistant/message", reasoningMessage(1, [{ type: "reasoning", text: "thinking again" }, { type: "text", text: "answer" }]));
	stream({ type: "end", attemptId, revision: 7, index: 5, outcome: { kind: "committed", eventType: "assistant/message", seq: 1 } });
	assert.deepEqual(await poll(), { attemptId, revision: 7, text: "thinking again", running: false });
	emit("turn/end", { turn: 1, reason: { kind: "completed" } });
	idleGate.resolve(); assert.equal((await send).ok, true); assert.equal(await poll(), null);
	await closed(f, id); await f.h.cleanup();
});

test("live reasoning fences invalid starts, assistant attempts, errors, close and bounded output", async () => {
	for (const kind of ["attempt", "error", "close", "size", "count"]) {
		const idleGate = deferred(), disposeGate = deferred();
		const f = fixtureTemp({ idleGate, disposeGate, onFollowup({ emit, turn }) { emit("turn/start", { turn }); } });
		const id = await opened(f), send = f.h.call("send", { sessionId: id, text: "q" });
		const { child, listeners } = f.runtimes[0];
		const stream = frame => listeners.get("agent/assistant-stream")({ agent: child, frame });
		const poll = async () => (await f.h.call("poll", { sessionId: id, includeLiveReasoning: true, fromReasoningSeq: 0 })).value;
		stream({ type: "start", attemptId: `${id}:1`, revision: 1, turn: 2, step: 1 });
		stream({ type: "start", attemptId: "foreign:1", revision: 2, turn: 1, step: 1 });
		assert.equal((await poll()).liveReasoning, null);
		stream({ type: "start", attemptId: `${id}:1`, revision: 3, turn: 1, step: 1 });
		const total = kind === "count" ? 4100 : 1;
		for (let i = 0; i < total; i++) stream({ type: "chunk", attemptId: `${id}:1`, revision: 4 + i, index: i,
			chunk: { type: "reasoning-delta", index: 0, text: kind === "size" ? "x".repeat(64000) : "x" } });
		if (kind === "attempt") {
			stream({ type: "end", attemptId: `${id}:1`, revision: 5, index: 1, outcome: { kind: "committed", eventType: "assistant/attempt", seq: 3 } });
			assert.equal((await poll()).liveReasoning, null);
		} else if (kind === "error") {
			listeners.get("agent/error")({ agent: child, error: Error("failed") });
			assert.equal((await poll()).liveReasoning, null);
		} else if (kind === "close") {
			const closing = f.h.call("close", { sessionId: id });
			assert.equal((await poll()).liveReasoning, null);
			stream({ type: "chunk", attemptId: `${id}:1`, revision: 5, index: 1, chunk: { type: "reasoning-delta", text: "late" } });
			assert.equal((await poll()).liveReasoning, null);
			disposeGate.resolve(); idleGate.resolve(); await closing;
		} else {
			assert.equal((await poll()).liveReasoning, null);
			assert.equal((await send).ok, false);
		}
		idleGate.resolve(); disposeGate.resolve(); await send;
		if (kind !== "close") await closed(f, id);
		await f.h.cleanup();
	}
});

// Synthetic rc.1 durable shape, including data.turn/step and assistant role.
// No provider, real session, source history or network is touched.
const reasoningMessage = (turn, content, extra = {}) => ({ turn, step: 1,
	message: { id: `assistant-${turn}`, role: "assistant", content,
		source: { provider: "synthetic", model: "fixture", replayState: { private: "never export replay state" } } },
	stream: [{ private: "never export compact stream" }], ...extra });
const thinkingPoll = (f, id, cursors = {}) => f.h.call("poll", { sessionId: id, fromReasoningSeq: 0, ...cursors });
function committedReasoning(runtime, text, reason = "completed") {
	const { emit, turn } = runtime;
	emit("turn/start", { turn });
	emit("assistant/message", reasoningMessage(turn, [
		{ type: "reasoning", text, thinkingSignature: "never export signature" },
		{ type: "text", text: "final answer" },
	]));
	emit("turn/end", { turn, reason: { kind: reason } });
}

test("committed reasoning has independent opt-in cursors, ordered turns and unchanged final answers/context", async () => {
	const options = { onFollowup(runtime) {
		const { emit, turn } = runtime;
		emit("turn/start", { turn });
		const event = emit("assistant/message", reasoningMessage(turn, [
			{ type: "reasoning", text: `${turn}: first `, thinkingSignature: "signature-secret" },
			{ type: "text", text: "final " },
			{ type: "reasoning", text: "second\n" },
			{ type: "tool-call", name: "read", arguments: "tool-secret" },
			{ type: "reasoning", text: { private: "not a string" } },
			{ type: "text", text: "answer" },
		]));
		runtime.listeners.get("session/event")(runtime.child.session, event); // same committed event replayed
		emit("turn/end", { turn, reason: { kind: "completed" } });
	} };
	const f = fixtureTemp(options), id = await opened(f, { contextMode: "recent", transcript: "authorized reference" });
	try {
		assert.deepEqual((await thinkingPoll(f, id)).value, { text: "", lastSeq: 0, reasoning: "", reasoningLastSeq: 0 });
		assert.deepEqual(await f.h.call("send", { sessionId: id, text: "question" }), { ok: true, value: { output: "final answer" } });
		assert.match(f.messages[0].content[0].text, /authorized reference/);
		assert.deepEqual((await f.h.call("poll", { sessionId: id })).value, { text: "temp reply", lastSeq: 1 });
		assert.deepEqual((await thinkingPoll(f, id, { fromSeq: 1 })).value,
			{ text: "", lastSeq: 1, reasoning: "1: first second\n", reasoningLastSeq: 2 });
		assert.deepEqual((await thinkingPoll(f, id, { fromSeq: 0, fromReasoningSeq: 1 })).value,
			{ text: "temp reply", lastSeq: 1, reasoning: "second\n", reasoningLastSeq: 2 });
		assert.equal((await f.h.call("send", { sessionId: id, text: "next" })).ok, true);
		assert.equal(f.messages[1].content[0].text, "next");
		assert.deepEqual((await thinkingPoll(f, id, { fromSeq: 1, fromReasoningSeq: 2 })).value,
			{ text: "temp reply", lastSeq: 2, reasoning: "2: first second\n", reasoningLastSeq: 4 });
		assert.equal((await thinkingPoll(f, id)).value.reasoning, "1: first second\n2: first second\n");
		assert.equal((await thinkingPoll(f, id, { fromReasoningSeq: 4 })).value.reasoning, "");
		for (const cursor of [-1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
			assert.equal((await thinkingPoll(f, id, { fromReasoningSeq: cursor })).value.reasoningLastSeq, 4);
		}
		assert.doesNotMatch(f.h.warnings.join("\n"), /first|second|signature-secret|tool-secret/);
		assert.equal(f.sessionEvents.some(event => JSON.stringify(event).includes("first second")), false, "host never persists reasoning");
	} finally { await closed(f, id); await f.h.cleanup(); }
});

test("reasoning ignores foreign sessions, attempts, streams, interruptions, tools and private fields", async () => {
	const f = fixtureTemp({ onFollowup({ child, emit, listeners, turn }) {
		emit("turn/start", { turn });
		emit("assistant/message", reasoningMessage(turn, [{ type: "reasoning", text: "source-secret" }]), { header: { id: "parent" } });
		emit("assistant/message", reasoningMessage(turn, [{ type: "reasoning", text: "same-id-secret" }]), { ...child.session });
		emit("assistant/attempt", reasoningMessage(turn, [{ type: "reasoning", text: "attempt-secret" }]));
		for (const type of ["chunk", "abandoned", "private", "settled"]) {
			listeners.get("agent/assistant-stream")({ agent: child, frame: { type, chunk: { type: "reasoning-delta", text: "stream-secret" } } });
		}
		emit("assistant/message", reasoningMessage(turn, [{ type: "reasoning", text: "interrupted-secret" }], { interrupted: true }));
		emit("assistant/message", reasoningMessage(turn + 50, [{ type: "reasoning", text: "wrong-turn-secret" }]));
		emit("tool/call", { turn, arguments: "tool-secret", content: [{ type: "reasoning", text: "nested-secret" }] });
		emit("assistant/message", reasoningMessage(turn, [{ type: "text", text: "visible answer" },
			{ type: "tool-call", arguments: { type: "reasoning", text: "tool-secret" } }, { type: "reasoning", text: 123 }]));
		emit("turn/end", { turn, reason: { kind: "completed" } });
	} }), id = await opened(f);
	try {
		assert.equal((await f.h.call("send", { sessionId: id, text: "q" })).ok, true);
		assert.equal((await thinkingPoll(f, id)).value.reasoning, "");
		assert.equal((await thinkingPoll(f, id)).value.reasoningLastSeq, 0);
		assert.doesNotMatch(f.h.warnings.join("\n"), /secret|compact stream|replay state/);
	} finally { await closed(f, id); await f.h.cleanup(); }
});

test("reasoning waits for successful idle; failed, aborted or unclosed turns never publish and late old turns stay isolated", async () => {
	for (const kind of ["completed", "aborted", "error", "missing"]) {
		const idleGate = deferred(), options = { idleGate, onFollowup(runtime) {
			if (kind === "missing") {
				runtime.emit("turn/start", { turn: runtime.turn });
				runtime.emit("assistant/message", reasoningMessage(runtime.turn, [{ type: "reasoning", text: "pending-secret" }]));
			} else committedReasoning(runtime, "pending-secret", kind);
		} };
		const f = fixtureTemp(options), id = await opened(f);
		try {
			const pending = f.h.call("send", { sessionId: id, text: "q" });
			assert.equal((await thinkingPoll(f, id)).value.reasoning, "", "even completed events wait for send settlement");
			if (kind === "completed") f.runtimes[0].listeners.get("agent/error")({ agent: f.runtimes[0].child, error: Error("synthetic failure after commit") });
			idleGate.resolve();
			const result = await pending;
			if (kind === "completed") assert.equal(result.ok, false);
			assert.equal((await thinkingPoll(f, id)).value.reasoningLastSeq, 0);
			options.onFollowup = runtime => {
				runtime.emit("turn/start", { turn: runtime.turn });
				runtime.emit("assistant/message", reasoningMessage(1, [{ type: "reasoning", text: "late-old-secret" }]));
				runtime.emit("assistant/message", reasoningMessage(runtime.turn, [{ type: "reasoning", text: "safe next turn" }]));
				runtime.emit("turn/end", { turn: runtime.turn, reason: { kind: "completed" } });
			};
			assert.equal((await f.h.call("send", { sessionId: id, text: "next" })).ok, true);
			assert.equal((await thinkingPoll(f, id)).value.reasoning, "safe next turn");
		} finally { await closed(f, id); await f.h.cleanup(); }
	}
});

test("reasoning limits share per-turn, lifetime and chunk budgets; overflowing turns fail closed", async () => {
	for (const options of [
		{ outputText: "x", onFollowup: runtime => committedReasoning(runtime, "r".repeat(64000)) },
		{ outputText: "x", onFollowup: runtime => committedReasoning(runtime, "r".repeat(64001)) },
		{ outputText: "x", onFollowup({ emit, turn }) {
			emit("turn/start", { turn });
			emit("assistant/message", reasoningMessage(turn, Array.from({ length: 4096 }, () => ({ type: "reasoning", text: "r" }))));
			emit("turn/end", { turn, reason: { kind: "completed" } });
		} },
	]) {
		const f = fixtureTemp(options), id = await opened(f);
		try {
			const result = await f.h.call("send", { sessionId: id, text: "q" });
			assert.equal(result.ok, false); assert.match(result.error.message, /上限/);
			assert.equal((await thinkingPoll(f, id)).value.reasoningLastSeq, 0);
			assert.equal((await f.h.call("send", { sessionId: id, text: "cannot reuse overflow" })).ok, false);
			assert.doesNotMatch(f.h.warnings.join("\n"), /rrrr|pending-secret/);
		} finally { await closed(f, id); await f.h.cleanup(); }
	}
	for (const chunks of [false, true]) {
		const options = { outputText: "x", onFollowup({ emit, turn }) {
			emit("turn/start", { turn });
			emit("assistant/message", reasoningMessage(turn, chunks
				? Array.from({ length: 1023 }, () => ({ type: "reasoning", text: "r" }))
				: [{ type: "reasoning", text: "r".repeat(63999) }]));
			emit("turn/end", { turn, reason: { kind: "completed" } });
		} };
		const f = fixtureTemp(options), id = await opened(f);
		try {
			for (let i = 0; i < 4; i++) assert.equal((await f.h.call("send", { sessionId: id, text: "q" })).ok, true);
			const before = (await thinkingPoll(f, id)).value;
			const result = await f.h.call("send", { sessionId: id, text: "overflow" });
			assert.equal(result.ok, false); assert.match(result.error.message, /上限/);
			const after = (await thinkingPoll(f, id, { fromReasoningSeq: before.reasoningLastSeq })).value;
			assert.equal(after.reasoning, ""); assert.equal(after.reasoningLastSeq, before.reasoningLastSeq);
			assert.ok(before.reasoning.length + before.text.length <= 256000);
			assert.ok(before.reasoningLastSeq + before.lastSeq <= 4096);
		} finally { await closed(f, id); await f.h.cleanup(); }
	}
});

test("close fences pending and late reasoning before disposal, including a failed close and a different child", async () => {
	const idleGate = deferred(), disposeGate = deferred();
	const options = { idleGate, disposeGate, disposeError: true, onFollowup: runtime => committedReasoning(runtime, "closing-secret") };
	const f = fixtureTemp(options), id = await opened(f);
	const pending = f.h.call("send", { sessionId: id, text: "q" });
	const closing = f.h.call("close", { sessionId: id });
	const { child, emit } = f.runtimes[0];
	emit("assistant/message", reasoningMessage(1, [{ type: "reasoning", text: "late-secret" }]));
	assert.equal((await pending).ok, false);
	assert.equal((await thinkingPoll(f, id)).value.reasoningLastSeq, 0);
	disposeGate.resolve(); assert.equal((await closing).ok, false);
	emit("turn/start", { turn: 2 });
	emit("assistant/message", reasoningMessage(2, [{ type: "reasoning", text: "failed-close-secret" }]));
	assert.equal((await thinkingPoll(f, id)).value.reasoning, "");
	options.disposeError = false;
	await closed(f, id);
	assert.equal((await thinkingPoll(f, id)).ok, false);
	const next = await opened(f);
	options.onFollowup = runtime => {
		emit("assistant/message", reasoningMessage(2, [{ type: "reasoning", text: "other-child-secret" }]));
		runtime.listeners.get("session/event")(child.session, { type: "assistant/message", seq: 9999, data: reasoningMessage(1, [{ type: "reasoning", text: "foreign-secret" }]) });
		committedReasoning(runtime, "new child reasoning");
	};
	assert.equal((await f.h.call("send", { sessionId: next, text: "new" })).ok, true);
	assert.equal((await thinkingPoll(f, next)).value.reasoning, "new child reasoning");
	await closed(f, next); await f.h.cleanup();
});
