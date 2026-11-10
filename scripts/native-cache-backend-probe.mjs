#!/usr/bin/env node
// Research only. NOT imported by lib/ or the published bundle.
// One process owns this sandbox. The mutex below is NOT a cross-process lock.
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

export const defer = () => {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
};
export function installed() {
	assert.ok(process.env.BTW_PROBE_ANCHOR, 'run through the sandbox launcher');
	const require = createRequire(process.env.BTW_PROBE_ANCHOR);
	return { require, load: name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href) };
}
async function syncDirectory(path) {
	const handle = await open(path, 'r');
	try { await handle.sync(); } finally { await handle.close(); }
}
export class TombstonedError extends Error {
	code = 'BTW_TOMBSTONED';
	constructor(key) { super(`research cache tombstone denies ${key}`); }
}
// Only synthetic UUID-like keys explicitly sealed by this owner are denied.
// Records contain no content; corruption/read errors reject rather than unblock.
export class Tombstones {
	constructor(root) { this.root = root; this.tails = new Map(); }
	async init() {
		await mkdir(this.root, { mode: 0o700 });
		await syncDirectory(dirname(this.root));
	}
	path(key) {
		assert.match(key, /^[a-zA-Z0-9_-]+$/);
		return join(this.root, `${key}.json`);
	}
	async has(key) {
		let text;
		try { text = await readFile(this.path(key), 'utf8'); }
		catch (error) { if (error.code === 'ENOENT') return false; throw error; }
		assert.deepEqual(JSON.parse(text), { version: 1, domain: 'session_projcache', table: 'sessions', key });
		return true;
	}
	withKey(key, job) {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(job);
		const tail = result.then(() => {}, () => {});
		this.tails.set(key, tail);
		tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
		return result;
	}
	seal(key) {
		return this.withKey(key, async () => {
			if (await this.has(key)) return;
			// Exclusive new file, fsync file + directory. A torn file fails closed
			// on restart; no power-loss/crash recovery certification is claimed.
			const handle = await open(this.path(key), 'wx', 0o600);
			try {
				await handle.writeFile(JSON.stringify({ version: 1, domain: 'session_projcache', table: 'sessions', key }));
				await handle.sync();
			} finally { await handle.close(); }
			await syncDirectory(this.root);
		});
	}
}
export class GatedBackend {
	constructor(delegate, tombstones, { beforePut = async () => {}, audit = () => {} } = {}) {
		this.delegate = delegate;
		this.tombstones = tombstones;
		this.beforePut = beforePut; // deterministic synthetic test latch, not host patching
		this.audit = audit;
		this.units = new Set();
		this.closed = false;
		this.kv = { open: descriptor => this.openUnit(descriptor) };
	}
	async openUnit(descriptor) {
		assert.equal(this.closed, false);
		const targeted = descriptor.name === 'session_projcache';
		if (targeted) {
			// Version-bound fail closed: no silent fallback for an unknown cache
			// layout/table/generation. Other domains are not restricted.
			assert.equal(descriptor.version, 7, 'unsupported session_projcache version');
			assert.equal(descriptor.layout, 'per-record', 'unsupported cache layout');
			assert.deepEqual(descriptor.tables, ['sessions'], 'unsupported cache tables');
			assert.equal(descriptor.hasGlobal, false, 'unsupported cache global');
			assert.deepEqual(descriptor.compatibleVersions ?? [], [3, 4, 5, 6], 'unsupported cache compatibility');
		}
		const unit = await this.delegate.kv.open(descriptor);
		const guarded = (table, key) => targeted && table === 'sessions';
		let closing = false, disposal;
		const pending = new Set();
		const run = job => {
			if (closing) return Promise.reject(Object.assign(new Error('research unit closed'), { code: 'closed' }));
			const result = Promise.resolve().then(job);
			pending.add(result);
			result.then(() => pending.delete(result), () => pending.delete(result));
			return result;
		};
		const wrapped = {
			loadAll: () => run(async () => {
				const snapshot = await unit.loadAll();
				if (targeted) for (const key of Object.keys(snapshot.tables.sessions ?? {})) {
					if (await this.tombstones.has(key)) delete snapshot.tables.sessions[key];
				}
				return snapshot;
			}),
			putRecord: (table, key, value) => run(() => {
				const write = async () => {
					if (guarded(table, key) && await this.tombstones.has(key)) {
						this.audit({ operation: 'denied', key });
						throw new TombstonedError(key); // never resolve as a no-op
					}
					await this.beforePut({ domain: descriptor.name, table, key });
					await unit.putRecord(table, key, value);
					this.audit({ operation: 'durable-put', key });
				};
				return guarded(table, key) ? this.tombstones.withKey(key, write) : write();
			}),
			// Deletion must still pass the gate. Domain serializes its own queue.
			deleteRecord: (table, key) => run(() => guarded(table, key)
				? this.tombstones.withKey(key, () => unit.deleteRecord(table, key)) : unit.deleteRecord(table, key)),
			deleteRecords: (table, keys) => run(async () => {
				// Match the delegate's batch contract; do not implement a partial loop.
				const ordered = guarded(table, '') ? [...new Set(keys)].sort() : [];
				const lock = index => index === ordered.length ? unit.deleteRecords(table, keys)
					: this.tombstones.withKey(ordered[index], () => lock(index + 1));
				return lock(0);
			}),
			setGlobal: value => run(() => unit.setGlobal(value)),
			close: () => disposal ??= (async () => {
				closing = true;
				await Promise.allSettled([...pending]);
				await unit.close();
				this.units.delete(wrapped);
			})(),
		};
		if (unit.backupRecord) wrapped.backupRecord = (table, key) => run(() => guarded(table, key)
			? this.tombstones.withKey(key, () => unit.backupRecord(table, key)) : unit.backupRecord(table, key));
		this.units.add(wrapped);
		return wrapped;
	}
	async close() {
		this.closed = true;
		await Promise.all([...this.units].map(unit => unit.close()));
		await this.delegate.close();
	}
}

async function components(root, restart = false) {
	const { load } = installed();
	const { Context, Service } = await load('cordis');
	const { BackendRegistry } = await load('dsh-storage');
	const { JsonStorageBackend } = await load('dsh-storage-json');
	const { DomainFacility } = await load('dsh-storage-domain');
	const { SessionProjectionCache, projectionCacheDomainSpec: spec } = await load('dsh-session-projection-cache');
	const tombstones = new Tombstones(join(root, 'tombstones'));
	if (!restart) await tombstones.init();
	const audit = [], changed = [];
	let onDenied = () => {};
	const json = new JsonStorageBackend(join(root, 'storage'));
	const backend = new GatedBackend(json, tombstones, { audit: e => { audit.push(e); if (e.operation === 'denied') onDenied(e); } });
	const ctx = new Context();
	const registry = new BackendRegistry();
	const unregisterJson = registry.register('json', json);
	const unregister = registry.register('btw-research', backend);
	ctx.provide('storage', { backend: registry });
	const facility = new DomainFacility(ctx, { backend: 'json', routes: { session_projcache: 'btw-research' } });
	ctx.provide('storageDomain', facility);
	ctx.on('domain/changed', e => changed.push(e));
	const A = 'owned-a', B = 'normal-b';
	const session = id => ({ id, header: { version: 4, createdAt: 1, isSeeded: false }, inheritedEventCount: 0 });
	const a = session(A), b = session(B);
	const entered = defer(), release = defer();
	let holdFlush = false;
	ctx.provide('sessions', { get: id => id === A ? a : b, flush: async s => {
		if (s === a && holdFlush) { entered.resolve(); await release.promise; }
	} });
	const rows = () => ({ title: { ver: 0, seq: 0, val: { text: 'SYNTHETIC-ONLY' } } });
	ctx.provide('sessionProjections', { checkpoint: rows, restore: () => ({ checkpoint: rows(), snapshot: { synthetic: true } }), viewCheckpoint: r => r });
	const cache = new SessionProjectionCache(ctx, { writeEveryEvents: 50, writeIntervalMs: 100000 });
	await cache[Service.init]();
	// Diagnostic lookup only for this harness's OWN composition/handle, not a
	// claim that a side plugin may mutate the production host's domain.
	const domain = facility.get(spec.name), table = domain.table('sessions');
	const path = key => join(root, 'storage/session_projcache/sessions', `${key}.json`);
	try {
		if (restart) {
			assert.equal(table.get(A), undefined);
			assert.ok(table.get(B));
			await assert.rejects(cache.write(a), { code: 'BTW_TOMBSTONED' });
			await cache.write(b);
			const reserved = await readFile(join(root, 'reserved-id'), 'utf8');
			await assert.rejects(cache.write(session(reserved)), { code: 'BTW_TOMBSTONED' });
			assert.equal(table.get(reserved), undefined);
			console.log('PASS component fresh OS process: pre-create and closing tombstones deny; B loads and writes');
			return;
		}
		// Preferred path: register a fresh exclusive id BEFORE constructing any
		// Session/Agent. This sandbox proves absence, not a multi-host claim.
		const freshId = randomUUID();
		assert.equal(table.get(freshId), undefined);
		await assert.rejects(readFile(path(freshId)), { code: 'ENOENT' });
		await tombstones.seal(freshId);
		await writeFile(join(root, 'reserved-id'), freshId);
		const fresh = session(freshId);
		const before = await readdir(join(root, 'storage')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
		await assert.rejects(cache.write(fresh), { code: 'BTW_TOMBSTONED' });
		assert.deepEqual(await readdir(join(root, 'storage')), before, 'denial must precede JSON temp/directory creation');
		const createdDenied = defer();
		onDenied = e => { if (e.key === freshId) createdDenied.resolve(); };
		ctx.emit('session/created', fresh);
		await createdDenied.promise;
		await cache.write(b); // domain queue survives rejected create write
		assert.equal(table.get(freshId), undefined);
		assert.equal(changed.some(e => e.key === freshId), false);
		assert.equal(audit.some(e => e.key === freshId && e.operation === 'durable-put'), false);
		const freshColdDenied = defer();
		onDenied = e => { if (e.key === freshId) freshColdDenied.resolve(); };
		cache.coldSnapshot({ ...fresh.header, id: freshId }, 0, []);
		await freshColdDenied.promise;
		const freshDisposedDenied = defer();
		onDenied = e => { if (e.key === freshId) freshDisposedDenied.resolve(); };
		ctx.emit('session/disposed', fresh);
		await freshDisposedDenied.promise;
		await cache.write(b);
		assert.equal(table.get(freshId), undefined);
		assert.equal(changed.some(e => e.key === freshId), false);
		await assert.rejects(readFile(path(freshId)), { code: 'ENOENT' });
		console.log('PASS component pre-create UUID gate: create/live/cold/disposed rejected BEFORE delegate, no cache Map/event/tmp; B queue works');
		await cache.write(a); await cache.write(b);
		const originalB = await readFile(path(B), 'utf8');
		holdFlush = true;
		const late = cache.write(a);
		const rejectedLate = assert.rejects(late, { code: 'BTW_TOMBSTONED' });
		await entered.promise;
		await tombstones.seal(A);
		assert.equal(await table.delete(A), true);
		release.resolve(); await rejectedLate;
		assert.equal(table.get(A), undefined);
		await assert.rejects(readFile(path(A)), { code: 'ENOENT' });
		assert.equal(changed.filter(e => e.key === A && e.operation === 'put').length, 1);
		assert.equal(audit.filter(e => e.key === A && e.operation === 'durable-put').length, 1);
		console.log('PASS component deterministic flush-late write rejects, no false success/map/event/disk resurrection');
		const deniedBefore = audit.filter(e => e.operation === 'denied').length;
		assert.deepEqual(cache.coldSnapshot({ ...a.header, id: A }, 0, []), { synthetic: true });
		await cache.write(b); // queue barrier, no timing sleep
		assert.equal(audit.filter(e => e.operation === 'denied').length, deniedBefore + 1);
		assert.equal(table.get(A), undefined);
		const disposedDenied = defer();
		onDenied = e => { if (e.key === A) disposedDenied.resolve(); };
		ctx.emit('session/disposed', a);
		await disposedDenied.promise;
		await cache.write(b);
		assert.equal(audit.filter(e => e.operation === 'denied').length, deniedBefore + 2);
		assert.equal(await table.delete(A), false);
		await assert.rejects(table.put(A, table.get(B)), { code: 'BTW_TOMBSTONED' });
		await table.put(B, table.get(B));
		assert.equal(await readFile(path(B), 'utf8'), originalB);
		assert.deepEqual(await readdir(dirname(path(B))), [`${B}.json`]);
		console.log('PASS component cold/disposed fail-soft producers denied underneath; delete allowed; B queue and bytes intact');
		await domain.close();
		const reopened = await facility.open(spec);
		assert.equal(reopened.table('sessions').get(A), undefined);
		assert.ok(reopened.table('sessions').get(B));
		await assert.rejects(reopened.table('sessions').put(A, reopened.table('sessions').get(B)), { code: 'BTW_TOMBSTONED' });
		await reopened.close();
		console.log('PASS component close/reopen keeps tombstone and normal session');
	} finally {
		await facility.closeAll(); unregister(); unregisterJson(); await backend.close(); await ctx.fiber.dispose();
	}
}

function child(command, args, env, cwd) {
	const result = spawnSync(command, args, { env, cwd, encoding: 'utf8', timeout: 30000 });
	process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
	assert.ifError(result.error); assert.equal(result.status, 0, `child failed: ${args.join(' ')}`);
	return result.stdout;
}
async function hostStartup(root, env, executable) {
	const profile = join(env.DSH_HOME, 'profiles', 'native-probe');
	const baseDir = join(profile, 'node_modules', 'btw-probe-base');
	const bundleDir = join(profile, 'node_modules', 'btw-probe-gate');
	await mkdir(baseDir, { recursive: true }); await mkdir(bundleDir, { recursive: true });
	const jsonFile = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
	await jsonFile(join(profile, 'package.json'), { name: 'btw-native-probe', private: true, dependencies: {}, dsh: { profile: { bundles: ['btw-probe-base', 'btw-probe-gate'] } } });
	for (const [name, dir] of [['btw-probe-base', baseDir], ['btw-probe-gate', bundleDir]]) {
		await jsonFile(join(dir, 'package.json'), { name, version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } });
	}
	await jsonFile(join(baseDir, 'cordis.patch.yml'), [{ insert: [
		{ id: 'storage', name: '@deepseek-ai/dsh-storage' },
		{ id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'host-normal-storage') } },
		{ id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
		{ id: 'session-projection-cache', name: '@deepseek-ai/dsh-session-projection-cache', config: { writeEveryEvents: 50, writeIntervalMs: 100000 } },
	] }]);
	// The extension bundle ITSELF overrides routes, before Loader activation.
	// Merely inserting/registering a new backend without this override cannot route.
	await jsonFile(join(bundleDir, 'cordis.patch.yml'), [
		{ insert: [{ id: 'btw-research-backend', name: fileURLToPath(new URL('../test/fixtures/native-cache-backend-host.mjs', import.meta.url)), config: { precedence: 'bundle' } }] },
		{ id: 'storage-domain', config: { backend: 'json', routes: { session_projcache: 'btw-research' } } },
	]);
	await jsonFile(join(profile, 'cordis.patch.yml'), [{ id: 'btw-research-backend', config: { precedence: 'profile' } }]);
	await jsonFile(join(env.DSH_HOME, 'cordis.patch.yml'), [{ id: 'btw-research-backend', config: { precedence: 'home' } }]);
	const overlay = join(root, 'cli.patch.yml');
	await jsonFile(overlay, [{ id: 'btw-research-backend', config: { precedence: 'cli-last' } }]);
	const output = child(executable, ['native-probe', '--patch', overlay], { ...env, BTW_PROBE_SESSION: randomUUID() }, root);
	assert.match(output, /PASS HOST real CLI startup/);
}
async function webStartup(root, baseEnv, executable) {
	// Keep the entire shipped web profile. Only add one fixture/route and choose
	// the synthetic default model. Never carry custom-CLI's HOME overlay across.
	await rm(join(baseEnv.DSH_HOME, 'cordis.patch.yml'), { force: true });
	const env = { ...baseEnv, TMPDIR: join(root, 'tmp'), DSH_AGENTS_HOME: join(root, 'agents'), NO_COLOR: '1', BTW_PROBE_SESSION: randomUUID(), BTW_PROBE_NORMAL: randomUUID() };
	await mkdir(env.TMPDIR, { recursive: true });
	const patch = join(root, 'web.patch.yml');
	await writeFile(patch, JSON.stringify([
		{ id: 'storage-domain', config: { backend: 'json', routes: { session_projcache: 'btw-web-research' } } },
		{ id: 'agent-default-model', config: { provider: 'btw-synthetic', model: 'synthetic-chat' } },
		{ insert: [{ id: 'btw-web-cache-research', name: fileURLToPath(new URL('../test/fixtures/native-cache-backend-web.mjs', import.meta.url)) }] },
	]));
	let output = '', interrupted = false, spawnError, passed = false;
	const processChild = spawn(executable, ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
	const signal = value => {
		if (!processChild.pid) return;
		try { if (process.platform === 'win32') processChild.kill(value); else process.kill(-processChild.pid, value); }
		catch (error) { if (error.code !== 'ESRCH') throw error; }
	};
	const interrupt = () => { interrupted = true; signal('SIGTERM'); };
	process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
	processChild.stdout.on('data', value => { output = (output + value).slice(-150000); });
	processChild.stderr.on('data', value => { output = (output + value).slice(-150000); });
	processChild.on('error', error => { spawnError = error; });
	const poll = async (check, description, timeout = 45000) => {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			assert.equal(interrupted, false, 'interrupted');
			if (spawnError) throw spawnError;
			assert.equal(processChild.exitCode, null, `Web exited: ${processChild.exitCode}`);
			assert.equal(processChild.signalCode, null, `Web signaled: ${processChild.signalCode}`);
			const result = await check();
			if (result) return result;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		throw new Error(`timed out: ${description}`);
	};
	try {
		const url = new URL(await poll(() => /dsh web:\s+(http:\/\/[^\s]+)/.exec(output)?.[1], 'Web launch URL', 60000));
		assert.equal(url.hostname, '127.0.0.1'); assert.ok(url.searchParams.get('token'));
		assert.doesNotMatch(output, /(?:entries did not activate|entry did not activate|activation failures|full diagnostics:)/i);
		assert.match(output, /WEB probe ready/);
		const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
		assert.equal(exchange.status, 303);
		const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(cookie);
		const rpc = async (channel, method, payload) => {
			const rpcId = randomUUID();
			const response = await fetch(`${url.origin}/${channel}/${method}`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) });
			assert.equal(response.status, 200, `${channel}/${method}`);
			const envelope = await response.json();
			assert.equal(envelope.rpcId, rpcId);
			assert.equal(envelope.result?.ok, true, `${channel}/${method}: ${JSON.stringify(envelope.result)}`);
			return envelope.result.value;
		};
		const api = (method, request) => rpc('api', `session/${method}`, { args: { request } });
		const ids = await rpc('btw-cache-probe', 'create', {});
		assert.equal(ids.blockedId, env.BTW_PROBE_SESSION); assert.equal(ids.normalId, env.BTW_PROBE_NORMAL);
		console.log('PASS WEB full installed web composition: authenticated HTTP; pre-sealed UUID then two real root Agents');
		for (const id of [ids.blockedId, ids.normalId]) {
			assert.deepEqual(await api('prompt', { sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'SYNTHETIC-ONLY prompt; reply with SYNTHETIC-LOCAL-REPLY. Do not call tools.' }] }), { accepted: true });
			const done = await api('wait', { sessionId: id, timeoutMs: 15000 });
			assert.equal(done.reason, 'idle', JSON.stringify(done));
			const events = await api('events', { address: { kind: 'session', sessionId: id }, maxMessages: 50 });
			assert.equal(events.records.some(row => row.event?.type === 'turn/end' && row.event.data?.reason?.kind === 'error'), false, JSON.stringify(events));
			assert.ok(events.records.some(row => row.event?.type === 'user/message' && JSON.stringify(row.event.data).includes('SYNTHETIC-ONLY')), JSON.stringify({ done, events }));
			assert.ok(events.records.some(row => row.event?.type === 'assistant/message' && JSON.stringify(row.event.data).includes('SYNTHETIC-LOCAL-REPLY')), JSON.stringify(events));
		}
		const list = await rpc('api', 'session/list', { args: { _request: {} } });
		assert.ok(list.items.some(item => item.sessionId === ids.blockedId), 'temporary root Session must be addressable in the native catalog');
		assert.ok(list.items.some(item => item.sessionId === ids.normalId), 'ordinary control Session must remain in the native catalog');
		const verified = await rpc('btw-cache-probe', 'verify', {});
		assert.equal(verified.blockedMapAbsent, true); assert.equal(verified.normalMapPresent, true);
		console.log(`PASS WEB real /api/session/prompt + wait/events/list for both Sessions; local synthetic adapter calls=${verified.calls}; blocked Map/disk/tmp absent, normal cache present`);
		assert.deepEqual(await rpc('btw-cache-probe', 'dispose', {}), { disposed: true, blockedMapAbsent: true, normalBytesUnchanged: true });
		console.log('PASS WEB abort/dispose owned Agents; post-detach cache write denied; control cache bytes unchanged');
		assert.doesNotMatch(output, /(?:entries did not activate|entry did not activate|activation failures|full diagnostics:)/i);
		passed = true;
	} catch (error) {
		console.error('--- isolated Web log (launch token redacted) ---\n' + output.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>'));
		throw error;
	} finally {
		process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
		const exited = processChild.exitCode === null && processChild.signalCode === null && processChild.pid ? new Promise(resolve => processChild.once('exit', resolve)) : Promise.resolve();
		signal('SIGTERM');
		const timer = setTimeout(() => signal('SIGKILL'), 8000);
		try { await exited; } finally { clearTimeout(timer); signal('SIGKILL'); }
		if (process.platform !== 'win32' && processChild.pid) {
			const until = Date.now() + 5000;
			let groupAlive = true;
			while (groupAlive && Date.now() < until) {
				try { process.kill(-processChild.pid, 0); }
				catch (error) { if (error.code === 'ESRCH') groupAlive = false; else throw error; }
				if (groupAlive) await new Promise(resolve => setTimeout(resolve, 50));
			}
			assert.equal(groupAlive, false, 'owned Web process group remains');
		}
		console.log('CLEANED Web launcher exited; owned detached process group terminated');
		if (passed) {
			const cacheDir = join(env.DSH_HOME, 'storages/session_projcache/sessions');
			assert.deepEqual(await readdir(cacheDir), [`${env.BTW_PROBE_NORMAL}.json`]);
			assert.ok(await readFile(join(cacheDir, `${env.BTW_PROBE_NORMAL}.json`), 'utf8'));
			console.log('PASS WEB after host exit: only control cache record, no blocked record or JSON temp residue');
		}
	}
}
async function main() {
	const executable = process.env.DSH_BIN || (process.env.PATH || '').split(delimiter).map(p => join(p, 'dsh')).find(existsSync);
	assert.ok(executable, 'installed dsh required (or DSH_BIN)');
	const anchor = join(dirname(dirname(realpathSync(executable))), 'package.json');
	assert.equal(JSON.parse(await readFile(anchor, 'utf8')).version, '0.2.2-rc.1');
	const root = await mkdtemp(join(tmpdir(), 'btw-native-backend-'));
	const env = { PATH: process.env.PATH, HOME: root, DSH_HOME: join(root, 'dsh'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), DSH_TELEMETRY_DISABLED: '1', BTW_PROBE_ANCHOR: anchor, BTW_PROBE_ROOT: root };
	try {
		// Defense in depth only: this does not sandbox native/subprocess traffic.
		const guard = join(root, 'offline.cjs');
		await writeFile(guard, `const net = require('node:net');\nconst old = net.Socket.prototype.connect;\nnet.Socket.prototype.connect = function (...a) {\n const v = a[0]; const host = typeof v === 'object' && v !== null ? v.host : (typeof a[1] === 'string' ? a[1] : undefined);\n const path = typeof v === 'string' || (v && typeof v === 'object' && v.path);\n if (path || !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('offline probe blocked non-loopback connection');\n return old.apply(this, a);\n};\n`);
		env.NODE_OPTIONS = `--require=${guard}`;
		if (process.argv[2] !== '--web') {
			child(process.execPath, [fileURLToPath(import.meta.url), '--components'], env, root);
			child(process.execPath, [fileURLToPath(import.meta.url), '--restart'], env, root);
			await hostStartup(root, env, executable);
		}
		await webStartup(root, env, executable);
		console.log('UNCOVERED cross-process mutual exclusion, concurrent hosts, SIGKILL/power-loss recovery, real provider/model, browser UI and non-cache cleanup');
	} finally { await rm(root, { recursive: true, force: true }); console.log('CLEANED isolated HOME/DSH_HOME'); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv[2] === '--components') await components(process.env.BTW_PROBE_ROOT);
	else if (process.argv[2] === '--restart') await components(process.env.BTW_PROBE_ROOT, true);
	else await main();
}
