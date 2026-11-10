import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Execute the shipped scripts, not fake chunk exports. Mirrors the public flat
// registration protocol; client-modules.test.js also runs the installed system.
export function clientLoader(sandbox, resolveShared, { beforeChunk } = {}) {
	const factories = new Map(), values = new Map(), tasks = new Map(), requests = [];
	const context = vm.createContext(sandbox);
	const key = (file) => file || "entry";
	sandbox.window.__ModuleLoader__ = { load(registration) {
		assert.equal(registration.id, "dsh-btw");
		if (registration.chunk !== undefined) assert.match(registration.chunk, /^client\.[a-z-]+\.js$/);
		const id = key(registration.chunk);
		assert.equal(factories.has(id), false, "a script may register only once");
		factories.set(id, registration.factory);
	} };
	const execute = (file) => vm.runInContext(readFileSync(new URL("../lib/" + file, import.meta.url), "utf8"), context, { filename: file });
	const require = (id) => {
		assert.equal(id.startsWith("."), false, "synchronous sibling require is not supported by dsh");
		return resolveShared(id);
	};
	const materialize = (file) => {
		if (!values.has(file)) {
			assert.equal(typeof factories.get(file), "function", "script must register the requested sibling");
			values.set(file, factories.get(file)(require));
		}
		return values.get(file);
	};
	require.async = (specifier) => {
		assert.match(specifier, /^\.\/client\.[a-z-]+\.js$/);
		const file = specifier.slice(2);
		requests.push(file);
		if (values.has(file)) return Promise.resolve(values.get(file));
		if (!tasks.has(file)) {
			const task = Promise.resolve().then(() => beforeChunk?.(file)).then(() => {
				if (!factories.has(file)) execute(file);
				return materialize(file);
			}).finally(() => tasks.delete(file));
			tasks.set(file, task);
		}
		return tasks.get(file);
	};
	execute("client.js");
	return { entry: materialize("entry"), requests };
}
