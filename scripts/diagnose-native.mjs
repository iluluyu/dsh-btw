#!/usr/bin/env node
// Windows/macOS/Linux diagnostic for the native temporary chat.
//
// Runs its OWN isolated host (fresh HOME/DSH_HOME under the OS temp dir) with
// the local btw checkout, so it never touches a real profile, workspace list or
// session. Print the whole output when reporting a bug.
//
//   node scripts/diagnose-native.mjs            # uses `dsh` on PATH
//   DSH_BIN="C:\path\to\dsh.cmd" node scripts/diagnose-native.mjs
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, release } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const plugin = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'btw-diagnose-'));
const env = {
	PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root,
	XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
	TMPDIR: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
	DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'),
	DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
};
const redact = s => s.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>');
const wait = ms => new Promise(r => setTimeout(r, ms));
const say = (...args) => console.log(...args);
let child, output = '';
const stop = () => { if (child?.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already gone */ } } };

async function rpc(origin, channel, method, payload, cookie) {
	const rpcId = randomUUID();
	const response = await fetch(`${origin}/${channel}/${method}`, {
		method: 'POST', signal: AbortSignal.timeout(60000),
		headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
	});
	const envelope = await response.json().catch(() => ({}));
	return { status: response.status, envelope };
}

async function listing(dir) {
	let entries;
	try { entries = await readdir(dir, { withFileTypes: true }); }
	catch (error) { return `unreadable (${error.code})`; }
	const out = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(`${entry.name}/`, await listing(path));
		else { const info = await stat(path).catch(() => null); out.push(`${entry.name} ${info?.size ?? '?'}B`); }
	}
	return out.flat().join(' ');
}

try {
	await mkdir(env.TMPDIR, { recursive: true });
	say(`platform=${process.platform} node=${process.version} dsh-host=${hostname()} ${release()}`);
	say(`isolated root=${root}`);
	const patch = join(root, 'btw.patch.yml');
	await writeFile(patch, `- insert:\n    - id: btw\n      name: ${JSON.stringify(relative(root, plugin).replaceAll('\\', '/'))}\n`);
	const bin = process.env.DSH_BIN || (process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
	say(`dsh bin=${bin}`);
	say(`dsh version=${(await promisify(execFile)(bin, ['--version'], { cwd: root, env, timeout: 30000, shell: process.platform === 'win32' })).stdout.trim()}`);
	child = spawn(bin, ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
		cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
	});
	child.stdout.on('data', c => { output = (output + c).slice(-80000); });
	child.stderr.on('data', c => { output = (output + c).slice(-80000); });
	let url;
	const deadline = Date.now() + 120000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}`);
		const found = /dsh web:\s+(http:\/\/[^\s]+)/.exec(output);
		if (found) { url = new URL(found[1]); break; }
		await wait(150);
	}
	if (!url) throw new Error('no launch URL');
	const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
	const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('missing launch cookie');
	say('host started, authenticated');

	const profileDir = join(env.DSH_HOME, 'profiles/web');
	const configs = [join(profileDir, 'cordis.yml'), join(profileDir, 'cordis.patch.yml')];
	const before = {};
	for (const file of configs) before[file] = await readFile(file, 'utf8').catch(() => '<missing>');

	const opened = await rpc(url.origin, 'btw', 'nativeOpen', {}, cookie);
	say(`nativeOpen({}) -> HTTP ${opened.status} ${JSON.stringify(opened.envelope.result)}`);
	const id = opened.envelope.result?.value?.sessionId;
	if (!id) throw new Error('nativeOpen did not return a session id');
	say(`session dir before close: ${await listing(join(env.DSH_HOME, 'sessions'))}`);
	say(`recovery records: ${await listing(join(env.DSH_HOME, '.btw-temp-records'))}`);

	const workspaces = await rpc(url.origin, 'api', 'workspace/list', { args: {} }, cookie).catch(() => null);
	say(`workspace/list -> HTTP ${workspaces?.status ?? 'n/a'} ${JSON.stringify(workspaces?.envelope?.result ?? null).slice(0, 1200)}`);

	const closed = await rpc(url.origin, 'btw', 'nativeClose', { sessionId: id }, cookie);
	say(`nativeClose -> HTTP ${closed.status} ${JSON.stringify(closed.envelope.result)}`);
	await wait(1500);
	say(`session dir after close: ${await listing(join(env.DSH_HOME, 'sessions'))}`);
	say(`recovery records after close: ${await listing(join(env.DSH_HOME, '.btw-temp-records'))}`);
	const leftover = [];
	for (const dir of ['sessions', join('.btw-native-workspaces', '_no-cwd'), '.btw-native-deny']) {
		const text = await listing(join(env.DSH_HOME, dir));
		leftover.push(`${dir}: ${text}`);
	}
	say(`leftovers -> ${leftover.join(' | ')}`);
	for (const file of configs) {
		const after = await readFile(file, 'utf8').catch(() => '<missing>');
		say(`config ${file.slice(profileDir.length + 1)} ${after === before[file] ? 'UNCHANGED' : 'REWRITTEN'}`);
	}
	say(`activation warnings: ${/did not activate|activation failed/i.test(output) ? 'YES' : 'no'}`);
} catch (error) {
	say(`DIAGNOSE ERROR: ${error.message}`);
	say(redact(output).slice(-6000));
	process.exitCode = 1;
} finally {
	stop();
	await wait(500);
	await rm(root, { recursive: true, force: true }).catch(() => {});
	say('cleaned isolated root');
}
