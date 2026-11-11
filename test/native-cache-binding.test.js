import assert from "node:assert/strict";
import test from "node:test";
import { BACKEND, NativeCacheBackend } from "../lib/native-cache.js";

const descriptor = { name: "session_projcache", version: 7, layout: "per-record", tables: ["sessions"], hasGlobal: false, compatibleVersions: [3, 4, 5, 6] };
async function fixture(count = 1) {
	const denied = new Set(), writes = [];
	const markers = { has: async id => denied.has(id), seal: async id => { denied.add(id); } };
	const backend = new NativeCacheBackend({ kv: { open: async () => ({
		loadAll: async () => ({ tables: { sessions: {} }, global: null }),
		putRecord: async (_table, id) => writes.push(id),
		deleteRecord: async () => {}, deleteRecords: async () => {}, setGlobal: async () => {}, close: async () => {},
	}) } }, markers);
	const hub = { backend: { get: name => name === BACKEND ? backend : undefined } }, scopes = [];
	for (let i = 0; i < count; i++) {
		const unit = await backend.kv.open(descriptor); await unit.loadAll();
		const domain = {}, facility = { config: { backend: "json", routes: { session_projcache: BACKEND } }, get: () => domain };
		scopes.push({ unit, domain, facility, cache: {} });
	}
	return { backend, hub, markers, scopes, writes };
}

test("native cache capability supports multiple protected host scopes without a global singleton assumption", async () => {
	const f = await fixture(2);
	try {
		for (const scope of f.scopes) {
			assert.equal(f.backend.bind(f.hub, scope.facility, scope.cache)().domain, scope.domain);
		}
		await f.markers.seal("owned");
		for (const scope of f.scopes) await assert.rejects(scope.unit.putRecord("sessions", "owned", {}), { code: "BTW_TOMBSTONED" });
		assert.deepEqual(f.writes, []);
	} finally { await f.backend.close(); }
});

test("an unrelated protected unit cannot authorize a foreign-routed cache", async () => {
	const f = await fixture();
	try {
		for (const config of [{ backend: "json", routes: {} }, { backend: "json", routes: { session_projcache: "other" } }]) {
			assert.throws(() => f.backend.bind(f.hub, { config, get: () => ({}) }, {}), /路由|gate|拒写/);
		}
	} finally { await f.backend.close(); }
});

test("capability revocation is scoped to the current facility while another protected host remains usable", async () => {
	const f = await fixture(2);
	try {
		const [a, b] = f.scopes;
		const checkA = f.backend.bind(f.hub, a.facility, a.cache), checkB = f.backend.bind(f.hub, b.facility, b.cache);
		a.facility.get = () => undefined;
		await a.unit.close();
		assert.throws(checkA, /gate|拒写|缓存/);
		assert.equal(checkB().domain, b.domain);
	} finally { await f.backend.close(); }
});
