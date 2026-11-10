// Full installed Web profile. No replacement sessions/projections/Agent services.
// The ONLY simulated component is a local, non-network LlmAdapter.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { installed, GatedBackend, Tombstones, defer } from '../../scripts/native-cache-backend-probe.mjs';
const { load } = installed();
const { JsonStorageBackend } = await load('dsh-storage-json');
const { storageBackendServiceKey } = await load('dsh-storage');
const { LlmAdapter } = await load('dsh-llm');
const { projectionCacheDomainSpec: spec } = await load('dsh-session-projection-cache');
export const name = 'btw-web-cache-research';
export const inject = ['storage'];
export async function apply(ctx) {
	const root = process.env.BTW_PROBE_ROOT;
	const blockedId = process.env.BTW_PROBE_SESSION;
	const normalId = process.env.BTW_PROBE_NORMAL;
	assert.match(blockedId, /^[0-9a-f-]{36}$/);
	assert.match(normalId, /^[0-9a-f-]{36}$/);
	const tombstones = new Tombstones(join(root, 'web-tombstones'));
	await tombstones.init();
	const storageRoot = join(process.env.DSH_HOME, 'storages');
	const delegate = new JsonStorageBackend(storageRoot);
	const unit = await delegate.kv.open({ name: spec.name, version: spec.version, compatibleVersions: spec.compatibleVersions, tables: ['sessions'], hasGlobal: false, layout: spec.layout });
	const initial = await unit.loadAll();
	for (const id of [blockedId, normalId]) assert.equal(Object.hasOwn(initial.tables.sessions, id), false, 'refuse UUID collision');
	await unit.close();
	await tombstones.seal(blockedId); // strictly before cache open and Agent creation
	const audit = [], delegated = [], changes = [], calls = [];
	let targetDisposed, targetDetached = false;
	const backend = new GatedBackend(delegate, tombstones, {
		audit: e => { audit.push(e); if (targetDetached && e.operation === 'denied' && e.key === blockedId) targetDisposed?.resolve(); },
		beforePut: e => { delegated.push(e); },
	});
	ctx.effect(() => {
		const unregister = ctx.storage.backend.register('btw-web-research', backend);
		return async () => { unregister(); await backend.close(); };
	});
	ctx.provide(storageBackendServiceKey('btw-web-research'), backend);
	console.log('WEB gate sealed exclusive UUID and registered BEFORE storage-domain activation');
	ctx.on('domain/changed', e => { if (e.domain === spec.name) changes.push(e); });
	ctx.inject(['llm', 'agents', 'sessions', 'sessionProjectionCache', 'sessionPersistence', 'connection', 'webServer'], host => {
		host.on('session/disposed', session => { if (session.id === blockedId) targetDetached = true; });
		class SyntheticAdapter extends LlmAdapter {
			async listModels(provider) { return [{ provider, id: 'synthetic-chat', name: 'Synthetic local probe' }]; }
			async resolveModel(provider, model) { return { provider, id: model, name: 'Synthetic local probe', context: { contextWindow: 131072 }, defaultMaxTokens: 1024, inputModalities: ['text'] }; }
			async *stream(options) {
				assert.equal(options.provider, 'btw-synthetic');
				if (options.signal?.aborted) throw options.signal.reason;
				calls.push({ provider: options.provider, model: options.model });
				yield { type: 'text-delta', index: 0, text: 'SYNTHETIC-LOCAL-REPLY' };
				yield { type: 'finish', reason: { kind: 'stop' } };
			}
		}
		host.effect(() => host.llm.registerAdapter(['btw-synthetic'], new SyntheticAdapter()));
		// Supported public waterfall: fail before dispatch if any auxiliary
		// model request unexpectedly selects a real provider. No monkey patch.
		host.on('llm/stream', async function* (options, next) {
			assert.equal(options.provider, 'btw-synthetic', 'non-synthetic model dispatch forbidden');
			yield* next();
		});
		const handles = new Map();
		const record = id => {
			const agent = handles.get(id)?.agent;
			assert.ok(agent, 'owned Agent required');
			return host.sessionProjectionCache.cachedSnapshot(agent.session.header);
		};
		const checkpointPath = id => join(storageRoot, spec.name, 'sessions', `${id}.json`);
		const assertBlocked = async () => {
			assert.equal(record(blockedId), undefined, 'no cache Map record');
			assert.equal(changes.some(e => e.key === blockedId && e.operation === 'put'), false, 'no successful put event');
			assert.equal(delegated.some(e => e.key === blockedId), false, 'no delegate call, hence no JSON content temp');
			assert.equal(audit.some(e => e.key === blockedId && e.operation === 'durable-put'), false);
			assert.ok(audit.some(e => e.key === blockedId && e.operation === 'denied'), 'route must really reach gate');
			await assert.rejects(readFile(checkpointPath(blockedId)), { code: 'ENOENT' });
			const names = await readdir(join(storageRoot, spec.name, 'sessions'));
			assert.deepEqual(names, [`${normalId}.json`], 'no target record, tmp, backup or deleting residue');
		};
		const connection = host.extend({ webServer: host.webServer }).connection;
		const disposeChannel = connection.rpc.handle('/btw-cache-probe', async method => {
			try {
				if (method === 'create') {
					assert.equal(handles.size, 0);
					assert.equal(await tombstones.has(blockedId), true);
					for (const id of [blockedId, normalId]) {
						assert.equal(host.sessions.get(id), undefined);
						assert.equal(await host.sessionPersistence.stat(id), undefined);
						const handle = await host.agents.create({ sessionId: id, meta: { cwd: root }, agentOptions: { provider: 'btw-synthetic', model: 'synthetic-chat', maxTokens: 1024 } });
						assert.equal(handle.agent.session.header.parentSession, undefined, 'ordinary root Session');
						handles.set(id, handle);
					}
					return { ok: true, value: { blockedId, normalId } };
				}
				if (method === 'verify') {
					await assert.rejects(host.sessionProjectionCache.write(handles.get(blockedId).agent.session), { code: 'BTW_TOMBSTONED' });
					await host.sessionProjectionCache.write(handles.get(normalId).agent.session);
					await assertBlocked();
					assert.ok(record(normalId));
					assert.ok(calls.length >= 2, 'both prompts must reach local adapter');
					return { ok: true, value: { denied: audit.filter(e => e.operation === 'denied').length, calls: calls.length, blockedMapAbsent: true, normalMapPresent: true } };
				}
				if (method === 'dispose') {
					const b = handles.get(normalId).agent.session;
					await host.sessionProjectionCache.write(b);
					const before = await readFile(checkpointPath(normalId), 'utf8');
					targetDisposed = defer();
					handles.get(blockedId).agent.cancel({ kind: 'hook', reason: 'isolated probe disposal' });
					await handles.get(blockedId).dispose();
					await targetDisposed.promise; // actual detached cache disposed listener
					await host.sessionProjectionCache.write(b); // domain queue barrier
					assert.equal(host.agents.get(blockedId), undefined);
					assert.equal(host.sessions.get(blockedId), undefined);
					await assertBlocked();
					assert.equal(await readFile(checkpointPath(normalId), 'utf8'), before, 'control cache bytes unaffected by target disposal');
					handles.get(normalId).agent.cancel({ kind: 'hook', reason: 'isolated probe disposal' });
					await handles.get(normalId).dispose();
					return { ok: true, value: { disposed: true, blockedMapAbsent: true, normalBytesUnchanged: true } };
				}
				throw new Error(`unknown probe method ${method}`);
			} catch (error) { return { ok: false, error: { code: 'internal', message: String(error.stack || error), details: {} } }; }
		});
		host.effect(() => async () => {
			disposeChannel();
			for (const handle of handles.values()) { handle.agent.cancel({ kind: 'hook', reason: 'isolated probe shutdown' }); await handle.dispose(); }
		});
		console.log('WEB probe ready: real sessions/projections/Agent loop; local synthetic adapter only');
	});
}
