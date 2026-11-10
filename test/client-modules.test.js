import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import vm from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const installed = process.env.DSH_CLIENT_MODULES || join(dirname(process.execPath), "../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules");
const chunks = readdirSync(join(root, "lib")).filter(file => /^client\..+\.js$/.test(file)).sort();
const coreChunks = chunks.filter(file => file !== "client.settings.js");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("client entry revision tracks every immutable sibling chunk", () => {
	const entry = readFileSync(join(root, "lib/client.js"), "utf8");
	const stamps = [...entry.matchAll(/^ \* (client\.[a-z]+\.js): ([a-f0-9]{64})$/gm)];
	assert.deepEqual(stamps.map(([, name]) => name).sort(), chunks, "every chunk must have exactly one owner-entry stamp");
	for (const [, name, expected] of stamps) {
		const actual = createHash("sha256").update(readFileSync(join(root, "lib", name))).digest("hex");
		assert.equal(actual, expected, `${name} changed: update its SHA-256 stamp in lib/client.js to invalidate DSH's immutable chunk cache`);
	}
});

test("installed host revision changes when a chunk stamp updates its owner entry", { skip: !existsSync(join(installed, "lib/index.js")) && "installed dsh-client-modules unavailable" }, async t => {
	const dir = mkdtempSync(join(tmpdir(), "btw-chunk-revision-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const entryPath = join(dir, "client.js"), chunkPath = join(dir, "client.views.js");
	writeFileSync(entryPath, "// old chunk stamp\n"); writeFileSync(chunkPath, "old chunk");
	const { ClientModuleRegistry } = await import(pathToFileURL(join(installed, "lib/index.js")));
	const registry = Object.create(ClientModuleRegistry.prototype);
	registry.table = new Map([["dsh-btw", { entry: { id: "dsh-btw", rev: "initial" }, meta: { clientPath: entryPath, external: [] } }]]);
	registry.rebuildListeners = new Set(); registry.compose = () => ({}); registry.notifyGraphChanged = () => {};
	const initial = registry.rebuilt("dsh-btw");
	writeFileSync(chunkPath, "new chunk");
	assert.equal(registry.rebuilt("dsh-btw"), initial, "a sibling-only change does not invalidate DSH's cached URL");
	appendFileSync(entryPath, "// updated chunk stamp\n");
	assert.notEqual(registry.rebuilt("dsh-btw"), initial, "changing the stamped entry publishes a new cache URL");
});

test("npm pack includes every zero-build sibling beside the exported client entry", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(manifest.exports["./client"], "./lib/client.js");
	const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
	const files = new Set(pack.files.map(file => file.path));
	assert.ok(chunks.length >= 4);
	for (const file of ["client.js", ...chunks]) {
		assert.ok(files.has("lib/" + file), file + " must be published");
		const source = readFileSync(join(root, "lib", file), "utf8");
		assert.doesNotMatch(source, /require\(["']\.\//, "dsh does not support synchronous sibling outputs");
		assert.doesNotMatch(source, /\bimport\s*\(\s*["']/, "chunks must use the public handoff, not native ESM");
	}
});

test("installed dsh browser loader consumes actual host-served, revisioned sibling registrations", { skip: !existsSync(join(installed, "lib/client.js")) && "installed dsh-client-modules unavailable; set DSH_CLIENT_MODULES" }, async () => {
	// Use the real installed client system AND host route implementation. The
	// only transport is in-process: no server, credentials or network is used.
	const { ClientModuleRegistry } = await import(pathToFileURL(join(installed, "lib/index.js")));
	const registry = Object.create(ClientModuleRegistry.prototype);
	registry.table = new Map([["dsh-btw", { entry: { id: "dsh-btw", rev: "contract-rev" }, meta: { clientPath: join(root, "lib/client.js") } }]]);
	registry.responses = new Map(); registry.previousBatchResponses = new Map();
	const requests = [], arrivals = [], calls = [], registrations = new Map(), effects = [];
	let bootstrap;
	const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), useState: value => [value, () => {}], useRef: current => ({ current }), useReducer: () => [0, () => {}], useEffect() {}, useLayoutEffect() {} };
	const sandbox = { window: { innerWidth: 1200, innerHeight: 900, __ModuleLoader__: { load: value => { bootstrap = value; } } },
		document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
		setTimeout, clearTimeout, setInterval, clearInterval, AbortController, TextEncoder };
	const context = vm.createContext(sandbox);
	vm.runInContext(readFileSync(join(installed, "lib/client.js"), "utf8"), context);
	const moduleExports = bootstrap.factory(() => { throw new Error("unexpected bootstrap dependency"); });
	const target = { mode: "queue", pendingQueue: [] }; target.load = value => target.pendingQueue.push(value);
	sandbox.window.__ModuleLoader__ = target;
	vm.runInContext(readFileSync(join(root, "lib/client.js"), "utf8"), context);
	const system = moduleExports.createClientModuleSystem(target, { id: "@deepseek-ai/dsh-client-modules", exports: moduleExports }, {
		boot: { rev: "graph", release: { version: "contract" }, entries: [{ id: "dsh-btw", rev: "contract-rev", url: "plugins/??dsh-btw/client.js&rev=contract-rev" }], batches: [{ phase: "application", rev: "contract-rev", url: "plugins/??dsh-btw/client.js&rev=contract-rev", entries: ["dsh-btw"] }] },
		staticModules: { react: React },
		loadBundle(url) {
			requests.push(url);
			const task = (async () => {
				assert.match(url, /^plugins\/dsh-btw\/client\.[a-z]+\.js\?rev=contract-rev$/);
				const response = await registry.bundleResource("GET", "/" + url);
				assert.equal(response.status, 200, url);
				assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
				vm.runInContext(response.body.toString(), context, { filename: url });
			})(); arrivals.push(task); return task;
		},
	});
	const entry = await system.import("dsh-btw");
	entry.apply({ slots: { inject: (_name, callback) => callback(), register: (meta, component) => { registrations.set(meta.id || meta.key || meta.name, component); return () => {}; } },
		get: () => ({ rpc: { call: async (_channel, method) => { calls.push(method); return { ok: true, value: { providers: [] } }; } } }), effect: fn => effects.push(fn()) });
	assert.deepEqual(requests, []); assert.deepEqual(calls, []);
	registrations.get("btw-temp")({ sessionId: "source" }).props.onClick();
	registrations.get("btw-trigger")().props.onClick();
	await tick(); await Promise.all(arrivals); await tick();
	assert.deepEqual(requests.map(url => url.split("/").at(-1).split("?")[0]).sort(), coreChunks);
	assert.deepEqual(calls, ["models"], "chunk materialization never creates an agent or submits text");
	for (const file of coreChunks) assert.ok(system.loadCache.has("dsh-btw/" + file), file + " materialized under its real chunk id");
	const settings = registrations.get("dsh-btw#btw")({}).type;
	settings(); settings();
	await tick(); await Promise.all(arrivals); await tick();
	assert.ok(system.loadCache.has("dsh-btw/client.settings.js"));
	assert.equal(requests.filter(url => url.includes("/client.settings.js?")).length, 1);
	assert.equal(settings().type.name, "BtwSettings");
	assert.deepEqual(calls, ["models"], "settings materialization never creates a chat or changes a model");
	assert.equal((await registry.bundleResource("GET", "/plugins/dsh-btw/client.views.js?rev=wrong")).status, 404);
	assert.equal((await registry.bundleResource("GET", "/plugins/dsh-btw/client.missing.js?rev=contract-rev")).status, 404);
	assert.equal((await registry.bundleResource("HEAD", "/plugins/dsh-btw/client.views.js?rev=contract-rev")).body, undefined);
	for (const dispose of effects) dispose();
});
