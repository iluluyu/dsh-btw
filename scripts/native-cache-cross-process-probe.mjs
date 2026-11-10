#!/usr/bin/env node
// Research-only cross-process counterexample. Never imported by the plugin.
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GatedBackend, Tombstones, installed } from './native-cache-backend-probe.mjs';

const self = fileURLToPath(import.meta.url);
const descriptor = { name: 'session_projcache', version: 7, tables: ['sessions'], hasGlobal: false, layout: 'per-record', compatibleVersions: [3, 4, 5, 6] };

async function writer() {
	const { load } = installed();
	const { JsonStorageBackend } = await load('dsh-storage-json');
	const root = process.env.BTW_PROBE_ROOT, key = process.env.BTW_PROBE_KEY;
	const gate = new Tombstones(join(root, 'markers'));
	const backend = new GatedBackend(new JsonStorageBackend(join(root, 'storage')), gate, {
		beforePut: () => new Promise(resolve => {
			process.send({ type: 'checked' });
			process.once('message', message => { assert.equal(message, 'release'); resolve(); });
		}),
	});
	try {
		const unit = await backend.kv.open(descriptor);
		try {
			await unit.putRecord('sessions', key, { identity: {}, rows: { title: 'SYNTHETIC-ONLY' } });
			process.send({ type: 'written' });
		} catch (error) {
			if (error.code === 'BTW_TOMBSTONED') process.send({ type: 'denied' });
			else if (error instanceof SyntaxError) process.send({ type: 'corrupt-marker' });
			else throw error;
		}
		await unit.close();
	} finally { await backend.close(); }
}

async function sealer() {
	const gate = new Tombstones(join(process.env.BTW_PROBE_ROOT, 'markers'));
	await gate.seal(process.env.BTW_PROBE_KEY);
	process.on('message', () => {}); // keep IPC alive until the parent kills us
	process.send({ type: 'sealed' });
}

function nextMessage(child) {
	return new Promise((resolve, reject) => {
		const onMessage = message => { cleanup(); resolve(message); };
		const onExit = (code, signal) => { cleanup(); reject(new Error(`writer exited before message: ${code ?? signal}`)); };
		const onError = error => { cleanup(); reject(error); };
		const timer = setTimeout(() => { cleanup(); reject(new Error('writer message timed out')); }, 15000);
		function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); }
		child.once('message', onMessage); child.once('exit', onExit); child.once('error', onError);
	});
}
function childExit(child) {
	return new Promise((resolve, reject) => {
		child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`writer failed: ${code ?? signal}`)));
		child.once('error', reject);
	});
}
async function main() {
	const executable = process.env.DSH_BIN || (process.env.PATH || '').split(delimiter).map(path => join(path, 'dsh')).find(existsSync);
	assert.ok(executable, 'installed dsh required (or DSH_BIN)');
	const anchor = join(dirname(dirname(realpathSync(executable))), 'package.json');
	assert.equal(JSON.parse(await readFile(anchor, 'utf8')).version, '0.2.2-rc.1');
	const root = await mkdtemp(join(tmpdir(), 'btw-cross-process-'));
	const env = { PATH: process.env.PATH, HOME: root, DSH_HOME: join(root, 'dsh'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), DSH_TELEMETRY_DISABLED: '1', BTW_PROBE_ROOT: root, BTW_PROBE_ANCHOR: anchor };
	const active = new Set();
	const start = (key, mode = '--writer') => {
		const child = fork(self, [mode], { env: { ...env, BTW_PROBE_KEY: key }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
		active.add(child); child.once('exit', () => active.delete(child));
		return child;
	};
	const path = key => join(root, 'storage', 'session_projcache', 'sessions', `${key}.json`);
	try {
		const gate = new Tombstones(join(root, 'markers'));
		await gate.init();
		// The old writer pauses AFTER checking the gate. A marker from another
		// process cannot retroactively prevent that already-admitted write.
		const late = randomUUID(), first = start(late), firstExit = childExit(first);
		assert.equal((await nextMessage(first)).type, 'checked');
		await gate.seal(late);
		const firstResult = nextMessage(first); first.send('release');
		assert.equal((await firstResult).type, 'written'); await firstExit;
		assert.match(await readFile(path(late), 'utf8'), /SYNTHETIC-ONLY/);
		console.log('PASS counterexample: close-time marker alone cannot fence another process already past its check');

		// A marker is durable before the session can have a writer at all.
		const early = randomUUID(); await gate.seal(early);
		const second = start(early), secondExit = childExit(second);
		assert.equal((await nextMessage(second)).type, 'denied'); await secondExit;
		await assert.rejects(readFile(path(early)), { code: 'ENOENT' });
		console.log('PASS pre-create marker observed by a fresh OS process; own cache write denied');

		// A process killed after fsync cannot take its marker with it. This is
		// deliberately not a power-loss or interrupted-creation simulation.
		const crashed = randomUUID(), markerOwner = start(crashed, '--sealer');
		const killed = new Promise((resolve, reject) => {
			markerOwner.once('exit', (_code, signal) => resolve(signal));
			markerOwner.once('error', reject);
		});
		assert.equal((await nextMessage(markerOwner)).type, 'sealed');
		assert.equal(markerOwner.kill('SIGKILL'), true); assert.equal(await killed, 'SIGKILL');
		const recovered = start(crashed), recoveredExit = childExit(recovered);
		assert.equal((await nextMessage(recovered)).type, 'denied'); await recoveredExit;
		await assert.rejects(readFile(path(crashed)), { code: 'ENOENT' });
		console.log('PASS pre-create marker survives SIGKILL after fsync; fresh process still denies own cache write');

		const corrupt = randomUUID();
		await writeFile(gate.path(corrupt), '{', { mode: 0o600 });
		const corruptWriter = start(corrupt), corruptExit = childExit(corruptWriter);
		assert.equal((await nextMessage(corruptWriter)).type, 'corrupt-marker'); await corruptExit;
		await assert.rejects(readFile(path(corrupt)), { code: 'ENOENT' });
		console.log('PASS corrupted marker fails closed before cache writer');

		const normal = randomUUID(), third = start(normal), thirdExit = childExit(third);
		assert.equal((await nextMessage(third)).type, 'checked');
		const thirdResult = nextMessage(third); third.send('release');
		assert.equal((await thirdResult).type, 'written'); await thirdExit;
		assert.match(await readFile(path(normal), 'utf8'), /SYNTHETIC-ONLY/);
		console.log('PASS unmarked session writes normally after blocked session');

		let delegated = 0;
		const fakeDelegate = { kv: { open: async () => { delegated++; return { close: async () => {} }; } }, close: async () => {} };
		const checkedBackend = new GatedBackend(fakeDelegate, gate);
		for (const invalid of [
			{ ...descriptor, version: 8 }, { ...descriptor, layout: 'single' },
			{ ...descriptor, tables: ['sessions', 'other'] }, { ...descriptor, hasGlobal: true },
			{ ...descriptor, compatibleVersions: [] },
		]) await assert.rejects(checkedBackend.kv.open(invalid));
		assert.equal(delegated, 0, 'unknown descriptor must fail before opening the delegate');
		const other = await checkedBackend.kv.open({ name: 'another_domain' });
		assert.equal(delegated, 1); await other.close(); await checkedBackend.close();
		console.log('PASS unknown cache descriptors fail before delegate; unrelated domain remains unrestricted');
		console.log('UNCOVERED concurrent hosts, death during marker creation or cache write, power loss, marker loss, backend route bypass and native Web');
	} finally {
		for (const child of active) child.kill('SIGTERM');
		await Promise.allSettled([...active].map(child => childExit(child)));
		await rm(root, { recursive: true, force: true });
		console.log('CLEANED isolated HOME/DSH_HOME');
	}
}

if (process.argv[2] === '--writer') await writer();
else if (process.argv[2] === '--sealer') await sealer();
else await main();
