/** Zero-build package-local chunk; see docs/architecture.md. */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	chunk: "client.messages.js",
	factory: (require) => {
		// Native Markdown owns escaping; failure stays React plain text, never HTML.
		function displayReasoning(text) {
			const start = "<signature>", end = "</signature>";
			if (!text.startsWith("<")) return text;
			if (start.startsWith(text)) return "";
			if (!text.startsWith(start)) return text;
			const boundary = text.indexOf(end, start.length);
			return boundary < 0 ? "" : text.slice(boundary + end.length).replace(/^(?:\r?\n)+/, "");
		}
		function createMessageRenderer({ h, React, MarkdownText: SharedMarkdown, DisclosureRow, ThinkIcon, TextShimmer }) {
			const MARKDOWN_LABELS = { code: { copyLabel: "复制", copiedLabel: "已复制", toolbarLabels: { codeLabel: "代码", wrapLabel: "自动换行", unwrapLabel: "不换行" } }, footnotes: "脚注" };
			function reasoningContent(text, running, renderFactorySlot) {
				const fallback = SharedMarkdown ? h(SharedMarkdown, { text, streaming: running, labels: MARKDOWN_LABELS }) : h("div", { className: "dsh-btw-plain" }, text);
				return typeof renderFactorySlot === "function" ? renderFactorySlot("conversation.chat.reasoning.content", { text, running, labels: MARKDOWN_LABELS }, { fallback }) : fallback;
			}
			function ReasoningBlock({ text, running, autoOpen = running, title = "思考", prior, renderFactorySlot }) {
				// Stream activity can pause within one answer; it controls the
				// indicator, not whether the reader's disclosure is expanded.
				const [manualOpen, setManualOpen] = React.useState(null);
				const open = manualOpen ?? autoOpen;
				// Use the last paragraph with a complete first line, as in DSH's
				// native reasoning disclosure. Partial tokens don't flash in the header.
				const preview = running && !open ? text.replace(/\r\n/g, "\n").split(/\n(?:[\t ]*\n)+/).reduce((latest, paragraph, i, parts) => {
					const end = paragraph.indexOf("\n");
					const line = end >= 0 ? paragraph.slice(0, end) : i < parts.length - 1 ? paragraph : "";
					return line.replaceAll("**", "").trim() || latest;
				}, "") : "";
				const collapsedContent = preview ? [
					h("span", { key: "separator", className: "dsh-btw-think-separator", "data-shimmer-decoration": true, "aria-hidden": true }),
					h("span", { key: "preview", className: "dsh-btw-think-preview", "data-streaming": true }, TextShimmer ? h(TextShimmer, null, preview) : preview),
				] : undefined;
				return h("div", { className: "dsh-btw-reasoning", "data-variant": "think", "data-state": running ? "running" : "ok", "data-prior": prior }, h(DisclosureRow, {
					icon: ThinkIcon ? h(ThinkIcon, { size: 14 }) : undefined, title, running, open,
					expandable: true, expandOnRowClick: true, onToggle: () => setManualOpen(!open), collapsedContent,
				}, open ? h("div", { className: "dsh-btw-think-body" }, reasoningContent(text, running, renderFactorySlot)) : undefined));
			}
			// Public MarkdownText owns parsing/escaping and code controls. No source
			// render slots, file paths, text interactions or raw HTML are fabricated.
			function messageView(message, key, selection = null, renderFactorySlot) {
				const user = message.role === "user", markdown = !user && !message.error && SharedMarkdown;
				const canThink = !user && !message.error;
				const visible = text => typeof text === "string" ? displayReasoning(text) : "";
				const live = message.streaming ? visible(message.liveReasoning) : "";
				const committed = visible(message.reasoning);
				const waiting = message.streaming && !live && !committed ? message.reasoningPreview : null;
				const thinking = live ? !!message.liveReasoningRunning : !!message.streaming && !!committed;
				// During a retry gap, keep the previous thought in the same open
				// row. Move it to its own archive only when the next text arrives.
				const priors = canThink && Array.isArray(message.reasoningAttempts)
					? message.reasoningAttempts.map(a => ({ attemptId: a?.attemptId, text: visible(a?.text) })).filter(a => a.text) : [];
				const held = waiting?.attemptId ? priors.findIndex(a => a.attemptId === waiting.attemptId) + 1 : 0;
				const thought = live || committed || (held ? priors[held - 1].text : visible(waiting?.text));
				function thoughtRow(key, text, running, autoOpen, prior) {
					const title = prior ? "第 " + prior + " 次思考" : "思考";
					return React?.useState && DisclosureRow
						? h(ReasoningBlock, { key, text, running, autoOpen, title, prior, renderFactorySlot })
						: h("details", { key, className: "dsh-btw-reasoning", "data-prior": prior, open: autoOpen || undefined },
							h("summary", null, prior ? title : "思考过程"), reasoningContent(text, running, renderFactorySlot));
				}
				const priorBlocks = priors.flatMap((a, i) => i + 1 === held ? []
					: [thoughtRow(`prior-${a.attemptId ?? i}`, a.text, false, false, i + 1)]);
				const reads = user && Array.isArray(message.context?.reads)
					? message.context.reads.filter((r) => r && typeof r.text === "string" && r.text) : [];
				return h("div", { className: "dsh-btw-msg " + (user ? "user" : "agent") + (message.error ? " error" : ""), key },
					selection,
					priorBlocks.length ? priorBlocks : null,
					canThink && thought ? thoughtRow("current-reasoning", thought, thinking, !!message.streaming, held || undefined) : null,
					h("div", { className: user ? "dsh-btw-bubble" : "dsh-btw-prose" + (markdown ? "" : " dsh-btw-plain") },
						markdown ? h(SharedMarkdown, { text: message.text, streaming: !!message.streaming, labels: MARKDOWN_LABELS }) : message.text,
						message.streaming && !markdown ? h("span", { className: "dsh-btw-caret", "aria-hidden": true }) : null),
					user && message.context ? message.context.excerpts.length || reads.length
						? h("details", { className: "dsh-btw-context" },
							h("summary", null, "引用了 " + (message.context.excerpts.length + reads.length) + " 段"),
							...message.context.excerpts.map(({ seq, role, text }) => h("div", { key: seq, className: "dsh-btw-context-excerpt" },
								h("div", { className: "dsh-btw-context-source" }, role === "user" ? "你" : "助手"),
								h("div", null, text))),
							...reads.map((read, i) => h("div", { key: "read-" + i, className: "dsh-btw-context-excerpt" },
								h("div", { className: "dsh-btw-context-source" }, "补读 · " + (read.role === "user" ? "你" : "助手")),
								h("div", null, read.text))))
						: h("span", { className: "dsh-btw-context" }, message.context.limited ? "在搜索范围内未找到相关内容" : "未找到相关内容")
						: null);
			}
			return messageView;
		}
		return { createMessageRenderer };
	},
});
