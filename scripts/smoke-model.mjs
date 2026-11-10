#!/usr/bin/env node
// Explicit inputs only: node scripts/smoke-model.mjs /path/to/cordis.patch.yml /path/to/.credentials.yaml
// Makes real, billable requests; only synthetic prompts and snapshots are transmitted.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { access, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const wait = ms => new Promise(r => setTimeout(r, ms));
let root, child, stopped = false, interrupted = false, stage = 'arguments';
let logs = '';
const fail = category => { throw new Error(category); };
const check = (condition, category) => { if (!condition) fail(category); };
function classify(s) {
	if (/缺少所选模型 contextWindow/i.test(s)) return 'model-context-window-missing';
	if (/无法查询所选模型 contextWindow/i.test(s)) return 'model-context-window-lookup';
	if (/contextWindow|容量预算/i.test(s)) return 'model-context-window-capacity';
	if (/contextSnapshot|完整性及授权|parentSessionId/i.test(s)) return 'context-source-authorization';
	if (/模型返回空回答|empty (?:answer|response)|no (?:answer|response)/i.test(s)) return 'empty-model-answer';
	if (/模型未正常完成|did not complete|finish reason/i.test(s)) return 'model-finish';
	if (/401|403|unauthori[sz]ed|invalid.?api.?key|authentication/i.test(s)) return 'provider-auth';
	if (/429|rate.?limit|quota|balance|insufficient/i.test(s)) return 'provider-quota-or-rate-limit';
	if (/timeout|timed out|超时/i.test(s)) return 'timeout';
	if (/network|fetch failed|econn|enotfound|tls|socket/i.test(s)) return 'network';
	if (/tool|search|搜索/i.test(s)) return 'model-tool-or-search';
	if (/发送失败/i.test(s)) return 'temp-send-failed';
	if (/不存在|missing|not found/i.test(s)) return 'missing-resource';
	return 'request-or-model';
}
function signalChild(signal) {
	if (!child?.pid) return;
	try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
	catch (e) { if (e.code !== 'ESRCH') throw e; }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { interrupted = true; try { signalChild('SIGTERM'); } catch {} });
async function stop() {
	if (!child?.pid || stopped) return;
	stopped = true;
	const exited = child.exitCode === null && child.signalCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve();
	signalChild('SIGTERM');
	const timer = setTimeout(() => { try { signalChild('SIGKILL'); } catch {} }, 5000);
	try { await exited; } finally { clearTimeout(timer); signalChild('SIGKILL'); }
}
async function findBin(bin) {
	if (bin.includes('/')) return realpath(resolve(bin));
	for (const dir of (process.env.PATH || '').split(':')) {
		try { const p = resolve(dir || '.', bin); await access(p, 1); return await realpath(p); } catch {}
	}
	fail('dsh-not-found');
}
async function rpc(origin, channel, method, payload, cookie, timeout = 10000) {
	const rpcId = randomUUID();
	let response;
	try { response = await fetch(`${origin}/${channel}/${method}`, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) }); }
	catch (e) { fail(classify(String(e))); }
	if (!cookie) return response;
	check(response.status === 200, `rpc-http-${response.status}`);
	let envelope; try { envelope = await response.json(); } catch { fail('rpc-invalid-json'); }
	check(envelope.type === 'server-response' && envelope.rpcId === rpcId, 'rpc-envelope');
	if (!envelope.result?.ok) fail(classify(JSON.stringify(envelope.result?.error ?? '')));
	return envelope.result.value;
}
async function artifacts(id) {
	const found = [];
	async function walk(dir) {
		let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
		for (const entry of entries) {
			check(!entry.isSymbolicLink(), 'session-symlink');
			const path = join(dir, entry.name);
			if (entry.name.includes(id)) found.push(path);
			if (entry.isDirectory()) await walk(path);
		}
	}
	await walk(join(root, 'dsh', 'sessions'));
	return found;
}
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function eventually(fn, timeout = 5000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) { if (interrupted) fail('interrupted'); if (await fn()) return; await wait(150); }
	fail('timeout');
}
const nonce = () => 'N' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
const model = { provider: 'glm', model: 'glm-5.3-flash', reasoningEffort: 'low' };
async function ask(origin, cookie, contextMode, question, transcript, expected, source = {}) {
	// Fingerprint the serialized context shared by requests, not the changing question.
	// This proves our RPC input prefix is stable, not that the provider cached it.
	const context = { contextMode, transcript, model, ...source };
	const prefixHash = createHash('sha256').update(JSON.stringify(context)).digest('hex');
	const job = await rpc(origin, 'btw', 'ask', { ...context, question }, cookie);
	check(typeof job.jobId === 'string', 'ask-job');
	let result;
	try {
		await eventually(async () => { result = await rpc(origin, 'btw', 'askPoll', { jobId: job.jobId }, cookie); return result.done; }, 185000);
	} catch (e) { try { await rpc(origin, 'btw', 'askCancel', { jobId: job.jobId }, cookie); } catch {} throw e; }
	if (result.error) fail(classify(result.error));
	check(typeof result.text === 'string' && (contextMode === 'none' || contextMode === 'all' ? result.text.trim() === expected : result.text.includes(expected)), 'answer-mismatch');
	return prefixHash;
}

try {
	check(process.argv.length === 4, 'explicit-profile-and-credentials-required');
	const profilePath = resolve(process.argv[2]), credentialsPath = resolve(process.argv[3]);
	const bin = await findBin(process.env.DSH_BIN || 'dsh');
	const require = createRequire(bin);
	const yaml = require('yaml');
	// Parse only the non-secret llm-pi-ai block; the source patch may contain custom YAML tags elsewhere.
	stage = 'profile';
	const source = await readFile(profilePath, 'utf8');
	const match = /^- id: llm-pi-ai\s*\n[\s\S]*?(?=^- id: |(?![\s\S]))/m.exec(source);
	check(match, 'provider-block-missing');
	const parsed = yaml.parse(match[0]);
	const entry = parsed?.[0], provider = entry?.config?.providers?.glm;
	check(entry?.id === 'llm-pi-ai' && provider?.api === 'openai-completions' && provider?.baseURL === 'https://open.bigmodel.cn/api/coding/paas/v4' && provider?.apiKeyEnv === 'ZHIPU_API_KEY', 'provider-config-mismatch');
	check(Array.isArray(provider.models), 'provider-models');
	provider.models = provider.models.filter(m => m.id === 'glm-5.3-flash');
	check(provider.models.length === 1, 'provider-model-missing');
	entry.config.providers = { glm: provider };
	stage = 'credentials';
	const credentials = yaml.parse(await readFile(credentialsPath, 'utf8'));
	const key = credentials?.version === 1 && credentials?.refs?.ZHIPU_API_KEY;
	check(typeof key === 'string' && key.length > 0, 'credential-ref-missing');
	root = await mkdtemp(join(tmpdir(), 'btw-model-smoke-'));
	const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: root, DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), TMPDIR: join(root, 'tmp'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' };
	const work = join(root, 'work');
	await mkdir(env.DSH_HOME, { recursive: true }); await mkdir(env.TMPDIR); await mkdir(work);
	await writeFile(join(env.DSH_HOME, '.credentials.yaml'), yaml.stringify({ version: 1, refs: { ZHIPU_API_KEY: key } }), { mode: 0o600, flag: 'wx' });
	stage = 'launch';
	const version = await promisify(execFile)(bin, ['--version'], { cwd: work, env, timeout: 10000 });
	check(/(?:^|\s)0\.2\.2-rc\.1$/.test(version.stdout.trim()), 'dsh-version');
	const patch = join(root, 'patch.yml'), plugin = fileURLToPath(new URL('../lib/index.js', import.meta.url));
	let rel = relative(dirname(patch), plugin).replaceAll('\\', '/'); if (!rel.startsWith('.')) rel = './' + rel;
	await writeFile(patch, yaml.stringify([entry, { insert: [{ id: 'btw', name: rel }] }]));
	child = spawn(bin, ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
	child.stdout.on('data', x => { logs = (logs + x).slice(-100000); }); child.stderr.on('data', x => { logs = (logs + x).slice(-100000); });
	let spawnError; child.on('error', e => { spawnError = e; });
	let url;
	await eventually(async () => { if (spawnError || child.exitCode !== null || child.signalCode !== null) fail('dsh-start'); const m = /dsh web:\s+(http:\/\/[^\s]+)/.exec(logs); if (m) { url = new URL(m[1]); return true; } return false; }, 60000);
	check(url.hostname === '127.0.0.1' && url.searchParams.get('token'), 'launch-url');
	check(!/(?:plugin activation failed|failed to activate|activation failures|full diagnostics:|\b(?:entry|entries|plugins?) did not activate\b)/i.test(logs), 'plugin-activation');
	stage = 'authentication';
	check((await rpc(url.origin, 'btw', 'open', {})).status === 401, 'auth-fence');
	const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
	const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0];
	check(exchange.status === 303 && cookie, 'auth-exchange');
	console.log('PASS: isolated authenticated RPC');
	stage = 'ask-none';
	await ask(url.origin, cookie, 'none', 'Reply with exactly the single word READY and nothing else.', '', 'READY');
	console.log('PASS: ask none');
	stage = 'ask-recent';
	const a = nonce();
	await ask(url.origin, cookie, 'recent', 'What is the synthetic marker in the conversation? Reply with the marker only.', `User: The synthetic marker is ${a}.`, a);
	console.log('PASS: ask recent');
	stage = 'ask-on-demand';
	const b = nonce();
	await ask(url.origin, cookie, 'on-demand', 'Search the snapshot for synthetic marker and return its exact value.', `User: The synthetic marker is ${b}.`, b);
	console.log('PASS: ask on-demand');
	stage = 'ask-all-first';
	const oldest = nonce(), newest = nonce();
	const fullTranscript = `User: The opening synthetic marker is ${oldest}.\n`
		+ 'User: Later synthetic history entry, unrelated neutral filler data.\n'.repeat(1000)
		+ `User: The later synthetic marker is ${newest}. This does not replace the opening marker.\n`;
	check(fullTranscript.length > 48000 && !fullTranscript.slice(-48000).includes(oldest), 'all-fixture-not-beyond-recent-window');
	const fullSource = Object.freeze({ parentSessionId: 'synthetic-source', contextSnapshot: Object.freeze({ sessionId: 'synthetic-source', throughSeq: 0, complete: true, authorized: true }) });
	const firstPrefix = await ask(url.origin, cookie, 'all', 'Return only the exact opening synthetic marker from the very beginning of the conversation, not the later marker.', fullTranscript, oldest, fullSource);
	console.log('PASS: ask all opening nonce beyond 48k');
	stage = 'ask-all-second';
	const secondPrefix = await ask(url.origin, cookie, 'all', 'Which synthetic marker was recorded first at the start of this history? Reply with that marker alone, not the later marker.', fullTranscript, oldest, fullSource);
	check(firstPrefix === secondPrefix, 'all-prefix-changed');
	console.log('PASS: ask all second question with byte-identical context prefix');
	// /btw/askPoll exposes answer/status/error, not provider token usage. No
	// provider cache claim follows from equal inputs; client cache has its own tests.
	console.log('LIMIT: provider cache-read usage not exposed by btw RPC; cache hit unverified');
	stage = 'temp-open';
	const opened = await rpc(url.origin, 'btw', 'open', { model, contextMode: 'none' }, cookie);
	const id = opened.sessionId;
	check(typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id), 'session-id');
	check(opened.cwd == null || opened.cwd === '', 'no-workspace');
	const record = join(env.DSH_HOME, '.btw-temp-records', `${id}.json`);
	try {
		stage = 'temp-artifacts';
		await eventually(async () => (await artifacts(id)).length === 1 && await exists(record));
		stage = 'temp-turn-one';
		const c = nonce();
		const first = await rpc(url.origin, 'btw', 'send', { sessionId: id, text: `Remember the synthetic marker ${c}. Reply with exactly ${c}.` }, cookie, 185000);
		check(first.output?.includes(c), 'answer-mismatch');
		const firstPoll = await rpc(url.origin, 'btw', 'poll', { sessionId: id, fromSeq: 0 }, cookie);
		check(firstPoll.text?.includes(c) && Number.isSafeInteger(firstPoll.lastSeq), 'poll-mismatch');
		stage = 'temp-turn-two';
		const second = await rpc(url.origin, 'btw', 'send', { sessionId: id, text: 'What synthetic marker did I ask you to remember? Reply with the marker only.' }, cookie, 185000);
		check(second.output?.includes(c), 'answer-mismatch');
		const secondPoll = await rpc(url.origin, 'btw', 'poll', { sessionId: id, fromSeq: firstPoll.lastSeq }, cookie);
		check(secondPoll.text?.includes(c) && secondPoll.lastSeq >= firstPoll.lastSeq, 'poll-mismatch');
		console.log('PASS: no-workspace two-turn send/poll');
	} finally {
		const closed = await rpc(url.origin, 'btw', 'close', { sessionId: id }, cookie, 30000);
		check(closed.burned === true, 'close-failed');
	}
	stage = 'temp-cleanup';
	await eventually(async () => (await artifacts(id)).length === 0 && !(await exists(record)));
	await wait(1500);
	check((await artifacts(id)).length === 0 && !(await exists(record)), 'artifact-reappeared');
	console.log('PASS: session directory and marker removed');
} catch (e) {
	process.exitCode = 1;
	const safe = /^[a-z0-9-]+$/.test(e?.message || '') ? e.message : 'unexpected';
	console.error(`FAIL: ${stage}: ${safe}`);
} finally {
	try {
		await stop();
		if (child?.pid) {
			check(child.exitCode !== null || child.signalCode !== null, 'child-still-running');
			console.log('PASS: cleanup owned child exited and process group terminated');
		}
	} catch { process.exitCode = 1; console.error('FAIL: cleanup: process-stop'); }
	if (root) try {
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		check(!(await exists(root)), 'temporary-root-remains');
		console.log('PASS: cleanup temporary root absent');
	} catch { process.exitCode = 1; console.error('FAIL: cleanup: temporary-files'); }
}
