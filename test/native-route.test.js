// Auto-route binding: a normal install must not need a storage-domain edit,
// and it must never rewrite the user's configuration files.
import assert from "node:assert/strict";
import test from "node:test";
import { bindNativeRoute, NATIVE_BACKEND } from "../lib/index.js";

const ENTRY_NAME = "@deepseek-ai/dsh-storage-domain";

function loaderWith(entries) {
	return { entries: () => entries[Symbol.iterator]() };
}

function entryWith(config, { fiber } = {}) {
	const entry = { options: { id: "include:storage-domain", name: ENTRY_NAME, config }, fiber, updates: [] };
	entry.update = async options => { entry.updates.push(options); };
	return entry;
}

const reason = result => {
	assert.equal(typeof result, "string");
	assert.ok(result.length > 0);
	return result;
};

test("bindNativeRoute adds the route to an unstarted entry without restarting it", () => {
	const entry = entryWith({ backend: "json" });
	const before = entry.options.config;
	assert.equal(bindNativeRoute({ get: () => loaderWith([entry]) }), undefined);
	assert.deepEqual(entry.options.config, { backend: "json", routes: { session_projcache: NATIVE_BACKEND } });
	assert.notEqual(entry.options.config, before, "config is copied, never mutated in place");
	assert.deepEqual(before, { backend: "json" }, "the caller's object stays untouched");
	assert.equal(entry.updates.length, 0, "an unstarted entry needs no restart");
});

test("bindNativeRoute restarts a running entry through Entry.update, preserving other keys", async () => {
	const entry = entryWith({ backend: "json", routes: { other_domain: "json" }, extra: 1 }, { fiber: {} });
	assert.equal(bindNativeRoute({ get: () => loaderWith([entry]) }), undefined);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(entry.updates.length, 1);
	const merged = entry.updates[0].config;
	assert.deepEqual(merged, { backend: "json", routes: { other_domain: "json", session_projcache: NATIVE_BACKEND }, extra: 1 });
	assert.deepEqual(entry.options.config, { backend: "json", routes: { other_domain: "json" }, extra: 1 }, "options are not pre-mutated on the restart path");
});

test("bindNativeRoute is idempotent once the route is already ours", () => {
	const entry = entryWith({ backend: "json", routes: { session_projcache: NATIVE_BACKEND } }, { fiber: {} });
	assert.equal(bindNativeRoute({ get: () => loaderWith([entry]) }), undefined);
	assert.equal(entry.updates.length, 0);
});

test("bindNativeRoute never overrides an explicit foreign route or a non-JSON default", () => {
	const foreign = entryWith({ backend: "json", routes: { session_projcache: "sqlite" } }, { fiber: {} });
	reason(bindNativeRoute({ get: () => loaderWith([foreign]) }));
	assert.deepEqual(foreign.options.config.routes, { session_projcache: "sqlite" });
	assert.equal(foreign.updates.length, 0);

	const custom = entryWith({ backend: "sqlite" }, { fiber: {} });
	reason(bindNativeRoute({ get: () => loaderWith([custom]) }));
	assert.deepEqual(custom.options.config, { backend: "sqlite" });
	assert.equal(custom.updates.length, 0);
});

test("bindNativeRoute refuses configs it cannot merge safely", () => {
	const plain = { backend: "json", routes: { a: { __jsExpr: "process.cwd()" } } };
	const entry = entryWith(plain, { fiber: {} });
	reason(bindNativeRoute({ get: () => loaderWith([entry]) }));
	assert.equal(entry.options.config, plain);
	assert.equal(entry.updates.length, 0);

	reason(bindNativeRoute({ get: () => loaderWith([entryWith(undefined)]) }));
	reason(bindNativeRoute({ get: () => loaderWith([entryWith(["not", "an", "object"])]) }));
	reason(bindNativeRoute({ get: () => loaderWith([entryWith({ backend: "json", routes: [] })]) }));
});

test("bindNativeRoute reports missing loader or entry instead of guessing", () => {
	reason(bindNativeRoute({}));
	reason(bindNativeRoute({ get: () => ({}) }));
	reason(bindNativeRoute({ get: () => loaderWith([entryWith({ backend: "json" }, {})].map(e => ({ ...e, options: { ...e.options, name: "@deepseek-ai/dsh-other" } }))) }));
	reason(bindNativeRoute({ get: () => { throw new Error("no loader"); } }));
});
