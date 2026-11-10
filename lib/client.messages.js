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
			function ReasoningBlock({ text, running, renderFactorySlot }) {
				const [open, setOpen] = React.useState(running);
				const previousRunning = React.useRef(running);
				React.useEffect(() => {
					if (previousRunning.current !== running) { previousRunning.current = running; setOpen(running); }
				}, [running]);
				const complete = text.lastIndexOf("\n");
				const preview = running && complete >= 0 ? text.slice(0, complete).split(/\r?\n[\t ]*\r?\n/).at(-1).split(/\r?\n/)[0].replaceAll("**", "").trim() : "";
				const collapsedContent = preview ? h("span", { className: "dsh-btw-think-preview", "data-streaming": true }, " · ", TextShimmer ? h(TextShimmer, null, preview) : preview) : undefined;
				return h("div", { className: "dsh-btw-reasoning", "data-state": running ? "running" : "ok" }, h(DisclosureRow, {
					icon: ThinkIcon ? h(ThinkIcon, { size: 14 }) : undefined, title: "思考", running, open,
					expandable: true, expandOnRowClick: true, onToggle: () => setOpen(value => !value), collapsedContent,
				}, open ? h("div", { className: "dsh-btw-think-body" }, reasoningContent(text, running, renderFactorySlot)) : undefined));
			}
			// Public MarkdownText owns parsing/escaping and code controls. No source
			// render slots, file paths, text interactions or raw HTML are fabricated.
			function messageView(message, key, selection = null, renderFactorySlot) {
				const user = message.role === "user", markdown = !user && !message.error && SharedMarkdown;
				const live = message.streaming && message.liveReasoning;
				const rawThought = live || message.reasoning, thought = typeof rawThought === "string" ? displayReasoning(rawThought) : rawThought;
				const thinking = live ? !!message.liveReasoningRunning : !!message.streaming;
				return h("div", { className: "dsh-btw-msg " + (user ? "user" : "agent") + (message.error ? " error" : ""), key },
					selection,
					!user && !message.error && typeof thought === "string" && thought !== "" ?
						React?.useState && DisclosureRow ? h(ReasoningBlock, { text: thought, running: thinking, renderFactorySlot }) : h("details", { className: "dsh-btw-reasoning", open: thinking || undefined }, h("summary", null, "思考过程"), reasoningContent(thought, thinking, renderFactorySlot)) : null,
					h("div", { className: user ? "dsh-btw-bubble" : "dsh-btw-prose" + (markdown ? "" : " dsh-btw-plain") },
						markdown ? h(SharedMarkdown, { text: message.text, streaming: !!message.streaming, labels: MARKDOWN_LABELS }) : message.text,
						message.streaming && !markdown ? h("span", { className: "dsh-btw-caret", "aria-hidden": true }) : null));
			}
			return messageView;
		}
		return { createMessageRenderer };
	},
});
