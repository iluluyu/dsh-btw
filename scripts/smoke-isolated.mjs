#!/usr/bin/env node
// Isolated host smoke. No package manager, user profile, browser, or model call.
// Run: node scripts/smoke-isolated.mjs  (DSH_BIN may select a local launcher).
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'btw-smoke-'));
const plugin = fileURLToPath(new URL('../lib/index.js', import.meta.url));
let child;
let output = '';
let failed = false;
let interrupted = false;
const activationFailure = /(?:plugin activation failed|failed to activate|activation failures|full diagnostics:|\b(?:entry|entries|plugins?) did not activate\b|\bbtw\s*\([^\n)]*\)\s*:\s*(?:error|failed)\b)/i;
// A detached process group is ours alone; terminate the group on interruption too.
function signalChild(signal) {
	if (!child?.pid) return;
	try {
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) { if (error.code !== 'ESRCH') throw error; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
	interrupted = true;
	failed = true;
	try { signalChild('SIGTERM'); } catch { /* stop() will retry */ }
});
const redact = (s) => s.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = {
	PATH: process.env.PATH ?? '/usr/bin:/bin',
	HOME: root,
	XDG_CONFIG_HOME: join(root, 'config'),
	XDG_CACHE_HOME: join(root, 'cache'),
	XDG_DATA_HOME: join(root, 'data'),
	TMPDIR: join(root, 'tmp'),
	DSH_HOME: join(root, 'dsh'),
	DSH_AGENTS_HOME: join(root, 'agents'),
	DSH_TELEMETRY_DISABLED: '1',
	NO_COLOR: '1',
};

async function rpc(origin, channel, method, payload, cookie) {
	const rpcId = randomUUID();
	const response = await fetch(`${origin}/${channel}/${method}`, {
		method: 'POST', signal: AbortSignal.timeout(10000),
		headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
	});
	if (!cookie) return response;
	assert.equal(response.status, 200, `${channel}/${method}: HTTP ${response.status}`);
	const envelope = await response.json();
	assert.equal(envelope.type, 'server-response');
	assert.equal(envelope.rpcId, rpcId);
	assert.equal(envelope.result?.ok, true, `${channel}/${method}: ${JSON.stringify(envelope.result)}`);
	return envelope.result.value;
}

async function stop() {
	if (!child?.pid) return;
	const running = child.exitCode === null && child.signalCode === null;
	const exited = running ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
	signalChild('SIGTERM');
	const timer = setTimeout(() => signalChild('SIGKILL'), 10000);
	try { await exited; } finally {
		clearTimeout(timer);
		// Kill any descendants that outlived the launcher, before deleting its home.
		signalChild('SIGKILL');
	}
}

async function recordFor(id) {
	try { return JSON.parse(await readFile(join(env.DSH_HOME, '.btw-temp-records', `${id}.json`), 'utf8')); }
	catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Only inspect the isolated default persistence root; never follow symlinks.
async function sessionArtifacts(id) {
	const matches = [];
	let files = 0;
	async function walk(dir, insideMatch = false) {
		let entries;
		try { entries = await readdir(dir, { withFileTypes: true }); }
		catch (error) { if (error.code === 'ENOENT') return; throw error; }
		for (const entry of entries) {
			const path = join(dir, entry.name);
			assert.ok(!entry.isSymbolicLink(), `unexpected symlink in isolated sessions: ${path}`);
			const matched = insideMatch || entry.name.includes(id);
			if (entry.name.includes(id)) matches.push(path);
			if (matched && entry.isFile()) files += 1;
			if (entry.isDirectory()) await walk(path, matched);
		}
	}
	await walk(join(env.DSH_HOME, 'sessions'));
	return { matches, files };
}

async function eventually(check, description, timeout = 5000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (interrupted) throw new Error('interrupted');
		if (await check()) return;
		await wait(100);
	}
	throw new Error(`timed out: ${description}`);
}

async function concurrentTemps(origin, cookie) {
	const pending = new Set();
	try {
		for (const payload of [{ cwd: root }, {}]) {
			const { sessionId } = await rpc(origin, 'btw', 'open', payload, cookie);
			assert.match(sessionId, /^[0-9a-f-]{36}$/i);
			assert.equal(pending.has(sessionId), false, 'temporary chats must have distinct IDs');
			pending.add(sessionId);
			assert.ok(await recordFor(sessionId), 'each temporary chat owns a recovery record');
		}
		const [first, second] = [...pending];
		assert.equal((await rpc(origin, 'btw', 'close', { sessionId: first }, cookie)).burned, true);
		pending.delete(first);
		assert.equal(await recordFor(first), null);
		assert.deepEqual((await sessionArtifacts(first)).matches, []);
		assert.ok(await recordFor(second), 'closing one chat must preserve the other record');
		assert.ok((await sessionArtifacts(second)).files > 0, 'closing one chat must preserve the other log');
		assert.equal((await rpc(origin, 'btw', 'poll', { sessionId: second, fromSeq: 0 }, cookie)).lastSeq, 0);
	} finally {
		for (const id of pending) {
			assert.equal((await rpc(origin, 'btw', 'close', { sessionId: id }, cookie)).burned, true);
			assert.equal(await recordFor(id), null);
			assert.deepEqual((await sessionArtifacts(id)).matches, []);
		}
	}
}

async function nativeRoundTrip(origin, cookie) {
	const opened = await rpc(origin, 'btw', 'nativeOpen', {}, cookie);
	assert.match(opened.sessionId, /^[0-9a-f-]{36}$/i);
	const id = opened.sessionId;
	const ownedWorkspace = join(env.DSH_HOME, '.btw-native-workspaces', '_no-cwd', id);
	assert.equal(opened.cwd, ownedWorkspace);
	assert.equal((await lstat(ownedWorkspace)).isDirectory(), true);
	assert.ok((await sessionArtifacts(id)).files > 0);
	for (const records of ['.btw-native-records', '.btw-native-workspace-records']) {
		assert.ok(await readFile(join(env.DSH_HOME, records, `${id}.json`), 'utf8'));
	}
	// A real plugin reload disposes the owner and loses its in-memory close receipt.
	assert.equal((await rpc(origin, 'btw-smoke-lifecycle', 'restart', {}, cookie)).restarted, true);
	assert.equal((await rpc(origin, 'btw', 'nativeClose', { sessionId: id }, cookie)).burned, true);
	assert.equal((await rpc(origin, 'btw', 'nativeClose', { sessionId: id }, cookie)).burned, true);
	assert.deepEqual((await sessionArtifacts(id)).matches, []);
	await assert.rejects(lstat(ownedWorkspace), { code: 'ENOENT' });
	for (const records of ['.btw-native-records', '.btw-native-workspace-records']) {
		assert.equal((await readdir(join(env.DSH_HOME, records))).some(name => name.startsWith(id)), false);
	}
	assert.ok(await readFile(join(env.DSH_HOME, '.btw-native-deny', `${id}.json`), 'utf8'), 'permanent deny marker remains');
}

async function tempRoundTrip(origin, cookie, payload, noWorkspace) {
	const opened = await rpc(origin, 'btw', 'open', payload, cookie);
	// Do not interpolate an untrusted id into a path or accept an ambiguous match.
	assert.match(opened.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid session ID');
	const id = opened.sessionId;
	let siblingSentinel;
	try {
		if (noWorkspace) assert.ok(opened.cwd == null || opened.cwd === '', `no-workspace open fell back to cwd ${opened.cwd}`);
		else assert.equal(opened.cwd, root, 'workspace cwd differs from isolated root');
		const polled = await rpc(origin, 'btw', 'poll', { sessionId: id, fromSeq: 0 }, cookie);
		assert.equal(polled.text, '');
		assert.equal(polled.lastSeq, 0);
		await eventually(async () => (await sessionArtifacts(id)).files > 0, 'temporary session physical file before close');
		const artifacts = await sessionArtifacts(id);
		assert.equal(artifacts.matches.length, 1, 'expected one session directory');
		const dir = artifacts.matches[0];
		assert.equal((await lstat(dir)).isDirectory(), true, 'session directory must exist before close');
		const names = await readdir(dir);
		assert.ok(names.includes('session.v4.jsonl') || names.includes('session.v4.jsonl.zstd'), 'default JSONL file missing');
		siblingSentinel = join(dirname(dir), `smoke-sibling-${randomUUID()}`, 'sentinel');
		await mkdir(dirname(siblingSentinel));
		await writeFile(siblingSentinel, 'keep');
		const record = await recordFor(id);
		assert.ok(record, 'temporary session recovery record missing before close');
		assert.equal(record.version, 2);
		assert.equal(record.kind, 'btw-default-jsonl-temp');
		assert.equal(record.runtime, '0.2.2-rc.1');
		assert.ok(Number.isSafeInteger(record.owner?.pid));
		for (const identity of [record.rootIdentity, record.projectIdentity, record.dirIdentity]) {
			assert.match(identity?.dev, /^\d+$/);
			assert.match(identity?.ino, /^\d+$/);
		}
		assert.equal(record.id, id);
		assert.equal(record.backend, 'jsonl');
		assert.equal(record.root, join(env.DSH_HOME, 'sessions'));
		if (noWorkspace) assert.equal(record.cwd, null, 'no-workspace record has a cwd');
		else assert.equal(record.cwd, root, 'record cwd differs from isolated root');
	} finally {
		const closed = await rpc(origin, 'btw', 'close', { sessionId: id }, cookie);
		assert.equal(closed.burned, true);
	}
	await eventually(async () => (await sessionArtifacts(id)).matches.length === 0 && !(await recordFor(id)), 'physical session and recovery record cleanup');
	// Check again after delayed write-behind would have had an opportunity to recreate it.
	await wait(1500);
	assert.deepEqual((await sessionArtifacts(id)).matches, [], 'session artifact reappeared');
	assert.equal(await recordFor(id), null, 'recovery record reappeared');
	assert.equal(await readFile(siblingSentinel, 'utf8'), 'keep', 'sibling session sentinel changed');
	assert.equal(await readFile(join(env.DSH_HOME, '.btw-temp-records', 'smoke-sentinel'), 'utf8'), 'keep', 'record sentinel changed');
}

try {
	await mkdir(env.TMPDIR, { recursive: true });
	await mkdir(join(env.DSH_HOME, '.btw-temp-records'), { recursive: true });
	await writeFile(join(env.DSH_HOME, '.btw-temp-records', 'smoke-sentinel'), 'keep');
	// Restrict ordinary Node TCP clients to loopback; no credentials are inherited.
	// This is defense in depth, not an OS network namespace (see output).
	const guard = join(root, 'offline.cjs');
	await writeFile(guard, `const net = require('node:net');\nconst old = net.Socket.prototype.connect;\nnet.Socket.prototype.connect = function (...a) {\n const v = a[0]; const host = typeof v === 'object' && v !== null ? v.host : (typeof a[1] === 'string' ? a[1] : undefined);\n const path = typeof v === 'string' || (v && typeof v === 'object' && v.path);\n if (path || !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('offline smoke blocked non-loopback connection');\n return old.apply(this, a);\n};\n`);
	env.NODE_OPTIONS = `--require=${guard}`;
	const bin = process.env.DSH_BIN || 'dsh';
	const version = await promisify(execFile)(bin, ['--version'], { cwd: root, env, timeout: 10000 });
	assert.match(version.stdout.trim(), /(?:^|\s)0\.2\.2-rc\.1$/, 'expected dsh 0.2.2-rc.1');
	console.log('ok: dsh 0.2.2-rc.1');
	// Use a patch instead of pnpm: no registry access and the checkout is loaded directly.
	const patch = join(root, 'btw.patch.yml');
	const rel = relative(dirname(patch), plugin).replaceAll('\\', '/');
	// Keep the probe outside dsh-btw's package root: client-modules permits only
	// one active Loader source per client package.
	const reloadProbe = join(root, 'lifecycle-reload-host.mjs');
	await writeFile(reloadProbe, await readFile(new URL('../test/fixtures/lifecycle-reload-host.mjs', import.meta.url), 'utf8'));
	await writeFile(patch, `- insert:\n    - id: btw\n      name: ${JSON.stringify(rel.startsWith('.') ? rel : './' + rel)}\n    - id: btw-smoke-lifecycle\n      name: ${JSON.stringify(reloadProbe)}\n`);
	child = spawn(bin, ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
		cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
	});
	child.stdout.on('data', (x) => { output = (output + x).slice(-100000); });
	child.stderr.on('data', (x) => { output = (output + x).slice(-100000); });
	let spawnError;
	child.on('error', (error) => { spawnError = error; });
	let url;
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		if (interrupted) throw new Error('interrupted');
		if (spawnError) throw spawnError;
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`dsh exited before readiness: ${child.exitCode ?? child.signalCode}`);
		const match = /dsh web:\s+(http:\/\/[^\s]+)/.exec(output);
		if (match) { url = new URL(match[1]); break; }
		await wait(100);
	}
	assert.ok(url, 'no launch URL within 60 seconds');
	assert.equal(url.hostname, '127.0.0.1');
	assert.ok(url.searchParams.get('token'), 'missing launch token');
	assert.doesNotMatch(output, activationFailure, 'activation error in startup log');
	console.log('ok: isolated web started with local btw patch');
	for (const [channel, method, payload] of [['api', 'settings/describe', { args: {} }], ['btw', 'open', { cwd: root }]]) {
		assert.equal((await rpc(url.origin, channel, method, payload)).status, 401, `${channel} must reject unauthenticated requests`);
	}
	console.log('ok: authentication fence on /api and /btw');
	const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
	assert.equal(exchange.status, 303, 'launch token exchange');
	const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0];
	assert.ok(cookie, 'missing session cookie');
	const settings = await rpc(url.origin, 'api', 'settings/describe', { args: {} }, cookie);
	assert.ok(Array.isArray(settings.namespaces), 'settings namespaces missing');
	console.log('ok: authenticated built-in /api');
	await tempRoundTrip(url.origin, cookie, { cwd: root }, false);
	console.log('ok: workspace temp open/poll/close and physical/recovery-record cleanup');
	await tempRoundTrip(url.origin, cookie, {}, true);
	console.log('ok: no-workspace temp open/poll/close and physical/recovery-record cleanup');
	await concurrentTemps(url.origin, cookie);
	console.log('ok: concurrent temporary chats own independent records and close independently');
	await nativeRoundTrip(url.origin, cookie);
	console.log('ok: real native root survives plugin-reload close acknowledgement; owned JSONL/workspace/records removed, deny marker retained');
	assert.doesNotMatch(output, activationFailure, 'activation error in log');
} catch (error) {
	failed = true;
	console.error(`FAIL: ${redact(String(error.stack || error))}`);
	if (output) console.error(`--- dsh output (token redacted) ---\n${redact(output)}`);
} finally {
	await stop();
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	console.log('cleanup: stopped child and removed temporary directory');
	console.log('limit: Node network guard is not an OS-level network sandbox; native/subprocess traffic is not covered');
}
if (failed || interrupted) process.exitCode = 1;
