/**
 * dsh-btw — browser half (zero-build: hand-maintained source AND shipped
 * artifact, in the window.__ModuleLoader__ handoff format).
 *
 * One per-chat controller and disposable DSH child, presented as a fixed
 * composer-top small panel, floating small window, sidebar or fullscreen.
 * First send opens the child; all subsequent turns use its own retained history.
 * The user-facing modes remain small/sidebar/fullscreen. Minimize changes only
 * presentation and the chip continues the same live chat. X ends and cleans it.
 * The eager source bridge captures /btw drafts and authorized completed text;
 * optional controller/view/geometry/rendering modules load only on first use.
 *
 * All styling resolves against the host page's --dsw tokens with sensible
 * fallbacks; dark theme needs no special handling (the tokens flip).
 *
 * RPC envelope: { ok, value | error } over the dedicated `/btw` channel.
 *
 * DSH versions sibling chunks using this entry's revision, not each chunk's.
 * Keep these SHA-256 stamps current when changing a sibling so browsers cannot
 * reuse an immutable older chunk after a host restart. The test suite verifies
 * every stamp against the corresponding file.
 * client.controllers.js: c129bacf523f0882ea25cce36fda37fb594fd17d069ca7d6598f05311de7f205
 * client.geometry.js: fd530033d6912b1da98c008031b3d7f435869de658561a4dfcf89c21a2f9f43b
 * client.messages.js: a065422002f2aaeab8e066a6402285feba94b70a0683a9dd588202b762fbb4ff
 * client.settings.js: 9c380c78a6165f072b02597fb708ebff01a60a18e6b232b859bd5237e9be63af
 * client.views.js: 21f093a7050e538046ae145b2f337bac38ca4d70f8d095e73f6fdf42546a53dd
 */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	factory: (require) => {
		const React = require("react");
		const { useEffect, useRef, useReducer } = React;
		const h = React.createElement;

		const POLL_MS = 250;
		const NAME = "dsh-btw";

		// ── styles (injected once) ──────────────────────────────────────

		const CSS_ID = "@dsh-btw/client.css";
		const CSS = `
		[data-conversation-session],.dsh-btw-modal{--btw-temp-composer-stroke:rgba(124,127,134,.5);--btw-soft-edge:rgba(124,127,134,.26);--btw-soft-edge:color-mix(in srgb,var(--dsw-alias-label-primary,#16181d) 17%,transparent);}
		.dsh-btw-chip{height:28px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;flex:none;}
		.dsh-btw-chip:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.09));color:var(--dsw-alias-brand-text,#3964fe);}
		.dsh-btw-entry{height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;}
		.dsh-btw-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-entry svg{opacity:.75;}
		.dsh-btw-open-error{align-items:center;gap:4px;font-size:12px;}

		.dsh-btw-global-entry{display:none;position:absolute;inset-inline-end:28px;top:10px;z-index:2;-webkit-app-region:no-drag;}
		header:has([data-conversation-header-leading]):not(:has(nav)) .dsh-btw-global-entry,
		header:has([data-conversation-header-leading]):not(:has([data-btw-native-utility])) .dsh-btw-global-entry[data-btw-native-status],
		header:has([data-conversation-header-leading]) .dsh-btw-global-entry.dsh-btw-open-error{display:inline-flex;}
		header:has([data-conversation-header-corner] [data-sidebar-right-expand]) .dsh-btw-global-entry{inset-inline-end:64px;}
		.dsh-btw-dock{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,720px);margin:0 auto;padding:0 0 6px;}
		.dsh-btw-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-specific-input-major,#fff);border-radius:var(--dsw-radius-panel,24px);box-shadow:var(--dsw-shadow-lv2,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02));display:flex;flex-direction:column;overflow:hidden;font-family:var(--dsw-font-family,inherit);corner-shape:superellipse(1.5);}
		.dsh-btw-dock-loading{height:min(200px,50dvh);box-sizing:border-box;justify-content:center;}
		.dsh-btw-status{padding:4px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#57585a);}
		`;

		function injectCss(css = CSS, id = CSS_ID) {
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NAME;
			tag.dataset.pluginCss = id;
			tag.textContent = css;
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
		// ── Esc arbitration ─────────────────────────────────────────────
		// One document-level Escape for every btw surface. Focus does not have to
		// be inside a btw: when one is visible, Esc means "dismiss the btw I was
		// last using". Foreign menus, listboxes, dialogs, IME composition and
		// already-handled events keep their own Escape. The native temporary chat
		// page never registers here, so Esc can never destroy it.
		const escapeSurfaces = new Map();
		let escapeListening = false;
		function escapeTargetOf(event) {
			const surfaces = [...escapeSurfaces.values()];
			if (!surfaces.length) return undefined;
			const active = typeof document === "undefined" ? null : document.activeElement;
			const path = event.composedPath?.() ?? [];
			const owns = surface => {
				const root = surface.root();
				return Boolean(root) && (root.contains?.(event.target) || (active && root.contains?.(active)) || path.includes(root));
			};
			const focused = surfaces.find(owns);
			if (focused) return focused;
			return surfaces.sort((a, b) => (b.order?.() ?? 0) - (a.order?.() ?? 0))[0];
		}
		function onEscapeKey(e) {
			if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return;
			// A control that owns Escape itself keeps it.
			if (e.target?.closest?.("select,[role=menu],[role=listbox],[aria-expanded=true]")) return;
			const dialog = e.target?.closest?.("[role=dialog]");
			if (dialog && !/dsh-btw-(modal|card)/.test(String(dialog.className ?? ""))) return;
			const surface = escapeTargetOf(e);
			if (!surface) return;
			e.preventDefault?.();
			surface.close();
		}
		function registerEscapeSurface(surface) {
			escapeSurfaces.set(surface.id, surface);
			if (!escapeListening && typeof document !== "undefined") { document.addEventListener("keydown", onEscapeKey); escapeListening = true; }
			return () => {
				if (escapeSurfaces.get(surface.id) === surface) escapeSurfaces.delete(surface.id);
				if (!escapeSurfaces.size && escapeListening) { document.removeEventListener("keydown", onEscapeKey); escapeListening = false; }
			};
		}

		/** Tiny observable store: mutate + emit, subscribe via useReducer. */
		function createStore(initial, notify) {
			const state = { ...initial };
			const listeners = new Set();
			const patch = (fields) => {
				Object.assign(state, fields);
				notify?.();
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
		const DEFAULTS = { askContextMode: "recent", tempContextMode: "none", askModelMode: "default", tempModelMode: "default", askProvider: "", askModel: "", tempProvider: "", tempModel: "", showAskChip: true, enableSlash: true, showTempEntry: true, showGlobalTempEntry: true, askPresentation: "dock", chipPresentation: "dock", slashPresentation: "dock", headerPresentation: "sidebar", tempWindowPinned: false, tempRememberPosition: true };
		const prefs = createStore(DEFAULTS);
		const catalog = createStore({ status: "loading", providers: [], error: "" });
		let settingsScope = null, modelsTask = null;
		function projectSettings() {
			const snap = settingsScope?.getSnapshot();
			const value = snap?.status === "ready" && snap.value && typeof snap.value === "object" ? snap.value : {};
			const next = { ...DEFAULTS };
			for (const key of Object.keys(next)) if (typeof value[key] === typeof next[key]) next[key] = value[key];
			for (const key of ["askModelMode", "tempModelMode"]) if (["host", "current"].includes(next[key])) next[key] = "default";
			const validPosition = position => ["dock", "sidebar", "overlay"].includes(position);
			// Preserve the previous shared choice for each composer entry until
			// that entry gets its own setting. New writes never change the legacy key.
			const legacy = validPosition(next.askPresentation) ? next.askPresentation : DEFAULTS.askPresentation;
			for (const key of ["chipPresentation", "slashPresentation"]) if (!validPosition(value[key])) next[key] = legacy;
			if (!validPosition(next.headerPresentation)) next.headerPresentation = DEFAULTS.headerPresentation;
			// One shared context and model. Stored temp* may still differ until the next save;
			// the running client follows ask* so the card and both seats agree.
			next.tempContextMode = next.askContextMode;
			next.tempModelMode = next.askModelMode;
			next.tempProvider = next.askProvider;
			next.tempModel = next.askModel;
			prefs.patch(next);
		}
		function loadModels() {
			if (unloading) return Promise.resolve();
			if (modelsTask) return modelsTask;
			const epoch = activationEpoch;
			catalog.patch({ status: "loading", error: "" });
			const task = rpc("models", {}).then((value) => {
				if (unloading || epoch !== activationEpoch) return;
				if (!Array.isArray(value?.providers)) throw new Error("模型列表格式无效");
				const providers = value.providers.filter((p) => p && typeof p.id === "string" && Array.isArray(p.models)).map((p) => ({
					id: p.id, models: p.models.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id })),
				}));
				catalog.patch({ status: "ready", providers, error: "" });
			}).catch((e) => {
				if (unloading || epoch !== activationEpoch) return;
				const error = msg(e);
				catalog.patch({ status: "error", providers: [], error: /^unknown method:\s*models$/i.test(error.trim())
					? "宿主仍运行旧版 btw，请重启 dsh web 并刷新页面后重试" : error });
			}).finally(() => { if (modelsTask === task) modelsTask = null; });
			modelsTask = task;
			return task;
		}
		const modelKey = (provider, model) => JSON.stringify([provider, model]);
		function modelValue(mode, provider, model) {
			return mode === "custom" ? modelKey(provider, model) : ["host", "current", "default"].includes(mode) ? "default" : mode;
		}
		function parseModel(value) {
			if (["default", "host", "current"].includes(value)) return { mode: "default" };
			try { const v = JSON.parse(value); if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string" && x)) return { mode: "custom", model: { provider: v[0], model: v[1] } }; } catch { /* invalid selection */ }
			return { mode: "invalid" };
		}
		const loadModelOptions = (choice, sourceId) => rpc("modelOptions", { modelMode: resolveModelMode(choice, sourceId), ...(choice.model ? { model: choice.model } : {}), ...(sourceId ? { parentSessionId: sourceId } : {}) });
		const resolveModelMode = (choice, parentSessionId) => choice.mode === "default" ? (parentSessionId ? "current" : "host") : choice.mode;

		// A short-lived entry intent, never a second chat/message owner. Once a
		// source claims it, only its ordinary controller owns draft/history/child.
		const dockIntent = createStore({ requested: false, sourceId: null, draft: "", presentation: "dock" });
		function requestAsk(sourceId = null, draft = "", presentation = prefs.state.chipPresentation) {
			if (unloading) return;
			// A ready, matching source needs no post-paint intent handoff. In
			// particular, reopening a minimized chat must not flash a loading row.
			const source = originSnapshot;
			if (ui && source?.sessionId === sourceId && !source.removed) {
				if (dockIntent.state.requested) cancelDockIntent();
				openAsk(source.cwd, sourceId, draft, source.text, presentation);
				return;
			}
			dockIntent.patch({ requested: true, sourceId, draft, presentation });
			void loadUI();
		}
		function cancelDockIntent(sourceId) {
			if (sourceId === undefined || dockIntent.state.sourceId === sourceId) dockIntent.patch({ requested: false, sourceId: null, draft: "" });
			for (const [key, entry] of pendingEntries) if (entry.presentation === "dock" && (sourceId === undefined || entry.originId === sourceId)) pendingEntries.delete(key);
			changedTemp();
		}

		/** Authorized, already-loaded completed source text for a child prefix. */
		function transcriptOf(snap) {
			if (!Array.isArray(snap?.nodes)) return "";
			const parts = [], limit = 48_000;
			let size = 0, i = snap.nodes.length - 1, hasEntry = false;
			const prepend = (text) => {
				if (size >= limit) return;
				const suffix = text.slice(-Math.min(limit - size, text.length));
				parts.push(suffix); size += suffix.length;
			};
			const content = (blocks, key, label) => {
				if (!Array.isArray(blocks) || !blocks.some(block => block?.[key] === "text" && typeof block.text === "string" && block.text.length)) return false;
				if (hasEntry) prepend("\n\n");
				hasEntry = true;
				for (let j = blocks.length - 1; j >= 0 && size < limit; j--) {
					const block = blocks[j];
					if (block?.[key] === "text" && typeof block.text === "string") prepend(block.text);
				}
				prepend(label);
				return true;
			};
			// Only the loaded recent window is authorized here. Walk its completed
			// evidence backwards and stop once the final 48k suffix is full; never
			// prefix-clip an individual message or join unbounded history first.
			for (; i >= 0 && size < limit; i--) {
				const node = snap.nodes[i];
				if (node?.kind === "user") content(node.content, "type", "User: ");
				else if (node?.kind === "assistant") content(node.blocks, "kind", "Assistant: ");
				else if (node?.kind === "tool-result") {
					const pending = [{ tool: node, body: false }];
					while (pending.length && size < limit) {
						const { tool, body } = pending.pop();
						if (tool?.kind !== "tool-result") continue;
						if (body) { content(tool.content, "type", "Tool: "); continue; }
						pending.push({ tool, body: true });
						// Stack visits last child first, then the root's own text.
						if (Array.isArray(tool.subCalls)) for (const child of tool.subCalls) pending.push({ tool: child, body: false });
					}
				}
			}
			return parts.reverse().join("");
		}

		// Complete recorded text uses the cold-safe Remote events API, never a
		// projection, activation or surface fold (which would erase compacted text).
		const ALL_LIMIT = 1024 * 1024, ALL_TTL = 60_000, SERIALIZER_VERSION = 1;
		const allCache = new Map(), allReads = new Map(), allHeads = new Map(), contextSearches = new Set();
		let historyRemote = null, historyConnection = null, historyEpoch = 0;
		const utf8Size = (text) => new TextEncoder().encode(text).length;
		function clearHistory(sourceId) {
			historyEpoch++;
			for (const search of contextSearches) if (!sourceId || search.sourceId === sourceId) search.abort.abort();
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

		// Search only committed user/assistant text from the bound source.
		// Page backwards at one exact cut and keep only the four best candidates.
		async function searchContext(sourceId, question, signal) {
			const connection = ctxRef.current?.get?.("connection"), remote = historyRemote;
			if (!sourceId || !remote?.session?.events || !connection || connection !== historyConnection) throw new Error("来源对话读取服务不可用");
			const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
			const query = question.slice(0, 4096).toLowerCase();
			const atoms = query.match(/[a-z\d_./:-]{2,80}(?=[^a-z\d_./:-]|$)/g) || [];
			const words = segmenter ? [...segmenter.segment(query)].filter(part => part.isWordLike).map(part => part.segment)
				: query.match(/[\p{L}\p{N}_]+/gu) || [];
			const common = new Set(["什么", "为什么", "怎么", "怎样", "如何", "哪里", "哪些", "一下", "这个", "那个", "之前", "刚才", "是否", "一个", "我们", "请问", "the", "a", "an", "is", "to", "of", "for", "how", "why", "what", "where", "was", "were", "it", "did", "we", "and", "in", "can", "this", "that", "do", "you", "about"]);
			const terms = [...new Set([...atoms, ...words].map(word => word.replace(/^[./:-]+|[./:-]+$/g, ""))
				.filter(word => word.length >= 2 && word.length <= 80 && !common.has(word)))].slice(0, 18);
			const search = { sourceId, abort: new AbortController() };
			const { abort } = search;
			const check = () => {
				const state = connection.state?.getSnapshot();
				if (abort.signal.aborted || ctxRef.current?.get?.("connection") !== connection || historyConnection !== connection || historyRemote !== remote
					|| state !== undefined && state !== "connected") throw new Error("来源对话读取已取消或连接已断开");
			};
			const abortRead = () => abort.abort();
			if (signal?.aborted) abortRead(); else signal?.addEventListener("abort", abortRead, { once: true });
			contextSearches.add(search);
			const deadline = setTimeout(abortRead, 10_000);
			let cancel;
			try {
				const cancelled = new Promise((_, reject) => {
					cancel = () => reject(new Error("来源对话读取已取消或超时"));
					abort.signal.addEventListener("abort", cancel, { once: true });
				});
				let cut, expected, limited = false, recordsLeft = 8192, textLeft = 2 * 1024 * 1024;
				const best = [], visible = [];
				searchPages: for (let pages = 0; pages < 16; pages++) {
					check();
					const result = await Promise.race([remote.session.events({
						address: { kind: "session", sessionId: sourceId }, maxMessages: 64,
						...(cut === undefined ? {} : { throughSeq: cut, beforeSeq: expected + 1 }),
					}, abort.signal), cancelled]);
					check();
					if (!result?.ok) throw new Error(result?.error?.message || "读取来源对话失败");
					const page = result.value;
					if (!Number.isSafeInteger(page?.cursor) || page.cursor < -1 || !Array.isArray(page.records) || typeof page.hasMore !== "boolean") throw new Error("来源对话分页格式无效");
					if (cut === undefined) expected = cut = page.cursor;
					if (page.cursor !== cut || !page.records.length && expected >= 0) throw new Error("来源对话切点改变或记录不完整");
					for (let i = page.records.length - 1; i >= 0; i--) {
						if (recordsLeft-- === 0 || textLeft === 0) { limited = true; break searchPages; }
						const record = page.records[i], event = record?.event;
						if (record?.type !== "event" || event?.seq !== expected || expected < 0) throw new Error("来源对话事件序号不连续");
						expected--;
						// DSH logs injected runtime instructions as user-role events as
						// well. Only actual user prompts and completed assistant replies
						// may become either ranked excerpts or model-readable neighbors.
						const role = event.type === "user/message" && event.data?.source?.kind === "user" ? "user"
							: event.type === "assistant/message" && event.data?.interrupted !== true ? "assistant" : null;
						if (!role || event.surfaceOp && event.surfaceOp !== "append") continue;
						const content = (role === "user" ? event.data : event.data?.message)?.content;
						if (!Array.isArray(content)) continue;
						let candidates = null, preview = "";
						for (const block of content.slice(0, 32)) {
							if (block?.type !== "text" || typeof block.text !== "string") continue;
							const body = block.text.slice(0, Math.min(98_304, textLeft));
							textLeft -= body.length;
							if (preview.length < 800) preview += body.trim().slice(0, 800 - preview.length);
							const lower = body.toLowerCase();
							for (const term of terms) {
								const match = lower.indexOf(term);
								if (match < 0) continue;
								const start = Math.max(0, match - 220), stop = Math.min(body.length, start + 798);
								const window = lower.slice(start, stop);
								let score = 0;
								for (const t of terms) if (window.includes(t)) score += 1 + Math.min(t.length, 20) + (/[./:_-]/.test(t) ? 8 : 0);
								if (!candidates || candidates.score < score) candidates = { seq: event.seq, role, score,
									text: ((start ? "…" : "") + body.slice(start, stop) + (stop < block.text.length ? "…" : "")).toWellFormed().replaceAll("\u0000", "") };
							}
						}
						if (preview) visible.push({ seq: event.seq, role, text: preview.toWellFormed().replaceAll("\u0000", "").trim() });
						if (candidates) {
							best.push(candidates);
							best.sort((a, b) => b.score - a.score || b.seq - a.seq);
							if (best.length > 4) best.pop();
						}
					}
					if (page.hasMore !== (expected >= 0)) throw new Error("来源对话分页边界无效");
					limited = page.hasMore;
					if (!limited || !terms.length) break;
				}
				const excerpts = best.sort((a, b) => a.seq - b.seq).map(({ score, ...item }) => item);
				const anchors = new Set(excerpts.map(item => item.seq));
				// Build the window from the same authorized read, in visible-message
				// order. The host withholds these texts until the model asks.
				const neighbors = excerpts.flatMap(({ seq }) => {
					const index = visible.findIndex(item => item.seq === seq);
					if (index < 0) return [];
					const items = [visible[index + 1], visible[index - 1]].filter(item => item?.text && !anchors.has(item.seq));
					return items.length ? [{ anchor: seq, excerpts: items }] : [];
				});
				return { sessionId: sourceId, throughSeq: cut, limited, excerpts, ...(neighbors.length ? { neighbors } : {}) };
			} finally {
				clearTimeout(deadline);
				abort.signal.removeEventListener("abort", cancel);
				signal?.removeEventListener("abort", abortRead);
				contextSearches.delete(search);
			}
		}

		// ── temp chat store + actions ──────────────────────────────────

		const emptyTemp = () => ({
			phase: "idle", sessionId: null, originId: null, cwd: null, messages: [], busy: false, error: null, seq: 0,
			presentation: "hidden", draft: "", selecting: false, selected: [], insertionError: "", insertionNotice: "", contextMode: "none", modelChoice: "default", transcript: "", width: 740, height: 640, x: null, y: null, pinned: false, geometryKey: "",
		});
		let sidebar = null, globalLayout = null, composerBridge = null, originSnapshot = null;
		const TAB_ID = "dsh-btw/temp";

		// Native source-free sessions are owned separately from project children.
		const nativeState = createStore({ id: null, phase: "idle", error: "" });
		let nativeServices = null, nativeWorkspaces = null, nativeIntent = null, nativeScheduled = false, lastNativeWorkspace = null, nativePresetBridge = null;
		const nativeCleanup = new Map();
		const nativeDraftHandoff = createStore({ pending: null });
		const nativeDraftSources = new Map();

		function plainNativeDraft(id, input) {
			// rc.5's input snapshot omits quote/command nodes. Check the
			// composer markers as well, so a text-only handoff cannot flatten them.
			if (input?.phase !== "plain" || typeof input.draft !== "string" || input.attachmentIds?.length
				|| input.imageIds?.length || input.occurrences?.length
				|| document.querySelector(`[data-conversation-session=${JSON.stringify(id)}] [data-composer-input] :is([data-composer-quote],[data-composer-command])`)) return null;
			return input.draft;
		}
		function captureNativeDraft(id) {
			return id ? plainNativeDraft(id, nativeDraftSources.get(id)?.input) : null;
		}
		function clearNativeDraftHandoff(item = nativeDraftHandoff.state.pending) {
			if (!item || nativeDraftHandoff.state.pending !== item) return;
			clearTimeout(item.timer);
			item.dispose();
			nativeDraftHandoff.patch({ pending: null });
		}
		function handoffNativeDraft(owner, id, text, expected, opening = false) {
			if (text === null || text === "" && expected === "") return;
			const { services, connection } = owner;
			clearNativeDraftHandoff();
			const item = { id, owner, services, connection, text, expected, opening };
			const onNavigate = () => {
				Promise.resolve().then(() => {
					if (nativeDraftHandoff.state.pending !== item) return;
					const selected = selectedNative(services.sessions);
					if (services.layout.panelInfo.getSnapshot().activePanelId !== null || selected !== id && selected !== NATIVE_AMBIGUOUS) clearNativeDraftHandoff(item);
				});
			};
			const sessionDispose = services.sessions.list.subscribe(onNavigate);
			const panelDispose = services.layout.panelInfo.subscribe(onNavigate);
			item.dispose = () => { sessionDispose?.(); panelDispose?.(); };
			item.timer = setTimeout(() => clearNativeDraftHandoff(item), 5000);
			item.timer?.unref?.();
			nativeDraftHandoff.patch({ pending: item });
		}
		const NATIVE_RETRY_DELAYS = [250, 1000, 3000];

		const NATIVE_AMBIGUOUS = Symbol("ambiguous-mainview");
		const NATIVE_REASSERT_LIMIT = 3;
		function selectedNative(sessions) {
			const rows = sessions.list.getSnapshot()?.byId;
			if (!rows || typeof rows !== "object") throw new Error("宿主会话导航状态不可用");
			const ids = Object.keys(rows).filter(id => rows[id]?.retainedBy?.mainView > 0);
			// Mid-navigation projections can briefly retain two mainView rows. Wait
			// for the committed state instead of killing the mode on transient noise.
			return ids.length > 1 ? NATIVE_AMBIGUOUS : ids[0] || null;
		}
		function nativeSelection(intent) {
			if (intent.owner?.retainInfo.getSnapshot()?.retainedBy?.mainView > 0) return intent.owner.id;
			const current = selectedNative(intent.services.sessions);
			return nativeCleanup.has(current) ? null : current;
		}
		// Public host projections, including a blank selected by the native picker.
		// An initially empty list waits for mainView selection, not registration alone.
		// The host creates its preset seat lazily for each Session. Keep a short,
		// inert visual copy until the new seat renders the same mode; never invent
		// a mode or intercept input, and drop the copy on navigation/user action.
		function bridgeNativePreset(sourceId, targetId) {
			nativePresetBridge?.();
			if (typeof sourceId !== "string" || typeof targetId !== "string" || sourceId === targetId
				|| typeof MutationObserver !== "function" || !document.body?.appendChild) return;
			let clone, observer, timer, stopped = false;
			const stop = () => {
				if (stopped) return;
				stopped = true;
				observer?.disconnect(); clearTimeout(timer);
				document.removeEventListener("pointerdown", stop, true);
				document.removeEventListener("keydown", stop, true);
				clone?.remove();
				if (nativePresetBridge === stop) nativePresetBridge = null;
			};
			try {
				const findMode = id => {
					const root = document.querySelector(`[data-conversation-session=${JSON.stringify(id)}]`);
					const card = root?.querySelector?.("[data-composer-card]");
					if (!card) return;
					const cardTop = card.getBoundingClientRect().top;
					const menus = [...root.querySelectorAll('button[aria-haspopup="menu"]')].filter(button => {
						const rect = button.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0 && rect.bottom <= cardTop && rect.bottom >= cardTop - 100;
					});
					const workspace = menus.find(button => button.hasAttribute("aria-label"));
					if (!workspace) return;
					const top = workspace.getBoundingClientRect().top;
					return menus.find(button => button !== workspace && Math.abs(button.getBoundingClientRect().top - top) < 2);
				};
				const source = findMode(sourceId);
				if (!source || !source.textContent?.trim()) return;
				const rect = source.getBoundingClientRect(), label = source.textContent.trim();
				clone = source.cloneNode(true);
				clone.removeAttribute("id");
				for (const node of clone.querySelectorAll("[id]")) node.removeAttribute("id");
				clone.setAttribute("aria-hidden", "true"); clone.inert = true;
				Object.assign(clone.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, boxSizing: "border-box", margin: "0", pointerEvents: "none", zIndex: "2147483000" });
				nativePresetBridge = stop;
				document.body.appendChild(clone);
				observer = new MutationObserver(() => { if (findMode(targetId)?.textContent?.trim() === label) stop(); });
				observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
				document.addEventListener("pointerdown", stop, true);
				document.addEventListener("keydown", stop, true);
				timer = setTimeout(stop, 1500);
			} catch { stop(); }
		}
		function sessionPreset(row) {
			const preset = row?.projectionValues?.agentPreset;
			return typeof preset === "string" && preset.trim() ? preset : undefined;
		}
		function workspaceForSession(items, rows, current) {
			const cwd = rows[current]?.cwd;
			return (cwd && items.find(item => item.path === cwd)) || items.find(item => item.sessionIds.includes(current));
		}
		function selectedNativeWorkspace(items, rows, current, preferred) {
			const selected = current && workspaceForSession(items, rows, current);
			if (selected) return selected.workspaceId;
			if (preferred && items.some(item => item.workspaceId === preferred)) return preferred;
			let id, latest = Number.NEGATIVE_INFINITY;
			for (const item of items) {
				let time = Number.NEGATIVE_INFINITY;
				for (const sid of item.sessionIds) if (rows[sid]) time = Math.max(time, rows[sid].updatedAt);
				if (time === Number.NEGATIVE_INFINITY) time = Date.parse(item.createdAt);
				if (id === undefined || time > latest) { id = item.workspaceId; latest = time; }
			}
			return id;
		}
		function scheduleNative() {
			if (nativeScheduled || unloading) return;
			nativeScheduled = true;
			// Native workspace navigation publishes several synchronous projections.
			// Observe their committed state instead of canceling the picker mid-action.
			Promise.resolve().then(() => {
				nativeScheduled = false;
				if (nativeIntent && !unloading) reconcileNative(nativeIntent);
			});
		}
		function cancelNativeRequest(intent, request) {
			request.cancelled = true;
			request.reference?.release(); request.reference = null;
			if (intent.request === request) intent.request = null;
			if (request.owner) void closeNative(request.owner);
		}
		function stopNativeIntent(intent, restoreWorkspace = false) {
			if (!intent || intent.stopped) return;
			intent.stopped = true;
			intent.navigationCleanup?.();
			for (const dispose of intent.subscriptions) dispose?.();
			for (const request of intent.requests) cancelNativeRequest(intent, request);
			const owner = intent.owner;
			intent.owner = null;
			if (nativeIntent === intent) {
				nativeIntent = null;
				nativeState.patch({ id: null, phase: "idle", error: "" });
			}
			if (owner && nativeDraftHandoff.state.pending?.owner === owner) clearNativeDraftHandoff();
			if (owner) {
				if (restoreWorkspace) returnToWorkspace(owner);
				else void closeNative(owner);
			}
		}
		function watchOwnedNavigation(intent, owner, signal) {
			intent.navigationCleanup?.();
			intent.navigation = signal;
			intent.reopenedOwned = false;
			// Aborting the token only starts a navigation. DSH commits by retaining
			// the next main view before releasing the previous one. If it reused
			// our blank, the same ID briefly holds two mainView references. Observe
			// that edge synchronously, then reconcile after the commit.
			const dispose = owner.retainInfo.subscribe?.(() => {
				if (nativeIntent !== intent || intent.owner !== owner || unloading) return;
				if (signal?.aborted && owner.retainInfo.getSnapshot()?.retainedBy?.mainView > 1) {
					intent.reopenedOwned = true;
					scheduleNative();
				}
			});
			intent.navigationCleanup = dispose;
		}
		function returnToWorkspace(owner) {
			const { services } = owner;
			if (unloading || nativeServices !== services || !(owner.retainInfo?.getSnapshot?.()?.retainedBy?.mainView > 0)
				|| services.layout.panelInfo.getSnapshot().activePanelId !== null) { void closeNative(owner); return; }
			try {
				const rows = services.sessions.list.getSnapshot().byId;
				if (selectedNative(services.sessions) !== owner.id) { void closeNative(owner); return; }
				const items = nativeWorkspaces?.list?.getSnapshot()?.items ?? [];
				const preset = sessionPreset(rows[owner.id]) ?? owner.agentPreset;
				const draft = captureNativeDraft(owner.id);
				const reusable = owner.returnId && rows[owner.returnId]?.blank === true
					&& workspaceForSession(items, rows, owner.returnId)?.workspaceId === owner.workspaceId;
				if (reusable && (!preset || sessionPreset(rows[owner.returnId]) === preset)) {
					services.layout.beginNavigation();
					bridgeNativePreset(owner.id, owner.returnId);
					services.workspace.openSession(owner.returnId);
					handoffNativeDraft(owner, owner.returnId, draft, owner.draftCopied ? owner.sourceDraft : "");
					void closeNative(owner);
					return;
				}
				if (typeof services.sessions.create !== "function") { void closeNative(owner); return; }
				// Keep ownership during the replacement; a later navigation or plugin
				// unload may still retire this owner immediately.
				nativeCleanup.set(owner.id, owner);
				const navigation = services.layout.beginNavigation();
				let timer;
				const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); });
				Promise.race([Promise.resolve().then(() => services.sessions.create({ workspaceId: owner.workspaceId,
					...(reusable ? { sessionId: owner.returnId } : {}), ...(preset ? { agentPreset: preset } : {}) })), timeout])
					.then(id => {
						if (id && !navigation.aborted && !unloading && !nativeIntent && !owner.retired && nativeServices === services
							&& owner.retainInfo.getSnapshot()?.retainedBy?.mainView > 0 && selectedNative(services.sessions) === owner.id
							&& services.layout.panelInfo.getSnapshot().activePanelId === null) {
							bridgeNativePreset(owner.id, id);
							services.workspace.openSession(id);
							handoffNativeDraft(owner, id, draft, id === owner.returnId && owner.draftCopied ? owner.sourceDraft : "");
						}
					})
					.catch(error => console.warn("btw: normal workspace conversation could not be restored", error))
					.finally(() => { clearTimeout(timer); void closeNative(owner); });
			} catch (error) {
				console.warn("btw: normal workspace conversation could not be restored", error);
				void closeNative(owner);
			}
		}
		async function closeNative(owner) {
			if (!owner || owner.finished || owner.closeTask) return owner?.closeTask;
			const handoff = nativeDraftHandoff.state.pending;
			if (handoff?.opening && handoff.owner === owner) clearNativeDraftHandoff(handoff);
			clearTimeout(owner.retryTimer); owner.retryTimer = null;
			if (!owner.retired) {
				owner.retired = true;
				owner.style?.remove?.(); owner.release?.(); owner.release = null;
				nativeCleanup.set(owner.id, owner);
			}
			owner.closeTask = Promise.resolve().then(async () => {
				try {
					// Public navigation dismisses only our current native view. Record
					// removal is independent background work, never a foreground phase.
					let exitError;
					try {
						if (!unloading && nativeServices === owner.services && owner.retainInfo?.getSnapshot?.()?.retainedBy?.mainView > 0
							&& owner.services.layout.panelInfo.getSnapshot().activePanelId === null) {
							await owner.workspace.archiveSession(owner.id, { stopActivity: true });
						}
					} catch (error) { exitError = error; }
					// The host client merges the workspace echo itself. Wait for it
					// before detaching so a late response cannot put this ID back.
					await owner.workspaceEcho;
					const value = await rpc("nativeClose", { sessionId: owner.id }, owner.connection);
					if (value?.burned !== true) throw new Error("临时会话未确认安全清理");
					owner.finished = true; nativeCleanup.delete(owner.id);
					if (exitError) console.warn("btw: native view dismissal did not complete", exitError);
				} catch (error) {
					owner.lastError = msg(error);
					const delay = NATIVE_RETRY_DELAYS[owner.retries || 0];
					owner.retries = (owner.retries || 0) + 1;
					if (!unloading && delay !== undefined) {
						owner.retryTimer = setTimeout(() => { owner.retryTimer = null; void closeNative(owner); }, delay);
						owner.retryTimer?.unref?.();
					} else console.warn("btw: background record removal is pending; recovery evidence retained", error);
				} finally { owner.closeTask = null; }
			});
			return owner.closeTask;
		}
		function nativeRequestCurrent(intent, request) {
			return !unloading && nativeIntent === intent && !intent.stopped && !request.cancelled && intent.request === request
				&& intent.target?.workspaceId === request.workspaceId;
		}
		async function confirmNativeWorkspace(workspaces, owner) {
			const hasMembership = () => workspaces.list.getSnapshot().items.some(item =>
				item.workspaceId === owner.workspaceId && item.sessionIds.includes(owner.id));
			if (hasMembership()) return;
			// rc.5 Windows Desktop can miss the attachment in the Workspace
			// follow stream. The public move-to-self is a no-op on the host;
			// its authoritative echo updates DSH's own Workspace projection.
			// Do not reorder real sessions or assign a fake membership.
			const echo = workspaces.insertSessionBefore(owner.workspaceId, owner.id, owner.id);
			owner.workspaceEcho = echo.then(() => {}, () => {});
			let timer;
			try {
				await Promise.race([
					echo,
					new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("等待宿主工作区同步超时")), 6000); }),
				]);
				if (!hasMembership()) throw new Error("宿主未同步临时会话的工作区归属");
			} finally { clearTimeout(timer); }
		}
		async function createNative(intent, target) {
			const { services, connection } = intent;
			const request = { workspaceId: target.workspaceId, cancelled: false, owner: null, reference: null };
			intent.request = request; intent.requests.add(request);
			nativeState.patch({ id: null, phase: "opening", error: "" });
			try {
				const rows = services.sessions.list.getSnapshot().byId;
				const existing = new Set(Object.keys(rows));
				const agentPreset = intent.agentPreset ?? sessionPreset(rows[target.current]);
				const returnId = target.current && rows[target.current]?.blank === true
					&& workspaceForSession(intent.workspaces.list.getSnapshot().items, rows, target.current)?.workspaceId === target.workspaceId ? target.current : null;
				request.reference = target.current ? services.sessions.retain(target.current, { source: "controllerOperation" }) : null;
				const value = await rpc("nativeOpen", { workspaceId: request.workspaceId, ...(agentPreset ? { agentPreset } : {}) }, connection);
				if (typeof value?.sessionId !== "string" || !value.sessionId || existing.has(value.sessionId) || nativeCleanup.has(value.sessionId)) throw new Error("临时会话创建结果无效或与已有会话冲突");
				const reference = request.reference; request.reference = null;
				const owner = request.owner = { id: value.sessionId, workspaceId: request.workspaceId, returnId, agentPreset, services, workspace: services.workspace, sessions: services.sessions,
					connection, release: () => reference?.release(), retainInfo: null };
				// Own the ID before asking the client catalog for its reference view.
				owner.retainInfo = services.sessions.retainInfo(value.sessionId);
				if (nativeIntent === intent) reconcileNative(intent);
				if (!nativeRequestCurrent(intent, request)) { void closeNative(owner); return; }
				if (!services.sessions.list.getSnapshot().byId[owner.id] && typeof services.sessions.refresh === "function") await services.sessions.refresh();
				if (nativeIntent === intent) reconcileNative(intent);
				if (!nativeRequestCurrent(intent, request)) { void closeNative(owner); return; }
				if (window.location?.protocol === "dsh-app:"
					&& /^Win/.test(window.navigator?.userAgentData?.platform ?? window.navigator?.platform ?? "")
					&& typeof intent.workspaces.insertSessionBefore === "function") {
					if (value.workspaceId !== owner.workspaceId) throw new Error("宿主返回了不同的临时会话工作区");
					await confirmNativeWorkspace(intent.workspaces, owner);
					if (nativeIntent === intent) reconcileNative(intent);
					if (!nativeRequestCurrent(intent, request)) { void closeNative(owner); return; }
				}
				const style = owner.style = document.createElement("style"); style.dataset.plugin = NAME;
				const root = `[data-conversation-session=${JSON.stringify(owner.id)}]`;
				style.textContent = `${root} :is([data-composer-card],[data-message-bubble]){position:relative;}
					${root} :is([data-composer-card],[data-message-bubble])::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;corner-shape:inherit;}
					${root} [data-composer-card]::after{border:2px dashed var(--btw-temp-composer-stroke);}
					${root} [data-message-bubble]::after{box-shadow:inset 0 0 0 1px var(--btw-soft-edge);}`;
				document.head.appendChild(style);
				// Sample just before navigation so typing during nativeOpen is kept.
				// Do not clear the source on entry: a failed or canceled open can
				// never destroy the ordinary composer draft.
				owner.sourceDraft = !intent.entered && target.current && selectedNative(services.sessions) === target.current
					&& workspaceForSession(intent.workspaces.list.getSnapshot().items, services.sessions.list.getSnapshot().byId, target.current)?.workspaceId === owner.workspaceId
					? captureNativeDraft(target.current) : null;
				intent.owner = owner;
				services.layout.beginNavigation();
				bridgeNativePreset(target.current, owner.id);
				services.workspace.openSession(owner.id);
				if (!nativeRequestCurrent(intent, request)) { void closeNative(owner); return; }
				if (!(owner.retainInfo.getSnapshot()?.retainedBy?.mainView > 0)) {
					// The picker's blank commit can land between navigation and this
					// read; assert the owned view once more before failing the attempt.
					services.layout.beginNavigation();
					services.workspace.openSession(owner.id);
					if (!(owner.retainInfo.getSnapshot()?.retainedBy?.mainView > 0)) throw new Error("宿主未打开临时会话");
				}
				intent.entered = true;
				// openSession reveals the conversation via selectPanel(null), which
				// aborts the layout signal. Own a fresh token after that commit.
				watchOwnedNavigation(intent, owner, services.layout.beginNavigation());
				nativeState.patch({ id: owner.id, phase: "active" });
				handoffNativeDraft(owner, owner.id, owner.sourceDraft, "", true);
			} catch (error) {
				if (request.owner) {
					if (intent.owner === request.owner) intent.owner = null;
					void closeNative(request.owner);
				}
				if (nativeRequestCurrent(intent, request)) {
					console.warn("btw: native temporary conversation did not start", error);
					intent.failed = request.workspaceId;
					nativeState.patch({ id: null, phase: "error", error: msg(error) });
				}
			} finally {
				request.reference?.release(); request.reference = null;
				intent.requests.delete(request);
				if (intent.request === request) intent.request = null;
				scheduleNative();
			}
		}
		function reconcileNative(intent) {
			if (unloading || nativeIntent !== intent || intent.stopped) return;
			try {
				const services = nativeServices, workspaces = nativeWorkspaces, connection = ctxRef.current?.get?.("connection");
				if (!services || !workspaces?.list?.getSnapshot || !connection?.rpc?.call) {
					if (intent.services) stopNativeIntent(intent);
					return;
				}
				if (!intent.services) {
					if (!services.workspace?.openSession || !services.workspace.archiveSession || !services.sessions?.list?.subscribe
						|| typeof services.sessions.retainInfo !== "function" || !services.layout?.beginNavigation || !services.layout.panelInfo?.subscribe) {
						throw new Error("宿主缺少原生会话导航能力");
					}
					Object.assign(intent, { services, workspaces, connection, epoch: activationEpoch });
					intent.preferred = lastNativeWorkspace?.services === services && lastNativeWorkspace.connection === connection ? lastNativeWorkspace.id : undefined;
					intent.subscriptions.push(services.sessions.list.subscribe(scheduleNative), services.layout.panelInfo.subscribe(scheduleNative), workspaces.list.subscribe?.(scheduleNative));
				} else if (services !== intent.services || workspaces !== intent.workspaces || connection !== intent.connection || intent.epoch !== activationEpoch) {
					stopNativeIntent(intent); return;
				}
				if (services.layout.panelInfo.getSnapshot().activePanelId !== null) { stopNativeIntent(intent); return; }
				const snapshot = workspaces.list.getSnapshot(), listing = services.sessions.list.getSnapshot();
				if (snapshot.phase !== "ready" || listing.phase !== undefined && listing.phase !== "ready") return;
				const current = nativeSelection(intent), rows = listing.byId;
				if (current === NATIVE_AMBIGUOUS) return;
				if (!intent.sourceSet) { intent.source = current; intent.sourceSet = true; }
				if (intent.owner && current === intent.owner.id) {
					if (intent.reopenedOwned && selectedNative(services.sessions) === current) stopNativeIntent(intent, true);
					return;
				}
				// DSH uses the same navigation signal for New Session and workspace
				// switches. Resolve the committed blank's workspace before treating
				// an aborted signal as an exit from temporary mode.
				if (current && (intent.entered || current !== intent.source) && rows[current]?.blank !== true) {
					stopNativeIntent(intent); return;
				}
				if (intent.owner) {
					if (current) {
						const holder = workspaceForSession(snapshot.items, rows, current);
						// A blank with no known workspace may still be the interactive picker.
						// Leave it visible until the host publishes its committed workspace.
						if (!holder) return;
						if (holder.workspaceId === intent.owner.workspaceId) {
							if (intent.navigation?.aborted) { stopNativeIntent(intent); return; }
							// Reassert only a committed blank in our workspace. Bound retries
							// per blank, not across unrelated picker operations.
							if (intent.reassertBlank !== current) { intent.reassertBlank = current; intent.reasserts = 0; }
							if ((intent.reasserts = (intent.reasserts || 0) + 1) <= NATIVE_REASSERT_LIMIT && !unloading) {
								intent.navigationCleanup?.();
								services.layout.beginNavigation();
								services.workspace.openSession(intent.owner.id);
								watchOwnedNavigation(intent, intent.owner, services.layout.beginNavigation());
							} else stopNativeIntent(intent);
							return;
						}
					}
					const owner = intent.owner; intent.owner = null;
					intent.navigationCleanup?.();
					intent.navigationCleanup = null;
					intent.navigation = null;
					intent.agentPreset = sessionPreset(rows[owner.id]) ?? owner.agentPreset;
					void closeNative(owner); nativeState.patch({ id: null, phase: "choosing", error: "" });
				}
				// An unassigned hero blank is the host's workspace picker. An
				// unrelated recent workspace must not bypass that pending choice.
				if (current && rows[current]?.blank === true && !workspaceForSession(snapshot.items, rows, current)) {
					if (intent.request) cancelNativeRequest(intent, intent.request);
					intent.target = null;
					if (nativeState.state.phase !== "choosing") nativeState.patch({ id: null, phase: "choosing", error: "" });
					return;
				}
				const workspaceId = selectedNativeWorkspace(snapshot.items, rows, current, intent.preferred);
				if (!workspaceId) {
					if (intent.request) cancelNativeRequest(intent, intent.request);
					intent.target = null;
					return;
				}
				intent.preferred = workspaceId;
				lastNativeWorkspace = { services, connection, id: workspaceId };
				intent.target = { workspaceId, current };
				if (intent.request && intent.request.workspaceId !== workspaceId) cancelNativeRequest(intent, intent.request);
				// One attempt per committed target. Another workspace selection or
				// the user's explicit Retry can start the next attempt.
				if (!intent.request && intent.failed !== workspaceId && !intent.owner) void createNative(intent, intent.target);
			} catch (error) {
				console.warn("btw: native temporary conversation navigation is not ready", error);
				stopNativeIntent(intent);
			}
		}
		function openNative() {
			if (unloading) return;
			if (nativeIntent) {
				if (nativeState.state.phase === "error") {
					nativeIntent.failed = null;
					nativeState.patch({ phase: "choosing", error: "" });
					reconcileNative(nativeIntent);
				} else stopNativeIntent(nativeIntent, true);
				return;
			}
			clearNativeDraftHandoff();
			const intent = nativeIntent = { stopped: false, services: null, requests: new Set(), subscriptions: [], request: null, owner: null, target: null };
			nativeState.patch({ id: null, phase: "choosing", error: "" });
			for (const owner of nativeCleanup.values()) if (!owner.closeTask && !owner.retryTimer) void closeNative(owner);
			reconcileNative(intent);
		}

		// Registry: client identities exist before a host child does. Every async
		// closure below belongs to one controller, never to the visible selection.
		const controllers = new Map();
		const tempRegistry = createStore({ activeId: null, revision: 0 });
		let nextTempId = 0, unloading = false;
		const changedTemp = () => tempRegistry.patch({ revision: tempRegistry.state.revision + 1 });
		const currentTemp = () => controllers.get(tempRegistry.state.activeId);
		const idleTemp = emptyTemp();
		const temp = {
			get state() { return currentTemp()?.store.state || idleTemp; },
			patch: (fields) => currentTemp()?.store.patch(fields),
			use: () => { tempRegistry.use(); return temp.state; },
		};
		let focusOrder = 0;
		function focusTemp(id) {
			const next = controllers.get(id);
			if (!next || unloading || tempRegistry.state.activeId === id) return;

			next.focusOrder = ++focusOrder;
			tempRegistry.patch({ activeId: id });
		}
		const sourceTemp = (originId) => [...controllers.values()].sort((a, b) => b.focusOrder - a.focusOrder).find((c) => c.store.state.originId === (originId || null) && c.store.state.phase !== "closing");
		const surfaceTemp = (mode, originId) => [...controllers.values()].find((c) => c.store.state.presentation === mode && (originId === undefined || c.store.state.originId === originId));
		// Native surfaces have one seat; displaced chats become visible windows.
		function reserveSurface(controller, mode) {
			for (const c of controllers.values()) if (c !== controller && c.store.state.presentation === mode && mode !== "overlay" && (mode !== "dock" || c.store.state.originId === controller.store.state.originId)) { c.stopFullscreenWatch?.(); c.store.patch({ presentation: "overlay" }); }
			focusTemp(controller.id);
		}
		function removeTemp(id) {
			const wasCurrent = tempRegistry.state.activeId === id;
			controllers.delete(id);
			if (wasCurrent) {
				tempRegistry.patch({ activeId: null });
				const last = [...controllers.values()].sort((a, b) => b.focusOrder - a.focusOrder)[0];
				if (last) focusTemp(last.id);
			}
			changedTemp();
		}
		// Public sidebar identity only: never restore chat state from its persisted
		// layout. Retirement is fenced from the resource-owning native close hook.
		const retiredTabs = new Map(), removingTabs = new Set();
		const tabToken = (sourceId, tabId) => JSON.stringify([sourceId, tabId]);
		function captureSidebarTab(controller) {
			const right = sidebar, sourceId = controller.store.state.originId;
			if (right?.mounted?.getSnapshot() !== sourceId) return controller.sidebarTab;
			const tab = right.active?.();

			if (tab?.kind === "btw-temp" && typeof tab.id === "string") controller.sidebarTab = { right, sourceId, tabId: tab.id };
			return controller.sidebarTab;

		}
		function closeRetiredTab(record) {
			const { right, sourceId, tabId } = record, token = tabToken(sourceId, tabId);
			if (right !== sidebar || right.mounted?.getSnapshot() !== sourceId || removingTabs.has(token)) return;
			const inventory = right.openTabs?.getSnapshot?.();
			const active = right.active?.();
			const known = Array.isArray(inventory) ? inventory.some(tab => tab.sessionId === sourceId && tab.tabId === tabId && tab.kind === "btw-temp") : active?.kind === "btw-temp" && active.id === tabId;
			if (!known) { if (Array.isArray(inventory)) retiredTabs.delete(token); return; }
			removingTabs.add(token);
			try {
				if (right.close?.(tabId) === false) throw new Error("无法关闭 btw 侧栏，请重试");
				retiredTabs.delete(token);
			} finally { removingTabs.delete(token); }
		}
		function retireSidebarTab(controller) {
			const record = controller.sidebarTab || (controller.store.state.presentation === "sidebar" ? captureSidebarTab(controller) : null);
			if (!record) return;
			// The same native page may already belong to its successor.
			if ([...controllers.values()].some(c => c !== controller && c.store.state.presentation === "sidebar" && c.store.state.originId === record.sourceId)) { controller.sidebarTab = null; return; }
			retiredTabs.set(tabToken(record.sourceId, record.tabId), record);
			closeRetiredTab(record);
			controller.sidebarTab = null;
		}
		function sweepSidebarTabs() {
			if (!sidebar || unloading) return;
			const inventory = sidebar.openTabs?.getSnapshot?.();
			const sourceId = sidebar.mounted?.getSnapshot();
			const active = sidebar.active?.();
			const records = Array.isArray(inventory) ? inventory : active?.kind === "btw-temp" && sourceId ? [{ sessionId: sourceId, tabId: active.id, kind: active.kind }] : [];
			for (const tab of records) if (tab.kind === "btw-temp" && !surfaceTemp("sidebar", tab.sessionId)) {
				const record = { right: sidebar, sourceId: tab.sessionId, tabId: tab.tabId };
				retiredTabs.set(tabToken(record.sourceId, record.tabId), record);
			}
			for (const record of retiredTabs.values()) {
				if (surfaceTemp("sidebar", record.sourceId)) continue;
				try { closeRetiredTab(record); } catch { /* next mounted/body commit can retry; no resource is recreated */ }
			}
		}
		function openTemp(cwd, originId, presentation = "overlay") {
			if (unloading) return null;
			const controller = createTempController("btw-" + ++nextTempId);
			controllers.set(controller.id, controller);
			controller.configure(cwd, originId, presentation);
			if (presentation === "overlay") {
				const occupied = [...controllers.values()].filter((c) => c !== controller && c.store.state.presentation === "overlay");
				const s = controller.store.state;
				if (occupied.some((c) => Math.abs(c.store.state.x - s.x) < 24 && Math.abs(c.store.state.y - s.y) < 24)) {
					const last = occupied.at(-1).store.state, { vw, vh } = geometryBounds();
					controller.store.patch(clampGeometry({ ...s, x: last.x + s.width + 28 <= vw ? last.x + 28 : Math.max(0, last.x - 28), y: last.y + s.height + 28 <= vh ? last.y + 28 : Math.max(0, last.y - 28) }));
				}
			}
			presentTemp(controller, presentation);
			return controller;
		}
		function openAsk(cwd, originId, draft = "", transcript = "", presentation) {
			if (unloading) return null;
			if (!ui) { queueEntry(cwd, originId, presentation, draft, transcript); return null; }
			// All three entries resume the same chat and keep its current seat.
			// The entry's default position only applies to a new chat.
			const dock = surfaceTemp("dock", originId);
			let controller = dock && dock.store.state.phase !== "closing" ? dock : sourceTemp(originId);
			if (!controller) {
				controller = openTemp(cwd, originId, presentation);
				const p = prefs.state;
				controller.store.patch({ contextMode: originId ? p.askContextMode : "none", modelChoice: modelValue(p.askModelMode, p.askProvider, p.askModel), transcript });
			} else {
				const s = controller.store.state;
				const mode = s.presentation === "hidden" ? s.resumePresentation || "dock" : s.presentation;
				if (mode === "sidebar" && s.presentation === mode && controller.fullscreenReturn && controller.sidebarTab) {
					sidebar?.focus?.(controller.sidebarTab.tabId);
					focusTemp(controller.id);
				} else if (mode === "sidebar" || s.presentation === "hidden") presentTemp(controller, mode);
				else focusTemp(controller.id);
			}
			controller.store.patch({
				editorRequest: (controller.store.state.editorRequest || 0) + 1,
				...(draft ? { draft: controller.store.state.draft ? controller.store.state.draft + "\n" + draft : draft } : {}),
			});
			return controller;
		}
		function sidebarPages(right, sourceId) {
			if (right !== sidebar || right.mounted?.getSnapshot() !== sourceId) return null;
			const tabs = right.openTabs?.getSnapshot?.();
			// The host's start page is a placeholder, not a user tab.
			return Array.isArray(tabs) ? tabs.filter(tab => tab.sessionId === sourceId && tab.kind !== "guide") : null;
		}
		function soleBtwTab(pages, tabId) {
			return pages?.length === 1 && pages[0].tabId === tabId && pages[0].kind === "btw-temp";
		}
		function hideSoleSidebarTab(record) {
			if (!record || !soleBtwTab(sidebarPages(record.right, record.sourceId), record.tabId)) return;
			const { right, tabId } = record;
			// hide() would close a floating occurrence and re-enter the native handler.
			if (typeof right.toggleExpanded === "function") {
				if (right.isExpanded?.()) right.toggleExpanded();
			} else if (right.active?.()?.id === tabId) right.hide?.(tabId);
		}
		function minimizeTemp(controller) {
			if (!controller || !controllers.has(controller.id) || controller.store.state.phase === "closing") return;
			const before = controller.store.state.presentation;
			if (before === "sidebar") {
				const record = captureSidebarTab(controller);
				// A native fullscreen sidebar may otherwise expose its Start page
				// over the composer after the btw tab is removed. Hide only our
				// active tab's column; never collapse a different selected page.
				try { hideSoleSidebarTab(record); } catch (e) { controller.store.patch({ insertionError: msg(e) }); }
			}
			controller.cancelPresentation?.();
			controller.stopFullscreenWatch?.();
			controller.store.patch({ presentation: "hidden", resumePresentation: before });
			try { retireSidebarTab(controller); } catch (e) { controller.store.patch({ insertionError: msg(e) }); }
			if (before === "global") globalLayout?.selectPanel(null);
		}
		function resumeTemp(cwd, originId, presentation = "overlay") {
			if (!ui) { queueEntry(cwd, originId, presentation); return null; }
			const found = sourceTemp(originId);
			if (found && found.store.state.phase !== "closing") { presentTemp(found, presentation); return found; }
			return openTemp(cwd, originId, presentation);
		}
		function showPage(controller = currentTemp()) {
			if (!controller || !globalLayout) return;
			reserveSurface(controller, "global");
			controller.showOverlay(clampGeometry(controller.store.state)); // Collapse, never destroy, the source sidebar.
			controller.store.patch({ presentation: "global" });
			globalLayout.selectPanel(GLOBAL_PANEL);
		}

		// A bounded, cancellable handoff: the host publishes the selected session
		// before its React seat and focus target have necessarily committed.
		function showNativeFullscreen(controller, returnMode = "dock") {
			const right = sidebar, source = controller.store.state.originId;
			if (!source || !right || !globalLayout || typeof right.commandTarget !== "function" || typeof right.isTargetCurrent !== "function" || typeof right.toggleFullscreen !== "function" || typeof right.openTab !== "function" || !right.mounted?.subscribe) { showPage(controller); return; }
			let timer, unsubscribe, cancelled = false, opened = false;
			const cancel = () => {
				if (cancelled) return;
				cancelled = true; clearTimeout(timer); unsubscribe?.();
				document.removeEventListener("pointerdown", cancel, true); document.removeEventListener("keydown", cancel, true);
				if (controller.cancelPresentation === cancel) controller.cancelPresentation = null;
			};
			const valid = () => !cancelled && !unloading && sidebar === right && controllers.get(controller.id) === controller && !["idle", "closing"].includes(controller.store.state.phase);
			const fallback = () => { if (!valid()) return; cancel(); controller.stopFullscreenWatch?.(); showPage(controller); };
			const finish = () => {
				if (!valid()) return;
				if (right.mounted.getSnapshot() !== source || controller.store.state.presentation !== "sidebar") { fallback(); return; }
				try {
					const record = controller.sidebarTab, target = right.commandTarget(null);
					if (!record || !target || target.sessionId !== source || target.tabId !== record.tabId || target.host !== "dock" || !right.isTargetCurrent(target)) { fallback(); return; }
					const info = controller.nativeTabInfo;
					beginFullscreenWatch(controller, right, source, record.tabId, returnMode);
					if (info?.tab?.id === record.tabId && info.sidebar?.fullscreen) controller.fullscreenReturn.observed = true;
					else if (!(window.innerWidth < 768)) right.toggleFullscreen(target);
					cancel();
				} catch { fallback(); }
			};
			const start = () => {
				if (!valid() || opened) return;
				const mounted = right.mounted.getSnapshot();
				if (mounted === undefined) return;
				if (mounted !== source) { fallback(); return; }
				opened = true; unsubscribe?.(); unsubscribe = null; clearTimeout(timer);
				controller.cancelPresentation = null;
				controller.showSidebar();
				// showSidebar installs its own initial-focus correction; fullscreen
				// never competes with it or repeatedly steals the user's focus.
				controller.cancelPresentation?.();
				controller.cancelPresentation = cancel;
				if (controller.store.state.presentation !== "sidebar") { fallback(); return; }
				timer = setTimeout(finish, 120);
			};
			controller.cancelPresentation = cancel;
			document.addEventListener("pointerdown", cancel, true); document.addEventListener("keydown", cancel, true);
			if (controller.store.state.presentation === "global") { controller.store.patch({ presentation: "overlay" }); globalLayout.selectPanel(null); }
			unsubscribe = right.mounted.subscribe(start);
			timer = setTimeout(fallback, 1200); start();
		}

		function presentTemp(controller, mode) {
			if (!controller) return;
			controller.cancelPresentation?.();
			controller.stopFullscreenWatch?.();
			controller.nativeTabInfo = null;
			const before = controller.store.state.presentation;
			controller.normalSidebarPending = mode === "sidebar" && before !== "sidebar";
			// mounted is intentionally undefined while a global panel owns main.
			// Restore the already-selected conversation first, never navigate to a
			// different source just to make its sidebar available.
			if (before === "global" && mode !== "global") {
				controller.store.patch({ presentation: "overlay" });
				globalLayout?.selectPanel(null);
			}
			if (mode === "dock") {
				if (before === "sidebar") {
					try { hideSoleSidebarTab(captureSidebarTab(controller)); } catch { /* retirement remains authoritative */ }
				}
				reserveSurface(controller, "dock");
				controller.store.patch({ presentation: "dock", resumePresentation: "dock" });
				try { retireSidebarTab(controller); } catch (e) { controller.store.patch({ insertionError: msg(e) }); }
			} else if (mode === "global" && globalLayout) {
				if (before === "dock" || before === "overlay") showNativeFullscreen(controller, before);
				else showPage(controller);
			}
			else if (mode === "sidebar" && sidebar && controller.store.state.originId) {
				const mounted = sidebar.mounted;
				const restore = () => {
					const source = mounted?.getSnapshot();
					if (source === undefined) return;
					controller.cancelPresentation?.();
					if (!controllers.has(controller.id) || ["closing", "idle"].includes(controller.store.state.phase)) return;
					if (source === controller.store.state.originId) controller.showSidebar();
				};
				if (mounted?.getSnapshot() === controller.store.state.originId) controller.showSidebar();
				else {
					controller.showOverlay(clampGeometry(controller.store.state));
					if (mounted?.getSnapshot() === undefined && mounted?.subscribe) {
						const dispose = mounted.subscribe(restore);
						controller.cancelPresentation = () => { dispose(); controller.cancelPresentation = null; };
						restore();
					}
				}
			} else controller.showOverlay(clampGeometry(controller.store.state));
			focusTemp(controller.id);
		}

		// Controller + transport lifecycle: pinned owner, open/close barrier,
		// generation fence and serial poll cursor are independent for each chat.

		// Eager source bridge: lifecycle, slash capture and local draft must exist
		// before any optional UI arrives. No child/transport is created by import.

		function BtwAskPanel(props) {
			const p = prefs.use(), intent = dockIntent.use(), ns = nativeState.use();
			tempRegistry.use(); uiState.use();
			const lifecycle = props.useSession !== undefined ? props.useSession((x) => x) : null;
			const nodes = props.useChat ? props.useChat((x) => x.legacy?.nodes) : props.useConversation?.((x) => x.views.get("chat")?.legacy?.nodes);
			const snapshotRef = useRef(null);
			if (!snapshotRef.current || snapshotRef.current.sourceId !== props.sessionId || snapshotRef.current.nodes !== nodes) snapshotRef.current = { sourceId: props.sessionId, nodes, text: transcriptOf({ nodes }) };
			const transcript = snapshotRef.current.text;
			const sourceCwd = props.useSessions?.((x) => x.byId[props.sessionId]?.cwd);
			const armed = useRef(true);
			useEffect(() => () => { if (props.sessionId) clearHistory(props.sessionId); }, [props.sessionId]);
			useEffect(() => {
				if (typeof props.sessionId !== "string" || !props.inputActions || typeof props.inputActions.captureInsertion !== "function" || typeof props.inputActions.insertText !== "function") return;
				const bridge = { sessionId: props.sessionId, actions: props.inputActions };
				composerBridge = bridge;
				return () => { if (composerBridge === bridge) composerBridge = null; };
			}, [props.sessionId, props.inputActions]);
			if (typeof props.sessionId === "string") originSnapshot = { sessionId: props.sessionId, text: transcript, cwd: sourceCwd, removed: !!lifecycle?.removed };
			useEffect(() => {
				if (lifecycle?.removed) clearHistory(props.sessionId);
				for (const controller of controllers.values()) if (controller.store.state.originId === props.sessionId && controller.store.state.phase === "configuring")
					controller.store.patch({ transcript, sourceClosed: !!lifecycle?.removed, ...(sourceCwd ? { cwd: sourceCwd } : {}) });
			}, [props.sessionId, transcript, sourceCwd, lifecycle?.removed]);
			const input = props.useInput !== undefined ? props.useInput((x) => x) : null;
			const draftText = input?.draft;
			const { pending: handoff } = nativeDraftHandoff.use();
			useEffect(() => {
				if (typeof props.sessionId !== "string" || typeof props.inputActions?.setDraft !== "function") return;
				const id = props.sessionId, source = { input };
				nativeDraftSources.set(id, source);
				return () => { if (nativeDraftSources.get(id) === source) nativeDraftSources.delete(id); };
			}, [props.sessionId, props.inputActions, input]);
			useEffect(() => {
				if (!handoff || nativeDraftHandoff.state.pending !== handoff || handoff.id !== props.sessionId
					|| unloading || nativeServices !== handoff.services || ctxRef.current?.get?.("connection") !== handoff.connection
					|| selectedNative(handoff.services.sessions) !== handoff.id || lifecycle?.removed
					|| typeof props.inputActions?.setDraft !== "function" || !input) return;
				if (handoff.opening ? nativeIntent?.owner !== handoff.owner : nativeIntent !== null) return;
				const current = plainNativeDraft(handoff.id, input);
				clearNativeDraftHandoff(handoff);
				if (current === null || current !== handoff.expected && (current !== "" || handoff.text === "")) return;
				if (current !== handoff.text) props.inputActions.setDraft(handoff.text);
				if (handoff.opening) handoff.owner.draftCopied = true;
			}, [handoff, props.sessionId, props.inputActions, input, lifecycle?.removed, ns.id]);
			useEffect(() => {
				if (ns.id === props.sessionId || !p.enableSlash || typeof props.inputActions?.setDraft !== "function" || typeof draftText !== "string") return;
				if (armed.current && /^\/btw(\s|$)/.test(draftText)) {
					armed.current = false;
					const carried = draftText.replace(/^\/btw\s*/, "");
					props.inputActions.setDraft("");
					requestAsk(props.sessionId, carried, p.slashPresentation);
				} else if (!/^\/btw/.test(draftText)) armed.current = true;
			}, [draftText, props.inputActions, p.enableSlash, ns.id, props.sessionId]);
			useEffect(() => {
				if (!intent.requested || intent.sourceId && intent.sourceId !== props.sessionId || lifecycle?.removed || unloading) return;
				const { draft, presentation } = intent;
				dockIntent.patch({ requested: false, sourceId: null, draft: "" });
				openAsk(sourceCwd, props.sessionId, draft, transcript, presentation);
			}, [intent.requested, intent.sourceId, intent.draft, intent.presentation, props.sessionId, lifecycle?.removed]);
			if (unloading) return null;
			const controller = surfaceTemp("dock", props.sessionId);
			if (controller && ui) return h(ui.BtwDockView, { key: controller.id, controller, renderFactorySlot: props.renderFactorySlot });
			const pending = [...pendingEntries.values()].some(entry => entry.presentation === "dock" && entry.originId === props.sessionId);
			return pending || intent.presentation === "dock" && intent.requested && (!intent.sourceId || intent.sourceId === props.sessionId) ? dockLoadingView(sourceCwd, props.sessionId) : null;
		}
		function BtwTrigger(props = {}) {
			const p = prefs.use(), intent = dockIntent.use();
			tempRegistry.use();
			const sourceId = props.sessionId || props.useSession?.(x => x.sessionId) || originSnapshot?.sessionId;
			const visible = surfaceTemp("dock", sourceId);
			if (!p.showAskChip || visible || intent.requested && (!sourceId || !intent.sourceId || intent.sourceId === sourceId)) return null;
			return h("button", { type: "button", className: "dsh-btw-chip", title: sourceTemp(sourceId) ? "继续顺便问" : "顺便问（/btw）",
				onClick: () => requestAsk(sourceId) }, "顺便问");
		}
		function btwEntryIcon() {
			return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: "1.35", strokeLinecap: "round", strokeLinejoin: "round" },
				h("path", { d: "M5 3h6a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 11 11H7l-3.5 2v-2.5a2.5 2.5 0 0 1-1-2v-3A2.5 2.5 0 0 1 5 3Z" }));
		}

		function NativeTempIcon({ active = false } = {}) {
			return h("svg", { viewBox: "0 0 20 20", width: "16", height: "16", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" },
				h("circle", { cx: "10", cy: "10", r: "7.3", strokeDasharray: "2 2" }),
				active ? h("path", { d: "m6.8 10 2.1 2.1 4.4-4.4" }) : h("path", { d: "M10 9v4m0-6h.01" }));
		}
		function NativeTempStatus({ global = false, phase = "active" } = {}) {
			return h("button", { type: "button", className: "dsh-btw-entry" + (global ? " dsh-btw-global-entry" : ""), "aria-label": "结束临时聊天", "aria-pressed": true,
				"data-btw-native-status": global ? "" : undefined, "data-btw-native-utility": global ? undefined : "",
				title: phase === "choosing" ? "已选择临时聊天 · 选择工作区后继续" : "已选择临时聊天 · 点击退出", onClick: () => openNative() },
				h(NativeTempIcon, { active: phase === "active" }), "临时聊天");
		}
		function BtwTempEntry(props) {
			temp.use();
			const p = prefs.use();
			const summary = props.useSessions?.((x) => props.sessionId !== undefined ? x.byId[props.sessionId] : undefined);
			const ns = nativeState.use();
			if (props.sessionId && props.sessionId === ns.id) return NativeTempStatus({ phase: ns.phase });
			if (!(props.sessionId ? p.showTempEntry : p.showGlobalTempEntry)) return null;
			const source = props.sessionId === originSnapshot?.sessionId ? originSnapshot : null;
			return h("button", { type: "button", className: "dsh-btw-entry",
				title: props.sessionId ? sourceTemp(props.sessionId) ? "继续顺便问" : "打开顺便问" : "开启临时聊天",
				"aria-label": props.sessionId ? "顺便问" : "临时聊天",
				onClick: () => props.sessionId ? openAsk(summary?.cwd ?? source?.cwd, props.sessionId, "", source?.text, p.headerPresentation) : void openNative() },
				btwEntryIcon(), props.sessionId ? "顺便问" : "临时聊天");
		}

		// Registry/focus chooses seats; keyed shared views own only DOM interaction.
		function BtwTempOverlay({ inline = false, standalone = false, controllerId, alignSourceComposer = false, renderFactorySlot } = {}) {
			tempRegistry.use(); uiState.use();
			if (!ui && !unloading && [...pendingEntries.values()].some(entry => entry.presentation !== "dock")) return loadingView(() => {
				for (const [key, entry] of pendingEntries) if (entry.presentation !== "dock") pendingEntries.delete(key);
				changedTemp();
			});
			if (unloading) return null;
			const mode = standalone ? "global" : inline ? "sidebar" : "overlay";
			const visible = controllerId ? [controllers.get(controllerId)].filter(Boolean) : [...controllers.values()].filter((c) => c.store.state.presentation === mode);
			if (!visible.length) return null;
			// Keep DOM order stable while focusing: raising must not move/remount an
			// editor, interrupt IME, wipe its selection or steal keyboard focus.
			const views = visible.map((controller) => h(ui.BtwTempView, { key: controller.id, controller, inline, standalone, alignSourceComposer, renderFactorySlot }));
			return inline || standalone ? views : h("div", { className: "dsh-btw-desktop" }, ...views);
		}

		const GLOBAL_PANEL = "dsh-btw-global";
		function BtwGlobalEntry() {
			const p = prefs.use(), ns = nativeState.use();
			if (ns.phase === "error") return h("span", { className: "dsh-btw-global-entry dsh-btw-open-error" },
				h("span", { role: "status", title: ns.error }, "临时聊天未开启"),
				h("button", { type: "button", className: "dsh-btw-entry", onClick: openNative, title: ns.error }, "重试"),
				h("button", { type: "button", className: "dsh-btw-entry", onClick: () => stopNativeIntent(nativeIntent) }, "取消"));
			if (ns.phase !== "idle") return NativeTempStatus({ global: true, phase: ns.phase });
			if (!p.showGlobalTempEntry) return null;
			return h("button", { type: "button", className: "dsh-btw-entry dsh-btw-global-entry", "aria-pressed": false, onClick: () => openNative(),
				"aria-label": "开启全局临时聊天", title: "开启临时聊天" }, h(NativeTempIcon), "临时聊天");
		}
		function BtwGlobalPanel({ renderFactorySlot } = {}) {
			tempRegistry.use();
			useEffect(() => {
				if (!surfaceTemp("global")) resumeTemp(null, null, "global");
				return () => {
					const c = surfaceTemp("global");
					if (!c) return;
					// Leaving a source-free ephemeral page is a close, not a hidden
					// floating window that survives in the workspace.
					if (!c.store.state.originId) {
						c.store.patch({ presentation: "hidden" });
						void c.closeTemp();
					} else c.store.patch({ presentation: "overlay" });
				};
			}, []);
			return h(BtwTempOverlay, { standalone: true, renderFactorySlot });
		}
		// Fullscreen state is supplied by the public tab slot, never inferred from
		// host markup. Only an explicit handoff goes back to a small window.
		function beginFullscreenWatch(controller, right, sourceId, tabId, returnMode = "dock") {
			controller.stopFullscreenWatch?.();
			const watch = controller.fullscreenReturn = { right, sourceId, tabId, returnMode, observed: false, gesture: 0, resize: 0 };
			const gesture = () => { watch.gesture = Date.now(); };
			const resize = () => { watch.resize = Date.now(); };
			document.addEventListener("pointerdown", gesture, true); document.addEventListener("keydown", gesture, true);
			window.addEventListener?.("resize", resize);
			controller.stopFullscreenWatch = () => {
				document.removeEventListener("pointerdown", gesture, true); document.removeEventListener("keydown", gesture, true);
				window.removeEventListener?.("resize", resize);
				if (controller.fullscreenReturn === watch) controller.fullscreenReturn = null;
				controller.stopFullscreenWatch = null;
			};
		}
		function observeSidebarInfo(controller, sourceId, info) {
			const record = controller?.sidebarTab, right = sidebar;
			if (!controller || unloading || controllers.get(controller.id) !== controller || controller.store.state.presentation !== "sidebar" || ["idle", "closing"].includes(controller.store.state.phase) || controller.store.state.originId !== sourceId || !record || record.right !== right || record.sourceId !== sourceId || right?.mounted?.getSnapshot() !== sourceId || info?.tab?.id !== record.tabId || info.tab.signal?.aborted) return;
			controller.nativeTabInfo = info;
			const watch = controller.fullscreenReturn;
			if (watch && watch.right === right && watch.sourceId === sourceId && watch.tabId === record.tabId) {
				if (info.sidebar.fullscreen) watch.observed = true;
				else if (watch.observed) {
					if (info.sidebar.expanded && info.tab.visible && !info.panel.isFloating && watch.gesture && watch.gesture > watch.resize && Date.now() - watch.gesture < 1000) {
						try {
							const target = right.commandTarget(null);
							if (target?.sessionId === sourceId && target.tabId === record.tabId && target.host === "dock" && right.isTargetCurrent(target)) { presentTemp(controller, watch.returnMode); return; }
						} catch { /* host changed while handling the gesture */ }
					}
					// A resize, hidden tab or foreign target is not a native Exit.
					controller.stopFullscreenWatch?.();
				}
				return;
			}
			if (!controller.normalSidebarPending) return;
			controller.normalSidebarPending = false;
			// A panel mode belongs to the entire column. Never reset one owned by
			// another tab, and never fight the host's automatic narrow layout.
			const tabs = right.openTabs?.getSnapshot?.();
			if (!info.sidebar.fullscreen || !info.sidebar.expanded || !info.tab.visible || info.panel.isFloating || window.innerWidth < 768 || !Array.isArray(tabs) || tabs.filter(tab => tab.sessionId === sourceId).length !== 1) return;
			try {
				const target = right.commandTarget?.(null);
				if (target?.sessionId === sourceId && target.tabId === record.tabId && target.host === "dock" && right.isTargetCurrent?.(target)) right.toggleFullscreen?.(target);
			} catch { /* optional native capability */ }
		}
		function BtwSidebarBody(props) {
			tempRegistry.use();
			const info = typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
			const controller = surfaceTemp("sidebar", props.btwSessionId);
			useEffect(() => { sweepSidebarTabs(); }, [props.btwSessionId, tempRegistry.state.revision]);
			useEffect(() => { if (info) observeSidebarInfo(controller, props.btwSessionId, info); }, [controller, props.btwSessionId, info]);
			return controller ? h(BtwTempOverlay, { inline: true, controllerId: controller.id, alignSourceComposer: !!info && !info.sidebar?.fullscreen && !info.panel?.isFloating, renderFactorySlot: props.renderFactorySlot }) : null;
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
			if (choice.mode === "default") { saveSetting(prefix + "ModelMode", "host"); return; }
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

		// Settings ship as their own sibling chunk: only a real visit to a
		// settings slot loads it — ordinary chat first-use never pulls the
		// card. Promise-deduped, activation-fenced, retryable on failure.
		let settingsUi = null, settingsTask = null;
		const settingsUiState = createStore({ status: "idle", error: "" });
		function loadSettings(retry = false) {
			if (unloading) return Promise.resolve(null);
			if (settingsUi) return Promise.resolve(settingsUi);
			if (settingsTask) return settingsTask;
			if (settingsUiState.state.status === "error" && !retry) return Promise.resolve(null);
			const epoch = activationEpoch;
			settingsUiState.state.status = "loading"; settingsUiState.state.error = "";
			const task = Promise.resolve().then(() => unloading || epoch !== activationEpoch ? null : require.async("./client.settings.js")).then((module) => {
				if (!module || unloading || epoch !== activationEpoch) return null;
				// Pickers and the configured model menu live in the views closure:
				// pass them in explicitly — never a synchronous cross-chunk require.
				settingsUi = { BtwSettings: module.createSettings({ React, prefs, settingsErrors, getSettingsScope, saveSetting, saveModel, ...ui.settingsHelpers }) };
				injectCss(module.CSS, CSS_ID + "/settings");
				settingsUiState.patch({ status: "ready", error: "" });
				return settingsUi;
			}).catch((e) => {
				if (!unloading && epoch === activationEpoch) settingsUiState.patch({ status: "error", error: msg(e) });
				return null; // Failure is visible and retryable, never an unhandled rejection.
			}).finally(() => { if (settingsTask === task) settingsTask = null; });
			settingsTask = task;
			return task;
		}
		function BtwSettingsGate() {
			uiState.use(); settingsUiState.use();
			if (unloading) return null;
			if (!ui) { void loadUI(); return loadingView(); }
			if (!settingsUi) {
				void loadSettings();
				const error = settingsUiState.state.error;
				return h("div", { className: "dsh-btw-status", role: "status" }, error ? "btw 设置加载失败：" + error : "正在加载 btw 设置…",
					error ? h("button", { type: "button", onClick: () => { void loadSettings(true); } }, "重试") : null);
			}
			return h(settingsUi.BtwSettings);
		}

		// ── first-use module handoff ───────────────────────────────────
		let ui = null, uiTask = null, activationEpoch = 0;
		let geometryKey, geometryBounds, clampGeometry, savedGeometry, persistGeometry, createTempController;
		const uiState = createStore({ status: "idle", error: "" });
		const pendingEntries = new Map();
		const getSidebar = () => sidebar, getLayout = () => globalLayout;
		const speech = createStore({ remote: null, navigation: null, t: null });
		const getSettingsScope = () => settingsScope, getComposerBridge = () => composerBridge;
		const getOriginSnapshot = () => originSnapshot, isUnloading = () => unloading;
		const WINDOW_PIN_KEY = "dsh-btw/window-pinned/v1";
		let windowPinned;
		try {
			const stored = window.localStorage?.getItem(WINDOW_PIN_KEY);
			if (stored === "true" || stored === "false") windowPinned = stored === "true";
		} catch { /* storage may be unavailable */ }
		const getWindowPinned = () => windowPinned ?? prefs.state.tempWindowPinned;
		function setWindowPinned(controller) {
			const state = controller.store.state;
			// A click from an outgoing view must not change the preference or
			// interrupt a chat after it has moved to a different seat.
			if (state.presentation !== "overlay" || state.phase === "idle" || state.phase === "closing") return;
			const pinned = windowPinned = !state.pinned;
			controller.store.patch({ pinned });
			try { window.localStorage?.setItem(WINDOW_PIN_KEY, String(pinned)); } catch { /* keep the live preference */ }
		}
		function updateGeometry(controller, fields, persist = true) {
			if (!controller || controller.store.state.phase === "idle") return;
			const s = controller.store.state;
			const geometry = clampGeometry({ ...s, ...fields });
			controller.store.patch(geometry);
			if (persist) persistGeometry(s.geometryKey, geometry);
		}


		function dockLoadingView(cwd, sourceId) {
			// Preserve a user's explicit project dimensions while the geometry
			// chunk loads; only numeric geometry is read, never chat state.
			let style;
			if (prefs.state.tempRememberPosition && (cwd || !sourceId)) try {
				const key = "dsh-btw/geometry/v1/" + encodeURIComponent(cwd || "host") + "/dock-v3";
				const saved = JSON.parse(window.localStorage?.getItem(key) || "null");
				if (saved && typeof saved === "object") {
					style = {};
					if (Number.isFinite(saved.height)) style.height = `min(${Math.max(180, saved.height)}px, 50dvh)`;
				}
			} catch { /* private/quota-restricted browser */ }
			return h("div", { className: "dsh-btw-dock" }, h("div", { className: "dsh-btw-card dsh-btw-dock-loading", style }, loadingView(() => cancelDockIntent(sourceId))));
		}
		function loadingView(cancel) {
			const error = uiState.state.error;
			return h("div", { className: "dsh-btw-status", role: "status" }, error ? "btw 界面加载失败：" + error : "正在加载 btw…",

				error ? h("button", { type: "button", onClick: () => { void loadUI(true); } }, "重试") : null,
				cancel ? h("button", { type: "button", onClick: cancel, "aria-label": "取消加载 btw" }, "取消") : null);
		}
		function queueEntry(cwd, originId, presentation, draft = "", transcript = "") {
			if (unloading) return;
			const key = originId ?? null;
			const prior = pendingEntries.get(key);
			pendingEntries.set(key, prior ? { ...prior, cwd: prior.cwd ?? cwd, transcript: prior.transcript || transcript,
				draft: prior.draft && draft ? prior.draft + "\n" + draft : prior.draft || draft } : { cwd, originId, presentation, draft, transcript });
			changedTemp();
			void loadUI();
		}
		function loadUI(retry = false) {
			if (unloading || ui) return Promise.resolve(ui);
			if (uiTask) return uiTask;
			if (uiState.state.status === "error" && !retry) return Promise.resolve(null);
			const epoch = activationEpoch;
			uiState.state.status = "loading"; uiState.state.error = "";
			// Siblings are self-contained. Never synchronous relative require or
			// import(), and never a registry/service lookup inside a view module.
			const task = Promise.resolve().then(() => unloading || epoch !== activationEpoch ? null : Promise.all([
				require.async("./client.geometry.js"), require.async("./client.messages.js"),
				require.async("./client.views.js"), require.async("./client.controllers.js"),
			])).then((modules) => {
				if (!modules || unloading || epoch !== activationEpoch) return null;
				const [g, m, v, c] = modules;
				const geometry = g.createGeometry({ h, window, remember: () => prefs.state.tempRememberPosition });
				({ geometryKey, geometryBounds, clampGeometry, savedGeometry, persistGeometry } = geometry);
				const messageView = m.createMessageRenderer({ h, React, MarkdownText: v.MarkdownText, DisclosureRow: v.DisclosureRow, ThinkIcon: v.ThinkIcon, TextShimmer: v.TextShimmer });
				createTempController = c.createControllerFactory({ createStore, emptyTemp, changedTemp, controllers, focusTemp, surfaceTemp, reserveSurface, removeTemp, prefs, catalog, geometryKey, savedGeometry, getWindowPinned, modelValue, parseModel, resolveModelMode, completeContext, searchContext, ctxRef, rpc, msg, POLL_MS, getSidebar, getComposerBridge, getOriginSnapshot, isUnloading, captureSidebarTab, retireSidebarTab, hideSoleSidebarTab });
				ui = v.createViews({ React, geometry, messageView, modelKey, modelValue, parseModel, catalog, loadModels, loadModelOptions, speech, minimizeTemp, getSidebar, getLayout, getComposerBridge, controllers, tempRegistry, focusTemp, updateGeometry, setWindowPinned, openTemp, presentTemp, registerEscapeSurface });
				injectCss(v.CSS, CSS_ID + "/views");
				loadModels();
				uiState.patch({ status: "ready", error: "" });
				const entries = [...pendingEntries.values()];
				pendingEntries.clear();
				for (const { cwd, originId, presentation, draft, transcript } of entries) {
					if (presentation === "global") resumeTemp(cwd, originId, presentation);
					else openAsk(cwd, originId, draft, transcript, presentation);
				}
				return ui;
			}).catch((e) => {
				if (!unloading && epoch === activationEpoch) uiState.patch({ status: "error", error: msg(e) });
				return null; // Failure is visible and retryable, never an unhandled rejection.
			}).finally(() => { if (uiTask === task) uiTask = null; });
			uiTask = task;
			return task;
		}

		// ── plugin entry ───────────────────────────────────────────────
		function apply(ctx) {
			ctxRef.current = ctx;
			unloading = false;
			activationEpoch++;
			if (!ui) { uiTask = null; uiState.patch({ status: "idle", error: "" }); }
			injectCss();
			const fibers = [];
			const resize = () => { for (const c of controllers.values()) if (c.store.state.presentation === "overlay") updateGeometry(c, {}, false); };
			window.addEventListener?.("resize", resize);
			fibers.push(() => window.removeEventListener?.("resize", resize));
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
			if (typeof ctx.inject === "function") {
				// Cordis guards each Remote namespace independently of the root.
				try { fibers.push(ctx.inject(["remote", "remote.session", "connection"], (scope) => {
					historyRemote = scope.remote; historyConnection = scope.connection; clearHistory();
					const disposers = [scope.connection.state?.subscribe(() => { if (scope.connection.state.getSnapshot() !== "connected") clearHistory(); }), scope.connection.generation?.subscribe(() => clearHistory())];
					return () => { clearHistory(); historyRemote = null; historyConnection = null; for (const dispose of disposers) dispose?.(); };
				})); } catch { /* full-history service is optional */ }
				try { fibers.push(ctx.inject(["locale"], scope => {
					speech.patch({ t: scope.locale.bind("voice-input") });
					return () => speech.patch({ t: null });
				})); } catch { /* older hosts fall back to local copy */ }
				try { fibers.push(ctx.inject(["pluginNavigation"], scope => {
					const navigation = scope.pluginNavigation;
					speech.patch({ navigation });
					return () => { if (speech.state.navigation === navigation) speech.patch({ navigation: null }); };
				})); } catch { /* plugin details may be unavailable */ }
				try { fibers.push(ctx.inject(["remote", "remote.speech"], (scope) => {
					const remote = scope.remote.speech;
					speech.patch({ remote });
					return () => { if (speech.state.remote === remote) speech.patch({ remote: null }); };
				})); } catch { /* speech is optional */ }
				try { fibers.push(ctx.inject(["layout"], (scope) => { globalLayout = scope.layout; return () => { if (globalLayout === scope.layout) globalLayout = null; }; })); } catch { /* layout is optional */ }
				try { fibers.push(ctx.inject(["uiWorkspace", "sessions", "layout"], (scope) => { const services = nativeServices = { workspace: scope.uiWorkspace, sessions: scope.sessions, layout: scope.layout }; scheduleNative(); return () => { if (nativeServices === services) { nativeServices = null; scheduleNative(); } }; })); } catch { /* native entry reports unavailable */ }
				try { fibers.push(ctx.inject(["workspaces"], (scope) => { const service = nativeWorkspaces = scope.workspaces; scheduleNative(); return () => { if (nativeWorkspaces === service) { nativeWorkspaces = null; scheduleNative(); } }; })); } catch { /* older hosts may lack workspace discovery */ }
				try { fibers.push(ctx.inject(["sidebarRight", "sidebarRightTabs"], (scope) => {
					const right = scope.sidebarRight;
					sidebar = right;
					const type = scope.sidebarRightTabs.register({ id: TAB_ID, kind: "btw-temp", title: () => "btw" });
					// Explicit native tab close is a resource close, not a body unmount.
					const closeHandler = right.registerCloseHandler?.("btw-temp", (sessionId, tab) => {
						if (tab && removingTabs.has(tabToken(sessionId, tab.id))) return;
						const controller = surfaceTemp("sidebar", sessionId);
						if (!controller || controller.store.state.phase === "closing" || tab && controller.sidebarTab && controller.sidebarTab.tabId !== tab.id) return;
						// DSH invokes this handler before committing the native tab removal.
						// Recheck after the commit; a new tab or a session switch wins.
						if (tab && soleBtwTab(sidebarPages(right, sessionId), tab.id)) {
							Promise.resolve().then(() => {
								if (!unloading && sidebarPages(right, sessionId)?.length === 0 && right.isExpanded?.()) right.toggleExpanded?.();
							}).catch(error => console.warn("btw: empty sidebar could not be collapsed", error));
						}
						controller.sidebarTab = null;
						controller.store.patch({ presentation: "overlay" });
						void controller.closeTemp({ background: true });
					});
					const watch = [right.mounted?.subscribe?.(sweepSidebarTabs), right.openTabs?.subscribe?.(sweepSidebarTabs)];
					sweepSidebarTabs();
					const seat = scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, inject: (sessionId) => ({ btwSessionId: sessionId }) }, BtwSidebarBody));
					return () => { for (const dispose of watch) dispose?.(); closeHandler?.(); if (sidebar === right) { for (const controller of controllers.values()) { controller.cancelPresentation?.(); controller.stopFullscreenWatch?.(); } sidebar = null; } if (typeof seat === "function") seat(); else seat?.dispose?.(); if (typeof type === "function") type(); else type?.dispose?.(); };
				})); } catch { /* sidebar is optional */ }
			}
			if (ctx.slots !== undefined) {
				const renderSettings = (props) => props?.view === "summary" ? "侧问与临时聊天设置" : h(BtwSettingsGate);
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
				// Every controller retains its own connection and late-open barrier.
				unloading = true;
				clearNativeDraftHandoff();
				nativeDraftSources.clear();
				nativePresetBridge?.();
				activationEpoch++; pendingEntries.clear();
				for (const controller of controllers.values()) void controller.closeTemp();
				stopNativeIntent(nativeIntent);
				for (const owner of nativeCleanup.values()) { clearTimeout(owner.retryTimer); owner.retryTimer = null; if (!owner.closeTask) void closeNative(owner); }
				tempRegistry.patch({ activeId: null });
				cancelDockIntent();
				clearHistory();
				for (const fiber of fibers) {
					try { const p = typeof fiber.dispose === "function" ? fiber.dispose() : fiber(); if (p !== undefined && typeof p.catch === "function") p.catch(() => {}); } catch { /* ignore */ }
				}
				settingsScope = null; composerBridge = null; originSnapshot = null; sidebar = null; globalLayout = null; ctxRef.current = null;
			});
		}
		return { inject: ["slots"], apply };
	},
});
