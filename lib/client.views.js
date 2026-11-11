/** First-use views. Stores, resource ownership and transport stay in the entry. */
window.__ModuleLoader__.load({
	id: "dsh-btw",
	chunk: "client.views.js",
	factory: (require) => {
		// Optional browser shared module, not an npm/runtime service dependency.
		let SharedMenu = null, SharedChevron = null, SharedMarkdown = null, SharedButton = null, SharedTooltip = null;
		let SharedDisclosureRow = null, SharedThinkIcon = null, SharedTextShimmer = null;
		const nativeIcons = {};
		const renderable = (value) => typeof value === "function" || (value && typeof value === "object" && [Symbol.for("react.memo"), Symbol.for("react.forward_ref")].includes(value.$$typeof));
		try {
			const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
			if (typeof primitives?.Menu === "function") SharedMenu = primitives.Menu;
			if (typeof primitives?.IconChevronDownOutlineRegular === "function") SharedChevron = primitives.IconChevronDownOutlineRegular;
			if (renderable(primitives?.MarkdownText)) SharedMarkdown = primitives.MarkdownText;
			if (renderable(primitives?.Button)) SharedButton = primitives.Button;
			if (renderable(primitives?.Tooltip)) SharedTooltip = primitives.Tooltip;
			if (renderable(primitives?.DisclosureRow)) SharedDisclosureRow = primitives.DisclosureRow;
			if (renderable(primitives?.IconThinkOutlineRegular)) SharedThinkIcon = primitives.IconThinkOutlineRegular;
			if (renderable(primitives?.TextShimmer)) SharedTextShimmer = primitives.TextShimmer;
			for (const name of ["FullscreenOutline", "PanelLeftOutline", "PinFill", "PinOutline"]) {
				const icon = primitives?.["Icon" + name + "Regular"] || primitives?.["Icon" + name + "Medium"];
				if (renderable(icon)) nativeIcons[name] = icon;
			}
		} catch { /* older hosts keep the native select */ }

		const CSS = `
		/* ── side-question panel (composer dock row) ── */
		.dsh-btw-dock-stage{position:relative;width:100%;min-width:0;}
		.dsh-btw-dock-panel{position:relative;box-sizing:border-box;max-width:100%;max-height:min(50dvh,var(--btw-dock-max-height,480px));min-height:0;container-type:inline-size;}
		.dsh-btw-dock-panel>.dsh-btw-head,.dsh-btw-dock-panel>.dsh-btw-row{flex:none;}
		.dsh-btw-dock-panel>.dsh-btw-answer{flex:1;min-height:0;margin-right:8px;overscroll-behavior:contain;}
		.dsh-btw-dock-panel>.dsh-btw-row{min-height:0;border-top:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2,rgba(0,0,0,.08)));}
		.dsh-btw-dock-panel .dsh-btw-q{min-height:24px;line-height:20px;padding:2px 6px;}
		.dsh-btw-dock-panel .dsh-btw-row{gap:4px;padding:4px 10px 6px;}
		.dsh-btw-dock-panel .dsh-btw-select{padding:4px 6px;}
		/* After a reply neither the fold control nor the reopened composer may own
		   a flow row of panel height: the toggle floats at the panel bottom and the
		   expanded editor overlays the transcript (measured via --btw-editor-h). */
		.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-row{position:absolute;left:0;right:0;bottom:0;z-index:3;background:var(--dsw-specific-input-major,#fff);box-shadow:0 -6px 16px rgba(0,0,0,.06);}
		.dsh-btw-dock-panel[data-editor=collapsed]>.dsh-btw-answer{padding-bottom:34px;}
		.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-answer{padding-bottom:calc(var(--btw-editor-h,88px) + 14px);}
		.dsh-btw-dock-panel[data-editor]>.dsh-btw-tools,.dsh-btw-dock-panel[data-editor]>.dsh-btw-status{margin-bottom:34px;}
		.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-tools,.dsh-btw-dock-panel[data-editor=expanded]>.dsh-btw-status{margin-bottom:calc(var(--btw-editor-h,88px) + 14px);}
		.dsh-btw-editor-toggle{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);z-index:4;display:grid;place-items:center;width:24px;height:24px;margin:0;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:50%;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;box-shadow:var(--dsw-shadow-lv2,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02));}
		.dsh-btw-row>.dsh-btw-editor-toggle{bottom:auto;top:-12px;}
		.dsh-btw-editor-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-editor-toggle[aria-expanded=false] svg{transform:rotate(180deg);}
		.dsh-btw-editor-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:1px;}
		/* The dock head is one row: icons keep their hit area while the title and
		   text buttons shrink; container queries drop decor before any overflow. */
		.dsh-btw-head{display:flex;flex-wrap:nowrap;align-items:center;gap:4px;padding:6px 8px 0;min-width:0;}
		.dsh-btw-head .dsh-btw-mtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.dsh-btw-head>button.dsh-btw-control{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.dsh-btw-head .dsh-btw-window-control{min-width:26px;min-height:26px;padding:4px;}
		@container (max-width:320px){.dsh-btw-head{gap:2px;padding-inline:6px}.dsh-btw-head .dsh-btw-window-controls{gap:0}.dsh-btw-head .dsh-btw-window-control{min-width:22px;min-height:22px;padding:2px}}
		@container (max-width:250px){.dsh-btw-head .dsh-btw-mtitles{display:none}.dsh-btw-head .dsh-btw-x{width:20px;height:20px}}
		.dsh-btw-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#57585a);letter-spacing:.02em;}
		.dsh-btw-hint{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.dsh-btw-x{flex:none;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center;}
		.dsh-btw-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-answer{display:flex;flex-direction:column;gap:12px;padding:8px 14px;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere;overflow-y:auto;scrollbar-width:thin;}
		.dsh-btw-answer:empty{padding-block:0;}
		.dsh-btw-caret{display:inline-block;width:7px;height:14px;background:var(--dsw-alias-brand-text,#3964fe);vertical-align:-2px;margin-left:2px;animation:dsh-btw-caret .8s steps(2) infinite;}
		@keyframes dsh-btw-caret{0%,100%{opacity:1}50%{opacity:0}}
		.dsh-btw-status{padding:4px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-pick{width:14px;height:14px;margin:2px 4px;cursor:pointer;accent-color:var(--dsw-alias-brand-text,#3964fe);}
		.dsh-btw-err{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-row{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:8px 10px 10px;}
		.dsh-btw-q{display:block;box-sizing:border-box;width:100%;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;padding:4px 6px;max-height:120px;}
		.dsh-btw-q::placeholder{color:var(--dsw-alias-label-caption,#a1a3a8);}
		.dsh-btw-go{flex:none;display:grid;place-items:center;width:34px;height:34px;padding:0;background:var(--dsw-alias-button-info-fill,#3964fe);color:#fff;cursor:pointer;border:none;border-radius:50%;}
		.dsh-btw-go:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2b55e0);}
		.dsh-btw-go:disabled{opacity:.4;cursor:default;}
		.dsh-btw-go.ghost{background:transparent;color:var(--dsw-alias-label-secondary,#57585a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));}
		.dsh-btw-go.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsh-alias-label-primary,#0f1115);}
		/* ── chip trigger beside the send button ── */
		/* ── temp-chat header entry ── */
		/* ── temp-chat overlay (shell.overlay) ── */
		.dsh-btw-desktop{position:fixed;inset:0;z-index:9000;pointer-events:none;}
		.dsh-btw-veil{position:absolute;inset:0;pointer-events:none;}
		.dsh-btw-veil>.dsh-btw-modal{pointer-events:auto;position:absolute;}
		.dsh-btw-modal[data-focused=true]{border-color:var(--dsw-alias-brand-text,#3964fe);}
		@keyframes dsh-btw-fade{from{opacity:0}to{opacity:1}}
		.dsh-btw-veil[data-phase=closing]{pointer-events:none;animation:dsh-btw-fade .24s ease-in reverse forwards;}
		.dsh-btw-inline{width:100%;height:100%;min-height:0;}
		.dsh-btw-modal,.dsh-btw-mcard,.dsh-btw-bubble,.dsh-btw-entry,.dsh-btw-x{corner-shape:superellipse(1.5);}
		.dsh-btw-modal{box-sizing:border-box;min-width:0;min-height:0;width:min(var(--btw-width,740px),calc(100vw - 32px));max-width:100%;height:min(640px,calc(100dvh - 48px));background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-panel,24px);box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.16));display:flex;flex-direction:column;overflow:hidden;font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-modal[data-phase=closing]{animation:dsh-btw-shrink .24s ease-in forwards;}
		@keyframes dsh-btw-shrink{to{opacity:0;transform:scale(.97) translateY(8px)}}
		.dsh-btw-mhead{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));}
		.dsh-btw-micon{flex:none;width:30px;height:30px;border-radius:999px;display:grid;place-items:center;background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#57585a);}
		.dsh-btw-mtitles{flex:1;min-width:0;}
		.dsh-btw-mtitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);line-height:20px;}
		.dsh-btw-msub{font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.dsh-btw-mbody{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
		.dsh-btw-veil .dsh-btw-mbody{margin-right:8px;}
		.dsh-btw-empty{margin:auto;text-align:center;color:var(--dsw-alias-label-tertiary,#81858c);font-size:13px;line-height:22px;max-width:400px;padding:0 16px;}
		.dsh-btw-empty b{color:var(--dsw-alias-label-secondary,#57585a);font-weight:600;}
		.dsh-btw-msg{display:flex;flex-direction:column;}
		.dsh-btw-msg.user{align-items:flex-end;}
		.dsh-btw-msg.agent{align-items:stretch;}
		.dsh-btw-reasoning{margin:0 0 8px;color:var(--dsw-alias-label-secondary,#57585a);font-size:13px;line-height:1.6;overflow-wrap:anywhere;}
		.dsh-btw-reasoning>summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,#81858c);}
		.dsh-btw-reasoning[open]>summary{margin-bottom:6px;}
		.dsh-btw-think-body{padding:4px 0 0 20px;}
		.dsh-btw-think-preview{color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.dsh-btw-bubble{max-width:85%;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px;padding:8px 12px;border-radius:12px;}
		.dsh-btw-msg.user .dsh-btw-bubble{background:var(--dsw-specific-selector,#e8e8e8);color:var(--dsw-alias-label-primary,#0f1115);border-bottom-right-radius:4px;}
		/* Assistant正文 is unboxed, unlike the right-aligned user bubble. */
		.dsh-btw-prose{min-width:0;width:100%;font-size:14px;line-height:24px;color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere;}
		.dsh-btw-plain{white-space:pre-wrap;}
		.dsh-btw-prose pre{max-width:100%;overflow:auto;white-space:pre;}
		.dsh-btw-prose img,.dsh-btw-prose video{max-width:100%;}
		.dsh-btw-prose table{display:block;max-width:100%;overflow-x:auto;}
		.dsh-btw-msg.error .dsh-btw-prose{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-mfoot{flex:none;padding:10px 12px 12px;}
		.dsh-btw-mcard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-specific-input-major,#fff);border-radius:var(--dsw-radius-panel,24px);padding:8px 10px;display:flex;flex-direction:column;gap:6px;}
		.dsh-btw-mrow{display:flex;align-items:flex-end;gap:8px;}
		.dsh-btw-mta{flex:1;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;padding:4px 6px;max-height:140px;}
		.dsh-btw-mta::placeholder{color:var(--dsw-alias-label-caption,#a1a3a8);}
		.dsh-btw-control,.dsh-btw-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#57585a);border:0;background:transparent;border-radius:var(--dsw-radius-md,8px);padding:8px;cursor:pointer;corner-shape:superellipse(1.5);}
		.dsh-btw-control:hover,.dsh-btw-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-control:disabled,.dsh-btw-select:disabled{opacity:.45;cursor:default;}
		.dsh-btw-select{max-width:100%;min-width:0;}
		.dsh-btw-picker{max-width:100%;min-width:0;display:inline-flex;}
		.dsh-btw-picker-trigger{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;text-align:start;}
		.dsh-btw-picker-trigger>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
		.dsh-btw-picker-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:2px;}
		/* Native Menu portals escape card clipping; its default z-index is below our veil. */
		.dsh-btw-picker-menu[data-menu-material]{z-index:9010;max-width:min(360px,calc(100vw - 24px),var(--dsh-anchored-max-width,100vw));font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-picker-menu [role=menuitem]{scroll-margin-block:4px;}
		.dsh-btw-picker-label{white-space:normal;overflow-wrap:anywhere;}
		.dsh-btw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;}
		.dsh-btw-tools{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;}
		.dsh-btw-tools>label,.dsh-btw-tools>span{min-width:0;max-width:100%;}
		.dsh-btw-tools .dsh-btw-err{overflow-wrap:anywhere;}
		.dsh-btw-mta{width:100%;box-sizing:border-box;min-height:64px;}
		.dsh-btw-standalone{width:100%;height:100%;min-height:0;}
		.dsh-btw-standalone [data-global=true] .dsh-btw-mcard{border-style:dashed;}
		.dsh-btw-standalone [data-global=true] .dsh-btw-msg.user .dsh-btw-bubble{border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.22));}
		.dsh-btw-standalone .dsh-btw-mhead{min-height:64px;padding:10px 34px;}
		.dsh-btw-standalone .dsh-btw-mfoot{box-sizing:border-box;width:min(var(--btw-width,740px),calc(100% - 32px));margin:0 auto;padding:10px 0 24px;}
		.dsh-btw-standalone .dsh-btw-mbody>.dsh-btw-msg{box-sizing:border-box;width:100%;max-width:var(--btw-width,740px);margin-inline:auto;}
		.dsh-btw-resize{position:absolute;border:0;padding:0;background:transparent;touch-action:none;z-index:2;}
		.dsh-btw-resize:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:-3px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
		.dsh-btw-resize[data-edge=n],.dsh-btw-resize[data-edge=s]{left:16px;right:16px;height:8px;cursor:ns-resize;}
		.dsh-btw-resize[data-edge=n]{top:0}.dsh-btw-resize[data-edge=s]{bottom:0}
		.dsh-btw-resize[data-edge=e],.dsh-btw-resize[data-edge=w]{top:16px;bottom:16px;width:8px;cursor:ew-resize;}
		.dsh-btw-resize[data-edge=e]{right:0}.dsh-btw-resize[data-edge=w]{left:0}
		.dsh-btw-resize[data-edge=ne],.dsh-btw-resize[data-edge=nw],.dsh-btw-resize[data-edge=se],.dsh-btw-resize[data-edge=sw]{width:16px;height:16px;}
		.dsh-btw-resize[data-edge=ne]{top:0;right:0;cursor:nesw-resize}.dsh-btw-resize[data-edge=sw]{bottom:0;left:0;cursor:nesw-resize}
		.dsh-btw-resize[data-edge=nw]{top:0;left:0;cursor:nwse-resize}.dsh-btw-resize[data-edge=se]{bottom:0;right:0;cursor:nwse-resize}
		.dsh-btw-inline .dsh-btw-modal{max-width:100%;}
		.dsh-btw-window-controls{display:inline-flex;align-items:center;gap:2px;flex:none;margin-inline-start:auto;}
		.dsh-btw-window-control{display:inline-flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;padding:5px;}
		.dsh-btw-window-control[aria-pressed=true]{background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-window-control:focus-visible{outline:2px solid var(--dsw-alias-brand-text,#3964fe);outline-offset:1px;}
		.dsh-btw-window-control:disabled{opacity:.4;cursor:default;}
		.dsh-btw-window-tooltip{display:inline-flex;}
		.dsh-btw-mhead[data-draggable=true]{cursor:move;touch-action:none;user-select:none;}
		`;
		function createViews({ React, geometry, messageView, modelKey, modelValue, parseModel, catalog, loadModels, minimizeTemp, getSidebar, getLayout, controllers, tempRegistry, focusTemp, keyboardBelongsTo, updateGeometry, openTemp, presentTemp, surfaceTemp, GHOST_ICON }) {
			const { useEffect, useLayoutEffect, useRef, useState } = React;
			const h = React.createElement;
			const { geometryKey, geometryBounds, clampGeometry, resizeHandles, storedGeometry, savedGeometry, persistGeometry, dockBounds, clampDockGeometry } = geometry;
			// Only public primitives. No native pop-out/window glyph is exported:
			// that one uses a small semantic SVG, not Pin or a text-arrow substitute.
			function windowGlyph(mode) {
				const Icon = nativeIcons[mode === "global" ? "FullscreenOutline" : mode === "sidebar" ? "PanelLeftOutline" : ""];
				if (Icon) return h(Icon, { width: 16, height: 16, "aria-hidden": true, style: mode === "sidebar" ? { transform: "scaleX(-1)" } : undefined });
				return h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.25, "aria-hidden": true },
					mode === "overlay" ? [h("rect", { key: "back", x: 2, y: 2, width: 8, height: 7, rx: 1 }), h("rect", { key: "front", x: 6, y: 6, width: 8, height: 8, rx: 1 })]
						: mode === "sidebar" ? [h("rect", { key: "frame", x: 2, y: 2, width: 12, height: 12, rx: 1 }), h("path", { key: "column", d: "M10 2v12" })]
							: h("path", { d: "M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" }));
			}
			function iconButton({ label, tooltip = label, pressed, disabled, onClick, mode, icon }) {
				const button = h(SharedButton || "button", { type: "button", ...(SharedButton ? { size: "sm" } : {}), className: "dsh-btw-control dsh-btw-window-control",
					"aria-label": label, "aria-pressed": pressed, "data-btw-mode": mode, title: tooltip, disabled,
					onClick: () => { if (!disabled) onClick(); } }, icon || windowGlyph(mode));
				return SharedTooltip ? h(SharedTooltip, { label: tooltip, side: "bottom", delayMs: 500 }, h("span", { className: "dsh-btw-window-tooltip" }, button)) : button;
			}
			function windowControls({ presentation, sourceId, fromGlobal = false, disabled = false, onChange }) {
				const right = getSidebar(), layout = getLayout();
				const sidebarReason = !sourceId ? "没有来源会话，无法停靠侧边栏" : !right ? "宿主侧边栏不可用" : !fromGlobal && right.mounted?.getSnapshot() !== sourceId ? "请先返回来源会话，才能停靠侧边栏" : "";
				return h("div", { className: "dsh-btw-window-controls", role: "group", "aria-label": "窗口显示模式" },
					...PRESENTATIONS.filter(({ value }) => presentation !== "sidebar" || value !== "global").map(({ value, label }) => {
						const unavailable = value === "sidebar" ? sidebarReason : value === "global" && !layout ? "宿主全屏面板不可用" : "";
						const selected = presentation === value;
						return iconButton({ mode: value, label: value === "overlay" ? "浮动小窗" : value === "sidebar" ? "停靠侧边栏" : "全屏",
							tooltip: unavailable || label + (selected ? "（当前）" : ""), pressed: selected, disabled: disabled || !!unavailable, onClick: () => onChange(value) });
					}));
			}
			/** rc.1 Menu owns positioning, outside dismissal, IME-safe Escape,
			 * arrow/Home/End navigation and focus return. onSelect does NOT close it.
			 * Use its public items contract, never the private session ModelSelect. */
			function ChoiceMenu({ value, options, onChange, disabled, label, title }) {
				const [open, setOpen] = useState(false);
				useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
				const selected = options.find((option) => option.value === value);
				const close = () => setOpen(false);
				return h(SharedMenu, {
					open: open && !disabled, onClose: close,
					portal: true, side: "top", align: "end", autoFocus: true,
					className: "dsh-btw-picker", listClassName: "dsh-btw-picker-menu",
					selectedId: value,
					items: options.map((option) => ({ id: option.value, label: h("span", { className: "dsh-btw-picker-label" }, option.label,
						option.value === value ? h("span", { className: "dsh-btw-sr" }, "（已选择）") : null) })),
					onSelect: (next) => {
						close();
						if (!disabled && options.some((option) => option.value === next)) onChange(next);
					},
					anchor: h("button", {
						type: "button", className: "dsh-btw-select dsh-btw-picker-trigger", disabled, title,
						"aria-label": label + "：" + (selected?.label || value), "aria-haspopup": "menu", "aria-expanded": open && !disabled,
						onClick: () => { if (!disabled) setOpen((wasOpen) => !wasOpen); },
						onKeyDown: (e) => {
							const ime = e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.nativeEvent?.keyCode === 229;
							if (!open && !disabled && !ime && !e.defaultPrevented && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
								e.preventDefault(); e.stopPropagation(); setOpen(true);
							}
						},
					}, h("span", null, selected?.label || value), h(SharedChevron || "svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", "aria-hidden": true, style: { flex: "none", transform: open ? "rotate(180deg)" : undefined } }, SharedChevron ? null : h("path", { d: "m4 6 4 4 4-4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }))),
				});
			}
			function choiceSelect(props, options) {
				if (SharedMenu) return h(ChoiceMenu, { ...props, options });
				const { label, value, disabled, title, onChange } = props;
				return h("select", { className: "dsh-btw-select", "aria-label": label, value, disabled, title, onChange: (e) => { if (!disabled) onChange(e.target.value); } },
					...options.map((option) => h("option", { key: option.value, value: option.value }, option.label)));
			}
			const PRESENTATIONS = [{ value: "overlay", label: "小窗" }, { value: "sidebar", label: "侧边栏" }, { value: "global", label: "全屏" }];
			const CONTEXT_OPTIONS = [{ value: "none", label: "无上下文" }, { value: "recent", label: "最近对话" }, { value: "on-demand", label: "按需搜索近期快照" }, { value: "all", label: "全部对话" }];
			function ModelSelect({ value, onChange, disabled }) {
				const models = catalog.use();
				const known = models.providers.some((p) => p.models.some((m) => modelKey(p.id, m.id) === value));
				const options = [
					{ value: "default", label: "默认" },
					...(value !== "default" && !known ? [{ value, label: "已保存模型不可用" }] : []),
					...models.providers.flatMap((p) => p.models.map((m) => ({ value: modelKey(p.id, m.id), label: p.id + " / " + m.name }))),
				];
				return h("span", null, choiceSelect({ label: "模型", value, disabled, onChange }, options),
					models.status === "error" ? h("span", { className: "dsh-btw-err", role: "status" }, " 模型列表加载失败：" + models.error, " ", h("button", { type: "button", onClick: loadModels }, "重试")) : null);
			}
			// Fixed is a layout adapter only. The same controller and shared view
			// own all drafts, messages, sends and cleanup in every presentation.
			function BtwDockView({ controller, renderFactorySlot }) {
				const s = controller.store.state;
				const stageRef = useRef(null), dockResize = useRef(null), dockGeometryRef = useRef(null), dockKeyRef = useRef(null), dockMemory = useRef(null);

				const [dockSize, setDockSize] = useState(null);
				// Reset older width/height records once: the dock now follows the
				// composer width and remembers only explicit height adjustments.
				const dockKey = s.originId && !s.cwd ? "" : geometryKey(s.cwd) + "/dock-v3";
				if (dockMemory.current?.key !== dockKey) {
					const value = storedGeometry(dockKey);
					dockMemory.current = { key: dockKey, manual: !!value, value };
				}
				const clampDock = (value) => clampDockGeometry(value, stageRef.current);
				const dockGeometry = clampDock(dockMemory.current.manual ? dockKeyRef.current === dockKey && dockSize || dockMemory.current.value : {});
				dockGeometryRef.current = dockGeometry;
				const writeDock = (value) => {
					const geometry = clampDock(value);
					dockMemory.current = { key: dockKey, manual: true, value: geometry };
					dockKeyRef.current = dockKey;
					dockGeometryRef.current = geometry; setDockSize(geometry);
					persistGeometry(dockKey, { height: geometry.height });
				};
				useEffect(() => {
					dockKeyRef.current = dockKey;
					// Measurement never turns a default into a saved manual size. In

					// particular, first-paint fallback width must not pin the host column.
					const resize = () => {
						const measured = clampDock(dockMemory.current.manual ? dockGeometryRef.current : {});
						dockGeometryRef.current = measured; setDockSize(measured);
					};
					resize();
					window.addEventListener?.("resize", resize);
					const observer = typeof ResizeObserver === "function" && stageRef.current ? new ResizeObserver(resize) : null;
					if (observer) observer.observe(stageRef.current);
					return () => { observer?.disconnect(); window.removeEventListener?.("resize", resize); dockResize.current = null; };
				}, [dockKey]);

				return h("div", { className: "dsh-btw-dock" }, h("div", { className: "dsh-btw-dock-stage", ref: stageRef },
					h(BtwTempView, { controller, renderFactorySlot, dock: true, dockStyle: { width: "100%", height: dockGeometry.height, "--btw-dock-max-height": dockBounds(stageRef.current).maxHeight + "px" },
						dockHandles: resizeHandles({ gesture: dockResize, label: "侧问小窗", edges: ["n"], bounds: () => dockBounds(stageRef.current),
							read: () => { const g = clampDock(dockGeometryRef.current); return { ...g, y: dockBounds(stageRef.current).maxHeight - g.height }; }, write: writeDock }) })));
			}
			function BtwTempView({ controller, inline = false, standalone = false, dock = false, dockStyle, dockHandles, renderFactorySlot }) {
				const sidebar = getSidebar(), globalLayout = getLayout();
				tempRegistry.use();
				const s = controller.store.use();
				const patch = (fields) => controller?.store.patch(fields);
				const { beginTemp, sendTemp, closeTemp, showOverlay, showSidebar, insertSelected, toggleMessage } = controller || {};
				const draft = s.draft, setDraft = (value) => patch({ draft: value });
				const bodyRef = useRef(null), taRef = useRef(null), rowRef = useRef(null), composing = useRef(false), modalRef = useRef(null), drag = useRef(null), resizing = useRef(null);
				const hasReply = s.messages.some(m => m.role === "agent" && !m.error && m.text);
				const [editorExpanded, setEditorExpanded] = useState(!dock || !hasReply);
				const seenReply = useRef(!!hasReply), focusEditor = useRef(false);
				useEffect(() => {
					if (dock && hasReply && !seenReply.current) { seenReply.current = true; setEditorExpanded(false); }
				}, [dock, hasReply]);
				// The reopened composer overlays the transcript; measure it so the body
				// can keep its last line scrolled clear of the overlay. Degrades to the
				// CSS fallback silently when refs or ResizeObserver are unavailable.
				useEffect(() => {
					if (!dock || !editorExpanded || !hasReply) return undefined;
					const panel = modalRef.current, row = rowRef.current;
					if (!panel || !row || typeof ResizeObserver !== "function") return undefined;
					const apply = () => { const height = Number(row.offsetHeight); if (Number.isFinite(height) && height > 0) panel.style.setProperty("--btw-editor-h", Math.ceil(height) + "px"); };
					apply();
					const observer = new ResizeObserver(apply);
					observer.observe(row);
					return () => { observer.disconnect(); panel.style.removeProperty("--btw-editor-h"); };
				}, [dock, editorExpanded, hasReply]);
				useLayoutEffect(() => { if (editorExpanded && focusEditor.current) { focusEditor.current = false; taRef.current?.focus(); } }, [editorExpanded]);
				// No focus effect on phase/focus changes: the clicked control/editor
				// keeps browser focus, including while another chat finishes opening.
				useLayoutEffect(() => { const el = bodyRef.current; if (el !== null) el.scrollTop = el.scrollHeight; }, [controller?.id, s.messages, editorExpanded]);
				useEffect(() => {
					if (dock || inline || standalone || s.presentation !== "overlay" || !["active", "error", "opening", "configuring"].includes(s.phase)) return undefined;
					// Esc leaves the small window (parking it with its chat and draft); it
					// never ends the btw. Ending stays an explicit X action, and the native
					// temporary chat (standalone) installs no Esc handler at all.
					const onKey = (e) => { if (tempRegistry.state.activeId === controller.id && keyboardBelongsTo(modalRef.current, e) && e.key === "Escape" && !e.isComposing && !e.nativeEvent?.isComposing && e.keyCode !== 229 && !e.defaultPrevented && !e.target?.closest?.("select,[role=menu],[aria-expanded=true]")) { e.preventDefault?.(); minimizeTemp(controller); } };
					document.addEventListener("keydown", onKey);
					return () => document.removeEventListener("keydown", onKey);
				}, [controller?.id, s.phase, s.presentation, inline, standalone, dock]);
				if (!controller || s.phase === "idle" || (dock ? s.presentation !== "dock" : standalone ? s.presentation !== "global" : inline ? s.presentation !== "sidebar" : s.presentation !== "overlay")) return null;
				const submit = () => {
					const text = draft.trim();
					if (text === "" || controller.store.state.busy) return;
					if (controller.store.state.phase === "configuring") beginTemp(text);
					else if (controller.store.state.phase === "active") { setDraft(""); sendTemp(text); if (dock && hasReply) setEditorExpanded(false); }
				};
				const onKey = (e) => {
					// Esc in the fixed panel collapses the editor first and only then parks
					// the panel; the chat, its child and the draft are never discarded.
					if (dock && e.key === "Escape" && !e.isComposing && !composing.current && !e.nativeEvent?.isComposing && e.keyCode !== 229 && !e.defaultPrevented && !e.target?.closest?.("select,[role=menu],[aria-expanded=true]")) {
						e.stopPropagation?.();
						if (editorFoldable && editorExpanded) setEditorExpanded(false);
						else minimizeTemp(controller);
						return;
					}
					if (e.key !== "Enter" || e.shiftKey) return;
					const ime = composing.current || e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229;
					if (!ime) { e.preventDefault(); submit(); }
				};
				const presentation = standalone ? "global" : inline ? "sidebar" : "overlay";
				const ranked = [...controllers.values()].sort((a, b) => a.focusOrder - b.focusOrder);
				// After a reply the fold control floats (absolute) instead of owning a
				// flow row: collapsed it anchors to the panel bottom, expanded to the
				// overlay composer's top edge. The panel carries the state for CSS.
				const editorFoldable = dock && hasReply && s.phase !== "error";
				const editorToggle = editorFoldable ? h("button", { type: "button", className: "dsh-btw-editor-toggle", "aria-label": editorExpanded ? "收起输入框" : "展开输入框", "aria-expanded": editorExpanded, onClick: () => { if (!editorExpanded) focusEditor.current = true; setEditorExpanded(!editorExpanded); } }, h(SharedChevron || "svg", { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", "aria-hidden": true }, SharedChevron ? null : h("path", { d: "m4 6 4 4 4-4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }))) : null;
				const renderFrame = (card) => dock ? card : h("div", { className: standalone ? "dsh-btw-standalone" : inline ? "dsh-btw-inline" : "dsh-btw-veil", style: { zIndex: !inline && !standalone ? ranked.indexOf(controller) + 1 : undefined }, "data-phase": s.phase, "data-chat-id": controller.id,
					onPointerDownCapture: () => focusTemp(controller.id), onFocusCapture: () => focusTemp(controller.id) }, card);
				return renderFrame(
					h("div", { key: controller.id, ref: modalRef, className: dock ? "dsh-btw-card dsh-btw-dock-panel" : "dsh-btw-modal", style: dock ? dockStyle : { "--btw-width": s.width + "px", ...(!inline && !standalone ? { left: s.x, top: s.y, width: s.width, height: s.height } : { position: "relative", width: "100%", height: "100%", border: 0, borderRadius: "var(--dsw-radius-panel,24px)", boxShadow: "none" }) }, "data-phase": s.phase, "data-focused": tempRegistry.state.activeId === controller.id, "data-global": !s.originId, "data-empty": s.messages.length === 0, "data-editor": editorFoldable ? (editorExpanded ? "expanded" : "collapsed") : undefined, role: dock || inline || standalone ? "region" : "dialog", "aria-label": dock ? "btw 侧问小窗" : "临时聊天", "data-chat-id": dock ? controller.id : undefined },
						h("div", { className: dock ? "dsh-btw-head" : "dsh-btw-mhead", "data-draggable": !dock && !inline && !standalone && !s.pinned,
							onPointerDown: (e) => {
								if (dock || inline || standalone || controller.store.state.pinned || e.button !== 0 || e.target.closest?.("button,input,select,textarea,[role=menu]")) return;
								const rect = modalRef.current?.getBoundingClientRect();
								if (!rect) return;
								drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
								e.currentTarget.setPointerCapture?.(e.pointerId); e.preventDefault();
							},
							onPointerMove: (e) => {
								const from = drag.current;
								if (!from || from.pointer !== e.pointerId || controller.store.state.pinned) return;
								updateGeometry(controller, { x: from.left + e.clientX - from.x, y: from.top + e.clientY - from.y });
							},
							onPointerUp: () => { drag.current = null; }, onPointerCancel: () => { drag.current = null; }, onLostPointerCapture: () => { drag.current = null; },
						},
							!dock ? h("span", { className: "dsh-btw-micon" }, GHOST_ICON) : null,
							h("div", { className: "dsh-btw-mtitles" }, h("div", { className: "dsh-btw-mtitle" }, "btw"),
								h("div", { className: "dsh-btw-msub" }, s.phase === "opening" ? "正在开启…" : s.phase === "closing" ? "正在清理…" : s.phase === "error" ? "清理未完成" : "")),
							!dock && !inline && !(standalone && !s.originId) ? h("button", { type: "button", className: "dsh-btw-control", onClick: () => {
								const next = openTemp(s.cwd, s.originId, "overlay");
								if (next && next.store.state.x === s.x && next.store.state.y === s.y) {
									const { vw, vh } = geometryBounds();
									updateGeometry(next, { x: s.x + s.width + 28 <= vw ? s.x + 28 : Math.max(0, s.x - 28), y: s.y + s.height + 28 <= vh ? s.y + 28 : Math.max(0, s.y - 28) });
								}
							}, "aria-label": "新建临时聊天" }, "新建") : null,
							s.originId && s.messages.some((m) => !m.streaming && !m.error) ? h("button", { type: "button", className: "dsh-btw-control", "aria-pressed": s.selecting, onClick: () => patch({ selecting: !s.selecting, selected: [], insertionError: "", insertionNotice: "" }) }, s.selecting ? "取消选择" : "选择消息") : null,
							!inline && !(standalone && !s.originId) ? windowControls({ presentation, sourceId: s.originId, fromGlobal: standalone, disabled: s.phase === "closing", onChange: (mode) => { drag.current = null; resizing.current = null; presentTemp(controller, mode); } }) : null,
							!dock && !inline && !standalone ? iconButton({ label: "固定小窗", pressed: s.pinned, tooltip: s.pinned ? "已固定，点击允许拖动" : "可拖动，点击固定", onClick: () => { drag.current = null; patch({ pinned: !controller.store.state.pinned }); },
								icon: nativeIcons[s.pinned ? "PinFill" : "PinOutline"] ? h(nativeIcons[s.pinned ? "PinFill" : "PinOutline"], { width: 16, height: 16, "aria-hidden": true }) : h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: s.pinned ? "currentColor" : "none", stroke: "currentColor", strokeWidth: 1.2, "aria-hidden": true }, h("path", { d: "M5 2h6l-1 4 2 2v1H4V8l2-2-1-4Zm3 7v5" })) }) : null,
							!inline && !(standalone && !s.originId) ? iconButton({ label: "最小化 btw", tooltip: "最小化，保留聊天与草稿", disabled: s.phase === "closing", onClick: () => minimizeTemp(controller), icon: h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true }, h("path", { d: "M3 11h10", stroke: "currentColor", strokeWidth: 1.5 })) }) : null,
							// X ends the chat: the surface leaves immediately and the host cleanup
							// finishes in the background, so no "正在清理" placeholder is shown.
							h("button", { className: "dsh-btw-x", title: "结束并清理当前 btw", onClick: () => { const closing = closeTemp({ background: true }); if (standalone) globalLayout?.selectPanel(null); else if (closing) closing.then((closed) => { if (closed && !surfaceTemp("global") && standalone) globalLayout?.selectPanel(null); }); }, "aria-label": dock ? "关闭侧问面板" : "结束临时聊天" }, "×"),

						),
						dock ? dockHandles : !inline && !standalone ? resizeHandles({ gesture: resizing, read: () => clampGeometry(controller.store.state), write: (geometry) => updateGeometry(controller, geometry), onStart: () => focusTemp(controller.id) }) : null,
						s.phase === "error" ? h("div", { className: "dsh-btw-empty" }, h("div", { className: "dsh-btw-err" }, s.error), h("div", null, "结束失败，请重试。")) : h("div", { className: dock ? "dsh-btw-answer" : "dsh-btw-mbody", ref: bodyRef, tabIndex: dock ? 0 : undefined, "aria-label": dock ? "侧问消息" : undefined },
							s.messages.length === 0 ? h("div", { className: "dsh-btw-empty" }, s.cwd ? "比如：这个项目是干什么的？" : "问点什么…") : s.messages.map((m, i) => messageView(m, i,
								s.selecting && !m.streaming && !m.error ? h("input", { className: "dsh-btw-pick", type: "checkbox", checked: s.selected.includes(i), onChange: () => toggleMessage(i), "aria-label": "选择消息 " + (i + 1) }) : null, renderFactorySlot))),
						s.selected.length ? h("div", { className: "dsh-btw-tools" }, h("button", { type: "button", className: "dsh-btw-control", onClick: insertSelected }, "送回来源会话草稿（" + s.selected.length + "）")) : null,
						s.insertionError || s.insertionNotice ? h("div", { className: "dsh-btw-status" + (s.insertionError ? " dsh-btw-err" : ""), role: "status" }, s.insertionError || s.insertionNotice) : null,
						editorToggle && !editorExpanded ? editorToggle : null,
						s.phase !== "error" && (!dock || editorExpanded) ? h("div", { className: dock ? "dsh-btw-row" : "dsh-btw-mfoot", ref: dock ? rowRef : undefined },
						editorToggle,
						h("div", { className: dock ? undefined : "dsh-btw-mcard" },
							h("textarea", { className: dock ? "dsh-btw-q" : "dsh-btw-mta", ref: taRef, value: draft, rows: dock ? 1 : 2, disabled: !["active", "configuring"].includes(s.phase), placeholder: "问点什么… Enter 发送，Shift+Enter 换行", onChange: (e) => setDraft(e.target.value), onKeyDown: onKey, onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { setTimeout(() => { composing.current = false; }, 10); } }),
							h("div", { className: "dsh-btw-tools" },
								h(ModelSelect, { value: s.modelChoice, disabled: s.phase !== "configuring", onChange: (value) => { if (controller.store.state.phase === "configuring") patch({ modelChoice: value }); } }),
								s.originId ? h("label", null, choiceSelect({ label: dock ? "侧问上下文" : "临时聊天上下文", title: "按需模式授权最近的文本快照，不是完整历史", value: s.contextMode, disabled: s.phase !== "configuring", onChange: (value) => { if (controller.store.state.phase === "configuring") patch({ contextMode: value }); } }, CONTEXT_OPTIONS)) : null,
								h("button", { type: "button", className: "dsh-btw-go", onMouseDown: e => e.preventDefault(), onClick: submit, disabled: s.busy || draft.trim() === "" || !["active", "configuring"].includes(s.phase), "aria-label": dock ? "提问" : "发送", title: "发送（Enter）" }, h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: "M8 13V3M3 8l5-5 5 5" })))))) : null,
					),
				);
			}
			// The settings card itself ships as its own sibling chunk
			// (client.settings.js): the entry lazy-loads it on the first real
			// settings visit and passes these closure helpers to its
			// createSettings — native Menu pickers and the configured model
			// list stay owned here, with no synchronous cross-chunk require.
			return { BtwDockView, BtwTempView, settingsHelpers: { ModelSelect, choiceSelect, modelValue, CONTEXT_OPTIONS, PRESENTATIONS } };
		}
		return { createViews, MarkdownText: SharedMarkdown, DisclosureRow: SharedDisclosureRow, ThinkIcon: SharedThinkIcon, TextShimmer: SharedTextShimmer, CSS };
	},
});
