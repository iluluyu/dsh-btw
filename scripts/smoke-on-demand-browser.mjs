#!/usr/bin/env node
// Isolated browser E2E for btw on-demand context (按需引用当前对话) on dsh 0.2.2-rc.5.
// No real provider/account/production profile: a loopback OpenAI-compatible SSE
// stub answers every model call, an isolated HOME hosts dsh web, and a system
// Chromium is driven over raw CDP using a clean temporary browser profile.
//
// Run: node scripts/smoke-on-demand-browser.mjs [--keep] [--supplement | --scroll | --retry | --native-draft]
// Env: CHROME_BIN (default /usr/sbin/chromium), DSH_BIN (default dsh).
//
// --supplement exercises the btw_read_context 补读 round trip: the stub's
// first child turn answers with a btw_read_context tool call whose anchor is a
// seq actually quoted in the excerpt prompt; after the host returns the
// adjacent tool-result text, the follow-up turn quotes that text verbatim.
// Asserts the first request withholds the neighbor (and unrelated /
// other-session data), the anchor is a quoted seq, the tool result is exactly
// the adjacent reply, and the citation disclosure shows 补读 + neighbor text.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const KEEP = process.argv.includes('--keep');
const SUPPLEMENT = process.argv.includes('--supplement');
const RETRY = process.argv.includes('--retry');
const SCROLL = process.argv.includes('--scroll');
const NATIVE_DRAFT = process.argv.includes('--native-draft');
assert.ok([SUPPLEMENT, RETRY, SCROLL, NATIVE_DRAFT].filter(Boolean).length <= 1);
const RETRY_THOUGHT = 'RETRY-FIRST-THOUGHT';
let retryStarted = false;
const CHROME_BIN = process.env.CHROME_BIN || '/usr/sbin/chromium';
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const MODEL = { provider: 'glm', model: 'stub-mini' };
const API_KEY = 'stub-key-' + randomUUID().slice(0, 12);
const NEEDLE = 'NEEDLE-STG-7Q4X9K';
const PRIVATE = 'PRIVATE-9981KK';
const SEED_OK = 'OK，已记下。';
const MSG_PRIVATE = `私密备忘：测试银行卡暗号 ${PRIVATE}，只允许本会话使用，不要外传。回复 OK 即可。`;
const MSG_NEEDLE = `部署记录：staging 环境的部署口令是 ${NEEDLE}，请记住，稍后我会提问。回复 OK 即可。`;
const MSG_UNRELATED = '下周团建安排：火锅聚餐报名，周五中午前登记。回复 OK 即可。';
const QUESTION = 'staging 环境的部署口令是什么？请引用原文回答。';
const TOOL_NAME = 'btw_read_context';
const NEIGHBOR = 'NEIGHBOR-EXT-8W2V';
// --supplement withheld neighbor: the assistant reply to a setup message seeded
// right before the needle. DSH commits injected context as its own user events
// AFTER each user message, so that reply is the event immediately preceding the
// needle user event — the older neighbor the host withholds until the model
// calls btw_read_context. Neither text shares a question term
// (staging/环境/部署/口令/引用/原文/回答), so the client search keeps both out
// of the excerpts.
const MSG_PRE = `运维备忘：紧急联系分机 ${NEIGHBOR} 也请记牢。回复 OK 即可。`;
const REPLY_PRE = `OK，已记下。运维值班分机 ${NEIGHBOR} 已一并记录。`;
const MILESTONES = '/tmp/btw-on-demand-e2e-milestones.log';
const SHOT_OK = NATIVE_DRAFT ? '/tmp/btw-native-draft-roundtrip.png' : '/tmp/btw-on-demand-e2e.png';
const SHOT_FAIL = '/tmp/btw-on-demand-e2e-fail.png';
const FRAME_CHILD = 'untrusted excerpts from the source conversation';

const mile = (line) => {
	const text = `${new Date().toISOString()} ${line}`;
	try { appendFileSync(MILESTONES, text + '\n'); } catch { /* best effort */ }
	console.log(text);
};
writeFileSync(MILESTONES, `# btw on-demand browser E2E ${SUPPLEMENT ? '--supplement ' : ''}${new Date().toISOString()}\n`);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let root, dshChild, chromeChild, dshOutput = '', interrupted = false, failed = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; failed = true; mile(`interrupted by ${signal}`); });

function signalChild(signal) {
	for (const child of [chromeChild, dshChild]) {
		if (!child?.pid) continue;
		try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
	}
}
async function teardown() {
	signalChild('SIGKILL');
	await wait(300);
	if (!KEEP && root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

// ── loopback OpenAI-compatible SSE stub ─────────────────────────────────────
const requests = []; // { t, path, auth, body, raw }
let supplementToolCalls = 0; // --supplement: at most one tool-call turn per run
const stub = createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const raw = Buffer.concat(chunks).toString('utf8');
		let body = null;
		try { body = JSON.parse(raw); } catch { /* keep null */ }
		requests.push({ t: Date.now(), path: req.url, auth: req.headers.authorization || '', body, raw });
		if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: `stub: unexpected ${req.method} ${req.url}` } }));
			return;
		}
		// Default mode stays tool-less by construction: one plain text answer.
		// DSH may append its own context after the child question; a needle is
		// echoed only from the user message carrying our excerpt frame.
		// --supplement mode: the first child turn responds with a btw_read_context
		// tool call anchored to a seq actually quoted in the excerpt prompt; the
		// follow-up turn answers by quoting the adjacent text the host tool
		// returned, so the final answer is grounded in real tool output.
		const flat = (m) => typeof m?.content === 'string' ? m.content
			: Array.isArray(m?.content) ? m.content.map((b) => b?.text ?? '').join('') : '';
		const messages = body?.messages ?? [];
		let text = null, toolCalls = null;
		if (SUPPLEMENT) {
			const childMessage = messages.find((m) => m.role === 'user' && flat(m).includes(FRAME_CHILD));
			const readTexts = [];
			for (const m of messages) {
				const content = flat(m);
				if (!content.includes('Untrusted neighboring source messages')) continue;
				const payload = /\[[\s\S]*\]/.exec(content.split('Untrusted neighboring source messages')[1] ?? '')?.[0];
				try { readTexts.push(...(JSON.parse(payload ?? '[]') ?? []).map((e) => e?.text).filter((t) => typeof t === 'string')); } catch { /* the answer flags the gap */ }
			}
			if (childMessage) {
				const convo = /<conversation[^>]*>\n([\s\S]*?)\n<\/conversation>/.exec(flat(childMessage))?.[1] ?? '';
				let excerpts = [];
				try { excerpts = JSON.parse(convo) ?? []; } catch { /* fall through */ }
				const target = excerpts.find((e) => typeof e?.text === 'string' && e.text.includes('NEEDLE-STG-')) ?? excerpts[0];
				const needle = /NEEDLE-STG-[A-Z0-9]+/.exec(String(target?.text ?? ''))?.[0] ?? '';
				const offered = (body?.tools ?? []).some((t) => (t?.function?.name ?? t?.name) === TOOL_NAME);
				if (!readTexts.length && offered && Number.isSafeInteger(target?.seq) && supplementToolCalls < 1) {
					supplementToolCalls++;
					toolCalls = [{ index: 0, id: 'call-e2e-read-1', type: 'function',
						function: { name: TOOL_NAME, arguments: JSON.stringify({ anchor: target.seq }) } }];
				} else {
					text = `staging 部署口令是 ${needle}。` + (readTexts.length
					? `相邻消息原文：「${readTexts.join('」「')}」`
					: '（未能取得相邻消息原文）');
				}
			} else text = messages.some((m) => m.role === 'user' && flat(m).startsWith(MSG_PRE)) ? REPLY_PRE : SEED_OK;
		} else {
			const excerptPrompt = messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).find(t => t.includes(FRAME_CHILD)) ?? '';
			const needle = /NEEDLE-STG-[A-Z0-9]+/.exec(excerptPrompt)?.[0];
			text = needle ? `staging 部署口令是 ${needle}。` : SEED_OK;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
		const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
			id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: MODEL.model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`);
		chunk({ role: 'assistant', content: '' });
		if (RETRY && messages.some(m => flat(m).includes(FRAME_CHILD))) {
			if (!retryStarted) {
				retryStarted = true;
				chunk({ reasoning_content: RETRY_THOUGHT });
				setTimeout(() => res.end('data: ' + JSON.stringify({ error: { message: '503 Service Unavailable' } }) + '\n\n'), 1700);
			} else {
				// A real empty start frame follows the retry. Give the client
				// time to render the transition before the first new thought.
				setTimeout(() => {
					chunk({ reasoning_content: 'RETRY-SECOND-THOUGHT' });
					chunk({ content: text });
					chunk({}, 'stop');
					res.end('data: [DONE]\n\n');
				}, 1400);
			}
			return;
		}
		if (SCROLL && messages.some(m => flat(m).includes(FRAME_CHILD))) {
			let part = 0;
			const timer = setInterval(() => {
				if (res.destroyed) { clearInterval(timer); return; }
				if (part < 18) {
					part++;
					chunk({ reasoning_content: Array.from({ length: 6 }, (_, i) => `Scroll sample ${part}.${i + 1}: reasoning text.\n\n`).join('') });
					return;
				}
				clearInterval(timer);
				chunk({ content: text });
				chunk({}, 'stop');
				res.end('data: [DONE]\n\n');
			}, 300);
			return;
		}
		if (toolCalls) {
			chunk({ tool_calls: toolCalls });
			chunk({}, 'tool_calls');
		} else {
			for (const piece of (text ?? SEED_OK).match(/[\s\S]{1,24}/g) ?? []) chunk({ content: piece });
			chunk({}, 'stop');
		}
		if (body?.stream_options?.include_usage) {
			res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		}
		res.write('data: [DONE]\n\n');
		res.end();
	});
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;
mile(`stub: OpenAI-compatible SSE server on 127.0.0.1:${stubPort}`);

// ── isolated dsh web (rc.5) with local provider + btw patch ─────────────────
root = await mkdtemp(join(tmpdir(), 'btw-demand-e2e-'));
const env = {
	PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root,
	XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
	XDG_DATA_HOME: join(root, 'data'), TMPDIR: join(root, 'tmp'),
	DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'),
	DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', STUB_API_KEY: API_KEY,
};
await mkdir(env.TMPDIR, { recursive: true });
await mkdir(join(root, 'qa-project'));
// Defense in depth: ordinary Node TCP clients in the child stay on loopback.
const guard = join(root, 'offline.cjs');
await writeFile(guard, [
	'const net = require("node:net");',
	'const old = net.Socket.prototype.connect;',
	'net.Socket.prototype.connect = function (...a) {',
	' const args = Array.isArray(a[0]) ? a[0] : a;',
	' const v = args[0]; const host = typeof v === "object" && v !== null ? v.host : (typeof args[1] === "string" ? args[1] : undefined);',
	' const path = typeof v === "string" || (v && typeof v === "object" && v.path);',
	' if (path || !["127.0.0.1", "::1", "localhost"].includes(host)) {',
	'  console.error("e2e blocked non-loopback connection", String(host)); throw new Error("e2e blocked non-loopback connection");',
	' }',
	' return old.apply(this, a);',
	'};',
	'',
].join('\n'));
env.NODE_OPTIONS = `--require=${guard}`;
const version = await promisify(execFile)(DSH_BIN, ['--version'], { cwd: root, env, timeout: 15000 });
assert.match(version.stdout.trim(), /(?:^|\s)0\.2\.2-rc\.5$/, `expected dsh 0.2.2-rc.5, got ${version.stdout.trim()}`);
mile(`ok: dsh ${version.stdout.trim()}`);

const plugin = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const patchPath = join(root, 'patch.yml');
let rel = relative(dirname(patchPath), plugin).replaceAll('\\', '/');
if (!rel.startsWith('.')) rel = './' + rel;
await writeFile(patchPath, `- insert:
    - id: llm-pi-ai
      name: "@deepseek-ai/dsh-llm-pi-ai"
      config:
        providers:
          glm:
            displayName: Local Stub
            apiKeyEnv: STUB_API_KEY
            api: openai-completions
            baseURL: http://127.0.0.1:${stubPort}/v1
            models:
              - id: ${MODEL.model}
                name: Stub Mini
                contextWindow: 128000
                maxTokens: 4096
    - id: agent-default-model
      name: "@deepseek-ai/dsh-agent-default-model"
      config:
        provider: ${MODEL.provider}
        model: ${MODEL.model}
    - id: btw
      name: ${JSON.stringify(rel)}
`);
dshChild = spawn(DSH_BIN, ['--profile', 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
	cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
});
dshChild.stdout.on('data', (x) => { dshOutput = (dshOutput + x).slice(-120000); });
dshChild.stderr.on('data', (x) => { dshOutput = (dshOutput + x).slice(-120000); });
let launchUrl = '';
{
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline && !launchUrl) {
		if (interrupted) throw new Error('interrupted');
		if (dshChild.exitCode !== null || dshChild.signalCode !== null) throw new Error(`dsh exited before readiness: ${dshChild.exitCode ?? dshChild.signalCode}\n${dshOutput}`);
		const match = /dsh web:\s+(http:\/\/[^\s]+)/.exec(dshOutput);
		if (match) launchUrl = match[1];
		else await wait(150);
	}
	assert.ok(launchUrl, `no launch URL within 60s\n${dshOutput}`);
	assert.equal(new URL(launchUrl).hostname, '127.0.0.1');
	assert.doesNotMatch(dshOutput, /(?:plugin activation failed|failed to activate|activation failures|full diagnostics:)/i, `activation error\n${dshOutput}`);
	mile(`ok: isolated dsh web at ${launchUrl.replace(/token=[^&]+/, 'token=<redacted>')}`);
}

// ── raw CDP driver over the system Chromium ────────────────────────────────
chromeChild = spawn(CHROME_BIN, [
	'--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
	'--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--window-size=1500,950',
	`--user-data-dir=${join(root, 'chrome')}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
{
	let chromeLog = '';
	const found = await new Promise((resolve) => {
		const timer = setTimeout(resolve, 25000);
		chromeChild.stderr.on('data', (x) => {
			chromeLog += x;
			const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(chromeLog);
			if (match) { chromeLog = match[1]; clearTimeout(timer); resolve(); }
		});
	});
	await found;
	assert.ok(/^ws:\/\//.test(chromeLog), `no CDP endpoint from chromium\n${String(chromeLog).slice(-2000)}`);
	var chromeWsUrl = chromeLog;
}
const ws = new WebSocket(chromeWsUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		message.error ? reject(new Error(`CDP ${message.error.message}`)) : resolve(message.result);
	}
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 45000).unref?.();
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: page } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, page);
await send('Runtime.enable', {}, page);
mile('ok: chromium headless attached via CDP');

async function evaluate(fn, arg) {
	const expression = `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`;
	const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page);
	if (result.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(result.exceptionDetails).slice(0, 600)}`);
	return result.result?.value;
}
async function waitFor(fn, arg, label, timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (interrupted) throw new Error('interrupted');
		const value = await evaluate(fn, arg);
		if (value) return value;
		await wait(250);
	}
	throw new Error(`timed out: ${label}`);
}
const shot = async (path) => {
	const { data } = await send('Page.captureScreenshot', { format: 'png' }, page);
	writeFileSync(path, Buffer.from(data, 'base64'));
	mile(`screenshot: ${path}`);
};

// ── page-side helpers (serialized into the page; no closures) ───────────────
const PAGE_HELPERS = [
	'window.__e2e = window.__e2e || {};',
	'__e2e.visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 8 && r.height > 8 && s.visibility !== "hidden" && s.display !== "none"; };',
	'__e2e.setEditable = (el, text) => {',
	'	if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {',
	'		Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(el, text);',
	'	} else { el.focus(); el.textContent = text; }',
	'	el.dispatchEvent(new Event("input", { bubbles: true }));',
	'};',
	'__e2e.enter = (el) => {',
	'	for (const type of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));',
	'};',
	'__e2e.composer = () => {',
	'	const candidates = [...document.querySelectorAll("textarea, [contenteditable=\\"true\\"], [role=\\"textbox\\"]")]',
	'		.filter(__e2e.visible)',
	'		.filter((el) => !el.closest(".dsh-btw-modal"))',
	'		.filter((el) => !/workspace|search|搜索|选择/i.test([el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" ")))',
	'		.map((el) => ({ el, r: el.getBoundingClientRect(), ta: el.tagName === "TEXTAREA" ? 1 : 0 }))',
	'		.sort((a, b) => (b.ta - a.ta) || (b.r.bottom - a.r.bottom));',
	'	__e2e.composerEl = candidates[0]?.el || null;',
	'	return !!__e2e.composerEl;',
	'};',
	'__e2e.typeAndEnter = (text) => {',
	'	const el = __e2e.composerEl;',
	'	if (!el) return false;',
	'	__e2e.setEditable(el, text);',
	'	__e2e.enter(el);',
	'	return true;',
	'};',
	'__e2e.clickSendButton = () => {',
	'	const buttons = [...document.querySelectorAll("button")].filter(__e2e.visible)',
	'		.filter((b) => /发送|send|submit/i.test([b.getAttribute("aria-label"), b.getAttribute("title"), b.textContent].join(" ")))',
	'		.filter((b) => !b.closest(".dsh-btw-modal"));',
	'	if (!buttons.length) return false;',
	'	buttons[0].click();',
	'	return true;',
	'};',
	'__e2e.newSession = () => {',
	'	const buttons = [...document.querySelectorAll("button, [role=\\"button\\"], a")].filter(__e2e.visible)',
	'		.filter((b) => /新(?:会话|聊天|对话|建)|new (?:chat|session|conversation)/i.test([b.getAttribute("aria-label"), b.getAttribute("title"), b.textContent].join(" ")));',
	'	if (!buttons.length) return false;',
	'	buttons[0].click();',
	'	return true;',
	'};',
	'__e2e.bodyText = () => document.body.innerText || "";',
	'__e2e.dismissChooser = () => {',
	'	const buttons = [...document.querySelectorAll("button")].filter(__e2e.visible);',
	'	const find = (pattern) => buttons.find(b => pattern.test(b.textContent.trim()));',
	'	const folders = buttons.filter(b => b.textContent.trim() === "qa-project");',
	'	const dialog = find(/^(Continue|继续)$/i) || (folders.length === 1 ? folders[0] : null) || find(/^(Open|打开)$/i) || find(/^(Choose workspace|选择工作区)$/i);',
	'	if (!dialog || dialog.disabled) return false;',
	'	dialog.click();',
	'	return true;',
	'};',
	'true;',
].join('\n');

async function seedMessage(text, label) {

	assert.ok(await waitFor(() => { return !__e2e.dismissChooser() && __e2e.composer(); }, undefined, `composer not found for ${label}`, 30000), `composer not found for ${label}`);
	await evaluate(() => __e2e.composerEl.focus());
	await send('Input.insertText', { text }, page);
	await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page);
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page);
	const probe = text.slice(0, 24);
	const submitted = () => requests.some((r) => (r.raw || '').includes(probe));
	for (let attempt = 0; attempt < 24 && !(await submitted()); attempt++) {
		if (interrupted) throw new Error('interrupted');
		await wait(500);
		if (attempt === 8) await evaluate(() => __e2e.clickSendButton(), undefined);
	}
	assert.ok(await submitted(), `seed message never reached the stub model: ${label}\n${JSON.stringify(await evaluate(() => ({
		composer: (() => { const el = __e2e.composerEl; return el && { tag: el.tagName, cls: el.className, aria: el.getAttribute('aria-label'), ph: el.getAttribute('placeholder'), role: el.getAttribute('role'), ce: el.getAttribute('contenteditable'), value: (el.value || el.textContent || '').slice(0, 60) }; })(),
		editables: [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), aria: el.getAttribute('aria-label'), ph: el.getAttribute('placeholder'), vis: __e2e.visible(el), inBtw: !!el.closest('.dsh-btw-modal') })).slice(0, 8),
		buttons: [...document.querySelectorAll('button')].filter(__e2e.visible).map((b) => [b.getAttribute('aria-label'), b.getAttribute('title'), (b.textContent || '').trim().slice(0, 20)].join('|')).slice(0, 30),
		bodyHead: __e2e.bodyText().slice(0, 400),
	}), undefined), null, 2)}`);
	// The reply must render in the host conversation view, not just hit the stub.
	await waitFor((p) => __e2e.bodyText().includes(p), probe, `host shows message for ${label}`, 30000);
	await waitFor(() => __e2e.bodyText().includes('OK，已记下。') || __e2e.bodyText().includes('staging 部署口令是'), undefined, `visible stub reply for ${label}`);
	mile(`ok: seeded ${label}`);
}

try {
	// Navigate first: the load creates a fresh page context, helpers come after.
	await send('Page.navigate', { url: launchUrl }, page);
	await wait(1500);
	await evaluate((code) => { window.__E2E_HELPERS__ = code; eval(code); return true; }, PAGE_HELPERS);
	await waitFor(() => !__e2e.dismissChooser() && __e2e.composer(), undefined, 'host composer after workspace selection', 16000);
	mile('ok: web app loaded, host composer ready');

	if (NATIVE_DRAFT) await verifyNativeDraft();
	else await verifyAttachedChat();
} catch (error) {
	failed = true;
	mile(`FAIL: ${(error && error.stack) || error}`);
	try {
		await shot(SHOT_FAIL);
		console.error(await evaluate(() => ({
			panel: document.querySelector('.dsh-btw-modal')?.innerText,
			buttons: [...document.querySelectorAll('button')].filter(__e2e.visible).map(b => [b.textContent.trim().slice(0, 50), b.getAttribute('aria-label'), b.disabled]).slice(0, 50),
		})));
	} catch { /* browser may be gone */ }
	console.error(`FAIL: ${(error && error.stack) || error}`);
	console.error(`--- dsh output tail (token redacted) ---\n${dshOutput.slice(-4000).replace(/([?&]token=)[^&\s]+/g, '$1<redacted>')}`);
	console.error(`--- stub requests (${requests.length}) ---`);
	for (const [i, r] of requests.entries()) {
		console.error(`#${i} ${new Date(r.t).toISOString()} ${r.path} roles=${(r.body?.messages ?? []).map((m) => m.role).join('>')} chars=${(r.raw || '').length}${(r.raw || '').includes(FRAME_CHILD) ? ' CHILD' : ''}`);
	}
} finally {
	try { ws.close(); } catch { /* ignore */ }
	await teardown();
	if (KEEP) console.log(`kept isolated root: ${root}`);
	stub.close();
	console.log('cleanup: chromium + dsh stopped' + (KEEP ? '' : ', temporary directory removed'));
}
if (failed || interrupted) process.exitCode = 1;

async function verifyNativeDraft() {
	const draft = 'BTW-DRAFT-SYNTHETIC-1';
	const edited = draft + ' EDITED-IN-TEMP';
	const toggle = active => {
		const selector = active ? '[data-btw-native-utility], [data-btw-native-status]' : '.dsh-btw-global-entry[aria-pressed="false"]';
		const button = [...document.querySelectorAll(selector)].find(__e2e.visible);
		if (button) button.click();
		return !!button;
	};
	const shows = ({ active, draft }) => {
		if (!__e2e.composer() || !__e2e.composerEl.isContentEditable) return false;
		const id = __e2e.composerEl.closest('[data-conversation-session]')?.getAttribute('data-conversation-session');
		if (!id) return false;
		// The header reports a temporary intent before nativeOpen commits.
		// Require the session-specific decoration on the current composer.
		const native = [...document.querySelectorAll('style[data-plugin="dsh-btw"]')].some(s =>
			s.textContent.includes('[data-conversation-session=' + JSON.stringify(id) + ']'));
		return native === active && (__e2e.composerEl.value ?? __e2e.composerEl.innerText).trim() === draft;
	};
	await evaluate(() => __e2e.composerEl.focus());
	await send('Input.insertText', { text: draft }, page);
	await waitFor(shows, { active: false, draft }, 'ordinary draft');
	assert.ok(await evaluate(toggle, false));
	await waitFor(shows, { active: true, draft }, 'draft carried into native temporary chat');
	await evaluate(() => __e2e.composerEl.focus());
	await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }, page);
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }, page);
	await send('Input.insertText', { text: ' EDITED-IN-TEMP' }, page);
	await waitFor(shows, { active: true, draft: edited }, 'temporary edit');
	assert.ok(await evaluate(toggle, true));
	await waitFor(shows, { active: false, draft: edited }, 'edited draft carried back without sending');
	mile('ok: ordinary → temporary → ordinary kept the edited draft');
	await shot(SHOT_OK);
	assert.equal(requests.length, 0, 'opening, editing and closing must not call the model');
	assert.ok(await evaluate(toggle, false));
	await waitFor(shows, { active: true, draft: edited }, 'draft enters a second temporary chat');
	const composerSession = () => __e2e.composer() && __e2e.composerEl.closest('[data-conversation-session]')?.getAttribute('data-conversation-session');
	const beforeId = await evaluate(composerSession);
	assert.ok(await evaluate(() => __e2e.clickSendButton()));
	await waitFor(() => [...document.querySelectorAll('[data-conversation-session]')].some(root => {
		return __e2e.visible(root) && root.innerText.includes('OK，已记下。');
	}), undefined, 'stub reply in native temporary chat', 9000).catch(async error => {
		mile('native composer retained after send: ' + ((await evaluate(composerSession)) === beforeId));
		throw error;
	});
	assert.equal(await evaluate(composerSession), beforeId, 'same native conversation renders the assistant reply');
	assert.ok(requests.some(r => r.body?.messages?.some(m => m.role === 'user' && JSON.stringify(m.content).includes(edited))));
	assert.ok(await evaluate(() => __e2e.composerEl.innerText.trim() === ''), 'sent draft was consumed');
	assert.ok(await evaluate(toggle, true));
	await waitFor(shows, { active: false, draft: '' }, 'sent draft does not reappear in ordinary chat');
	mile('RESULT: PASS — draft roundtrip, one explicit send, no resend after exit');
}

async function verifyAttachedChat() {
	// Session B (other source, private) first; a NEW session then becomes A and stays current,
	// so no sidebar navigation back is needed.
	await seedMessage(MSG_PRIVATE, 'session B private message');
	assert.ok(await evaluate(() => __e2e.newSession(), undefined), 'new-session control not found');
	await waitFor((marker) => { __e2e.dismissChooser(); return __e2e.composer() && !__e2e.bodyText().includes(marker); }, PRIVATE, 'fresh session view after new-session click', 30000);
	mile('ok: switched to a fresh session for A');
	if (SUPPLEMENT) await seedMessage(MSG_PRE, 'session A neighbor setup message');
	await seedMessage(MSG_NEEDLE, 'session A needle message');
	await seedMessage(MSG_UNRELATED, 'session A unrelated message');

	// Let any session-title model calls drain before the measured window.
	{
		const deadline = Date.now() + 20000;
		let lastCount = requests.length, stable = 0;
		while (Date.now() < deadline && stable < 3) {
			await wait(900);
			stable = requests.length === lastCount ? stable + 1 : 0;
			lastCount = requests.length;
		}
		mile(`ok: stub quiet at ${requests.length} requests (title generation drained)`);
	}

	// Open the btw dock from session A and select the new mode by its visible label.
	assert.ok(await waitFor(() => { const chip = document.querySelector('button.dsh-btw-chip'); if (__e2e.visible(chip)) { chip.click(); return true; } return false; }, undefined, '顺便问 chip', 20000), 'chip clicked');
	await waitFor(() => __e2e.visible(document.querySelector('[aria-label="btw 侧问小窗"]')), undefined, 'btw dock panel', 20000);
	mile('ok: btw dock opened for session A');

	const modeLabel = '按需引用当前对话';
	const pickerKind = await evaluate(() => {
		const select = document.querySelector('select[aria-label="侧问上下文"]');
		if (select) return 'native';
		const trigger = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('侧问上下文：'));
		if (trigger) { trigger.click(); return 'menu'; }
		return null;
	}, undefined);
	assert.ok(pickerKind, 'context picker not found in dock');
	mile(`ok: context picker present (${pickerKind})`);
	await waitFor((label) => {
		const select = document.querySelector('select[aria-label="侧问上下文"]');
		if (select) {
			const option = [...select.options].find((o) => o.textContent.trim() === label);
			if (!option) return null;
			if (select.value !== option.value) {
				Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
				select.dispatchEvent(new Event('change', { bubbles: true }));
			}
			return select.value === option.value ? 'native' : null;
		}
		const trigger = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '侧问上下文：' + label);
		if (trigger) return 'menu-selected';
		const item = [...document.querySelectorAll('.dsh-btw-picker-menu span, .dsh-btw-picker-menu [role="option"], .dsh-btw-picker-menu [role="menuitem"]')]
			.find((el) => el.textContent.trim() === label);
		if (item) { item.click(); return 'menu-clicked'; }
		return null;
	}, modeLabel, `pick context mode ${modeLabel}`, 15000);
	await waitFor((label) => [...document.querySelectorAll('button')].some((x) => (x.getAttribute('aria-label') || '') === '侧问上下文：' + label)
		|| (() => { const s = document.querySelector('select[aria-label="侧问上下文"]'); const o = s && [...s.options].find((o) => o.textContent.trim() === label); return !!(s && o && s.value === o.value); })(), modeLabel, 'mode label visible on picker', 15000);
	mile(`ok: context mode selected: ${modeLabel}`);

	// One child turn by default (single tool-less call); --supplement adds the
	// btw_read_context round trip (excerpt turn + post-tool turn).
	const before = requests.length;
	await evaluate((t) => {
		const ta = document.querySelector('.dsh-btw-modal textarea.dsh-btw-mta');
		if (!ta) return false;
		__e2e.setEditable(ta, t);
		return true;
	}, QUESTION);
	assert.ok(await evaluate(() => { const b = document.querySelector('.dsh-btw-modal button.dsh-btw-go'); if (__e2e.visible(b) && !b.disabled) { b.click(); return true; } return false; }, undefined), 'btw send button not clickable');
	mile('ok: question sent from btw dock');

	if (RETRY) {
		await waitFor(marker => {
			const row = document.querySelector('.dsh-btw-reasoning[data-state="running"]');
			if (!row?.innerText.includes(marker)) return false;
			window.__e2e.firstThoughtRow = row;
			return true;
		}, RETRY_THOUGHT, 'first thought is visible live', 8000);
		await waitFor(marker => {
			const original = window.__e2e.firstThoughtRow;
			return original?.isConnected && original.dataset.state === 'ok' && original.innerText.includes(marker);
		}, RETRY_THOUGHT, 'same expanded row preserves the text during the empty retry step', 8000);
		await shot('/tmp/btw-reasoning-retry-gap.png');
		mile('ok: same reasoning row stays open through the retry gap');
	}

	if (SCROLL) {
		const point = await waitFor(() => {
			const p = document.querySelector('.dsh-btw-mbody');
			if (!p?.textContent.includes('Scroll sample 4.') || p.scrollTop < 100) return false;
			const r = p.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		}, undefined, 'the transcript follows streamed reasoning before reader input', 8000);
		await send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, deltaY: -1200, ...point }, page);
		const parked = await waitFor(() => {
			const p = document.querySelector('.dsh-btw-mbody');
			return p.scrollHeight - p.clientHeight - p.scrollTop > 180 ? { top: p.scrollTop, height: p.scrollHeight } : false;
		}, undefined, 'upward wheel moves away from the tail', 5000);
		const later = await waitFor(before => {
			const p = document.querySelector('.dsh-btw-mbody');
			return p.scrollHeight >= before.height + 250 ? { top: p.scrollTop } : false;
		}, parked, 'stream keeps growing above the parked reader', 6000);
		assert.ok(Math.abs(later.top - parked.top) <= 4, `reader moved from ${parked.top} to ${later.top}`);
		await shot('/tmp/btw-scroll-reading.png');
		await send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, deltaY: 10000, ...point }, page);
		const resumed = await waitFor(() => {
			const p = document.querySelector('.dsh-btw-mbody');
			return p.scrollHeight - p.clientHeight - p.scrollTop <= 24 ? { top: p.scrollTop } : false;
		}, undefined, 'reader scrolls down to the tail', 4000);
		await waitFor(before => {
			const p = document.querySelector('.dsh-btw-mbody');
			return p.scrollTop >= before.top + 100 && p.scrollHeight - p.clientHeight - p.scrollTop <= 24;
		}, resumed, 'after returning to tail, new content follows again', 6000);
		mile('ok: stream follows the tail, respects upward reading, and resumes when the reader returns');
	}

	const answer = await waitFor((needle) => {
		const panel = document.querySelector('[aria-label="btw 侧问小窗"]');
		if (!panel) return null;
		const text = panel.innerText || '';
		const count = /引用了\s*([0-9]+)\s*段/.exec(text);
		if (count && text.includes(needle)) return { count: Number(count[1]), text: text.slice(0, 4000) };
		return null;
	}, NEEDLE, 'btw answer with 引用了 N 段', SUPPLEMENT ? 30000 : 16000);
	assert.ok(answer.count >= 1 && answer.count <= 4, `excerpt count out of range: ${answer.count}`);
	mile(`ok: btw answered with visible 引用了 ${answer.count} 段 detail`);

	// Expand the excerpt details: the needle snippet with its source role must show.
	await evaluate(() => { const s = document.querySelector('.dsh-btw-context > summary'); if (s) { s.click(); return true; } return false; }, undefined);
	const details = await waitFor((needle) => {
		const panel = document.querySelector('[aria-label="btw 侧问小窗"]');
		const open = panel?.querySelector('details.dsh-btw-context[open]');
		return open && open.innerText.includes(needle) ? open.innerText.slice(0, 1500) : null;
	}, NEEDLE, 'expanded excerpt containing the needle', 10000);
	assert.match(details, /你|助手/, 'excerpt source role missing');
	mile('ok: excerpt details expand and show the needle with a source role');

	// ── assertions on what the stub model actually received ──────────────────
	const fresh = requests.slice(before);
	if (SUPPLEMENT) {
		// The final answer must quote the adjacent text the host tool returned.
		await waitFor((marker) => (document.querySelector('[aria-label="btw 侧问小窗"]')?.innerText || '').includes(marker), NEIGHBOR, 'btw answer quoting the adjacent neighbor text', 20000);
		mile('ok: btw answer quotes the adjacent neighbor text from the tool result');

		const childReqs = fresh.filter((r) => (r.raw || '').includes(FRAME_CHILD));
		assert.equal(childReqs.length, 2, `expected exactly two child model turns (excerpt turn + post-tool turn), got ${childReqs.length} (window has ${fresh.length} requests)`);
		const [first, second] = childReqs;

		// First request: bounded excerpts only — the neighbor stays withheld.
		const firstBody = first.raw || '';
		assert.ok(firstBody.includes(NEEDLE), 'first child prompt must contain the matching needle snippet');
		assert.ok(!firstBody.includes(NEIGHBOR), 'LEAK: the withheld neighbor text reached the model before any btw_read_context call');
		assert.ok(!firstBody.includes(PRIVATE), 'LEAK: private other-session content reached the child model');
		assert.ok(!firstBody.includes('火锅'), 'LEAK: unrelated in-conversation filler reached the child model');
		const toolsJson = JSON.stringify(first.body?.tools ?? []);
		assert.ok(toolsJson.includes(TOOL_NAME), 'first child request must offer the btw_read_context tool');
		assert.ok(!toolsJson.includes('search_snapshot'), 'the legacy snapshot-search tool must not be sent');
		assert.ok(first.auth === `Bearer ${API_KEY}`, 'provider auth header must come from apiKeyEnv');
		const firstPrompt = (first.body?.messages ?? []).find((m) => m.role === 'user' && JSON.stringify(m.content).includes(FRAME_CHILD))?.content;
		const firstPromptText = typeof firstPrompt === 'string' ? firstPrompt : (firstPrompt ?? []).map((b) => b.text || '').join('');
		assert.match(firstPromptText, /"seq":\d+,"role":/, 'child prompt must carry seq/role-tagged excerpts');
		const quotedSeqs = [...firstPromptText.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1]));
		assert.ok(quotedSeqs.length >= 1, 'no quoted seqs found in the first child prompt');

		// The model's tool call, recorded verbatim in the follow-up request history.
		const calls = (second.body?.messages ?? []).filter((m) => m.role === 'assistant').flatMap((m) => Array.isArray(m.tool_calls) ? m.tool_calls : []);
		assert.equal(calls.length, 1, `expected exactly one btw_read_context tool call in the follow-up history, got ${calls.length}`);
		assert.equal(calls[0]?.function?.name, TOOL_NAME, 'the tool call must target btw_read_context');
		let anchorArgs = null;
		try { anchorArgs = JSON.parse(calls[0]?.function?.arguments ?? '{}'); } catch { /* asserted below */ }
		const anchor = Number(anchorArgs?.anchor);
		assert.ok(Number.isSafeInteger(anchor) && quotedSeqs.includes(anchor), `tool anchor ${anchor} must be a seq quoted in the first request (${quotedSeqs.join(', ')})`);
		assert.ok(anchorArgs && Object.keys(anchorArgs).length === 1, 'tool arguments must be exactly {anchor}');

		// The host tool result inside the second request: the actual adjacent reply only.
		const secondBody = second.raw || '';
		assert.ok(secondBody.includes('Untrusted neighboring source messages'), 'second request must carry the host tool result');
		assert.ok(!secondBody.includes(PRIVATE), 'LEAK: private other-session content reached the post-tool request');
		assert.ok(!secondBody.includes('火锅'), 'LEAK: unrelated in-conversation filler reached the post-tool request');
		const toolResult = (second.body?.messages ?? []).map((m) => typeof m?.content === 'string' ? m.content
			: Array.isArray(m?.content) ? m.content.map((b) => b?.text ?? '').join('') : '').find((c) => c.includes('Untrusted neighboring source messages')) ?? '';
		assert.ok(toolResult.includes(REPLY_PRE), 'the tool result must quote the adjacent reply verbatim');
		assert.match(toolResult, /"role":"assistant"/, 'the read excerpt must be the adjacent assistant reply');
		assert.ok(!toolResult.includes('火锅') && !toolResult.includes(PRIVATE) && !toolResult.includes(NEEDLE), 'tool result must stay bounded to the adjacent message');
		assert.ok(fresh.every((r) => !(r.raw || '').includes(PRIVATE)), 'no request in the turn window may carry other-session private data');
		mile(`ok: supplement round trip — first turn withheld the neighbor, btw_read_context(anchor=${anchor}) returned exactly the adjacent reply`);

		// UI end state: the citation disclosure labels the read as 补读 with its text.
		const disclosure = await waitFor((marker) => {
			const panel = document.querySelector('[aria-label="btw 侧问小窗"]');
			let open = panel?.querySelector('details.dsh-btw-context[open]');
			if (!open) { const s = panel?.querySelector('details.dsh-btw-context > summary'); if (s) s.click(); }
			open = panel?.querySelector('details.dsh-btw-context[open]');
			return open && open.innerText.includes(marker) ? open.innerText.slice(0, 2000) : null;
		}, NEIGHBOR, 'expanded citation disclosure showing the read neighbor text', 12000);
		assert.match(disclosure, /补读/, 'citation disclosure must label the tool-read excerpt as 补读');
		mile('ok: citation disclosure labels the read with 补读 and shows the neighbor text');

		await shot(SHOT_OK);
		const finalPanel = await evaluate(() => document.querySelector('[aria-label="btw 侧问小窗"]')?.innerText ?? '', undefined);
		assert.match(finalPanel, new RegExp(NEEDLE), 'docked answer must echo the needle (proves the child consumed the snippet)');
		assert.match(finalPanel, new RegExp(NEIGHBOR), 'docked answer must quote the adjacent neighbor text (proves the child consumed the tool result)');
		console.log('\nRESULT: PASS — 按需引用当前对话 --supplement (btw_read_context 补读) browser E2E green');
		console.log(`requests_total=${requests.length} child_turns=2 tool_reads=1 excerpts=${answer.count} anchor=${anchor}`);
	} else if (RETRY) {
		assert.equal(fresh.filter(r => r.raw.includes(FRAME_CHILD)).length, 2, 'one failed attempt and one successful retry');
		await waitFor(() => {
			const prior = document.querySelector('.dsh-btw-reasoning[data-prior]');
			const title = [...(prior?.querySelectorAll('*') ?? [])].find(el => el.childElementCount === 0 && el.textContent.trim() === '第 1 次思考');
			if (!title) return false;
			// Activate the disclosure itself: a screen coordinate sampled while
			// the transcript is animating may hit a different row by mouseup.
			title.click();
			return true;
		}, undefined, 'prior thought disclosure title', 6000);
		await waitFor(marker => document.querySelector('.dsh-btw-reasoning[data-prior]')?.innerText.includes(marker), RETRY_THOUGHT,
			'prior thought is still expandable after retry', 6000);
		assert.equal(await evaluate(marker => [...document.querySelectorAll('.dsh-btw-msg.agent > .dsh-btw-prose')]
			.some(answer => answer.innerText.includes(marker)), RETRY_THOUGHT), false);
		await shot('/tmp/btw-reasoning-retry.png');
		console.log('RESULT: PASS — retry preview stays readable and separate from the answer');
	} else {
		assert.equal(fresh.length, 1, 'one BTW question should cause exactly one model request');
		const child = fresh.filter((r) => (r.raw || '').includes(FRAME_CHILD));
		assert.equal(child.length, 1, `expected exactly one tool-less child model turn carrying the excerpt framing, got ${child.length} (window has ${fresh.length} requests)`);
		const body = child[0].raw || '';
		assert.ok(body.includes(NEEDLE), 'child prompt must contain the matching needle snippet');
		const prompt = (child[0].body?.messages ?? []).find(m => m.role === 'user' && JSON.stringify(m.content).includes(FRAME_CHILD))?.content;
		const promptText = typeof prompt === 'string' ? prompt : (prompt ?? []).map(block => block.text || '').join('');
		assert.match(promptText, /"seq":\d+,"role":/, 'child prompt must carry seq/role-tagged excerpts');
		assert.ok(body.includes(QUESTION) || body.includes('部署口令'), 'child prompt must carry the question');
		assert.ok(!body.includes(PRIVATE), 'LEAK: private other-session content reached the child model');
		assert.ok(!body.includes('火锅'), 'LEAK: unrelated in-conversation filler reached the child model');
		assert.ok(!JSON.stringify(child[0].body?.tools ?? []).includes('search_snapshot'), 'the legacy snapshot-search tool must not be sent');
		assert.ok(child[0].auth === `Bearer ${API_KEY}`, 'provider auth header must come from apiKeyEnv');
		assert.ok(fresh.every((r) => !(r.raw || '').includes(PRIVATE)), 'no request in the turn window may carry other-session private data');
		mile('ok: child model received ONLY bounded matching excerpts (needle in, private/unrelated out), single tool-less turn');

		await shot(SHOT_OK);
		assert.match(answer.text, new RegExp(NEEDLE), 'docked answer must echo the needle (proves the child consumed the snippet)');
		console.log('\nRESULT: PASS — 按需引用当前对话 browser E2E green');
		console.log(`requests_total=${requests.length} child_turns=1 excerpts=${answer.count}`);
	}
}
