// Real dsh CLI Loader fixture; only synthetic projection/session adapters.
// No provider, credentials, HTTP listener, Agent or product plugin is mounted.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { installed, GatedBackend, Tombstones } from '../../scripts/native-cache-backend-probe.mjs';
const { load } = installed();
const { JsonStorageBackend } = await load('dsh-storage-json');
const { storageBackendServiceKey } = await load('dsh-storage');
export const name = 'btw-research-backend';
export const inject = ['storage'];
export async function apply(ctx, config) {
	const root = process.env.BTW_PROBE_ROOT;
	assert.equal(config.precedence, 'cli-last', 'profile < home < CLI overlay');
	const tombstones = new Tombstones(join(root, 'host-tombstones'));
	await tombstones.init();
	const id = process.env.BTW_PROBE_SESSION;
	// Before cache init/session publication. Fresh sandbox + random exclusive
	// UUID, checked against delegate snapshot before registration.
	const delegate = new JsonStorageBackend(join(root, 'host-storage'));
	const { projectionCacheDomainSpec: spec } = await load('dsh-session-projection-cache');
	const unit = await delegate.kv.open({ name: spec.name, version: spec.version, tables: ['sessions'], hasGlobal: false, layout: 'per-record' });
	assert.equal(Object.hasOwn((await unit.loadAll()).tables.sessions, id), false, 'UUID collision: refuse creation');
	await unit.close();
	await tombstones.seal(id);
	const audit = [];
	const backend = new GatedBackend(delegate, tombstones, { audit: e => audit.push(e) });
	ctx.effect(() => {
		const unregister = ctx.storage.backend.register('btw-research', backend);
		return async () => { unregister(); await backend.close(); };
	});
	console.log('HOST registered backend + durable pre-create marker BEFORE domain activation');
	ctx.provide('btwResearchControl', { audit, id });
	ctx.provide(storageBackendServiceKey('btw-research'), backend);
	const rows = () => ({ title: { ver: 0, seq: 0, val: { text: 'SYNTHETIC-ONLY' } } });
	ctx.provide('sessionProjections', { checkpoint: rows, restore: () => ({ checkpoint: rows(), snapshot: { synthetic: true } }), viewCheckpoint: r => r });
	ctx.provide('sessions', { get: () => undefined, flush: async () => {} });
	ctx.inject(['sessionProjectionCache', 'appReady', 'appExit'], testCtx => {
		testCtx.appReady.onReady(() => {
			(async () => {
				const cache = testCtx.sessionProjectionCache;
				const a = { id, header: { version: 4, createdAt: 1, isSeeded: false }, inheritedEventCount: 0 };
				const b = { ...a, id: 'normal-host-b' };
				const changes = [];
				const unlisten = testCtx.on('domain/changed', event => changes.push(event));
				await assert.rejects(cache.write(a), { code: 'BTW_TOMBSTONED' });
				await cache.write(b);
				assert.equal(cache.cachedSnapshot({ ...a.header, id }), undefined);
				assert.equal(changes.some(e => e.key === id), false);
				assert.equal(audit.filter(e => e.operation === 'denied' && e.key === id).length, 1);
				assert.equal(audit.some(e => e.operation === 'durable-put' && e.key === id), false);
				await assert.rejects(readFile(join(root, 'host-storage/session_projcache/sessions', `${id}.json`)), { code: 'ENOENT' });
				assert.ok(await readFile(join(root, 'host-storage/session_projcache/sessions/normal-host-b.json'), 'utf8'));
				unlisten();
				console.log('PASS HOST real CLI startup/registry/route/dependency barrier and CLI-last precedence; A rejected, B durable, no A map/event');
				testCtx.appExit(0);
			})().catch(error => { console.error(error); testCtx.appExit(1); });
		});
	});
}
