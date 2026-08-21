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
 *      plain-text transcript from the live conversation snapshot (standard
 *      `useSession` prop) and ships it with the question to the host's
 *      stateless one-shot; the answer streams back through a 250ms poll.
 *
 *   2. Temporary chat — a ChatGPT-style ephemeral overlay (`shell.overlay`),
 *      opened from the session header's right-aligned utilities row. The host
 *      spawns a disposable child agent whose cwd is the current project root;
 *      close burns it. Nothing enters session history or the sidebar.
 *
 * All styling resolves against the host page's --dsw tokens with sensible
 * fallbacks; dark theme needs no special handling (the tokens flip).
 *
 * RPC envelope: { ok, value | error } over the `/api` channel, prefix `btw/`.
 */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	factory: (require) => {
		const React = require("react");
		const { useEffect, useLayoutEffect, useRef, useState, useReducer } = React;
		const h = React.createElement;

		const RPC_PREFIX = "btw/";
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
		.dsh-btw-err{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-row{display:flex;align-items:flex-end;gap:8px;padding:8px 10px 10px;}
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
		.dsh-btw-msg.user .dsh-btw-bubble{background:var(--dsw-alias-button-info-fill,#3964fe);color:#fff;border-bottom-right-radius:4px;}
		.dsh-btw-msg.agent .dsh-btw-bubble{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#0f1115);border-bottom-left-radius:4px;}
		.dsh-btw-msg.error .dsh-btw-bubble{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-mfoot{flex:none;padding:10px 12px 12px;}
		.dsh-btw-mcard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-specific-input-major,#fff);border-radius:14px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;}
		.dsh-btw-mrow{display:flex;align-items:flex-end;gap:8px;}
		.dsh-btw-mta{flex:1;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;padding:4px 6px;max-height:140px;}
		.dsh-btw-mta::placeholder{color:var(--dsw-alias-label-caption,#a1a3a8);}
		.dsh-btw-mmeta{font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);padding:0 4px;}
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

		function rpc(method, payload) {
			const ctx = ctxRef.current;
			if (ctx === null || ctx.connection === undefined) return Promise.reject(new Error("插件未就绪"));
			return ctx.connection.rpc.call("/api", RPC_PREFIX + method, payload).then((r) => {
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

		// ── side question store + actions ──────────────────────────────

		const ask = createStore({ phase: "idle", question: "", text: "", error: null, jobId: null, timer: null });

		function resetAsk() {
			if (ask.state.timer !== null) clearInterval(ask.state.timer);
			ask.patch({ phase: "idle", question: "", text: "", error: null, jobId: null, timer: null });
		}

		function cancelAsk() {
			const { jobId, timer } = ask.state;
			if (timer !== null) clearInterval(timer);
			if (jobId !== null) rpc("askCancel", { jobId }).catch(() => { /* best effort */ });
			ask.patch({ phase: "done", timer: null });
		}

		function startAsk(question, transcript) {
			if (ask.state.phase === "asking") return;
			if (ask.state.timer !== null) clearInterval(ask.state.timer);
			ask.patch({ phase: "asking", question, text: "", error: null, jobId: null, timer: null });
			rpc("ask", { question, transcript }).then((r) => {
				const jobId = r.jobId;
				const timer = setInterval(() => {
					rpc("askPoll", { jobId }).then((p) => {
						ask.patch({ text: p.text, error: p.error || null });
						if (p.done) {
							clearInterval(timer);
							ask.patch({ phase: p.error ? "error" : "done", timer: null });
						}
					}).catch((e) => {
						clearInterval(timer);
						ask.patch({ phase: "error", error: msg(e), timer: null });
					});
				}, POLL_MS);
				ask.patch({ jobId, timer });
			}).catch((e) => ask.patch({ phase: "error", error: msg(e) }));
		}

		/** Plain-text transcript of the conversation for the one-shot prefix. */
		function transcriptOf(snap) {
			if (snap === null || typeof snap !== "object" || !Array.isArray(snap.nodes)) return "";
			const clip = (t, n) => (t.length > n ? t.slice(0, n) + "…" : t);
			const lines = [];
			for (const node of snap.nodes) {
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

		// ── temp chat store + actions ──────────────────────────────────

		const temp = createStore({
			phase: "idle", sessionId: null, cwd: null, messages: [], busy: false, error: null, seq: 0,
		});

		function openTemp(cwd) {
			if (temp.state.phase !== "idle") return;
			temp.patch({ phase: "opening", error: null, messages: [], sessionId: null, cwd: null, seq: 0 });
			rpc("open", { cwd }).then((r) => {
				temp.patch({ phase: "active", sessionId: r.sessionId, cwd: r.cwd, busy: false });
			}).catch((e) => {
				temp.patch({ phase: "error", error: msg(e) });
			});
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

		function sendTemp(text) {
			const { phase, busy, sessionId, seq } = temp.state;
			if (phase !== "active" || busy || sessionId === null) return;
			let fromSeq = seq;
			temp.patch({ busy: true, messages: temp.state.messages.concat([{ role: "user", text }]) });
			const timer = setInterval(() => {
				rpc("poll", { sessionId, fromSeq }).then((r) => {
					if (r.text !== "") {
						fromSeq = r.lastSeq;
						temp.patch({ seq: r.lastSeq });
						appendAgentText(r.text);
					}
				}).catch(() => { /* poll hiccup: the final poll below recovers */ });
			}, POLL_MS);
			rpc("send", { sessionId, text }).then((r) => {
				return rpc("poll", { sessionId, fromSeq }).then((last) => {
					if (last.text !== "") {
						temp.patch({ seq: last.lastSeq });
						appendAgentText(last.text);
					}
					if (typeof r.output === "string" && r.output !== "") finalizeAgentText(r.output);
				});
			}).catch((e) => {
				temp.patch({
					messages: temp.state.messages.concat([{ role: "agent", text: "（发送失败：" + msg(e) + "）", error: true }]),
				});
			}).then(() => {
				clearInterval(timer);
				temp.patch({ busy: false });
			});
		}

		function closeTemp() {
			const { phase, sessionId } = temp.state;
			if (phase !== "active" && phase !== "error") return;
			temp.patch({ phase: "closing", busy: true });
			if (sessionId !== null) rpc("close", { sessionId }).catch(() => { /* burn failure never blocks the UI */ });
			setTimeout(() => {
				temp.patch({ phase: "idle", sessionId: null, cwd: null, messages: [], busy: false, error: null, seq: 0 });
			}, 260);
		}

		// ── side-question panel (conversation.input.dock) ──────────────

		function BtwAskPanel(props) {
			const s = ask.use();
			const snap = props.useSession !== undefined ? props.useSession((x) => x) : null;
			const [draft, setDraft] = useState("");
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
				if (props.inputActions === undefined || draftText === null) return;
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
			}, [draftText, props.inputActions]);

			useEffect(() => {
				if (s.phase === "open") {
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

			if (s.phase === "idle") return null;

			const submit = () => {
				const q = draft.trim();
				if (q === "" || s.phase === "asking") return;
				setDraft("");
				startAsk(q, transcriptOf(snap));
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
						h("span", { className: "dsh-btw-hint" },
							s.phase === "asking" ? "回答中…基于当前会话上下文，不进入历史"
								: "基于当前会话上下文 · 不进入历史"),
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
						s.phase === "asking"
							? h("button", { className: "dsh-btw-go ghost", onClick: cancelAsk }, "停止")
							: h("button", {
								className: "dsh-btw-go",
								onClick: submit,
								disabled: draft.trim() === "",
								"aria-label": "提问",
							}, "问"),
					),
				),
			);
		}

		// ── chip trigger (conversation.input.right) ────────────────────

		function BtwTrigger() {
			const s = ask.use();
			if (s.phase !== "idle") return null;
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
			// Current session cwd — the temp chat opens in the same project.
			const summary = props.useSessions !== undefined
				? props.useSessions((x) => (x.current !== undefined ? x.byId[x.current] : undefined))
				: undefined;
			if (s.phase !== "idle") return null;
			return h("button", {
				type: "button",
				className: "dsh-btw-entry",
				title: "临时聊天 · 用完即焚，工作目录指向当前项目",
				"aria-label": "临时聊天",
				onClick: () => { openTemp(summary?.cwd); },
			}, GHOST_ICON, "临时聊天");
		}

		// ── temp-chat overlay (shell.overlay) ──────────────────────────

		function BtwTempOverlay() {
			const s = temp.use();
			const [draft, setDraft] = useState("");
			const bodyRef = useRef(null);
			const taRef = useRef(null);
			const composing = useRef(false);

			useEffect(() => {
				if (s.phase === "active") taRef.current?.focus({ preventScroll: true });
			}, [s.phase]);

			useLayoutEffect(() => {
				const el = bodyRef.current;
				if (el !== null) el.scrollTop = el.scrollHeight;
			}, [s.messages]);

			useEffect(() => {
				if (s.phase !== "active" && s.phase !== "error" && s.phase !== "opening") return undefined;
				const onKey = (e) => {
					if (e.key === "Escape" && !e.isComposing) closeTemp();
				};
				document.addEventListener("keydown", onKey);
				return () => { document.removeEventListener("keydown", onKey); };
			}, [s.phase]);

			if (s.phase === "idle") return null;

			const cwdName = s.cwd !== null ? s.cwd.split("/").filter(Boolean).pop() : null;
			const submit = () => {
				const text = draft.trim();
				if (text === "" || s.busy) return;
				setDraft("");
				sendTemp(text);
			};
			const onKey = (e) => {
				if (e.key !== "Enter" || e.shiftKey) return;
				const ime = composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
				if (!ime) { e.preventDefault(); submit(); }
			};

			return h("div", { className: "dsh-btw-veil", "data-phase": s.phase, onClick: (e) => {
				if (e.target === e.currentTarget) closeTemp();
			} },
				h("div", { className: "dsh-btw-modal", "data-phase": s.phase, role: "dialog", "aria-label": "临时聊天" },
					h("div", { className: "dsh-btw-mhead" },
						h("span", { className: "dsh-btw-micon" }, GHOST_ICON),
						h("div", { className: "dsh-btw-mtitles" },
							h("div", { className: "dsh-btw-mtitle" }, "临时聊天"),
							h("div", { className: "dsh-btw-msub" },
								s.phase === "opening" ? "正在开启…"
									: s.phase === "closing" ? "正在焚毁…"
									: s.phase === "error" ? "开启失败"
										: (cwdName !== null ? `${cwdName} · ` : "") + "不会出现在历史记录中，关闭即焚毁"),
						),
						h("button", {
							className: "dsh-btw-x", title: "关闭并焚毁（Esc）", onClick: closeTemp,
							"aria-label": "关闭临时聊天",
						}, "×"),
					),
					s.phase === "error"
						? h("div", { className: "dsh-btw-empty" },
							h("div", { className: "dsh-btw-err" }, s.error), h("div", null, "关闭后再试一次。"))
						: h("div", { className: "dsh-btw-mbody", ref: bodyRef },
							s.messages.length === 0
								? h("div", { className: "dsh-btw-empty" },
									h("b", null, "用完即焚的临时对话"),
									h("div", null, "工作目录指向当前项目，不进入历史记录。"),
									h("div", null, "比如直接问：这个项目是干什么的？怎么在本地跑起来？"))
								: s.messages.map((m, i) => h("div", {
									className: "dsh-btw-msg " + m.role + (m.error ? " error" : ""),
									key: i,
								},
									h("div", { className: "dsh-btw-bubble" },
										m.text,
										m.streaming ? h("span", { className: "dsh-btw-caret" }) : null))),
						),
					s.phase !== "error" ? h("div", { className: "dsh-btw-mfoot" },
						h("div", { className: "dsh-btw-mcard" },
							h("div", { className: "dsh-btw-mrow" },
								h("textarea", {
									className: "dsh-btw-mta",
									ref: taRef,
									value: draft,
									rows: 2,
									disabled: s.phase !== "active",
									placeholder: s.busy ? "回复中…（可以等它说完）" : "问点什么… Enter 发送，Shift+Enter 换行",
									onChange: (e) => { setDraft(e.target.value); },
									onKeyDown: onKey,
									onCompositionStart: () => { composing.current = true; },
									onCompositionEnd: () => { setTimeout(() => { composing.current = false; }, 10); },
								}),
								h("button", {
									className: "dsh-btw-go",
									style: { height: "34px" },
									onClick: submit,
									disabled: s.busy || draft.trim() === "" || s.phase !== "active",
									"aria-label": "发送",
								}, "发送"),
							),
							h("div", { className: "dsh-btw-mmeta" }, "关闭（Esc）即焚毁：不进历史、不留磁盘"),
						),
					) : null,
				),
			);
		}

		// ── plugin entry ───────────────────────────────────────────────

		/** Session-scoped seats mount per session, so they go through slots.inject
		 *  (which returns a Fiber); the root-scoped overlay registers directly. */
		function apply(ctx) {
			ctxRef.current = ctx;
			injectCss();

			const fibers = [];
			if (ctx.slots !== undefined) {
				fibers.push(ctx.slots.inject("conversation.input.dock", () =>
					ctx.slots.register({ name: "conversation.input.dock", id: "btw-ask", order: 8 }, BtwAskPanel)));
				fibers.push(ctx.slots.inject("conversation.input.right", () =>
					ctx.slots.register({ name: "conversation.input.right", id: "btw-trigger", order: 5 }, BtwTrigger)));
				fibers.push(ctx.slots.inject("conversation.session.header.utilities", () =>
					ctx.slots.register({ name: "conversation.session.header.utilities", id: "btw-temp", order: 5 }, BtwTempEntry)));
			}

			ctx.effect(
				() => ctx.slots.register({ name: "shell.overlay", id: "btw", order: 30 }, BtwTempOverlay),
				"btw: temp-chat overlay slot",
			);

			ctx.effect(() => () => {
				for (const fiber of fibers) {
					try {
						const p = typeof fiber.dispose === "function" ? fiber.dispose() : fiber();
						if (p !== undefined && typeof p.catch === "function") p.catch(() => { /* ignore */ });
					} catch { /* ignore */ }
				}
				if (ask.state.timer !== null) clearInterval(ask.state.timer);
				const { sessionId, phase } = temp.state;
				if (sessionId !== null && (phase === "active" || phase === "opening")) {
					rpc("close", { sessionId }).catch(() => { /* host unload burns anyway */ });
				}
				ctxRef.current = null;
			});
		}

		return { inject: ["slots", "connection"], apply };
	},
});
