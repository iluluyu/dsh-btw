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
	apply({ ...services, logger: { warn: text => warnings.push(text) }, get: name => services[name], extend(p) { return { ...this, ...p }; }, effect(fn) { cleanup = fn(); } }, config);
	return { call: (...args) => call(...args), request: () => request, creations: () => creations, cleanup: () => cleanup(), services, warnings };
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
	const mounted = [], messages = [], selectionHooks = [], selections = [];
	let disposals = 0, creations = 0, id;
	const agents = {
		get: id => id === "parent" ? { model: { current: () => parentModel } } : undefined,
		async create(opts) {
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
			const child = {
				session: { append() {} },
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
					if (options.agentError) listeners.get("agent/error")?.({ agent: options.unrelatedError ? {} : child, turn: messages.length, step: 1, error: Error(options.agentError) });
				},
			};
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
	return { h, persistence, mounted, messages, options, selectionHooks, selections, id: () => id, disposals: () => disposals, creations: () => creations };
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
