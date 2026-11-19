/** Per-chat resource owner: pinned connection, generation/close barrier, serial polls. */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	chunk: "client.controllers.js",
	factory: () => {
		function createControllerFactory({ createStore, emptyTemp, changedTemp, controllers, focusTemp, surfaceTemp, reserveSurface, removeTemp, prefs, catalog, geometryKey, savedGeometry, getWindowPinned = () => prefs.state.tempWindowPinned ?? false, modelValue, parseModel, resolveModelMode, completeContext, searchContext, ctxRef, rpc, msg, POLL_MS, getSidebar, getComposerBridge, getOriginSnapshot, isUnloading, captureSidebarTab, retireSidebarTab, hideSoleSidebarTab }) {
			function createTempController(id) {
				const temp = createStore(emptyTemp(), changedTemp);
				let generation = 0, openingAttempt = null, closingTemp = null;
				let tempTurn = 0, tempPollTimer = null, reasoningSeq = 0, contextRead = null;
				function stopTempTurn() {
					tempTurn++;
					contextRead?.abort();
					contextRead = null;
					if (tempPollTimer !== null) clearInterval(tempPollTimer);
					tempPollTimer = null;
				}
				function showOverlay(geometry) {
					const controller = controllers.get(id), sidebar = getSidebar();
					try {
						focusTemp(id);
						if (temp.state.presentation === "sidebar") {
							hideSoleSidebarTab?.(captureSidebarTab(controller));
							// Older hosts lack inventory and expose no active-tab getter.
							if (!sidebar?.openTabs && !sidebar?.active && sidebar?.isExpanded?.()) sidebar.toggleExpanded?.();
						}
						// Presentation changes BEFORE public close, so even a synchronous
						// native close callback cannot dispose the continuing resource.
						temp.patch({ ...geometry, presentation: "overlay" });
						retireSidebarTab(controller);
					} catch (e) { temp.patch({ insertionError: "无法移除旧侧栏：" + msg(e) }); }
				}
				function showSidebar() {
					const sidebar = getSidebar(), controller = controllers.get(id);
					if (!sidebar || !temp.state.originId || sidebar.mounted?.getSnapshot() !== temp.state.originId) {
						temp.patch({ insertionError: "请先返回来源会话，才能打开侧栏" }); return;
					}
					const before = temp.state.presentation;
					try {
						temp.patch({ presentation: "sidebar", insertionError: "", insertionNotice: "" });
						reserveSurface(controller, "sidebar"); sidebar.openTab("btw-temp");
						let record = captureSidebarTab(controller);
						if (!record) {
							const tabs = sidebar.openTabs?.getSnapshot?.();
							const matches = Array.isArray(tabs) ? tabs.filter(tab => tab.sessionId === temp.state.originId && tab.kind === "btw-temp") : [];
							if (matches.length === 1) record = controller.sidebarTab = { right: sidebar, sourceId: temp.state.originId, tabId: matches[0].tabId };
						}
						// One bounded post-commit correction for the host's initial default
						// page. Any subsequent user gesture or presentation change wins.
						if (record && typeof sidebar.focus === "function") {
							let timer;
							const cancel = () => {
								clearTimeout(timer);
								document.removeEventListener("pointerdown", cancel, true);
								document.removeEventListener("keydown", cancel, true);
								if (controller.cancelPresentation === cancel) controller.cancelPresentation = null;
							};
							controller.cancelPresentation = cancel;
							document.addEventListener("pointerdown", cancel, true);
							document.addEventListener("keydown", cancel, true);
							timer = setTimeout(() => {
								cancel();
								if (getSidebar() !== sidebar || sidebar.mounted?.getSnapshot() !== record.sourceId || temp.state.presentation !== "sidebar" || !controllers.has(id)) return;
								const active = sidebar.active?.();
								const inventory = sidebar.openTabs?.getSnapshot?.();
								if (active?.id !== record.tabId && Array.isArray(inventory) && inventory.some(tab => tab.sessionId === record.sourceId && tab.tabId === record.tabId && tab.kind === "btw-temp")) {
									try { sidebar.focus(record.tabId); } catch { /* optional service became unavailable */ }
								}
							}, 80);
						}
					} catch (e) { temp.patch({ presentation: before === "sidebar" ? "overlay" : before, insertionError: "无法打开侧栏：" + msg(e) }); }
				}
				function insertSelected() {
					const sidebar = getSidebar(), composerBridge = getComposerBridge();
					const s = temp.state;
					const fail = (error) => temp.patch({ insertionError: error });
					if (!s.originId || !sidebar || sidebar.mounted?.getSnapshot() !== s.originId || !composerBridge || composerBridge.sessionId !== s.originId) return fail("来源会话未显示，无法送回草稿");
					const english = /^en(?:-|$)/i.test(typeof document === "undefined" ? "" : document.documentElement?.lang || "");
					const labels = english ? { user: "User: ", agent: "Agent: " } : { user: "用户：", agent: "助手：" };
					const text = s.selected.slice().sort((a, b) => a - b).map((i) => s.messages[i]).filter((m) => m && !m.streaming && !m.error).map((m) => labels[m.role === "user" ? "user" : "agent"] + m.text).join("\n\n");
					if (!text) return fail("请选择已完成的消息");
					try {
						const span = composerBridge.actions.captureInsertion();
						if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || !Number.isInteger(span.draftRev)) return fail("无法确认草稿位置，请重试");
						if (sidebar.mounted.getSnapshot() !== s.originId || composerBridge.sessionId !== s.originId) return fail("会话已切换，未插入草稿");
						// Collapse the captured range: never replace selected text or references.
						const point = Math.max(span.start, span.end);
						if (!composerBridge.actions.insertText("\n\n" + text + "\n", { ...span, start: point, end: point })) return fail("草稿已更改或编辑器不可用，请重试");
						temp.patch({ selecting: false, selected: [], insertionError: "", insertionNotice: "已插入草稿，未发送" });
					} catch (e) { fail("未能插入草稿：" + msg(e)); }
				}
				function toggleMessage(i) {
					const selected = temp.state.selected;
					temp.patch({ selected: selected.includes(i) ? selected.filter((n) => n !== i) : selected.concat(i), insertionError: "", insertionNotice: "" });
				}

				function configureTemp(cwd, originId, presentation = "overlay") {
					const originSnapshot = getOriginSnapshot();
					if (temp.state.phase !== "idle") return;
					generation++;
					reasoningSeq = 0;
					const p = prefs.state;
					const key = originId && !cwd ? "" : geometryKey(cwd);
					temp.patch({ ...savedGeometry(key), pinned: getWindowPinned(), geometryKey: key, phase: "configuring", error: null, messages: [], sessionId: null, cwd: cwd || null, seq: 0, originId: typeof originId === "string" ? originId : null, presentation, draft: "", selecting: false, selected: [], insertionError: "", insertionNotice: "", contextMode: originId ? p.tempContextMode : "none", modelChoice: modelValue(p.tempModelMode, p.tempProvider, p.tempModel), transcript: originSnapshot && originSnapshot.sessionId === originId ? originSnapshot.text : "" });
				}

				function beginTemp(text) {
					if (temp.state.phase !== "configuring" || isUnloading()) return;
					// Match the host's simultaneous-child limit, reserving pending opens too.
					if ([...controllers.values()].filter((c) => ["opening", "active", "closing", "error"].includes(c.store.state.phase)).length >= 16) {
						temp.patch({ insertionError: "最多同时开启 16 个临时聊天，请先结束一个" }); return;
					}
					const source = getOriginSnapshot();
					if (source?.sessionId === temp.state.originId) temp.patch({ transcript: source.text, sourceClosed: !!source.removed });
					if (temp.state.sourceClosed) { temp.patch({ insertionError: "来源会话已关闭，未发送" }); return; }
					const s = { ...temp.state };
					const choice = parseModel(s.modelChoice);
					if (choice.mode === "invalid" || (choice.mode === "current" && !s.originId) || (choice.mode === "custom" && !catalog.state.providers.some((p) => p.id === choice.model.provider && p.models.some((m) => m.id === choice.model.model)))) {
						temp.patch({ insertionError: "所选模型不可用，请检查设置和来源会话" }); return;
					}
					if (!["none", "recent", "on-demand", "all"].includes(s.contextMode)) { temp.patch({ insertionError: "此上下文模式尚不可用" }); return; }
					if (s.contextMode === "on-demand" && !s.originId) { temp.patch({ insertionError: "按需引用需要来源对话" }); return; }
					const connection = ctxRef.current?.get?.("connection");
					const requestGeneration = generation;
					const attempt = openingAttempt = { connection, sessionId: null, sent: false, abort: s.contextMode === "all" ? new AbortController() : null };
					temp.patch({ phase: "opening", insertionError: "", insertionNotice: "" });
					const open = (context) => {
						if (generation !== requestGeneration) throw new Error("临时聊天已取消");
						attempt.sent = true;
						return rpc("open", { cwd: s.cwd, contextMode: s.contextMode, ...context, modelMode: resolveModelMode(choice, s.originId), ...(choice.model ? { model: choice.model } : {}), ...(s.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}), ...(s.originId ? { parentSessionId: s.originId } : {}) }, connection);
					};
					attempt.opened = (s.contextMode === "all" ? completeContext(s.originId, attempt.abort.signal).then(open) : open(s.contextMode === "on-demand" ? { contextSource: "events" } : { transcript: s.contextMode === "none" ? "" : s.transcript })).then((r) => {
						attempt.sessionId = r.sessionId;
						return r;
					});
					attempt.opened.then((r) => {
						if (generation !== requestGeneration) return;
						temp.patch({ phase: "active", sessionId: r.sessionId, cwd: r.cwd, busy: false, draft: temp.state.draft.trim() === text ? "" : temp.state.draft });
						sendTemp(text);
					}).catch((e) => { if (generation === requestGeneration) temp.patch({ phase: "configuring", insertionError: msg(e) }); });
				}

				function appendAgentText(delta, reasoning, live, hasLive, retries) {
					const messages = temp.state.messages.slice();
					const last = messages[messages.length - 1];
					const current = last !== undefined && last.role === "agent" && last.streaming ? last : null;
					if (!current && !delta && !reasoning && !live?.text && !retries?.length) return;
					// Retry previews arrive as whole past attempts from the host; live
					// snapshots always replace, never concatenate. Both stay out of the
					// committed reasoning and answer text.
					let attempts = Array.isArray(current?.reasoningAttempts) ? current.reasoningAttempts : [];
					if (retries?.length) {
						const merged = attempts.slice(), known = new Set(merged.map((a) => a.attemptId));
						for (const item of retries) {
							if (!item || typeof item.attemptId !== "string" || typeof item.text !== "string" || !item.text || known.has(item.attemptId)) continue;
							known.add(item.attemptId); merged.push({ attemptId: item.attemptId, text: item.text.slice(0, 4000).toWellFormed() });
						}
						attempts = merged.slice(-8);
					}
					const liveChanged = hasLive && (!current || (live === null
						? (current.liveAttemptId ?? null) !== null || (current.liveReasoning || "") !== "" || !!current.liveReasoningRunning
						: current.liveAttemptId !== live.attemptId || (current.liveReasoning || "") !== (live.text || "") || !!current.liveReasoningRunning !== !!live.running));
					if (current && !delta && !reasoning && !liveChanged
						&& attempts.length === (current.reasoningAttempts?.length ?? 0)
						&& attempts.every((item, i) => item === current.reasoningAttempts[i])) return;
					const next = { ...(current || { role: "agent", text: "", reasoning: "", streaming: true }),
						text: (current?.text || "") + delta, reasoning: (current?.reasoning || "") + reasoning };
					if (attempts.length) next.reasoningAttempts = attempts;
					if (hasLive) {
						next.liveReasoning = live?.text || "";
						next.liveReasoningRunning = !!live?.running;
						next.liveAttemptId = live?.attemptId || null;
						// An empty snapshot can be the handoff to the next tool/model
						// step. Keep the last display-only text until fresh text arrives.
						const text = live?.text, signature = "<signature>";
						const signatureEnd = text?.indexOf("</signature>") ?? -1;
						const visible = text?.startsWith(signature) ? signatureEnd >= 0 && text.slice(signatureEnd + 12).trim() : text && !signature.startsWith(text);
						if (visible) next.reasoningPreview = { attemptId: next.liveAttemptId, text };
					}
					if (current) messages[messages.length - 1] = next; else messages.push(next);
					temp.patch({ messages });
				}

				function finalizeAgentText(text) {
					const messages = temp.state.messages.slice();
					const last = messages[messages.length - 1];
					if (last !== undefined && last.role === "agent") {
						// Prior-attempt previews survive completion; only the live cursor resets.
						messages[messages.length - 1] = { ...last, text, streaming: false, liveReasoning: "", liveReasoningRunning: false, liveAttemptId: null, reasoningPreview: null };
					} else if (text !== "") {
						messages.push({ role: "agent", text, streaming: false });
					}
					temp.patch({ messages });
				}

				function sendTemp(text) {
					const { phase, busy, sessionId, seq } = temp.state;
					if (phase !== "active" || busy || sessionId === null) return;
					const connection = openingAttempt?.connection;
					const turn = ++tempTurn;
					const current = () => !isUnloading() && turn === tempTurn && temp.state.sessionId === sessionId && temp.state.phase === "active";
					if (temp.state.contextMode !== "on-demand") { sendTurn(); return; }
					const read = contextRead = new AbortController();
					temp.patch({ busy: true, contextSearching: true, insertionError: "", insertionNotice: "" });
					searchContext(temp.state.originId, text, read.signal).then(context => {
						if (current()) sendTurn(context);
					}).catch(e => {
						if (!current()) return;
						const draft = temp.state.draft;
						temp.patch({ busy: false, contextSearching: false, insertionError: "读取来源对话失败，未发送：" + msg(e),
							draft: draft && draft !== text ? text + "\n" + draft : text, editorRequest: (temp.state.editorRequest || 0) + 1 });
					}).finally(() => { if (contextRead === read) contextRead = null; });

					function sendTurn(context) {
						let fromSeq = seq, inFlight = null, settled = false;
						const userIndex = temp.state.messages.length; // captured before insertion
						temp.patch({ busy: true, contextSearching: false,
							messages: temp.state.messages.concat([{ role: "user", text, ...(context ? { context: { excerpts: context.excerpts, limited: context.limited } } : {}) }]) });
						const poll = (final = false) => rpc("poll", { sessionId, fromSeq, fromReasoningSeq: reasoningSeq, includeLiveReasoning: true }, connection).then((r) => {
							if (!current() || (settled && !final)) return;
							if (!Number.isSafeInteger(r.lastSeq) || r.lastSeq < fromSeq) throw new Error("回复游标无效");
							let delta = "", reasoning = "";
							if (r.lastSeq > fromSeq) {
								fromSeq = r.lastSeq;
								temp.patch({ seq: fromSeq });
								if (typeof r.text === "string") delta = r.text;
							}
							// Older hosts omit both fields. Never advance on a malformed pair.
							if (Number.isSafeInteger(r.reasoningLastSeq) && r.reasoningLastSeq > reasoningSeq && typeof r.reasoning === "string") {
								reasoningSeq = r.reasoningLastSeq;
								reasoning = r.reasoning;
							}
							const hasLive = Object.prototype.hasOwnProperty.call(r, "liveReasoning") && (r.liveReasoning === null ||
								(typeof r.liveReasoning?.text === "string" && typeof r.liveReasoning?.running === "boolean"));
							const retries = Array.isArray(r.retryReasoning) ? r.retryReasoning : null;
							if (delta || reasoning || hasLive || retries?.length) appendAgentText(delta, reasoning, hasLive ? r.liveReasoning : null, hasLive, retries);
						});
						const timer = setInterval(() => {
							if (!current() || settled || inFlight) return;
							inFlight = poll().catch(() => { /* final poll recovers transient failures */ }).finally(() => { inFlight = null; });
						}, POLL_MS);
						tempPollTimer = timer;
						rpc("send", { sessionId, text, ...(context ? { context } : {}) }, connection).then(async (r) => {
							settled = true;
							clearInterval(timer);
							// Fence the old reply before taking the final cut; never poll in parallel.
							await inFlight;
							if (!current()) return;
							await poll(true);
							if (!current()) return;
							const last = temp.state.messages.at(-1);
							finalizeAgentText(typeof r.output === "string" && r.output !== "" ? r.output : last?.streaming ? last.text : "");
							// Supplemental on-demand reads arrive only on this turn's success.
							const reads = Array.isArray(r.contextReads) ? r.contextReads.filter((p) => p && typeof p.text === "string" && p.text
								&& (p.role === "user" || p.role === "assistant")) : [];
							if (reads.length) {
								const messages = temp.state.messages.slice();
								const target = messages[userIndex];
								if (target && target.role === "user" && target.text === text) {
									messages[userIndex] = { ...target, context: { excerpts: [], limited: false, ...(target.context || {}), reads } };
									temp.patch({ messages });
								}
							}
						}).catch(async (e) => {
							if (!current()) return;
							// One final poll salvages previews of attempts the timer missed.
							try { await poll(true); } catch { /* keep the previews already received */ }
							if (!current()) return;
							const messages = temp.state.messages.map((m) => {
								if (!m.streaming) return m;
								// A failed turn keeps its real thinking visible: server previews
								// plus the live snapshot the reader was watching.
								const attempts = (Array.isArray(m.reasoningAttempts) ? m.reasoningAttempts : [])
									.filter((a) => typeof a?.text === "string" && a.text && a.attemptId !== m.liveAttemptId);
								if (m.liveReasoning) attempts.push({ attemptId: typeof m.liveAttemptId === "string" ? m.liveAttemptId : null, text: m.liveReasoning.slice(0, 4000).toWellFormed() });
								return { ...m, streaming: false, liveReasoning: "", liveReasoningRunning: false, liveAttemptId: null, reasoningPreview: null,
									...(attempts.length ? { reasoningAttempts: attempts.slice(-8) } : {}) };
							});
							temp.patch({ messages: messages.concat([{ role: "agent", text: "（发送失败：" + msg(e) + "）", error: true }]) });
						}).finally(() => {
							settled = true;
							clearInterval(timer);
							if (tempPollTimer === timer) tempPollTimer = null;
							if (current()) temp.patch({ busy: false });
						});
					}
				}

				/**
				 * End and clean up this chat.
				 *
				 * `background` is the user-facing X: the UI disappears in the same tick
				 * (no "正在清理" placeholder) and the host cleanup finishes on its own. A
				 * failure is never reported as success — it is logged and leaves the host
				 * recovery record in place. Without `background`, callers that must await
				 * the outcome (unload, tests) keep the previous behaviour.
				 */
				function closeTemp(options) {
					const background = options?.background === true;
					const { phase, sessionId } = temp.state;
					if (phase === "closing") return closingTemp;
					if (!["active", "error", "configuring", "opening"].includes(phase)) return Promise.resolve(phase === "idle");
					controllers.get(id)?.cancelPresentation?.();
					controllers.get(id)?.stopFullscreenWatch?.();
					const attempt = openingAttempt, closeGeneration = ++generation;
					stopTempTurn();
					attempt?.abort?.abort();
					const backgroundPresentation = temp.state.presentation;
					if (background) {
						// Detach the surface first: the chat must vanish immediately even
						// while the host is still deleting records.
						const controller = controllers.get(id);
						if (temp.state.presentation === "sidebar") {
							const record = captureSidebarTab(controller);
							try { hideSoleSidebarTab?.(record); } catch { /* tab cleanup stays authoritative */ }
						}
						try { retireSidebarTab(controller); } catch { /* keep cleaning regardless */ }
						temp.patch({ phase: "closing", busy: true, presentation: "hidden", resumePresentation: undefined });
					} else temp.patch({ phase: "closing", busy: true });
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
							const controller = controllers.get(id);
							if (temp.state.presentation === "sidebar") {
								const record = captureSidebarTab(controller);
								try { hideSoleSidebarTab?.(record); } catch { /* tab cleanup remains authoritative */ }
							}
							retireSidebarTab(controller);
							openingAttempt = null;
							removeTemp(id);
							temp.patch(emptyTemp());
						}
						return true;
					}).catch((e) => {
						if (!background) {
							if (generation === closeGeneration) temp.patch({ phase: "error", sessionId: attempt?.sessionId || sessionId, busy: false, error: "临时记录清理未完成", insertionError: "结束失败，请重试：" + msg(e) });
							return false;
						}
						// Background close: the surface already left, so bring it back only to
						// report the failure and offer a retry. Success stays invisible.
						console.error("btw: 临时记录清理未完成", e);
						if (generation === closeGeneration) {
							const previous = backgroundPresentation;
							temp.patch({ phase: "error", busy: false, error: "临时记录清理未完成：" + msg(e), insertionError: "结束失败，可重试：" + msg(e) });
							try {
								if (previous === "sidebar") showSidebar();
								else if (previous) temp.patch({ presentation: previous });
							} catch { /* the error text alone is enough to retry */ }
						}
						return false;
					}).finally(() => { closingTemp = null; });
					return closingTemp;
				}

				return { id, focusOrder: 0, store: temp, configure: configureTemp, beginTemp, sendTemp, closeTemp, showOverlay, showSidebar, insertSelected, toggleMessage };
			}

			return createTempController;
		}
		return { createControllerFactory };
	},
});
