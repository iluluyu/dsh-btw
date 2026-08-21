/**
 * dsh-btw — host half.
 *
 * Two bypass surfaces over one RPC channel (`/api` intercept, prefix `btw/`),
 * both leaving the main session untouched:
 *
 *   1. Side question (`btw/ask|askPoll|askCancel`) — one stateless LLM call.
 *      The browser assembles the transcript prefix from the live conversation
 *      snapshot (projection text, not the raw event log), so provider prefix
 *      caches never see these requests anyway; a single user message carrying
 *      transcript + question keeps the wire minimal. Answer streams into a
 *      poll job; nothing is persisted anywhere.
 *
 *   2. Temporary chat (`btw/open|send|poll|close`) — a disposable child agent
 *      (pattern credit: dsh-incognito, adapted). Differences that matter:
 *        - cwd is the CURRENT PROJECT ROOT (the whole point: "what is this
 *          repo about"), so burn only ever removes the child's own session
 *          directory under that project key — never the project directory.
 *        - Orphan recovery is a marker file ($DSH_HOME/.btw-temps.json) keyed
 *          by pid: dead-pid leftovers are burned on next host start, while a
 *          concurrently live dsh host keeps its own temp sessions.
 *        - The child composes DIRECTLY in setup (persona + read-leaning tools
 *          imported from the profile's node_modules and mounted with
 *          ctx.plugin) instead of agentPresets.mount: the profile's heal
 *          symlinks mix the launcher tree and the dsh-base tree, which loads
 *          two dsh-scope copies with distinct `Symbol(dsh.scope)` tags — the
 *          preset service can reject a loop-tagged context as "unscoped".
 *          Direct composition sidesteps the symbol identity entirely.
 *
 * Model selection follows the host default (`agentDefaultModel`) for both
 * surfaces; no credentials are handled here — the `llm` service owns them.
 *
 * Zero external deps: node builtins + injected services only.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

export const inject = ["llm", "agentDefaultModel", "agents", "connection"];

const RPC_PREFIX = "btw/";
const SEND_TIMEOUT_MS = 120_000;
const ASK_TIMEOUT_MS = 180_000;
const JOB_TTL_MS = 10 * 60_000;

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const MARKER_PATH = join(DSH_HOME, ".btw-temps.json");
const PROFILE_MODULES = join(DSH_HOME, "profiles", "node_modules");

/** Transcript re-cap host-side: keep the most recent ~48 KB. */
const TRANSCRIPT_MAX = 48_000;

const ASK_SYSTEM = [
	"You answer quick side questions about an ongoing coding session.",
	"The recent conversation is provided as context inside <conversation> tags; the question follows inside <question> tags.",
	"Answer directly and concisely, in the language of the question.",
	"When the answer is in the context (file paths, names, decisions), quote them exactly.",
	"When it is not, say so plainly in one line — do not invent, do not ask follow-up questions.",
	"No tool use; a few short paragraphs at most.",
].join(" ");

// ── session-directory bookkeeping (projectKey mirrored from dsh persistence) ──

function encodeSegmentChar(ch, code) {
	if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) return ch;
	return "~" + code.toString(16).toUpperCase().padStart(4, "0");
}

function projectKey(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else {
			readable += encodeSegmentChar(ch, code);
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

function sessionDir(sessionId, cwd) {
	return join(DSH_HOME, "sessions", projectKey(cwd), sessionId);
}

/**
 * Remove one temp session's own directory, retrying: the persistence layer
 * may still be flushing events after dispose (observed in the wild).
 */
function burnSession(sessionId, cwd) {
	const dir = sessionDir(sessionId, cwd);
	let attempts = 0;
	const tryBurn = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
			if (attempts < 3 && existsSync(dir)) {
				attempts += 1;
				setTimeout(tryBurn, 400);
			}
		} catch {
			// Never block the flow on a stubborn directory.
		}
	};
	setTimeout(tryBurn, 300);
}

// ── marker file: crash-orphan recovery scoped by pid liveness ──

function pidAlive(pid) {
	if (!Number.isInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function readMarker() {
	try {
		const parsed = JSON.parse(readFileSync(MARKER_PATH, "utf8"));
		return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.id === "string" && typeof e.cwd === "string") : [];
	} catch {
		return [];
	}
}

function writeMarker(entries) {
	try {
		writeFileSync(MARKER_PATH, JSON.stringify(entries, null, 1));
	} catch {
		// Read-only home: orphans then survive until the user cleans up.
	}
}

/** Burn leftover temp sessions from hosts that are no longer running. */
function sweepMarker() {
	const entries = readMarker();
	const stale = entries.filter((e) => !pidAlive(e.pid));
	if (stale.length === 0) return;
	for (const e of stale) burnSession(e.id, e.cwd);
	writeMarker(entries.filter((e) => pidAlive(e.pid)));
}

// ── direct child composition (persona + read-leaning tools) ──────
// Resolved through the profile's heal-symlink node_modules so the module
// instances match what the host composition itself loads.
const CHILD_PERSONA = `你是 dsh「临时聊天」里的编程助手。工作目录 {{cwd}} 是用户当前的项目根目录。

## 临时聊天
- 这是一段用完即焚的对话：不进入任何历史记录，关闭后整段焚毁
- 典型用途：快速了解当前项目（结构/技术栈/怎么跑起来）、随手问短问题
- 倾向只读探索：读文件、目录树、git log/status、搜索；除非用户明确要求，不要修改项目文件
- 回答直接、简洁，用用户的语言；提到项目文件时给出确切路径
- 你没有更早的上下文，也不维护跨消息的记忆；每条消息独立完成即可`;

const CHILD_PLUGINS = [
	["@deepseek-ai/dsh-persona", { text: CHILD_PERSONA }],
	["@deepseek-ai/dsh-tool-bash"],
	["@deepseek-ai/dsh-tool-fs"],
	["@deepseek-ai/dsh-tool-fs-search", { sampleOverCapGlobResults: true }],
	["@deepseek-ai/dsh-skill-filesystem"],
	["@deepseek-ai/dsh-tool-skill"],
];

/** Import one composition package from the profile's node_modules. */
async function importProfilePackage(name) {
	const req = createRequire(join(PROFILE_MODULES, "noop.js"));
	const target = req.resolve(name);
	return await import(pathToFileURL(target).href);
}

/** Mount the child composition directly on the agent's scoped context. */
async function composeChild(childCtx) {
	for (const [name, config] of CHILD_PLUGINS) {
		const mod = await importProfilePackage(name);
		const plugin = mod.default ?? mod;
		childCtx.plugin(plugin, config);
	}
}

// ── child-agent helpers (mirrored from dsh agent/subagent internals) ──

/**
 * Model selection for a preset-less child context: injects {{provider}}/{{model}}
 * into persona assembly and pins provider/model on every agent request.
 * Without the variables hook, a persona referencing {{model}} fails assembly.
 */
function installModelSelection(agentCtx, selection) {
	const disposeAssembly = agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
		const selected = selection.current;
		const assembled = await next();
		selection.assembled = selected;
		if (selected === undefined) return assembled;
		return {
			...assembled,
			variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
		};
	});
	const disposeRequest = agentCtx.on("agent/request", async (_payload, next) => {
		const resolved = await next();
		const selected = selection.assembled;
		if (selected === undefined) return resolved;
		const { reasoningEffort: _inherited, ...withoutInherited } = resolved;
		return {
			...withoutInherited,
			provider: selected.provider,
			model: selected.model,
			...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
		};
	});
	return () => {
		disposeAssembly();
		disposeRequest();
	};
}

/** User message in the harness wire shape — content MUST be a part array. */
function userMessage(text) {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: { kind: "user" },
	};
}

/** Final assistant output as plain text (last non-empty assistant message). */
function finalAssistantOutput(events) {
	let message;
	for (const event of events) {
		if (event.type === "assistant/message") {
			const content = event.data?.message?.content;
			if (Array.isArray(content) && content.length > 0) message = content;
		}
	}
	if (message === undefined) return "";
	return message.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("").trim();
}

/** Text deltas after `fromSeq`, for poll streaming. */
function collectChunkDelta(events, fromSeq) {
	let text = "";
	let lastSeq = fromSeq;
	for (const event of events) {
		if (event.type !== "assistant/chunk" || event.seq <= fromSeq) continue;
		lastSeq = event.seq;
		const chunk = event.data?.chunk;
		if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
	}
	return { text, lastSeq };
}

/**
 * Host half entry: register the btw RPC surface over the `/api` channel.
 * @param ctx - host plugin context carrying llm/agentDefaultModel/agents/
 *   connection.
 */
export function apply(ctx) {
	const llm = ctx.get("llm");
	const defaults = ctx.get("agentDefaultModel");
	const agents = ctx.get("agents");
	const connection = ctx.get("connection");
	if (llm === undefined || defaults === undefined || agents === undefined
		|| connection === undefined) return;

	// Side-question jobs: jobId -> { ac, text, done, error }
	const jobs = new Map();
	// Live temp chats: sessionId -> { handle, agent, cwd, busy }
	const temps = new Map();

	// NOTE: the browser's serverResponseSchema validates error `code` against the
	// official RpcErrorCode vocabulary (each with a fixed `details` shape) — custom
	// codes would fail the client-side parse and mask the real message. Every btw
	// failure therefore uses `internal` (details: {}) and carries specifics in `message`.
	const ok = (value) => ({ ok: true, value });
	const err = (message) => ({ ok: false, error: { code: "internal", message, details: {} } });

	const currentSelection = () => {
		try {
			return defaults.currentSelection();
		} catch {
			return undefined;
		}
	};

	const gcJobs = () => {
		const now = Date.now();
		for (const [id, job] of jobs) {
			if (job.done && now - job.created > JOB_TTL_MS) jobs.delete(id);
		}
	};

	// ── side question: stateless one-shot ─────────────────────────────

	function runAsk(jobId, question, transcript) {
		const job = jobs.get(jobId);
		if (job === undefined) return;
		const finish = (error) => {
			job.done = true;
			job.error = error ?? null;
			clearTimeout(job.timer);
		};
		job.timer = setTimeout(() => {
			try { job.ac.abort(); } catch { /* already settled */ }
			finish("侧问超时（3 分钟），已取消");
		}, ASK_TIMEOUT_MS);
		(async () => {
			try {
				const selection = currentSelection();
				if (selection === undefined || !selection.provider || !selection.model) {
					finish("host 未配置默认模型（设置里选一个默认模型）");
					return;
				}
				const body = transcript === ""
					? question
					: `<conversation>\n${transcript}\n</conversation>\n\n<question>\n${question}\n</question>`;
				const opts = {
					provider: selection.provider,
					model: selection.model,
					system: ASK_SYSTEM,
					messages: [userMessage(body)],
					signal: job.ac.signal,
				};
				if (selection.reasoningEffort !== undefined) opts.reasoningEffort = selection.reasoningEffort;
				for await (const chunk of llm.stream(opts)) {
					if (chunk.type === "text-delta" && typeof chunk.text === "string") job.text += chunk.text;
					else if (chunk.type === "finish" || chunk.type === "aborted" || chunk.type === "error") break;
				}
				finish(null);
			} catch (error) {
				finish(error instanceof Error ? error.message : String(error));
			}
		})();
	}

	function handleAsk(payload) {
		gcJobs();
		const question = typeof payload?.question === "string" ? payload.question.trim() : "";
		if (question === "") return err("问题为空");
		let transcript = typeof payload?.transcript === "string" ? payload.transcript : "";
		if (transcript.length > TRANSCRIPT_MAX) transcript = transcript.slice(transcript.length - TRANSCRIPT_MAX);
		const jobId = randomUUID();
		jobs.set(jobId, { ac: new AbortController(), text: "", done: false, error: null, created: Date.now(), timer: null });
		runAsk(jobId, question, transcript);
		return ok({ jobId });
	}

	function handleAskPoll(payload) {
		const job = jobs.get(payload?.jobId);
		if (job === undefined) return err("侧问任务不存在或已过期");
		return ok({ text: job.text, done: job.done, error: job.error });
	}

	function handleAskCancel(payload) {
		const job = jobs.get(payload?.jobId);
		if (job === undefined) return ok({ cancelled: false });
		try { job.ac.abort(); } catch { /* already settled */ }
		job.done = true;
		return ok({ cancelled: true });
	}

	// ── temporary chat: disposable child agent ────────────────────────

	function burnTemp(sessionId, entry) {
		temps.delete(sessionId);
		burnSession(sessionId, entry.cwd);
		writeMarker(readMarker().filter((e) => e.id !== sessionId));
	}

	/** Dispose + burn every live temp chat (page refresh, plugin unload). */
	async function burnAllTemps() {
		for (const [sessionId, entry] of temps) {
			try { await entry.handle.dispose(); } catch { /* already down */ }
			burnTemp(sessionId, entry);
		}
	}

	async function handleOpen(payload) {
		await burnAllTemps();
		let cwd = homedir();
		if (typeof payload?.cwd === "string" && payload.cwd.startsWith("/") && !payload.cwd.includes("..")) {
			try {
				if (statSync(payload.cwd).isDirectory()) cwd = payload.cwd;
			} catch { /* fall back to home */ }
		}
		const sessionId = randomUUID();
		const selection = { current: currentSelection(), assembled: undefined };
		const setup = async (childCtx) => {
			installModelSelection(childCtx, selection);
			// Approval never: the overlay has no question surface.
			childCtx.agent.session.append("approval/policy", { policy: "never", source: "delegation" });
			await composeChild(childCtx);
		};
		let handle;
		try {
			handle = await agents.create({
				sessionId,
				meta: { origin: "subagent", cwd },
				setup,
			});
		} catch (error) {
			return err("开启临时聊天失败：" + (error instanceof Error ? error.message : String(error)));
		}
		temps.set(sessionId, { handle, agent: handle.agent, cwd, busy: false });
		writeMarker(readMarker().concat([{ id: sessionId, cwd, pid: process.pid }]));
		return ok({ sessionId, cwd });
	}

	async function handleSend(payload) {
		const entry = temps.get(payload?.sessionId);
		if (entry === undefined) return err("临时聊天不存在或已焚毁");
		const text = typeof payload?.text === "string" ? payload.text.trim() : "";
		if (text === "") return err("消息为空");
		if (entry.busy) return err("回复中，稍后再发");
		entry.busy = true;
		try {
			entry.agent.followup(userMessage(text));
			await Promise.race([
				entry.agent.whenIdle(),
				new Promise((_resolve, reject) => setTimeout(
					() => reject(new Error(`子 agent 执行超时（${SEND_TIMEOUT_MS / 1000}s）`)),
					SEND_TIMEOUT_MS,
				)),
			]);
			return ok({ output: finalAssistantOutput(entry.agent.session.events) });
		} catch (error) {
			return err("发送失败：" + (error instanceof Error ? error.message : String(error)));
		} finally {
			entry.busy = false;
		}
	}

	async function handlePoll(payload) {
		const entry = temps.get(payload?.sessionId);
		if (entry === undefined) return err("临时聊天不存在或已焚毁");
		const fromSeq = typeof payload?.fromSeq === "number" ? payload.fromSeq : 0;
		return ok(collectChunkDelta(entry.agent.session.events, fromSeq));
	}

	async function handleClose(payload) {
		const entry = temps.get(payload?.sessionId);
		if (entry === undefined) return ok({ burned: false });
		try { await entry.handle.dispose(); } catch { /* already down */ }
		burnTemp(payload.sessionId, entry);
		return ok({ burned: true });
	}

	// ── one intercept, both surfaces ──────────────────────────────────

	const disposeIntercept = connection.rpc.intercept(
		"/api",
		(endpoint) => endpoint.startsWith(RPC_PREFIX),
		async (endpoint, payload) => {
			const method = endpoint.slice(RPC_PREFIX.length);
			try {
				switch (method) {
					case "ask": return handleAsk(payload);
					case "askPoll": return handleAskPoll(payload);
					case "askCancel": return handleAskCancel(payload);
					case "open": return await handleOpen(payload);
					case "send": return await handleSend(payload);
					case "poll": return await handlePoll(payload);
					case "close": return await handleClose(payload);
					default: return err(`unknown method: ${method}`);
				}
			} catch (error) {
				return err(error instanceof Error ? error.message : String(error));
			}
		},
		{ authority: "loopback" },
	);

	sweepMarker();

	ctx.effect(() => () => {
		disposeIntercept();
		for (const [, job] of jobs) {
			try { job.ac.abort(); } catch { /* already settled */ }
		}
		jobs.clear();
		void burnAllTemps();
	});
}
