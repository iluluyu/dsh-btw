/**
 * dsh-btw — browser half (zero-build: hand-maintained source AND shipped
 * artifact, in the window.__ModuleLoader__ handoff format).
 *
 * Two surfaces, both bypassing the main session:
 *
 *   1. Side question — a transient panel stacked above the composer card
 *      (`conversation.input.dock`). Open it with the "btw" chip beside the
 *      send button or by typing "/btw …" in the main composer (the prefix is
 *      stripped in place via `inputActions.setDraft`). The panel assembles a
 *      plain-text transcript from the recorded `useChat(s => s.legacy)`
 *      projection and ships it with the question to the host's
 *      stateless one-shot; the answer streams back through a 250ms poll.
 *
 *   2. Temporary chat — one local conversation, presented in the global main
 *      panel, overlay or sidebar. First send creates a disposable host child;
 *      global entry has neither workspace nor parent. Explicit exit waits for
 *      host cleanup; hiding the overlay/sidebar does not destroy the child.
 *
 * All styling resolves against the host page's --dsw tokens with sensible
 * fallbacks; dark theme needs no special handling (the tokens flip).
 *
 * RPC envelope: { ok, value | error } over the dedicated `/btw` channel.
 */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	factory: (require) => {
		const React = require("react");
		const { useEffect, useLayoutEffect, useRef, useState, useReducer } = React;
		const h = React.createElement;

		const POLL_MS = 250;
		const NAME = "dsh-btw";

		// ── styles (injected once) ──────────────────────────────────────

		const CSS_ID = "@dsh-btw/client.css";
		const CSS = `
		/* ── side-question panel (composer dock row) ── */
		.dsh-btw-dock{width:100%;max-width:var(--dsh-composer-card-max-width,720px);margin:0 auto;padding:0 var(--dsh-composer-side-clearance,16px) 6px;}
		.dsh-btw-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-specific-input-major,#fff);border-radius:14px;box-shadow:var(--dsw-shadow-lv2,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02));display:flex;flex-direction:column;overflow:hidden;font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-head{display:flex;align-items:center;gap:8px;padding:8px 12px 0;}
		.dsh-btw-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#57585a);letter-spacing:.02em;}
		.dsh-btw-hint{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.dsh-btw-x{flex:none;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center;}
		.dsh-btw-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-answer{padding:6px 14px 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow-y:auto;}
		.dsh-btw-answer:empty{display:none;}
		.dsh-btw-answer .dsh-btw-caret{display:inline-block;width:7px;height:14px;background:var(--dsw-alias-brand-text,#3964fe);vertical-align:-2px;margin-left:2px;animation:dsh-btw-caret .8s steps(2) infinite;}
		@keyframes dsh-btw-caret{0%,100%{opacity:1}50%{opacity:0}}
		.dsh-btw-status{padding:4px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-pick{width:14px;height:14px;margin:2px 4px;cursor:pointer;accent-color:var(--dsw-alias-brand-text,#3964fe);}
		.dsh-btw-err{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-row{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:8px 10px 10px;}
		.dsh-btw-q{flex:1;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;padding:4px 6px;max-height:120px;}
		.dsh-btw-q::placeholder{color:var(--dsw-alias-label-caption,#a1a3a8);}
		.dsh-btw-go{flex:none;background:var(--dsw-alias-button-info-fill,#3964fe);color:#fff;cursor:pointer;border:none;border-radius:999px;height:30px;min-width:56px;font-size:12px;font-weight:500;}
		.dsh-btw-go:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2b55e0);}
		.dsh-btw-go:disabled{opacity:.4;cursor:default;}
		.dsh-btw-go.ghost{background:transparent;color:var(--dsw-alias-label-secondary,#57585a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));}
		.dsh-btw-go.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsh-alias-label-primary,#0f1115);}
		/* ── chip trigger beside the send button ── */
		.dsh-btw-chip{height:28px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;flex:none;}
		.dsh-btw-chip:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.09));color:var(--dsw-alias-brand-text,#3964fe);}
		/* ── temp-chat header entry ── */
		.dsh-btw-entry{height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;}
		.dsh-btw-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-entry svg{opacity:.75;}
		/* ── temp-chat overlay (shell.overlay) ── */
		.dsh-btw-veil{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.32);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:grid;place-items:center;animation:dsh-btw-fade .18s ease-out;}
		@keyframes dsh-btw-fade{from{opacity:0}to{opacity:1}}
		.dsh-btw-veil[data-phase=closing]{pointer-events:none;animation:dsh-btw-fade .24s ease-in reverse forwards;}
		.dsh-btw-inline{width:100%;height:100%;min-height:0;}
		.dsh-btw-card,.dsh-btw-modal,.dsh-btw-mcard,.dsh-btw-bubble,.dsh-btw-entry,.dsh-btw-x{corner-shape:superellipse(1.5);}
		.dsh-btw-modal[data-global=true] .dsh-btw-mcard{background:var(--dsw-specific-selector,#f1f2f4);}
		.dsh-btw-modal{width:min(720px,calc(100vw - 32px));height:min(640px,calc(100vh - 96px));background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:16px;box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.16));display:flex;flex-direction:column;overflow:hidden;font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-modal[data-phase=closing]{animation:dsh-btw-shrink .24s ease-in forwards;}
		@keyframes dsh-btw-shrink{to{opacity:0;transform:scale(.97) translateY(8px)}}
		.dsh-btw-mhead{flex:none;display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));}
		.dsh-btw-micon{flex:none;width:30px;height:30px;border-radius:999px;display:grid;place-items:center;background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-mtitles{flex:1;min-width:0;}
		.dsh-btw-mtitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);line-height:20px;}
		.dsh-btw-msub{font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.dsh-btw-mbody{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
		.dsh-btw-empty{margin:auto;text-align:center;color:var(--dsw-alias-label-tertiary,#81858c);font-size:13px;line-height:22px;max-width:400px;padding:0 16px;}
		.dsh-btw-empty b{color:var(--dsw-alias-label-secondary,#57585a);font-weight:600;}
		.dsh-btw-msg{display:flex;flex-direction:column;}
		.dsh-btw-msg.user{align-items:flex-end;}
		.dsh-btw-msg.agent{align-items:flex-start;}
		.dsh-btw-bubble{max-width:85%;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px;padding:8px 12px;border-radius:12px;}
		.dsh-btw-msg.user .dsh-btw-bubble{background:var(--dsw-specific-selector,#e8e8e8);color:var(--dsw-alias-label-primary,#0f1115);border-bottom-right-radius:4px;}
		.dsh-btw-msg.agent .dsh-btw-bubble{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#0f1115);border-bottom-left-radius:4px;}
		.dsh-btw-msg.error .dsh-btw-bubble{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-mfoot{flex:none;padding:10px 12px 12px;}
		.dsh-btw-mcard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-specific-input-major,#fff);border-radius:14px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;}
		.dsh-btw-mrow{display:flex;align-items:flex-end;gap:8px;}
		.dsh-btw-mta{flex:1;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;padding:4px 6px;max-height:140px;}
		.dsh-btw-mta::placeholder{color:var(--dsw-alias-label-caption,#a1a3a8);}
		.dsh-btw-control,.dsh-btw-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#57585a);border:0;background:transparent;border-radius:var(--dsw-radius-md,8px);padding:8px;cursor:pointer;corner-shape:superellipse(1.5);}
		.dsh-btw-control:hover,.dsh-btw-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-control:disabled,.dsh-btw-select:disabled{opacity:.45;cursor:default;}
		.dsh-btw-tools{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;}
		.dsh-btw-mta{width:100%;box-sizing:border-box;min-height:64px;}
		.dsh-btw-standalone{width:100%;height:100%;min-height:0;}
		.dsh-btw-standalone .dsh-btw-mhead{min-height:64px;padding:10px 34px;}
		.dsh-btw-standalone .dsh-btw-mfoot{width:min(740px,calc(100% - 56px));margin:0 auto;padding:0 0 64px;}
		.dsh-btw-standalone [data-empty=true] .dsh-btw-mbody{flex:1 1 50%;justify-content:flex-end;}
		.dsh-btw-standalone [data-empty=true] .dsh-btw-empty{margin:0 auto 30px;}
		.dsh-btw-standalone [data-empty=true] .dsh-btw-mfoot{flex:1 1 50%;}
		.dsh-btw-standalone .dsh-btw-mcard{border:0;border-radius:var(--dsw-radius-xl,24px);padding:16px;box-shadow:0 0 0 .5px var(--dsw-alias-border-l2,rgba(0,0,0,.1));}
		.dsh-btw-global-entry{display:none;position:absolute;right:28px;top:10px;z-index:2;}
		header:has([data-conversation-header-leading]):not(:has(nav)) .dsh-btw-global-entry{display:inline-flex;}
		`;

		function injectCss() {
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NAME;
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── shared plumbing ────────────────────────────────────────────

		const ctxRef = { current: null };

		async function rpc(method, payload, connection = ctxRef.current?.get?.("connection")) {
			// Resolve lazily; cleanup may pin the connection that created a child.
			if (!connection?.rpc?.call) throw new Error("插件未就绪");
			return connection.rpc.call("/btw", method, payload).then((r) => {
				if (!r.ok) throw new Error(r.error?.message || `btw/${method} 失败`);
				return r.value;
			});
		}

		const msg = (e) => (e && e.message) || String(e);

		/** Tiny observable store: mutate + emit, subscribe via useReducer. */
		function createStore(initial) {
			const state = { ...initial };
			const listeners = new Set();
			const patch = (fields) => {
				Object.assign(state, fields);
				for (const fn of listeners) {
					try { fn(); } catch { /* broken listener never blocks */ }
				}
			};
			const use = () => {
				const force = useReducer((x) => x + 1, 0)[1];
				useEffect(() => {
					listeners.add(force);
					return () => { listeners.delete(force); };
				}, []);
				return state;
			};
			return { state, patch, use };
		}

		// Settings are projected from the official form scope; defaults preserve
		// the pre-settings behaviour while the scope is loading or unavailable.
		const DEFAULTS = { askContextMode: "recent", tempContextMode: "none", askModelMode: "host", tempModelMode: "host", askProvider: "", askModel: "", tempProvider: "", tempModel: "", showAskChip: true, enableSlash: true, showTempEntry: true };
		const prefs = createStore(DEFAULTS);
		const catalog = createStore({ status: "loading", providers: [], error: "" });
		let settingsScope = null;
		function projectSettings() {
			const snap = settingsScope?.getSnapshot();
			const value = snap?.status === "ready" && snap.value && typeof snap.value === "object" ? snap.value : {};
			const next = { ...DEFAULTS };
			for (const key of Object.keys(next)) if (typeof value[key] === typeof next[key]) next[key] = value[key];
			prefs.patch(next);
		}
		function loadModels() {
			catalog.patch({ status: "loading", error: "" });
			rpc("models", {}).then((value) => {
				if (!Array.isArray(value?.providers)) throw new Error("模型列表格式无效");
				const providers = value.providers.filter((p) => p && typeof p.id === "string" && Array.isArray(p.models)).map((p) => ({
					id: p.id, models: p.models.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id })),
				}));
				catalog.patch({ status: "ready", providers, error: "" });
			}).catch((e) => {
				const error = msg(e);
				catalog.patch({ status: "error", providers: [], error: /^unknown method:\s*models$/i.test(error.trim())
					? "宿主仍运行旧版 btw，请重启 dsh web 并刷新页面后重试" : error });
			});
		}
		const modelKey = (provider, model) => JSON.stringify([provider, model]);
		function modelOptions(providers) {
			return providers.flatMap((p) => p.models.map((m) => h("option", { key: modelKey(p.id, m.id), value: modelKey(p.id, m.id) }, p.id + " / " + m.name)));
		}
		function modelValue(mode, provider, model) {
			return mode === "custom" ? modelKey(provider, model) : mode;
		}
		function parseModel(value) {
			if (value === "host") return { mode: "host" };
			if (value === "current") return { mode: "current" };
			try { const v = JSON.parse(value); if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string" && x)) return { mode: "custom", model: { provider: v[0], model: v[1] } }; } catch { /* invalid selection */ }
			return { mode: "invalid" };
		}
		function ModelSelect({ value, onChange, disabled, configuredMode }) {
			const models = catalog.use();
			const known = models.providers.some((p) => p.models.some((m) => modelKey(p.id, m.id) === value));
			return h("label", null, h("select", { className: "dsh-btw-select", "aria-label": "模型", value, disabled, onChange: (e) => onChange(e.target.value) },
				h("option", { value: "host" }, "宿主默认"),
				configuredMode === "no-parent" ? null : h("option", { value: "current" }, "当前会话模型"),
				value !== "host" && value !== "current" && !known ? h("option", { value }, "已保存模型不可用") : null,
				...modelOptions(models.providers)),
				models.status === "error" ? h("span", { className: "dsh-btw-err" }, " 模型列表加载失败：" + models.error, " ", h("button", { type: "button", onClick: loadModels }, "重试")) : null);
		}

		// ── side question store + actions ──────────────────────────────

		const ask = createStore({ phase: "idle", originId: null, question: "", text: "", error: null, jobId: null, timer: null });
		let askRequest = 0, askAbort = null;

		function resetAsk() {
			askRequest++; askAbort?.abort();
			if (ask.state.jobId) rpc("askCancel", { jobId: ask.state.jobId }).catch(() => {});
			if (ask.state.timer !== null) clearInterval(ask.state.timer);
			ask.patch({ phase: "idle", originId: null, question: "", text: "", error: null, jobId: null, timer: null });
		}

		function cancelAsk() {
			askRequest++; askAbort?.abort();
			const { jobId, timer } = ask.state;
			if (timer !== null) clearInterval(timer);
			if (jobId !== null) rpc("askCancel", { jobId }).catch(() => { /* best effort */ });
			ask.patch({ phase: "done", timer: null });
		}

		function startAsk(question, transcript, contextMode, choice, parentSessionId) {
			if (ask.state.phase === "asking") return;
			if (ask.state.timer !== null) clearInterval(ask.state.timer);
			ask.patch({ phase: "asking", originId: parentSessionId || null, question, text: "", error: null, jobId: null, timer: null });
			const request = ++askRequest;
			const current = () => request === askRequest && ask.state.originId === (parentSessionId || null);
			askAbort = contextMode === "all" ? new AbortController() : null;
			const send = (context) => {
				if (!current()) throw new Error("提问已取消");
				return rpc("ask", { question, ...context, contextMode, modelMode: choice.mode, ...(choice.model ? { model: choice.model } : {}), ...(typeof parentSessionId === "string" ? { parentSessionId } : {}) });
			};
			const response = contextMode === "all" ? completeContext(parentSessionId, askAbort.signal).then(send) : send({ transcript: contextMode === "none" ? "" : transcript });
			response.then((r) => {
				const jobId = r.jobId;
				if (!current()) { rpc("askCancel", { jobId }).catch(() => {}); return; }
				let polling = false;
				const timer = setInterval(() => {
					if (!current() || polling) return;
					polling = true;
					rpc("askPoll", { jobId }).then((p) => {
						if (!current()) return;
						ask.patch({ text: p.text, error: p.error || null });
						if (p.done) {
							clearInterval(timer);
							ask.patch({ phase: p.error ? "error" : "done", timer: null });
						}
					}).catch((e) => {
						clearInterval(timer);
						if (current()) ask.patch({ phase: "error", error: msg(e), timer: null });
					}).finally(() => { polling = false; });
				}, POLL_MS);
				ask.patch({ jobId, timer });
			}).catch((e) => { if (current()) ask.patch({ phase: "error", error: msg(e) }); });
		}

		/** Plain-text transcript of the conversation for the one-shot prefix. */
		function transcriptOf(snap) {
			const nodes = snap?.nodes;
			if (!Array.isArray(nodes)) return "";
			const clip = (t, n) => (t.length > n ? t.slice(0, n) + "…" : t);
			const lines = [];
			for (const node of nodes) {
				if (node.kind === "user") {
					const t = (Array.isArray(node.content) ? node.content : [])
						.filter((b) => b !== null && b.type === "text" && typeof b.text === "string")
						.map((b) => b.text).join("");
					if (t.trim() !== "") lines.push("User: " + clip(t, 1600));
				} else if (node.kind === "assistant") {
					const t = (Array.isArray(node.blocks) ? node.blocks : [])
						.filter((b) => b !== null && b.kind === "text" && typeof b.text === "string")
						.map((b) => b.text).join("");
					if (t.trim() !== "") lines.push("Assistant: " + clip(t, 1600));
				}
			}
			const recent = lines.length > 14 ? ["…", ...lines.slice(-14)] : lines;
			return recent.join("\n\n");
		}

		// Complete recorded text uses the cold-safe Remote events API, never a
		// projection, activation or surface fold (which would erase compacted text).
		const ALL_LIMIT = 1024 * 1024, ALL_TTL = 60_000, SERIALIZER_VERSION = 1;
		const allCache = new Map(), allReads = new Map(), allHeads = new Map();
		let historyRemote = null, historyConnection = null, historyEpoch = 0;
		const utf8Size = (text) => new TextEncoder().encode(text).length;
		function clearHistory(sourceId) {
			historyEpoch++;
			for (const [key, entry] of allCache) if (!sourceId || entry.sourceId === sourceId) allCache.delete(key);
			for (const [key, read] of allReads) if (!sourceId || read.sourceId === sourceId) { read.abort.abort(); allReads.delete(key); }
			for (const [key, head] of allHeads) if (!sourceId || key === sourceId) { head.abort.abort(); allHeads.delete(key); }
		}
		function recordedText(event) {
			const data = event.data;
			const message = event.type === "user/message" ? data : data?.message;
			const content = ["user/message", "assistant/message", "tool/result"].includes(event.type) ? message?.content : null;
			const text = Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("") : "";
			const body = event.type === "tool/call" ? JSON.stringify({ name: data?.name, callId: data?.callId, arguments: data?.arguments }) : text;
			// Mark EVERY event, including compaction/replacement, without flattening
			// arbitrary event metadata, reasoning streams or attachment payloads.
			return `[event ${event.seq} ${event.type}${event.surfaceOp && event.surfaceOp !== "append" ? " replacement=" + JSON.stringify(event.surfaceOp) : ""}]\n${body || ""}\n\n`;
		}
		function waitForRead(read, signal) {
			read.users++;
			return new Promise((resolve, reject) => {
				let done = false;
				const finish = (fn, value) => { if (done) return; done = true; signal?.removeEventListener("abort", cancel); if (--read.users === 0) read.abort.abort(); fn(value); };
				const cancel = () => finish(reject, new Error("读取全部对话已取消"));
				if (signal?.aborted) { cancel(); return; }
				signal?.addEventListener("abort", cancel, { once: true });
				read.promise.then((v) => finish(resolve, v), (e) => finish(reject, e));
			});
		}
		async function completeContext(sourceId, signal) {
			const connection = ctxRef.current?.get?.("connection");
			if (!sourceId || !historyRemote?.session?.events || !connection || connection !== historyConnection) throw new Error("完整对话读取服务不可用");
			if (connection.state?.getSnapshot() !== undefined && connection.state.getSnapshot() !== "connected") { clearHistory(); throw new Error("连接已断开，未读取上下文"); }
			const remote = historyRemote, epoch = historyEpoch;
			const check = () => { if (historyEpoch !== epoch || connection !== historyConnection || ctxRef.current?.get?.("connection") !== connection || remote !== historyRemote || signal?.aborted) throw new Error("来源或连接已改变，完整上下文已取消"); };
			const page = async (request, readSignal) => {
				const result = await remote.session.events({ address: { kind: "session", sessionId: sourceId }, maxMessages: 100, ...request }, readSignal);
				if (!result?.ok) throw new Error(result?.error?.message || "完整对话读取失败");
				const value = result.value;
				if (!Number.isSafeInteger(value?.cursor) || value.cursor < -1 || !Array.isArray(value.records) || typeof value.hasMore !== "boolean") throw new Error("完整对话分页格式无效");
				return value;
			};
			let head = allHeads.get(sourceId);
			if (!head) {
				head = { abort: new AbortController(), users: 0 };
				head.promise = page({}, head.abort.signal).finally(() => { if (allHeads.get(sourceId) === head) allHeads.delete(sourceId); });
				allHeads.set(sourceId, head);
			}
			const first = await waitForRead(head, signal); check();
			const cut = first.cursor, key = JSON.stringify([sourceId, cut, SERIALIZER_VERSION]);
			if (cut < 0) throw new Error("来源会话没有已记录文本，未发送");
			for (const [k, entry] of allCache) if (Date.now() - entry.at > ALL_TTL) allCache.delete(k);
			const cached = allCache.get(key);
			if (cached) { allCache.delete(key); allCache.set(key, cached); return cached.payload; }
			let read = allReads.get(key);
			if (!read) {
				if (allReads.size >= 2) throw new Error("完整上下文读取繁忙，请稍后再试");
				read = { sourceId, abort: new AbortController(), users: 0 };
				read.promise = (async () => {
					let base = null;
					for (const entry of allCache.values()) if (entry.sourceId === sourceId && entry.cut < cut && (!base || entry.cut > base.cut)) base = entry;
					let expected = cut, current = first, size = base?.bytes || 0;
					const chunks = [];
					while (true) {
						if (read.abort.signal.aborted || historyEpoch !== epoch) throw new Error("完整对话读取已取消");
						if (current.cursor !== cut) throw new Error("完整对话分页切点改变");
						if (current.records.length === 0 && expected >= 0) throw new Error("完整对话出现空页或缺页");
						const parts = [];
						for (let i = current.records.length - 1; i >= 0; i--) {
							const record = current.records[i], event = record?.event;
							if (record?.type !== "event" || !Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq !== expected || typeof event.type !== "string") throw new Error("完整对话事件序号不连续");
							expected--;
							if (!base || event.seq > base.cut) {
								const text = recordedText(event); size += utf8Size(text);
								if (size > ALL_LIMIT) throw new Error("全部对话超过 1 MiB 上限；未截断、未发送");
								parts.push(text);
							}
						}
						chunks.push(parts.reverse().join(""));
						if (base && expected <= base.cut) break;
						if (expected === -1) { if (current.hasMore) throw new Error("完整对话分页边界无效"); break; }
						if (!current.hasMore) throw new Error("完整对话缺少早期记录");
						current = await page({ throughSeq: cut, beforeSeq: expected + 1 }, read.abort.signal);
					}
					const transcript = (base?.payload.transcript || "") + chunks.reverse().join("");
					const payload = { transcript, contextSnapshot: { sessionId: sourceId, throughSeq: cut, complete: true, authorized: true } };
					if (historyEpoch !== epoch || read.abort.signal.aborted) throw new Error("完整对话读取已取消");
					while (allCache.size >= 2 || [...allCache.values()].reduce((n, e) => n + e.bytes, 0) + size > ALL_LIMIT) allCache.delete(allCache.keys().next().value);
					allCache.set(key, { sourceId, cut, bytes: size, at: Date.now(), payload });
					return payload;
				})().finally(() => { if (allReads.get(key) === read) allReads.delete(key); });
				allReads.set(key, read);
			}
			const payload = await waitForRead(read, signal); check(); return payload;
		}

		// ── temp chat store + actions ──────────────────────────────────

		const emptyTemp = () => ({
			phase: "idle", sessionId: null, originId: null, cwd: null, messages: [], busy: false, error: null, seq: 0,
			presentation: "hidden", draft: "", selected: [], insertionError: "", insertionNotice: "", contextMode: "none", modelChoice: "host", transcript: "",
		});
		const temp = createStore(emptyTemp());
		let sidebar = null;
		let globalLayout = null;
		let composerBridge = null;
		let originSnapshot = null;
		let generation = 0;
		// One attempt owns the child connection, context read and open promise.
		// closeTemp is the sole release path, including panel/plugin unmount.
		let openingAttempt = null, closingTemp = null;
		let tempTurn = 0, tempPollTimer = null;
		function stopTempTurn() {
			tempTurn++;
			if (tempPollTimer !== null) clearInterval(tempPollTimer);
			tempPollTimer = null;
		}
		const TAB_ID = "dsh-btw/temp";
		function showOverlay() {
			try {
				// Collapse the native fullscreen surface without closing its tabs.
				if (sidebar?.isExpanded?.()) sidebar.toggleExpanded();
				temp.patch({ presentation: "overlay" });
			} catch (e) { temp.patch({ insertionError: "无法收起侧栏：" + msg(e) }); }
		}
		function showSidebar() {
			if (!sidebar || !temp.state.originId || sidebar.mounted?.getSnapshot() !== temp.state.originId) {
				temp.patch({ insertionError: "请先返回来源会话，才能打开侧栏" }); return;
			}
			try { sidebar.openTab("btw-temp"); temp.patch({ presentation: "sidebar", insertionError: "", insertionNotice: "" }); }
			catch (e) { temp.patch({ insertionError: "无法打开侧栏：" + msg(e) }); }
		}
		function insertSelected() {
			const s = temp.state;
			const fail = (error) => temp.patch({ insertionError: error });
			if (!s.originId || !sidebar || sidebar.mounted?.getSnapshot() !== s.originId || !composerBridge || composerBridge.sessionId !== s.originId) return fail("来源会话未显示，无法送回草稿");
			const text = s.selected.slice().sort((a, b) => a - b).map((i) => s.messages[i]).filter((m) => m && !m.streaming && !m.error).map((m) => (m.role === "user" ? "用户：" : "助手：") + m.text).join("\n\n");
			if (!text) return fail("请选择已完成的消息");
			try {
				const span = composerBridge.actions.captureInsertion();
				if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || !Number.isInteger(span.draftRev)) return fail("无法确认草稿位置，请重试");
				if (sidebar.mounted.getSnapshot() !== s.originId || composerBridge.sessionId !== s.originId) return fail("会话已切换，未插入草稿");
				// Collapse the captured range: never replace selected text or references.
				const point = Math.max(span.start, span.end);
				if (!composerBridge.actions.insertText("\n\n" + text + "\n", { ...span, start: point, end: point })) return fail("草稿已更改或编辑器不可用，请重试");
				temp.patch({ selected: [], insertionError: "", insertionNotice: "已插入草稿，未发送" });
			} catch (e) { fail("未能插入草稿：" + msg(e)); }
		}
		function toggleMessage(i) {
			const selected = temp.state.selected;
			temp.patch({ selected: selected.includes(i) ? selected.filter((n) => n !== i) : selected.concat(i), insertionError: "", insertionNotice: "" });
		}

		function openTemp(cwd, originId, presentation = "overlay") {
			if (temp.state.phase !== "idle") return;
			generation++;
			const p = prefs.state;
			temp.patch({ phase: "configuring", error: null, messages: [], sessionId: null, cwd: cwd || null, seq: 0, originId: typeof originId === "string" ? originId : null, presentation, draft: "", selected: [], insertionError: "", insertionNotice: "", contextMode: originId ? p.tempContextMode : "none", modelChoice: !originId && p.tempModelMode === "current" ? "host" : modelValue(p.tempModelMode, p.tempProvider, p.tempModel), transcript: originSnapshot && originSnapshot.sessionId === originId ? originSnapshot.text : "" });
		}

		function beginTemp(text) {
			if (temp.state.phase !== "configuring") return;
			const s = { ...temp.state };
			const choice = parseModel(s.modelChoice);
			if (choice.mode === "invalid" || (choice.mode === "current" && !s.originId) || (choice.mode === "custom" && !catalog.state.providers.some((p) => p.id === choice.model.provider && p.models.some((m) => m.id === choice.model.model)))) {
				temp.patch({ insertionError: "所选模型不可用，请检查设置和来源会话" }); return;
			}
			if (!["none", "recent", "on-demand", "all"].includes(s.contextMode)) { temp.patch({ insertionError: "此上下文模式尚不可用" }); return; }
			if (s.contextMode === "on-demand" && !s.transcript.trim()) { temp.patch({ insertionError: "按需上下文需要来源会话的近期文本快照" }); return; }
			const connection = ctxRef.current?.get?.("connection");
			const requestGeneration = generation;
			const carried = s.messages.filter((m) => !m.error && !m.streaming).map(({ role, text }) => ({ role, text }));
			const firstText = carried.length ? "Earlier btw exchange (untrusted transcript):\n" + JSON.stringify(carried) + "\n\nCurrent question:\n" + text : text;
			const attempt = openingAttempt = { connection, sessionId: null, sent: false, abort: s.contextMode === "all" ? new AbortController() : null };
			temp.patch({ phase: "opening", insertionError: "", insertionNotice: "" });
			const open = (context) => {
				if (generation !== requestGeneration) throw new Error("临时聊天已取消");
				attempt.sent = true;
				return rpc("open", { cwd: s.cwd, contextMode: s.contextMode, ...context, modelMode: choice.mode, ...(choice.model ? { model: choice.model } : {}), ...(s.originId ? { parentSessionId: s.originId } : {}) }, connection);
			};
			attempt.opened = (s.contextMode === "all" ? completeContext(s.originId, attempt.abort.signal).then(open) : open({ transcript: s.contextMode === "none" ? "" : s.transcript })).then((r) => {
				attempt.sessionId = r.sessionId;
				return r;
			});
			attempt.opened.then((r) => {
				if (generation !== requestGeneration) return;
				temp.patch({ phase: "active", sessionId: r.sessionId, cwd: r.cwd, busy: false, draft: "" });
				sendTemp(text, firstText);
			}).catch((e) => { if (generation === requestGeneration) temp.patch({ phase: "configuring", insertionError: msg(e) }); });
		}

		function appendAgentText(delta) {
			const messages = temp.state.messages.slice();
			const last = messages[messages.length - 1];
			if (last !== undefined && last.role === "agent" && last.streaming) {
				messages[messages.length - 1] = { role: "agent", text: last.text + delta, streaming: true };
			} else {
				messages.push({ role: "agent", text: delta, streaming: true });
			}
			temp.patch({ messages });
		}

		function finalizeAgentText(text) {
			const messages = temp.state.messages.slice();
			const last = messages[messages.length - 1];
			if (last !== undefined && last.role === "agent") {
				messages[messages.length - 1] = { role: "agent", text, streaming: false };
			} else if (text !== "") {
				messages.push({ role: "agent", text, streaming: false });
			}
			temp.patch({ messages });
		}

		function sendTemp(text, wireText = text) {
			const { phase, busy, sessionId, seq } = temp.state;
			if (phase !== "active" || busy || sessionId === null) return;
			const connection = openingAttempt?.connection;
			const turn = ++tempTurn;
			const current = () => turn === tempTurn && temp.state.sessionId === sessionId && temp.state.phase === "active";
			let fromSeq = seq, inFlight = null, settled = false;
			temp.patch({ busy: true, messages: temp.state.messages.concat([{ role: "user", text }]) });
			const poll = (final = false) => rpc("poll", { sessionId, fromSeq }, connection).then((r) => {
				if (!current() || (settled && !final)) return;
				if (!Number.isSafeInteger(r.lastSeq) || r.lastSeq < fromSeq) throw new Error("回复游标无效");
				if (r.lastSeq > fromSeq) {
					fromSeq = r.lastSeq;
					temp.patch({ seq: fromSeq });
					if (r.text) appendAgentText(r.text);
				}
			});
			const timer = setInterval(() => {
				if (!current() || settled || inFlight) return;
				inFlight = poll().catch(() => { /* final poll recovers transient failures */ }).finally(() => { inFlight = null; });
			}, POLL_MS);
			tempPollTimer = timer;
			rpc("send", { sessionId, text: wireText }, connection).then(async (r) => {
				settled = true;
				clearInterval(timer);
				// Fence the old reply before taking the final cut; never poll in parallel.
				await inFlight;
				if (!current()) return;
				await poll(true);
				if (!current()) return;
				const last = temp.state.messages.at(-1);
				finalizeAgentText(typeof r.output === "string" && r.output !== "" ? r.output : last?.streaming ? last.text : "");
			}).catch((e) => {
				if (!current()) return;
				const messages = temp.state.messages.map((m) => m.streaming ? { ...m, streaming: false } : m);
				temp.patch({ messages: messages.concat([{ role: "agent", text: "（发送失败：" + msg(e) + "）", error: true }]) });
			}).finally(() => {
				settled = true;
				clearInterval(timer);
				if (tempPollTimer === timer) tempPollTimer = null;
				if (current()) temp.patch({ busy: false });
			});
		}

		function closeTemp() {
			const { phase, sessionId } = temp.state;
			if (phase === "closing") return closingTemp;
			if (!["active", "error", "configuring", "opening"].includes(phase)) return Promise.resolve(phase === "idle");
			const attempt = openingAttempt, closeGeneration = ++generation;
			stopTempTurn();
			attempt?.abort?.abort();
			temp.patch({ phase: "closing", busy: true });
			const release = () => {
				const id = attempt?.sessionId || sessionId;
				return id === null ? Promise.resolve() : rpc("close", { sessionId: id }, attempt?.connection);
			};
			const close = phase === "opening" ? attempt.opened.catch((e) => {
				// Cancellation before any open request is safe; once sent, every
				// failure is actionable, regardless of the server's error wording.
				if (!attempt.sent && attempt.abort?.signal.aborted) return;
				throw e;
			}).then(release) : release();
			closingTemp = close.then(() => {
				if (generation === closeGeneration) {
					openingAttempt = null;
					temp.patch(emptyTemp());
				}
				return true;
			}).catch((e) => {
				if (generation === closeGeneration) temp.patch({ phase: "error", sessionId: attempt?.sessionId || sessionId, busy: false, error: "临时记录清理未完成", insertionError: "结束失败，请重试：" + msg(e) });
				return false;
			}).finally(() => { closingTemp = null; });
			return closingTemp;
		}

		// ── side-question panel (conversation.input.dock) ──────────────

		function BtwAskPanel(props) {
			useEffect(() => () => {
				if (props.sessionId) clearHistory(props.sessionId);
				if (ask.state.originId === props.sessionId) resetAsk();
			}, [props.sessionId]);
			useEffect(() => {
				if (typeof props.sessionId !== "string" || !props.inputActions || typeof props.inputActions.captureInsertion !== "function" || typeof props.inputActions.insertText !== "function") return undefined;
				const bridge = { sessionId: props.sessionId, actions: props.inputActions };
				composerBridge = bridge;
				return () => { if (composerBridge === bridge) composerBridge = null; };
			}, [props.sessionId, props.inputActions]);
			const s = ask.use();
			const p = prefs.use();
			const lifecycle = props.useSession !== undefined ? props.useSession((x) => x) : null;
			const transcript = props.useChat ? props.useChat((x) => transcriptOf(x.legacy)) : props.useConversation?.((x) => transcriptOf(x.views.get("chat")?.legacy)) || "";
			const sourceCwd = props.useSessions?.((x) => x.byId[props.sessionId]?.cwd);
			useEffect(() => { if (lifecycle?.removed) { clearHistory(props.sessionId); if (ask.state.originId === props.sessionId) cancelAsk(); } }, [props.sessionId, lifecycle?.removed]);
			if (typeof props.sessionId === "string") originSnapshot = { sessionId: props.sessionId, text: transcript };
			const [draft, setDraft] = useState("");
			const [contextMode, setContextMode] = useState(p.askContextMode);
			const [selected, setSelected] = useState(modelValue(p.askModelMode, p.askProvider, p.askModel));
			const taRef = useRef(null);
			const answerRef = useRef(null);
			const composing = useRef(false);
			const armed = useRef(true); // /btw 前缀只吃一次，避免 setDraft 回环
			const pendingCarried = useRef(""); // /btw 带入的问题文本，面板打开时填入

			// "/btw …" in the main composer opens the panel and moves the whole
			// question over (not just the prefix) so the main draft stays clean.
			const input = props.useInput !== undefined ? props.useInput((x) => x) : null;
			const draftText = input !== null && input !== undefined ? input.draft : null;
			useEffect(() => {
				if (!p.enableSlash || typeof props.inputActions?.setDraft !== "function" || typeof draftText !== "string") return;
				if (armed.current && /^\/btw(\s|$)/.test(draftText)) {
					armed.current = false;
					const carried = draftText.replace(/^\/btw\s*/, "");
					props.inputActions.setDraft("");
					if (ask.state.phase === "idle") ask.patch({ phase: "open" });
					if (carried !== "") pendingCarried.current = carried;
					requestAnimationFrame(() => taRef.current?.focus({ preventScroll: true }));
				} else if (!/^\/btw/.test(draftText)) {
					armed.current = true;
				}
			}, [draftText, props.inputActions, p.enableSlash]);

			useEffect(() => {
				if (s.phase === "open") {
					setContextMode(p.askContextMode);
					setSelected(modelValue(p.askModelMode, p.askProvider, p.askModel));
					if (pendingCarried.current !== "") {
						setDraft(pendingCarried.current);
						pendingCarried.current = "";
					}
					taRef.current?.focus({ preventScroll: true });
				}
			}, [s.phase]);

			useLayoutEffect(() => {
				const el = answerRef.current;
				if (el !== null) el.scrollTop = el.scrollHeight;
			}, [s.text]);

			if (s.phase === "idle" || (s.originId && s.originId !== props.sessionId)) return null;

			const submit = () => {
				const q = draft.trim();
				if (q === "" || s.phase === "asking") return;
				if (lifecycle?.removed) { ask.patch({ error: "来源会话已关闭，未发送" }); return; }
				const choice = parseModel(selected);
				if ((choice.mode === "current" && !props.sessionId) || choice.mode === "invalid" || (choice.mode === "custom" && !catalog.state.providers.some((p) => p.id === choice.model.provider && p.models.some((m) => m.id === choice.model.model)))) {
					ask.patch({ error: "所选模型不可用，请重新选择模型" });
					return;
				}
				if (!["none", "recent", "on-demand", "all"].includes(contextMode)) { ask.patch({ error: "此上下文模式尚不可用" }); return; }
				if (contextMode === "on-demand" && !transcript.trim()) { ask.patch({ error: "按需上下文需要来源会话的近期文本快照" }); return; }
				setDraft("");
				startAsk(q, transcript, contextMode, choice, props.sessionId);
			};
			const onKey = (e) => {
				if (e.key === "Escape") { resetAsk(); return; }
				if (e.key !== "Enter" || e.shiftKey) return;
				const ime = composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
				if (!ime) { e.preventDefault(); submit(); }
			};

			return h("div", { className: "dsh-btw-dock" },
				h("div", { className: "dsh-btw-card" },
					h("div", { className: "dsh-btw-head" },
						h("span", { className: "dsh-btw-title" }, "btw · 侧问"),
						h("span", { className: "dsh-btw-hint" }, s.phase === "asking" ? "回答中…" : ""),
						sidebar && props.sessionId ? h("button", { className: "dsh-btw-control", title: "停靠侧边栏", "aria-label": "停靠侧边栏", disabled: s.phase === "asking" || temp.state.phase !== "idle", onClick: () => {
							if (sidebar.mounted?.getSnapshot() !== props.sessionId) { ask.patch({ error: "请先返回来源会话" }); return; }
							openTemp(sourceCwd, props.sessionId);
							const messages = [];
							if (s.question) messages.push({ role: "user", text: s.question });
							if (s.text) messages.push({ role: "agent", text: s.text });
							temp.patch({ messages, draft, modelChoice: selected, contextMode, transcript });
							showSidebar();
							if (temp.state.presentation === "sidebar") resetAsk();
						} }, "▣") : null,
						h("button", {
							className: "dsh-btw-x", title: "关闭（Esc）", onClick: resetAsk,
							"aria-label": "关闭侧问面板",
						}, "×"),
					),
					s.error !== null
						? h("div", { className: "dsh-btw-answer dsh-btw-err" }, s.error)
						: h("div", { className: "dsh-btw-answer", ref: answerRef },
							s.text,
							s.phase === "asking" ? h("span", { className: "dsh-btw-caret" }) : null),
					h("div", { className: "dsh-btw-row" },
						h("textarea", {
							className: "dsh-btw-q",
							ref: taRef,
							value: draft,
							rows: 1,
							placeholder: "顺手问一句，比如：刚才定的配置文件叫什么？",
							onChange: (e) => { setDraft(e.target.value); },
							onKeyDown: onKey,
							onCompositionStart: () => { composing.current = true; },
							onCompositionEnd: () => { setTimeout(() => { composing.current = false; }, 10); },
						}),
						h("div", { className: "dsh-btw-tools" },
							h(ModelSelect, { value: selected, onChange: setSelected, disabled: s.phase === "asking" }),
							h("select", { className: "dsh-btw-select", "aria-label": "侧问上下文", title: "按需搜索授权近期文本快照，非完整历史", value: contextMode, disabled: s.phase === "asking", onChange: (e) => setContextMode(e.target.value) }, h("option", { value: "none" }, "无上下文"), h("option", { value: "recent" }, "最近对话"), h("option", { value: "on-demand" }, "按需搜索近期快照"), h("option", { value: "all" }, "全部对话")),
						s.phase === "asking"
							? h("button", { className: "dsh-btw-go ghost", onClick: cancelAsk }, "停止")
							: h("button", {
								className: "dsh-btw-go",
								onClick: submit,
								disabled: draft.trim() === "",
								"aria-label": "提问",
							}, "问")),
					),
				),
			);
		}

		// ── chip trigger (conversation.input.right) ────────────────────

		function BtwTrigger() {
			const s = ask.use();
			const p = prefs.use();
			if (!p.showAskChip || s.phase !== "idle") return null;
			return h("button", {
				type: "button",
				className: "dsh-btw-chip",
				title: "btw 侧问 · 不打断主任务（也可以在输入框输入 /btw）",
				onClick: () => { ask.patch({ phase: "open" }); },
			}, "btw");
		}

		// ── temp-chat entry (conversation.session.header.utilities) ────

		const GHOST_ICON = h("svg", {
			viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true, fill: "none",
			stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round",
		},
			h("path", { d: "M8 2.2c-2.6 0-4.6 1.9-4.6 4.3 0 .8.2 1.5.7 2.1.2.3.3.6.3.9l-.2 1.6c-.1.4.4.7.7.5l1.5-.8c.3-.1.6-.2.9-.1.2 0 .5.1.7.1 2.6 0 4.6-1.9 4.6-4.3S10.6 2.2 8 2.2Z" }),
			h("path", { d: "M6 6.4h.01M10 6.4h.01M8 4.6h.01" }),
		);

		function BtwTempEntry(props) {
			const s = temp.use();
			const p = prefs.use();
			// Current session cwd — the temp chat opens in the same project.
			const summary = props.useSessions !== undefined
				? props.useSessions((x) => (props.sessionId !== undefined ? x.byId[props.sessionId] : undefined))
				: undefined;
			if (!p.showTempEntry) return null;
			return h("button", {
				type: "button",
				className: "dsh-btw-entry",
				title: summary?.cwd ? "临时聊天 · 工作目录指向当前项目" : "临时聊天 · 使用宿主默认工作目录",
				"aria-label": "临时聊天",
				onClick: () => { if (s.phase === "idle") openTemp(summary?.cwd, props.sessionId); showOverlay(); },
			}, GHOST_ICON, "临时聊天");
		}

		// ── temp-chat overlay (shell.overlay) ──────────────────────────

		function BtwTempOverlay({ inline = false, standalone = false } = {}) {
			const s = temp.use();
			const draft = s.draft;
			const setDraft = (value) => temp.patch({ draft: value });
			const bodyRef = useRef(null);
			const taRef = useRef(null);
			const composing = useRef(false);

			useEffect(() => {
				if (s.phase === "active" || s.phase === "configuring") taRef.current?.focus({ preventScroll: true });
			}, [s.phase]);

			useLayoutEffect(() => {
				const el = bodyRef.current;
				if (el !== null) el.scrollTop = el.scrollHeight;
			}, [s.messages]);

			useEffect(() => {
				if (inline || standalone || s.presentation !== "overlay" || (s.phase !== "active" && s.phase !== "error" && s.phase !== "opening" && s.phase !== "configuring")) return undefined;
				const onKey = (e) => {
					if (e.key === "Escape" && !e.isComposing) temp.patch({ presentation: "hidden" });
				};
				document.addEventListener("keydown", onKey);
				return () => { document.removeEventListener("keydown", onKey); };
			}, [s.phase, s.presentation, inline, standalone]);

			if (s.phase === "idle" || (standalone ? s.presentation !== "global" : inline ? s.presentation !== "sidebar" : s.presentation !== "overlay")) return null;

			const cwdName = s.cwd !== null ? s.cwd.split("/").filter(Boolean).pop() : null;
			const submit = () => {
				const text = draft.trim();
				if (text === "" || s.busy) return;
				if (s.phase === "configuring") beginTemp(text);
				else { setDraft(""); sendTemp(text); }
			};
			const onKey = (e) => {
				if (e.key !== "Enter" || e.shiftKey) return;
				const ime = composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
				if (!ime) { e.preventDefault(); submit(); }
			};

			return h("div", { className: standalone ? "dsh-btw-standalone" : inline ? "dsh-btw-inline" : "dsh-btw-veil", "data-phase": s.phase, onClick: (e) => {
				if (!inline && !standalone && e.target === e.currentTarget) temp.patch({ presentation: "hidden" });
			} },
				h("div", { className: "dsh-btw-modal", style: inline || standalone ? { width: "100%", height: "100%", border: 0, borderRadius: 0, boxShadow: "none" } : undefined, "data-phase": s.phase, "data-global": !s.originId, "data-empty": s.messages.length === 0, role: inline || standalone ? "region" : "dialog", "aria-label": "临时聊天" },
					h("div", { className: "dsh-btw-mhead" },
						h("span", { className: "dsh-btw-micon" }, GHOST_ICON),
						h("div", { className: "dsh-btw-mtitles" },
							h("div", { className: "dsh-btw-mtitle" }, inline ? "btw" : "临时聊天"),
							h("div", { className: "dsh-btw-msub" },
								s.phase === "opening" ? "正在开启…"
									: s.phase === "closing" ? "正在清理…"
									: s.phase === "error" ? "清理未完成"
									: standalone ? "结束后删除本机临时记录"
									: s.phase === "configuring" ? ""
									: (cwdName !== null ? `${cwdName} · ` : "") + "收起后保留，结束时尝试清理"),
						),
						standalone ? h("button", { className: "dsh-btw-control", onClick: () => { closeTemp()?.then((closed) => { if (closed) globalLayout?.selectPanel(null); }); }, disabled: s.phase === "closing" }, "退出临时聊天") : h(React.Fragment, null,
							inline ? h("button", { className: "dsh-btw-control", onClick: showOverlay }, "弹窗") : (sidebar && s.originId ? h("button", { className: "dsh-btw-control", title: "停靠侧边栏", "aria-label": "停靠侧边栏", onClick: showSidebar }, "▣") : null),
							h("button", { className: "dsh-btw-control", onClick: closeTemp, disabled: s.phase === "closing" }, "结束对话"),
							h("button", { className: "dsh-btw-x", title: "收起", onClick: () => temp.patch({ presentation: "hidden" }), "aria-label": "收起临时聊天" }, "×")),
					),
					s.phase === "error"
						? h("div", { className: "dsh-btw-empty" },
							h("div", { className: "dsh-btw-err" }, s.error), h("div", null, "关闭后再试一次。"))
						: h("div", { className: "dsh-btw-mbody", ref: bodyRef },
							s.messages.length === 0
								? h("div", { className: "dsh-btw-empty" },
									standalone ? null : h("b", null, "btw"),
									standalone ? null : h("div", null, s.cwd ? "比如：这个项目是干什么的？" : "问点什么…"))
								: s.messages.map((m, i) => h("div", {
									className: "dsh-btw-msg " + m.role + (m.error ? " error" : ""),
									key: i, onContextMenu: (e) => { if (!m.streaming && !m.error) { e.preventDefault(); toggleMessage(i); } },
								},
									!m.streaming && !m.error ? h("input", { className: "dsh-btw-pick", type: "checkbox", checked: s.selected.includes(i), onChange: () => toggleMessage(i), "aria-label": "选择消息 " + (i + 1) }) : null,
									h("div", { className: "dsh-btw-bubble" },
										m.text,
										m.streaming ? h("span", { className: "dsh-btw-caret" }) : null))),
						),
					s.selected.length ? h("button", { onClick: insertSelected }, "送回来源会话草稿（" + s.selected.length + "）") : null,
					s.insertionError || s.insertionNotice ? h("div", { className: "dsh-btw-status" + (s.insertionError ? " dsh-btw-err" : ""), role: "status" }, s.insertionError || s.insertionNotice) : null,
					s.phase !== "error" ? h("div", { className: "dsh-btw-mfoot" },
						h("div", { className: "dsh-btw-mcard" },
							h("textarea", {
									className: "dsh-btw-mta",
									ref: taRef,
									value: draft,
									rows: 2,
									disabled: s.phase !== "active" && s.phase !== "configuring",
									placeholder: s.busy ? "回复中…（可以等它说完）" : "问点什么… Enter 发送，Shift+Enter 换行",
									onChange: (e) => { setDraft(e.target.value); },
									onKeyDown: onKey,
									onCompositionStart: () => { composing.current = true; },
									onCompositionEnd: () => { setTimeout(() => { composing.current = false; }, 10); },
								}),
							h("div", { className: "dsh-btw-tools" },
								h(ModelSelect, { value: s.modelChoice, disabled: s.phase !== "configuring", configuredMode: s.originId ? undefined : "no-parent", onChange: (value) => temp.patch({ modelChoice: value }) }),
								s.originId ? h("label", null, h("select", { className: "dsh-btw-select", "aria-label": "临时聊天上下文", title: "按需模式授权最近的文本快照，不是完整历史", value: s.contextMode, disabled: s.phase !== "configuring", onChange: (e) => temp.patch({ contextMode: e.target.value }) }, h("option", { value: "none" }, "无上下文"), h("option", { value: "recent" }, "最近对话"), h("option", { value: "on-demand" }, "按需搜索近期快照"), h("option", { value: "all" }, "全部对话"))) : null,
								h("button", {
									className: "dsh-btw-go",
									style: { height: "34px" },
									onClick: submit,
									disabled: s.busy || draft.trim() === "" || (s.phase !== "active" && s.phase !== "configuring"),
									"aria-label": "发送",
								}, "发送"),
							),
						),
					) : null,
				),
			);
		}

		const GLOBAL_PANEL = "dsh-btw-global";
		function BtwGlobalEntry() {
			const p = prefs.use();
			if (!p.showTempEntry || !globalLayout) return null;
			return h("button", { type: "button", className: "dsh-btw-entry dsh-btw-global-entry", onClick: () => globalLayout.selectPanel(GLOBAL_PANEL), "aria-label": "开启全局临时聊天" }, GHOST_ICON, "临时聊天");
		}
		function BtwGlobalPanel() {
			const s = temp.use();
			useEffect(() => {
				let mounted = true;
				const enter = () => { if (mounted && temp.state.phase === "idle") openTemp(null, null, "global"); };
				if (temp.state.phase === "closing") closingTemp?.then(enter);
				else enter();
				return () => { mounted = false; if (temp.state.presentation === "global") void closeTemp(); };
			}, []);
			if (s.phase !== "idle" && s.presentation !== "global") return h("div", { className: "dsh-btw-empty" }, "已有会话内临时聊天，请先结束它。");
			return h(BtwTempOverlay, { standalone: true });
		}

		function BtwSidebarBody(props) {
			const s = temp.use();
			if (s.originId !== props.btwSessionId) return h("div", { className: "dsh-btw-empty" }, "此临时对话不属于当前会话。");
			if (s.phase === "idle") return h("div", { className: "dsh-btw-empty" }, "没有进行中的临时对话。");

			if (s.presentation !== "sidebar") return h("button", { onClick: showSidebar }, "在侧栏显示临时对话");
			return h(BtwTempOverlay, { inline: true });
		}

		// ── official plugin settings ───────────────────────────────────
		const settingsErrors = createStore({ error: "" });
		function settingSaved(result) {
			if (result === false) throw new Error("设置未保存，请重试");
			settingsErrors.patch({ error: "" });
		}
		function saveSetting(key, value) {
			const snap = settingsScope?.getSnapshot();
			if (!settingsScope || snap?.status !== "ready" || snap.writable === false) return;
			Promise.resolve().then(() => settingsScope.set(key, value)).then(settingSaved).catch((e) => settingsErrors.patch({ error: msg(e) }));
		}
		function saveModel(prefix, value) {
			const choice = parseModel(value);
			if (choice.mode === "host" || choice.mode === "current") { saveSetting(prefix + "ModelMode", choice.mode); return; }
			if (choice.mode !== "custom") return;
			const snap = settingsScope?.getSnapshot();
			if (!settingsScope || snap?.status !== "ready" || snap.writable === false) return;
			if (typeof settingsScope.mutate !== "function") { settingsErrors.patch({ error: "设置服务不支持原子更新模型" }); return; }
			Promise.resolve().then(() => settingsScope.mutate([
				{ op: "set", path: [prefix + "Provider"], value: choice.model.provider },
				{ op: "set", path: [prefix + "Model"], value: choice.model.model },
				{ op: "set", path: [prefix + "ModelMode"], value: "custom" },
			])).then(settingSaved).catch((e) => settingsErrors.patch({ error: msg(e) }));
		}
		function BtwSettings() {
			const p = prefs.use(), errors = settingsErrors.use();
			const snap = settingsScope?.getSnapshot();
			const disabled = snap?.status !== "ready" || snap.writable === false;
			const context = (key, label) => h("label", { style: { display: "block", margin: "10px 0" } }, label, " ",
				h("select", { className: "dsh-btw-select", value: p[key], disabled, onChange: (e) => saveSetting(key, e.target.value) },
					h("option", { value: "none" }, "无"), h("option", { value: "recent" }, "最近对话"), h("option", { value: "on-demand" }, "按需搜索近期快照"), h("option", { value: "all" }, "全部对话")));
			const toggle = (key, label) => h("label", { style: { display: "block", margin: "10px 0" } },
				h("input", { type: "checkbox", checked: p[key], disabled, onChange: (e) => saveSetting(key, e.target.checked) }), " ", label);
			return h("div", { className: "dsh-btw-card", style: { padding: "14px" } },
				h("strong", null, "btw 设置"),
				context("askContextMode", "侧问默认上下文"),
				h("div", null, "侧问默认", h(ModelSelect, { value: modelValue(p.askModelMode, p.askProvider, p.askModel), disabled, onChange: (v) => saveModel("ask", v) })),
				h("p", null, "按需搜索只使用授权的近期文本快照，不是完整历史。"),
				context("tempContextMode", "临时聊天默认上下文"),
				h("div", null, "临时聊天默认", h(ModelSelect, { value: modelValue(p.tempModelMode, p.tempProvider, p.tempModel), disabled, onChange: (v) => saveModel("temp", v) })),
				toggle("showAskChip", "显示侧问按钮"), toggle("enableSlash", "启用 /btw"), toggle("showTempEntry", "显示临时聊天入口"),
				disabled ? h("p", { className: "dsh-btw-err" }, "设置不可写或尚未加载") : null,
				errors.error ? h("p", { className: "dsh-btw-err" }, errors.error) : null);
		}

		// ── plugin entry ───────────────────────────────────────────────
		function apply(ctx) {
			ctxRef.current = ctx;
			generation++;
			injectCss();
			const fibers = [];
			const bindSettings = (forms) => {
				try {
					const scope = forms?.get("btw");
					if (!scope) return () => {};
					settingsScope = scope;
					const unsubscribe = scope.subscribe(projectSettings);
					projectSettings();
					return () => { if (settingsScope === scope) settingsScope = null; unsubscribe?.(); };
				} catch { settingsScope = null; return () => {}; }
			};
			try {
				if (typeof ctx.inject === "function") fibers.push(ctx.inject(["configForms"], (scope) => bindSettings(scope.configForms)));
				else fibers.push(bindSettings(ctx.configForms));
			} catch { /* settings are optional */ }
			loadModels();
			if (typeof ctx.inject === "function") {
				// Cordis guards each Remote namespace independently of the root.
				try { fibers.push(ctx.inject(["remote", "remote.session", "connection"], (scope) => {
					historyRemote = scope.remote; historyConnection = scope.connection; clearHistory();
					const disposers = [scope.connection.state?.subscribe(() => { if (scope.connection.state.getSnapshot() !== "connected") clearHistory(); }), scope.connection.generation?.subscribe(() => clearHistory())];
					return () => { clearHistory(); historyRemote = null; historyConnection = null; for (const dispose of disposers) dispose?.(); };
				})); } catch { /* full-history service is optional */ }
				try { fibers.push(ctx.inject(["layout"], (scope) => { globalLayout = scope.layout; return () => { if (globalLayout === scope.layout) globalLayout = null; }; })); } catch { /* layout is optional */ }
				try { fibers.push(ctx.inject(["sidebarRight", "sidebarRightTabs"], (scope) => {
					const right = scope.sidebarRight;
					sidebar = right;
					const type = scope.sidebarRightTabs.register({ id: TAB_ID, kind: "btw-temp", title: () => "btw" });
					const seat = scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, inject: (sessionId) => ({ btwSessionId: sessionId }) }, BtwSidebarBody));
					return () => { if (sidebar === right) sidebar = null; if (typeof seat === "function") seat(); else seat?.dispose?.(); if (typeof type === "function") type(); else type?.dispose?.(); };
				})); } catch { /* sidebar is optional */ }
			}
			if (ctx.slots !== undefined) {
				const renderSettings = (props) => props?.view === "summary" ? "侧问与临时聊天设置" : h(BtwSettings);
				fibers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-btw" }, renderSettings)));
				fibers.push(ctx.slots.inject("plugins.row.config", () => ctx.slots.register({ name: "plugins.row.config", key: "dsh-btw#btw" }, renderSettings)));
				fibers.push(ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "btw-ask", order: 8 }, BtwAskPanel)));
				fibers.push(ctx.slots.inject("conversation.input.right", () => ctx.slots.register({ name: "conversation.input.right", id: "btw-trigger", order: 5 }, BtwTrigger)));
				fibers.push(ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "btw-temp", order: 5 }, BtwTempEntry)));
				fibers.push(ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: GLOBAL_PANEL }, BtwGlobalPanel)));
				fibers.push(ctx.slots.inject("conversation.header.leading", () => ctx.slots.register({ name: "conversation.header.leading" }, BtwGlobalEntry)));
				fibers.push(ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "btw", order: 30 }, BtwTempOverlay)));
			}
			ctx.effect(() => () => {
				// Start the same close barrier before releasing services. Its captured
				// connection also owns a child whose open reply arrives after unload.
				void closeTemp();
				generation++;
				resetAsk();
				clearHistory();
				for (const fiber of fibers) {
					try {
						const p = typeof fiber.dispose === "function" ? fiber.dispose() : fiber();
						if (p !== undefined && typeof p.catch === "function") p.catch(() => {});
					} catch { /* ignore */ }
				}
				temp.patch(emptyTemp());
				settingsScope = null;
				composerBridge = null;
				originSnapshot = null;
				sidebar = null;
				globalLayout = null;
				ctxRef.current = null;
			});
		}
		return { inject: ["slots"], apply };
	},
});