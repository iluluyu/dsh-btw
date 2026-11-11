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
 * client.controllers.js: eb72a2d7abfec3f5f7e3d3f7c0dc0f817d0996de464ced53421550ae47556755
 * client.geometry.js: fd530033d6912b1da98c008031b3d7f435869de658561a4dfcf89c21a2f9f43b
 * client.messages.js: 243284887cd483e21ca093cb4652fe8944d775c1cd62ad03b4e8b54343a37e1f
 * client.settings.js: 2de45a8f15485377f94db5926a0f31bbc7846e36bf7568195efea87714c5d7d4
 * client.views.js: fa7d95d608a656480401e3b496b7e3a62668c24598491dd3001ee16aa4cfa578
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
		.dsh-btw-chip{height:28px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;flex:none;}
		.dsh-btw-chip:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.09));color:var(--dsw-alias-brand-text,#3964fe);}
		.dsh-btw-entry{height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;}
		.dsh-btw-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-entry svg{opacity:.75;}
		.dsh-btw-global-entry{display:none;position:absolute;right:28px;top:10px;z-index:2;}
		header:has([data-conversation-header-leading]):not(:has(nav)) .dsh-btw-global-entry{display:inline-flex;}
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
		function keyboardBelongsTo(root, event) {
			if (!root) return false;
			const target = event.target || document.activeElement;
			return !!target && (root.contains?.(target) || event.composedPath?.().includes(root));
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
		const DEFAULTS = { askContextMode: "recent", tempContextMode: "none", askModelMode: "default", tempModelMode: "default", askProvider: "", askModel: "", tempProvider: "", tempModel: "", showAskChip: true, enableSlash: true, showTempEntry: true, tempPresentation: "sidebar", tempWindowPinned: true, tempRememberPosition: true };
		const prefs = createStore(DEFAULTS);
		const catalog = createStore({ status: "loading", providers: [], error: "" });
		let settingsScope = null, modelsTask = null;
		function projectSettings() {
			const snap = settingsScope?.getSnapshot();
			const value = snap?.status === "ready" && snap.value && typeof snap.value === "object" ? snap.value : {};
			const next = { ...DEFAULTS };
			for (const key of Object.keys(next)) if (typeof value[key] === typeof next[key]) next[key] = value[key];
			for (const key of ["askModelMode", "tempModelMode"]) if (["host", "current"].includes(next[key])) next[key] = "default";
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
		const resolveModelMode = (choice, parentSessionId) => choice.mode === "default" ? (parentSessionId ? "current" : "host") : choice.mode;

		// A short-lived entry intent, never a second chat/message owner. Once a
		// source claims it, only its ordinary controller owns draft/history/child.
		const dockIntent = createStore({ requested: false, sourceId: null, draft: "" });
		function requestDock(sourceId = null, draft = "") {
			if (unloading) return;
			// A ready, matching source needs no post-paint intent handoff. In
			// particular, reopening a minimized chat must not flash a loading row.
			const source = originSnapshot;
			if (ui && source?.sessionId === sourceId && !source.removed) {
				if (dockIntent.state.requested) cancelDockIntent();
				openDock(source.cwd, sourceId, draft, source.text);
				return;
			}
			dockIntent.patch({ requested: true, sourceId, draft });
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
			presentation: "hidden", draft: "", selecting: false, selected: [], insertionError: "", insertionNotice: "", contextMode: "none", modelChoice: "default", transcript: "", width: 740, height: 640, x: null, y: null, pinned: true, geometryKey: "",
		});
		let sidebar = null, globalLayout = null, composerBridge = null, originSnapshot = null;
		const TAB_ID = "dsh-btw/temp";

		// Native source-free sessions are owned separately from project children.
		const nativeState = createStore({ id: null, busy: false, error: "" });
		let nativeServices = null, nativeWorkspaces = null, nativeOwner = null;
		function selectedNative(sessions) {
			const rows = sessions.list.getSnapshot()?.byId;
			if (!rows || typeof rows !== "object") throw new Error("宿主会话导航状态不可用");
			const ids = Object.keys(rows).filter(id => rows[id]?.retainedBy?.mainView > 0);
			if (ids.length > 1) throw new Error("宿主会话导航状态不明确");
			return ids[0] || null;
		}
		function nativeError(error) { nativeState.patch({ error: msg(error), busy: false }); if (unloading) console.error("btw 临时会话清理失败:", error); }
		async function closeNative(owner) {
			if (!owner || owner.finished || owner.closeTask) return owner?.closeTask;
			owner.closing = true;
			if (!unloading) nativeState.patch({ busy: true });
			const task = (async () => {
				try {
					// Ending the temporary chat never navigates the user back to a
					// previous window: the surface just goes away and the host decides
					// what the emptied view shows.
					const value = await rpc("nativeClose", { sessionId: owner.id }, owner.connection);
					if (value?.burned !== true) throw new Error("临时会话未确认安全清理");
					owner.finished = true;
					owner.unsubscribe?.(); owner.unpanel?.(); owner.style?.remove?.(); owner.release?.();
					if (nativeOwner === owner) nativeOwner = null;
					nativeState.patch({ id: null, busy: false, error: "" });
				} catch (e) { owner.closing = false; nativeError(e); }
				finally { owner.closeTask = null; }
			})();
			owner.closeTask = task;
			return task;
		}
		async function openNative() {
			if (unloading || nativeState.state.busy || nativeOwner) return;
			const services = nativeServices, connection = ctxRef.current?.get?.("connection");
			let reference = null;
			try {
				if (!services?.workspace?.openSession || !services.workspace.archiveSession || !services.sessions?.list?.subscribe || !services.sessions.list.getSnapshot || typeof services.sessions.retainInfo !== "function" || !services.layout?.beginNavigation || !services.layout?.panelInfo?.getSnapshot || !services.layout?.panelInfo?.subscribe || !connection?.rpc?.call) throw new Error("宿主缺少安全的临时会话导航能力");
				const previous = selectedNative(services.sessions), panel = services.layout.panelInfo.getSnapshot().activePanelId;
				const workspaceSnapshot = nativeWorkspaces?.list?.getSnapshot?.();
				if (previous && workspaceSnapshot?.phase && workspaceSnapshot.phase !== "ready") throw new Error("工作区尚未就绪，请稍后重试");
				const workspaceId = previous && workspaceSnapshot?.items?.find(item => item.sessionIds.includes(previous))?.workspaceId;
				const projectCwd = previous ? services.sessions.list.getSnapshot()?.byId?.[previous]?.cwd : undefined;
				// The client cannot see workspace paths, so when the current session is
				// not listed in a workspace it forwards the project directory and lets
				// the host resolve the owning workspace; without a directory the host
				// uses its exclusive empty workspace.
				const openPayload = workspaceId ? { workspaceId } : typeof projectCwd === "string" && projectCwd ? { cwd: projectCwd } : {};
				const existing = new Set(Object.keys(services.sessions.list.getSnapshot().byId)), epoch = activationEpoch;
				if (previous && typeof services.sessions.retain !== "function") throw new Error("宿主无法安全保留原会话导航");
				reference = previous ? services.sessions.retain(previous, { source: "controllerOperation" }) : null;
				const signal = services.layout.beginNavigation();
				let changed = false;
				const unwatch = services.sessions.list.subscribe(() => { try { if (selectedNative(services.sessions) !== previous) changed = true; } catch { changed = true; } });
				nativeState.patch({ busy: true, error: "" });
				let value;
				try { value = await rpc("nativeOpen", openPayload, connection); } finally { unwatch?.(); }
				if (typeof value?.sessionId !== "string" || !value.sessionId || existing.has(value.sessionId)) throw new Error("临时会话创建结果无效或与已有会话冲突");
				// Adopt the host-created Workspace through the client controller. It is
				// idempotent by path and makes the Workspace visible to this browser
				// model, which the desktop conversation needs before it opens.
				if (typeof value.cwd === "string" && value.cwd && typeof nativeWorkspaces?.create === "function") {
					try { await nativeWorkspaces.create({ path: value.cwd }); }
					catch (error) { await rpc("nativeClose", { sessionId: value.sessionId }, connection).catch(() => {}); throw error; }
				}
				const retained = reference; reference = null;
				const owner = { id: value.sessionId, previous, workspace: services.workspace, sessions: services.sessions, retainInfo: services.sessions.retainInfo(value.sessionId), connection, release: () => retained?.release(), closing: false, closeTask: null };
				nativeOwner = owner;
				if (unloading || epoch !== activationEpoch || signal.aborted || changed || selectedNative(services.sessions) !== previous || services.layout.panelInfo.getSnapshot().activePanelId !== panel) { await closeNative(owner); return; }
				// A newly created root may not yet be in the client catalog, which
				// retain/openSession requires. Refresh only metadata, never history.
				if (!services.sessions.list.getSnapshot().byId[owner.id] && typeof services.sessions.refresh === "function") {
					const stop = services.sessions.list.subscribe(() => { try { if (selectedNative(services.sessions) !== previous) changed = true; } catch { changed = true; } });
					try { await services.sessions.refresh(); } finally { stop?.(); }
					if (owner.closing || unloading || epoch !== activationEpoch || signal.aborted || changed || selectedNative(services.sessions) !== previous || services.layout.panelInfo.getSnapshot().activePanelId !== panel) { await closeNative(owner); return; }
				}
				nativeState.patch({ id: owner.id, busy: false, error: "" });
				const style = owner.style = document.createElement("style");
				style.dataset.plugin = NAME;
				const root = `[data-conversation-session=${JSON.stringify(owner.id)}]`;
				style.textContent = `${root} [data-composer-card],${root} [data-message-bubble]{border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.3)) !important;}`;
				document.head.appendChild(style);
				if (!owner.retainInfo?.getSnapshot || !owner.retainInfo.subscribe) throw new Error("宿主缺少临时会话引用观察能力");
				owner.workspace.openSession(owner.id);
				// The catalog row can arrive after openSession; retainInfo observes the
				// exact generation independently of catalog publication.
				if (!(owner.retainInfo.getSnapshot()?.retainedBy?.mainView > 0)) throw new Error("宿主未打开临时会话");
				owner.unsubscribe = owner.retainInfo.subscribe(() => {
					if (!owner.closing && !(owner.retainInfo.getSnapshot()?.retainedBy?.mainView > 0)) void closeNative(owner);
				});
				owner.unpanel = services.layout.panelInfo.subscribe(() => { if (!owner.closing && services.layout.panelInfo.getSnapshot().activePanelId !== null) void closeNative(owner); });
			} catch (e) { reference?.release(); if (nativeOwner && !nativeOwner.closeTask) await closeNative(nativeOwner); nativeError(e); }
		}
		function NativeStatus() {
			const s = nativeState.use();
			if (!s.error) return null;
			return h("div", { className: "dsh-btw-status", role: "alert", style: { position: "fixed", right: 20, bottom: 20, zIndex: 10000, background: "var(--dsw-alias-bg-base,#fff)" } }, "btw：" + s.error,
				nativeOwner ? h("button", { type: "button", onClick: () => void closeNative(nativeOwner) }, "重试结束") : h("button", { type: "button", onClick: () => nativeState.patch({ error: "" }) }, "关闭"));
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
		const sourceTemp = (originId) => [...controllers.values()].sort((a, b) => b.focusOrder - a.focusOrder).find((c) => c.store.state.originId === (originId || null));
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
		function openDock(cwd, originId, draft = "", transcript = "") {
			if (unloading) return null;
			if (!ui) { queueEntry(cwd, originId, "dock", draft, transcript); return null; }
			// The chip continues a minimized chat directly, including one that was
			// moved to another form. Closing removes it; no layout can recreate it.
			const hidden = [...controllers.values()].sort((a, b) => b.focusOrder - a.focusOrder).find(c => c.store.state.originId === (originId || null) && c.store.state.presentation === "hidden" && c.store.state.phase !== "closing");
			let controller = surfaceTemp("dock", originId) || hidden;
			if (controller?.store.state.phase === "closing") controller = null;
			if (!controller) {
				controller = openTemp(cwd, originId, "dock");
				const p = prefs.state;
				controller.store.patch({ contextMode: originId ? p.askContextMode : "none", modelChoice: modelValue(p.askModelMode, p.askProvider, p.askModel), transcript });
			} else presentTemp(controller, controller === hidden ? controller.store.state.resumePresentation || "dock" : "dock");
			if (draft) controller.store.patch({ draft: controller.store.state.draft ? controller.store.state.draft + "\n" + draft : draft });
			return controller;
		}
		function hideSoleSidebarTab(record) {
			if (!record || record.right !== sidebar || record.right.mounted?.getSnapshot() !== record.sourceId) return;
			const tabs = record.right.openTabs?.getSnapshot?.();
			if (!Array.isArray(tabs)) return;
			const own = tabs.filter(tab => tab.sessionId === record.sourceId);
			// Hide our tab when it is the only page of this Session; when nothing is
			// left afterwards, also collapse the column so no empty shell remains.
			const sole = own.length === 1 && own[0].tabId === record.tabId && own[0].kind === "btw-temp";
			if (sole && record.right.active?.()?.id === record.tabId) record.right.hide?.(record.tabId);
			// Collapse the column too when nothing of this Session is left behind, so
			// closing the only btw page never leaves an empty shell.
			const left = record.right.openTabs?.getSnapshot?.();
			const remaining = Array.isArray(left) ? left.filter(tab => tab.sessionId === record.sourceId && tab.kind !== "guide" && tab.tabId !== record.tabId) : [];
			if (remaining.length === 0 && record.right.isExpanded?.()) record.right.toggleExpanded?.();
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
			controller.showOverlay(); // Collapse, never destroy, the source sidebar.
			controller.store.patch({ presentation: "global" });
			globalLayout.selectPanel(GLOBAL_PANEL);
		}

		// A bounded, cancellable handoff: the host publishes the selected session
		// before its React seat and focus target have necessarily committed.
		function showNativeFullscreen(controller) {
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
					beginFullscreenWatch(controller, right, source, record.tabId);
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
			controller.normalSidebarPending = mode === "sidebar";
			const before = controller.store.state.presentation;
			// mounted is intentionally undefined while a global panel owns main.
			// Restore the already-selected conversation first, never navigate to a
			// different source just to make its sidebar available.
			if (before === "global" && mode !== "global") {
				controller.store.patch({ presentation: "overlay" });
				globalLayout?.selectPanel(null);
			}
			if (mode === "dock") {
				if (before === "sidebar") captureSidebarTab(controller);
				reserveSurface(controller, "dock");
				controller.store.patch({ presentation: "dock", resumePresentation: "dock" });
				try { retireSidebarTab(controller); } catch (e) { controller.store.patch({ insertionError: msg(e) }); }
			} else if (mode === "global" && globalLayout) {
				if (before === "dock") showNativeFullscreen(controller);
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
					controller.showOverlay();
					if (mounted?.getSnapshot() === undefined && mounted?.subscribe) {
						const dispose = mounted.subscribe(restore);
						controller.cancelPresentation = () => { dispose(); controller.cancelPresentation = null; };
						restore();
					}
				}
			} else controller.showOverlay();
			if (controller.store.state.presentation === "overlay") updateGeometry(controller, {}, false);
			focusTemp(controller.id);
		}
		function enterTemp(cwd, originId, presentation = prefs.state.tempPresentation) {
			if (!ui) { queueEntry(cwd, originId, presentation); return; }
			resumeTemp(cwd, originId, presentation);
		}

		// Controller + transport lifecycle: pinned owner, open/close barrier,
		// generation fence and serial poll cursor are independent for each chat.

		// Eager source bridge: lifecycle, slash capture and local draft must exist
		// before any optional UI arrives. No child/transport is created by import.
		function BtwAskPanel(props) {
			const p = prefs.use(), intent = dockIntent.use();
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
			useEffect(() => {
				if (!p.enableSlash || typeof props.inputActions?.setDraft !== "function" || typeof draftText !== "string") return;
				if (armed.current && /^\/btw(\s|$)/.test(draftText)) {
					armed.current = false;
					const carried = draftText.replace(/^\/btw\s*/, "");
					props.inputActions.setDraft("");
					requestDock(props.sessionId, carried);
				} else if (!/^\/btw/.test(draftText)) armed.current = true;
			}, [draftText, props.inputActions, p.enableSlash]);
			useEffect(() => {
				if (!intent.requested || intent.sourceId && intent.sourceId !== props.sessionId || lifecycle?.removed || unloading) return;
				const draft = intent.draft;
				dockIntent.patch({ requested: false, sourceId: null, draft: "" });
				openDock(sourceCwd, props.sessionId, draft, transcript);
			}, [intent.requested, intent.sourceId, intent.draft, props.sessionId, lifecycle?.removed]);
			if (unloading) return null;
			const controller = surfaceTemp("dock", props.sessionId);
			if (controller && ui) return h(ui.BtwDockView, { key: controller.id, controller, renderFactorySlot: props.renderFactorySlot });
			const pending = [...pendingEntries.values()].some(entry => entry.presentation === "dock" && entry.originId === props.sessionId);
			return pending || intent.requested && (!intent.sourceId || intent.sourceId === props.sessionId) ? dockLoadingView(sourceCwd, props.sessionId) : null;
		}
		function BtwTrigger(props = {}) {
			const p = prefs.use(), intent = dockIntent.use();
			tempRegistry.use();
			const sourceId = props.sessionId || props.useSession?.(x => x.sessionId) || originSnapshot?.sessionId;
			const visible = surfaceTemp("dock", sourceId);
			if (!p.showAskChip || visible || intent.requested && (!sourceId || !intent.sourceId || intent.sourceId === sourceId)) return null;
			return h("button", { type: "button", className: "dsh-btw-chip", title: "btw · 继续独立聊天（也可以在输入框输入 /btw）",
				onClick: () => requestDock(sourceId) }, "btw");
		}
		const GHOST_ICON = h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" },
			h("path", { d: "M8 2.2c-2.6 0-4.6 1.9-4.6 4.3 0 .8.2 1.5.7 2.1.2.3.3.6.3.9l-.2 1.6c-.1.4.4.7.7.5l1.5-.8c.3-.1.6-.2.9-.1.2 0 .5.1.7.1 2.6 0 4.6-1.9 4.6-4.3S10.6 2.2 8 2.2Z" }),
			h("path", { d: "M6 6.4h.01M10 6.4h.01M8 4.6h.01" }));

		function NativeTempIcon({ active = false } = {}) {
			return h("svg", { viewBox: "0 0 20 20", width: "16", height: "16", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" },
				h("circle", { cx: "10", cy: "10", r: "7.3", strokeDasharray: "2 2" }),
				active ? h("path", { d: "m6.8 10 2.1 2.1 4.4-4.4" }) : h("path", { d: "M10 9v4m0-6h.01" }));
		}
		function NativeTempStatus({ global = false, busy = false } = {}) {
			return h("button", { type: "button", className: "dsh-btw-entry" + (global ? " dsh-btw-global-entry" : ""), "aria-label": "结束临时聊天", "aria-pressed": true,
				title: "临时聊天已开启 · 点击结束并清理", disabled: busy, onClick: () => void closeNative(nativeOwner) }, h(NativeTempIcon, { active: true }), "临时聊天");
		}
		function BtwTempEntry(props) {
			temp.use();
			const p = prefs.use();
			const summary = props.useSessions?.((x) => props.sessionId !== undefined ? x.byId[props.sessionId] : undefined);
			const ns = nativeState.use();
			if (props.sessionId && props.sessionId === ns.id) return NativeTempStatus({ busy: ns.busy });
			if (!p.showTempEntry) return null;
			return h("button", { type: "button", className: "dsh-btw-entry", title: summary?.cwd ? "临时聊天 · 工作目录指向当前项目" : "临时聊天 · 使用宿主默认工作目录", "aria-label": "临时聊天",
				onClick: () => props.sessionId ? enterTemp(summary?.cwd, props.sessionId, sidebar ? "sidebar" : "overlay") : void openNative() }, GHOST_ICON, "btw");
		}

		// Registry/focus chooses seats; keyed shared views own only DOM interaction.
		function BtwTempOverlay({ inline = false, standalone = false, controllerId, renderFactorySlot } = {}) {
			tempRegistry.use(); uiState.use();
			const status = NativeStatus();
			const withStatus = (view) => !inline && !standalone && status ? h(React.Fragment, null, view, status) : view;
			if (!ui && !unloading && [...pendingEntries.values()].some(entry => entry.presentation !== "dock")) return withStatus(loadingView(() => {
				for (const [key, entry] of pendingEntries) if (entry.presentation !== "dock") pendingEntries.delete(key);
				changedTemp();
			}));
			if (unloading) return null;
			const mode = standalone ? "global" : inline ? "sidebar" : "overlay";
			const visible = controllerId ? [controllers.get(controllerId)].filter(Boolean) : [...controllers.values()].filter((c) => c.store.state.presentation === mode);
			if (!visible.length) return withStatus(null);
			// Keep DOM order stable while focusing: raising must not move/remount an
			// editor, interrupt IME, wipe its selection or steal keyboard focus.
			const views = visible.map((controller) => h(ui.BtwTempView, { key: controller.id, controller, inline, standalone, renderFactorySlot }));
			return withStatus(inline || standalone ? views : h("div", { className: "dsh-btw-desktop" }, ...views));
		}

		const GLOBAL_PANEL = "dsh-btw-global";
		function BtwGlobalEntry() {
			const p = prefs.use();
			const ns = nativeState.use();
			// The native header hides session utilities on its blank/hero page.
			// Keep an explicit close available before the first message too.
			if (ns.id) return NativeTempStatus({ global: true, busy: ns.busy });
			if (!p.showTempEntry) return null;
			return h("button", { type: "button", className: "dsh-btw-entry dsh-btw-global-entry", disabled: ns.busy, onClick: () => void openNative(), "aria-label": "开启全局临时聊天", title: "开启临时聊天" }, h(NativeTempIcon), "临时聊天");
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
		// host markup. Only an explicit fullscreen handoff can return to dock.
		function beginFullscreenWatch(controller, right, sourceId, tabId) {
			controller.stopFullscreenWatch?.();
			const watch = controller.fullscreenReturn = { right, sourceId, tabId, observed: false, gesture: 0, resize: 0 };
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
							if (target?.sessionId === sourceId && target.tabId === record.tabId && target.host === "dock" && right.isTargetCurrent(target)) { presentTemp(controller, "dock"); return; }
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
			return controller ? h(BtwTempOverlay, { inline: true, controllerId: controller.id, renderFactorySlot: props.renderFactorySlot }) : null;
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
		const getSettingsScope = () => settingsScope, getComposerBridge = () => composerBridge;
		const getOriginSnapshot = () => originSnapshot, isUnloading = () => unloading;
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
			pendingEntries.set((presentation === "dock" ? "dock:" : "temp:") + (originId || ""), { cwd, originId, presentation, draft, transcript });
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
				createTempController = c.createControllerFactory({ createStore, emptyTemp, changedTemp, controllers, focusTemp, surfaceTemp, reserveSurface, removeTemp, prefs, catalog, geometryKey, savedGeometry, modelValue, parseModel, resolveModelMode, completeContext, ctxRef, rpc, msg, POLL_MS, getSidebar, getComposerBridge, getOriginSnapshot, isUnloading, captureSidebarTab, retireSidebarTab, hideSoleSidebarTab });
				ui = v.createViews({ React, geometry, messageView, modelKey, modelValue, parseModel, catalog, loadModels, minimizeTemp, getSidebar, getLayout, controllers, tempRegistry, focusTemp, keyboardBelongsTo, updateGeometry, openTemp, presentTemp, surfaceTemp, GHOST_ICON });
				injectCss(v.CSS, CSS_ID + "/views");
				loadModels();
				uiState.patch({ status: "ready", error: "" });
				const entries = [...pendingEntries.values()].sort((a, b) => Number(a.presentation === "dock") - Number(b.presentation === "dock")); pendingEntries.clear();
				for (const { cwd, originId, presentation, draft, transcript } of entries) {
					if (presentation === "dock") openDock(cwd, originId, draft, transcript);
					else resumeTemp(cwd, originId, presentation);
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
				try { fibers.push(ctx.inject(["layout"], (scope) => { globalLayout = scope.layout; return () => { if (globalLayout === scope.layout) globalLayout = null; }; })); } catch { /* layout is optional */ }
				try { fibers.push(ctx.inject(["uiWorkspace", "sessions", "layout"], (scope) => { const services = nativeServices = { workspace: scope.uiWorkspace, sessions: scope.sessions, layout: scope.layout }; return () => { if (nativeServices === services) nativeServices = null; }; })); } catch { /* native entry reports unavailable */ }
				try { fibers.push(ctx.inject(["workspaces"], (scope) => { const service = nativeWorkspaces = scope.workspaces; return () => { if (nativeWorkspaces === service) nativeWorkspaces = null; }; })); } catch { /* older hosts may lack workspace discovery */ }
				try { fibers.push(ctx.inject(["sidebarRight", "sidebarRightTabs"], (scope) => {
					const right = scope.sidebarRight;
					sidebar = right;
					const type = scope.sidebarRightTabs.register({ id: TAB_ID, kind: "btw-temp", title: () => "btw" });
					// Explicit native tab close is a resource close, not a body unmount.
					const closeHandler = right.registerCloseHandler?.("btw-temp", (sessionId, tab) => {
						if (tab && removingTabs.has(tabToken(sessionId, tab.id))) return;
						const controller = surfaceTemp("sidebar", sessionId);
						if (!controller || controller.store.state.phase === "closing" || tab && controller.sidebarTab && controller.sidebarTab.tabId !== tab.id) return;
						controller.sidebarTab = null;
						controller.store.patch({ presentation: "overlay" });
						void controller.closeTemp();
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
				activationEpoch++; pendingEntries.clear();
				for (const controller of controllers.values()) void controller.closeTemp();
				if (nativeOwner) void closeNative(nativeOwner);
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
